require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const cron = require('node-cron');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const { sendWarningEmail, sendProcessStartEmail, sendProcessEndEmail } = require('./notify');

const ROOT = path.join(__dirname, '../..');

// ── Timezone mapping ──────────────────────────────────────────────────────────
// Server UTC  |  Cameroon UTC+1  |  Madagascar UTC+3
//
// MORNING Routing — processes TODAY's files (current day)
//   06h00 → 12h00 Madagascar  →  UTC 03:00 → 09:00  (every 30 min)
//   Warnings 15 min before each run
//
// AFTERNOON Routing — processes TOMORROW's files (next day)
//   13h00 → 19h00 Madagascar  →  UTC 10:00 → 16:00  (every 30 min)
//   Warnings 15 min before each run
//
// Report   : 00h00 Madagascar  →  UTC 21:00
// Warning  : 23h45 Madagascar  →  UTC 20:45
// ─────────────────────────────────────────────────────────────────────────────

// ── Shared routing runner ─────────────────────────────────────────────────────
async function runRouting(mode) {
  // mode: 'morning' (today's files) | 'afternoon' (tomorrow's files)
  const summary = { steps: [], files: [] };
  const label = mode === 'morning' ? '🌅 Morning' : '🌇 Afternoon';
  const cmd   = mode === 'morning'
    ? 'node run-all.js --today --no-report'
    : 'node run-all.js --no-report';
  const targetLabel = mode === 'morning' ? 'today' : 'tomorrow';

  console.log(`\n🔄 Starting ${label} routing (${targetLabel}'s files)...`);
  try { await sendProcessStartEmail('routing', mode); } catch (e) { console.error('❌ Start email:', e.message); }

  let output = '';
  try {
    output = execSync(cmd, { cwd: ROOT, encoding: 'utf8', shell: '/bin/sh', env: { ...process.env, PATH: process.env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' } });
    console.log(output);

    // Parse downloaded filenames: "  ✅ Downloaded: Livraison XX-XX-XXXX.1.xlsx"
    const fileMatches = [...output.matchAll(/✅ Downloaded: (.+?\.xlsx)/g)].map(m => m[1].trim());
    // Parse per-file email summary: "📊 Summary: X emails sent, Y failed"
    const summaryMatches = [...output.matchAll(/📊 Summary: (\d+) emails sent, (\d+) failed/g)];
    // Parse individually skipped filenames: "Skipping (already processed): Livraison XX.xlsx"
    const skippedMatches = [...output.matchAll(/Skipping \(already processed\): (.+?\.xlsx)/g)].map(m => m[1].trim());

    const noFiles    = output.includes('No Livraison') || output.includes('nothing to do');
    const allSkipped = !noFiles && fileMatches.length === 0 && skippedMatches.length > 0;
    const nothingAtAll = noFiles && fileMatches.length === 0;

    // Both processed AND skipped files appear in the summary
    summary.files = [
      ...fileMatches.map((name, i) => {
        const sm = summaryMatches[i];
        return { name, status: '✅ Processed', emailsSent: sm ? parseInt(sm[1]) : 0, emailsFailed: sm ? parseInt(sm[2]) : 0 };
      }),
      ...skippedMatches.map(name => ({ name, status: '⏭ Skipped (already processed)', emailsSent: 0, emailsFailed: 0 }))
    ];
    summary.mode = mode;

    const totalSent   = fileMatches.reduce((s, _, i) => { const sm = summaryMatches[i]; return s + (sm ? parseInt(sm[1]) : 0); }, 0);
    const totalFailed = fileMatches.reduce((s, _, i) => { const sm = summaryMatches[i]; return s + (sm ? parseInt(sm[2]) : 0); }, 0);

    if (nothingAtAll) {
      summary.steps.push({ name: 'SFTP Download', status: 'skipped', detail: `No matching file found on server for ${targetLabel}` });
    } else if (allSkipped) {
      summary.steps.push({ name: 'SFTP Download', status: 'skipped', detail: `All files already processed — skipped: ${skippedMatches.join(', ')}` });
    } else {
      const partialSkip = fileMatches.length > 0 && skippedMatches.length > 0;
      const downloadDetail = partialSkip
        ? `Processed: ${fileMatches.join(', ')} | Already done (skipped): ${skippedMatches.join(', ')}`
        : `${fileMatches.length} file(s) downloaded: ${fileMatches.join(', ')}`;
      summary.steps.push({ name: 'SFTP Download', status: 'ok', detail: downloadDetail });
      summary.steps.push({ name: 'Wialon Coordinates', status: 'ok', detail: 'Zones matched successfully' });
      summary.steps.push({ name: 'Route Calculation',  status: 'ok', detail: 'Optimal routes computed' });
      summary.steps.push({ name: 'Excel Update',       status: 'ok', detail: 'Order written to file(s)' });
      summary.steps.push({ name: 'SFTP Upload',        status: 'ok', detail: 'Updated file(s) uploaded to /IN' });
      summary.steps.push({
        name: 'Route Emails',
        status: totalFailed > 0 && totalSent === 0 ? 'error' : 'ok',
        detail: fileMatches.length > 0
          ? fileMatches.map((name, i) => { const sm = summaryMatches[i]; return `${name}: ${sm ? sm[1] : 0} sent, ${sm ? sm[2] : 0} failed`; }).join(' | ')
          : 'No new files processed — no emails sent'
      });
    }
  } catch (err) {
    const msg = err.message || '';
    const failedStep =
      msg.includes('Wialon')   ? 'Wialon Coordinates' :
      msg.includes('route')    ? 'Route Calculation'  :
      msg.includes('Excel')    ? 'Excel Update'       :
      msg.includes('upload')   ? 'SFTP Upload'        :
      msg.includes('email')    ? 'Route Emails'       : 'SFTP Download';
    summary.steps.push({ name: failedStep, status: 'error', detail: msg.split('\n')[0] });
    console.error(`❌ ${label} routing failed:`, msg);
  }

  try { await sendProcessEndEmail('routing', summary); } catch (e) { console.error('❌ End email:', e.message); }
}

const runMorningRouting   = () => runRouting('morning');
const runAfternoonRouting = () => runRouting('afternoon');

// ── Overlap runner — morning then afternoon, sequentially, every 1h ──────────────────
let _overlapRunning = false;
async function runOverlapRouting() {
  if (_overlapRunning) {
    console.log('⏳ Overlap slot skipped — previous run still in progress');
    return;
  }
  _overlapRunning = true;
  const errors = [];
  try {
    try {
      await runRouting('morning');
    } catch (e) {
      errors.push({ label: '🌅 Morning routing', message: e.message || String(e) });
      console.error('❌ Overlap — morning routing failed:', e.message);
    }
    try {
      await runRouting('afternoon');
    } catch (e) {
      errors.push({ label: '🌇 Afternoon routing', message: e.message || String(e) });
      console.error('❌ Overlap — afternoon routing failed:', e.message);
    }
    if (errors.length > 0) {
      const { sendMail } = require('../emails/graph-mailer');
      const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'ulrich.kamsu@camtrack.net';
      const errorRows = errors.map(e =>
        `<tr><td style="padding:6px 14px 6px 0;font-weight:bold">${e.label}</td>
         <td style="color:#c62828;font-size:13px"><pre style="margin:0;white-space:pre-wrap">${e.message.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</pre></td></tr>`
      ).join('');
      await sendMail({
        to: ADMIN_EMAIL,
        subject: `❌ Overlap Routing Error — ${errors.length} process(es) failed`,
        html: `<p>Hello,</p>
               <p>One or more processes failed during the <strong>overlap window (12h00→16h00 Madagascar)</strong>.</p>
               <table style="border-collapse:collapse;font-size:14px;width:100%">
                 <thead><tr style="background:#f5f5f5">
                   <th style="padding:6px 14px 6px 0;text-align:left">Process</th>
                   <th style="padding:6px 0;text-align:left">Error</th>
                 </tr></thead>
                 <tbody>${errorRows}</tbody>
               </table>
               <p style="margin-top:12px">Please check the server logs for details.</p>`
      }).catch(mailErr => console.error('❌ Could not send overlap error email:', mailErr.message));
    }
  } finally {
    _overlapRunning = false;
  }
}

// ── Report runner ─────────────────────────────────────────────────────────────
async function runReport(roundLabel) {
  const summary = { steps: [], files: [] };
  console.log(`\n📊 Starting report process... [${roundLabel}]`);

  try { await sendProcessStartEmail('report', undefined, roundLabel); } catch (e) { console.error('❌ Start email:', e.message); }

  // Step 1 — Wialon report generation (per-file error handling inside generateReport)
  let reportResult = { succeeded: [], failed: [] };
  try {
    const { generateReport } = require('./wialon-report');
    reportResult = await generateReport() || reportResult;

    const succeededNames = reportResult.succeeded.join(', ') || 'none';
    const failedNames    = reportResult.failed.map(f => f.name).join(', ') || 'none';

    summary.steps.push({
      name: 'Wialon Report Generation',
      status: reportResult.failed.length > 0 && reportResult.succeeded.length === 0 ? 'error' : 'ok',
      detail: `✅ Succeeded: ${succeededNames} | ❌ Failed: ${failedNames}`
    });

    summary.files = [
      ...reportResult.succeeded.map(name => ({ name, status: '✅ OK' })),
      ...reportResult.failed.map(f  => ({ name: f.name, status: `❌ ${f.error.split('\n')[0]}` }))
    ];
  } catch (err) {
    summary.steps.push({ name: 'Wialon Report Generation', status: 'error', detail: err.message.split('\n')[0] });
  }

  try { await sendProcessEndEmail('report', summary, roundLabel); } catch (e) { console.error('❌ End email:', e.message); }
}

// ── Manual / immediate launch (bypass schedule) ───────────────────────────────
if (process.argv.includes('--now')) {
  const isReport   = process.argv.includes('--report');
  const isMorning  = process.argv.includes('--morning');
  const isAfternoon = process.argv.includes('--afternoon');

  if (isReport) {
    console.log('🚀 Manual launch: report now...');
    runReport('manual').then(() => process.exit(0));
  } else if (isMorning) {
    console.log('🚀 Manual launch: morning routing (today\'s files)...');
    runMorningRouting().then(() => process.exit(0));
  } else if (isAfternoon) {
    console.log('🚀 Manual launch: afternoon routing (tomorrow\'s files)...');
    runAfternoonRouting().then(() => process.exit(0));
  } else {
    // default --now without qualifier → morning (today)
    console.log('🚀 Manual launch: routing (today\'s files by default)...');
    runMorningRouting().then(() => process.exit(0));
  }

} else {
  // ── Scheduled launch ─────────────────────────────────────────────────────────

  // ── MORNING routing — TODAY's files — 06h00→16h00 Madagascar (UTC 03:00→13:00) every 30 min ──
  // 06h00→11h30 Mada (UTC 03:00→08:30): morning only
  // 12h00→16h00 Mada (UTC 09:00→13:00): morning + afternoon run together
  cron.schedule('45  2 * * *', () => sendWarningEmail('routing', '06h00 🌅 matin').catch(console.error));         // UTC 02:45 → warn before 06h00 Mada
  cron.schedule('15  3 * * *', () => sendWarningEmail('routing', '06h30 🌅 matin').catch(console.error));         // UTC 03:15 → warn before 06h30 Mada
  cron.schedule('45  3 * * *', () => sendWarningEmail('routing', '07h00 🌅 matin').catch(console.error));         // UTC 03:45 → warn before 07h00 Mada
  cron.schedule('15  4 * * *', () => sendWarningEmail('routing', '07h30 🌅 matin').catch(console.error));         // UTC 04:15 → warn before 07h30 Mada
  cron.schedule('45  4 * * *', () => sendWarningEmail('routing', '08h00 🌅 matin').catch(console.error));         // UTC 04:45 → warn before 08h00 Mada
  cron.schedule('15  5 * * *', () => sendWarningEmail('routing', '08h30 🌅 matin').catch(console.error));         // UTC 05:15 → warn before 08h30 Mada
  cron.schedule('45  5 * * *', () => sendWarningEmail('routing', '09h00 🌅 matin').catch(console.error));         // UTC 05:45 → warn before 09h00 Mada
  cron.schedule('15  6 * * *', () => sendWarningEmail('routing', '09h30 🌅 matin').catch(console.error));         // UTC 06:15 → warn before 09h30 Mada
  cron.schedule('45  6 * * *', () => sendWarningEmail('routing', '10h00 🌅 matin').catch(console.error));         // UTC 06:45 → warn before 10h00 Mada
  cron.schedule('15  7 * * *', () => sendWarningEmail('routing', '10h30 🌅 matin').catch(console.error));         // UTC 07:15 → warn before 10h30 Mada
  cron.schedule('45  7 * * *', () => sendWarningEmail('routing', '11h00 🌅 matin').catch(console.error));         // UTC 07:45 → warn before 11h00 Mada
  cron.schedule('15  8 * * *', () => sendWarningEmail('routing', '11h30 🌅 matin').catch(console.error));         // UTC 08:15 → warn before 11h30 Mada
  // 12h00→16h00 Mada: both morning + afternoon warnings fire together (every 1h)
  cron.schedule('45  8 * * *', () => { sendWarningEmail('routing', '12h00 🌅 matin').catch(console.error); sendWarningEmail('routing', '12h00 🌇 après-midi').catch(console.error); }); // UTC 08:45 → warn before 12h00 Mada
  cron.schedule('45  9 * * *', () => { sendWarningEmail('routing', '13h00 🌅 matin').catch(console.error); sendWarningEmail('routing', '13h00 🌇 après-midi').catch(console.error); }); // UTC 09:45 → warn before 13h00 Mada
  cron.schedule('45 10 * * *', () => { sendWarningEmail('routing', '14h00 🌅 matin').catch(console.error); sendWarningEmail('routing', '14h00 🌇 après-midi').catch(console.error); }); // UTC 10:45 → warn before 14h00 Mada
  cron.schedule('45 11 * * *', () => { sendWarningEmail('routing', '15h00 🌅 matin').catch(console.error); sendWarningEmail('routing', '15h00 🌇 après-midi').catch(console.error); }); // UTC 11:45 → warn before 15h00 Mada
  cron.schedule('45 12 * * *', () => { sendWarningEmail('routing', '16h00 🌅 matin').catch(console.error); sendWarningEmail('routing', '16h00 🌇 après-midi').catch(console.error); }); // UTC 12:45 → warn before 16h00 Mada

  // Morning-only runs: 06h00→11h30 Mada (UTC 03:00→08:30)
  cron.schedule(' 0  3 * * *', runMorningRouting);  // UTC 03:00 → 06h00 Madagascar
  cron.schedule('30  3 * * *', runMorningRouting);  // UTC 03:30 → 06h30 Madagascar
  cron.schedule(' 0  4 * * *', runMorningRouting);  // UTC 04:00 → 07h00 Madagascar
  cron.schedule('30  4 * * *', runMorningRouting);  // UTC 04:30 → 07h30 Madagascar
  cron.schedule(' 0  5 * * *', runMorningRouting);  // UTC 05:00 → 08h00 Madagascar
  cron.schedule('30  5 * * *', runMorningRouting);  // UTC 05:30 → 08h30 Madagascar
  cron.schedule(' 0  6 * * *', runMorningRouting);  // UTC 06:00 → 09h00 Madagascar
  cron.schedule('30  6 * * *', runMorningRouting);  // UTC 06:30 → 09h30 Madagascar
  cron.schedule(' 0  7 * * *', runMorningRouting);  // UTC 07:00 → 10h00 Madagascar
  cron.schedule('30  7 * * *', runMorningRouting);  // UTC 07:30 → 10h30 Madagascar
  cron.schedule(' 0  8 * * *', runMorningRouting);  // UTC 08:00 → 11h00 Madagascar
  cron.schedule('30  8 * * *', runMorningRouting);  // UTC 08:30 → 11h30 Madagascar

  // Morning + Afternoon together: 12h00→16h00 Mada (UTC 09:00→13:00) — every 1h
  cron.schedule(' 0  9 * * *', runOverlapRouting);   // UTC 09:00 → 12h00 Madagascar
  cron.schedule(' 0 10 * * *', runOverlapRouting);   // UTC 10:00 → 13h00 Madagascar
  cron.schedule(' 0 11 * * *', runOverlapRouting);   // UTC 11:00 → 14h00 Madagascar
  cron.schedule(' 0 12 * * *', runOverlapRouting);   // UTC 12:00 → 15h00 Madagascar
  cron.schedule(' 0 13 * * *', runOverlapRouting);   // UTC 13:00 → 16h00 Madagascar (last morning run)

  // ── AFTERNOON routing — TOMORROW's files — 16h30→19h00 Madagascar (UTC 13:30→16:00) every 30 min ──
  cron.schedule('15 13 * * *', () => sendWarningEmail('routing', '16h30 🌇 après-midi').catch(console.error)); // UTC 13:15 → warn before 16h30 Mada
  cron.schedule('45 13 * * *', () => sendWarningEmail('routing', '17h00 🌇 après-midi').catch(console.error)); // UTC 13:45 → warn before 17h00 Mada
  cron.schedule('15 14 * * *', () => sendWarningEmail('routing', '17h30 🌇 après-midi').catch(console.error)); // UTC 14:15 → warn before 17h30 Mada
  cron.schedule('45 14 * * *', () => sendWarningEmail('routing', '18h00 🌇 après-midi').catch(console.error)); // UTC 14:45 → warn before 18h00 Mada
  cron.schedule('15 15 * * *', () => sendWarningEmail('routing', '18h30 🌇 après-midi').catch(console.error)); // UTC 15:15 → warn before 18h30 Mada
  cron.schedule('45 15 * * *', () => sendWarningEmail('routing', '19h00 🌇 après-midi').catch(console.error)); // UTC 15:45 → warn before 19h00 Mada

  cron.schedule('30 13 * * *', runAfternoonRouting); // UTC 13:30 → 16h30 Madagascar
  cron.schedule(' 0 14 * * *', runAfternoonRouting); // UTC 14:00 → 17h00 Madagascar
  cron.schedule('30 14 * * *', runAfternoonRouting); // UTC 14:30 → 17h30 Madagascar
  cron.schedule(' 0 15 * * *', runAfternoonRouting); // UTC 15:00 → 18h00 Madagascar
  cron.schedule('30 15 * * *', runAfternoonRouting); // UTC 15:30 → 18h30 Madagascar
  cron.schedule(' 0 16 * * *', runAfternoonRouting); // UTC 16:00 → 19h00 Madagascar

  // ── Report — 3 rounds: 23h00, 23h30, 00h00 Madagascar (UTC 20:00, 20:30, 21:00) ──────────
  cron.schedule('45 19 * * *', () => sendWarningEmail('report', '23h00').catch(console.error)); // UTC 19:45 → warn before 23h00 Mada
  cron.schedule(' 0 20 * * *', () => runReport('Round 1 — 23h00 Madagascar'));                  // UTC 20:00 → 23h00 Mada
  cron.schedule('15 20 * * *', () => sendWarningEmail('report', '23h30').catch(console.error)); // UTC 20:15 → warn before 23h30 Mada
  cron.schedule('30 20 * * *', () => runReport('Round 2 — 23h30 Madagascar'));                  // UTC 20:30 → 23h30 Mada
  cron.schedule('45 20 * * *', () => sendWarningEmail('report', '00h00').catch(console.error)); // UTC 20:45 → warn before 00h00 Mada
  cron.schedule(' 0 21 * * *', () => runReport('Round 3 — 00h00 Madagascar'));                  // UTC 21:00 → 00h00 Mada

  console.log('⏰ Scheduler started (UTC times):');
  console.log('');
  console.log('  🌅 MORNING ROUTING  — TODAY\'s files');
  console.log('  ├─ 🔄 Morning only  → UTC 03:00→08:30   (Mada 06h00→11h30)');
  console.log('  └─ 🔄 Morn + Aft    → UTC 09:00→13:00   (Mada 12h00→16h00)  ← every 1h, last morning run at 16h00');
  console.log('');
  console.log('  🌇 AFTERNOON ROUTING  — TOMORROW\'s files');
  console.log('  ├─ 🔄 With morning  → UTC 09:00→13:00   (Mada 12h00→16h00)');
  console.log('  └─ 🔄 Aft only      → UTC 13:30→16:00   (Mada 16h30→19h00)');
  console.log('  (⚠️  Warnings fire 15 min before each run throughout)');
  console.log('');
  console.log('  REPORT   (Madagascar UTC+3) — 3 rounds');
  console.log('  ├─ ⚠️  Warning   → 19:45 UTC  (22h45 Madagascar) — before 23h00');
  console.log('  ├─ 📊 Round 1   → 20:00 UTC  (23h00 Madagascar)');
  console.log('  ├─ ⚠️  Warning   → 20:15 UTC  (23h15 Madagascar) — before 23h30');
  console.log('  ├─ 📊 Round 2   → 20:30 UTC  (23h30 Madagascar)');
  console.log('  ├─ ⚠️  Warning   → 20:45 UTC  (23h45 Madagascar) — before 00h00');
  console.log('  └─ 📊 Round 3   → 21:00 UTC  (00h00 Madagascar)');
  console.log('');
  console.log('💡 Manual launch (no schedule):');
  console.log('   node src/report/schedule-report.js --now                → morning routing (today\'s files)');
  console.log('   node src/report/schedule-report.js --now --morning      → morning routing (today\'s files)');
  console.log('   node src/report/schedule-report.js --now --afternoon    → afternoon routing (tomorrow\'s files)');
  console.log('   node src/report/schedule-report.js --now --report       → report');
  console.log('');
}
