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

    // Detect all "nothing to do" states:
    // 1. No file found for that date on SFTP
    // 2. All files already have _updated-with-order on SFTP (skip duplicate processing)
    const noFiles      = output.includes('No Livraison') || output.includes('nothing to do');
    const alreadyDone  = output.includes('already been processed') || output.includes('already processed');
    const skipped      = noFiles || alreadyDone;

    // Parse downloaded filenames: "  ✅ Downloaded: Livraison XX-XX-XXXX.1.xlsx"
    const fileMatches = [...output.matchAll(/✅ Downloaded: (.+?\.xlsx)/g)].map(m => m[1].trim());
    // Parse per-file email summary: "📊 Summary: X emails sent, Y failed"
    const summaryMatches = [...output.matchAll(/📊 Summary: (\d+) emails sent, (\d+) failed/g)];
    // Parse skipped filenames: "Skipping (already processed): Livraison XX.xlsx → ..."
    const skippedMatches = [...output.matchAll(/Skipping \(already processed\): (.+?\.xlsx)/g)].map(m => m[1].trim());

    summary.files = skipped ? [] : fileMatches.map((name, i) => {
      const sm = summaryMatches[i];
      return { name, emailsSent: sm ? parseInt(sm[1]) : 0, emailsFailed: sm ? parseInt(sm[2]) : 0 };
    });
    summary.mode = mode;

    const totalSent   = summary.files.reduce((s, f) => s + f.emailsSent,   0);
    const totalFailed = summary.files.reduce((s, f) => s + f.emailsFailed, 0);

    const skippedDetail = alreadyDone && skippedMatches.length
      ? `Already processed — skipping to avoid duplicate emails: ${skippedMatches.join(', ')}`
      : alreadyDone
        ? `All ${targetLabel}'s files already processed — skipping to avoid duplicate emails`
        : `No matching file found on server for ${targetLabel}`;

    summary.steps.push({
      name: 'SFTP Download',
      status: skipped ? 'skipped' : 'ok',
      detail: skipped ? skippedDetail : `${fileMatches.length} file(s) downloaded: ${fileMatches.join(', ')}`
    });

    if (!skipped) {
      summary.steps.push({ name: 'Wialon Coordinates', status: 'ok', detail: 'Zones matched successfully' });
      summary.steps.push({ name: 'Route Calculation',  status: 'ok', detail: 'Optimal routes computed' });
      summary.steps.push({ name: 'Excel Update',       status: 'ok', detail: 'Order written to file(s)' });
      summary.steps.push({ name: 'SFTP Upload',        status: 'ok', detail: 'Updated file(s) uploaded to /IN' });
      summary.steps.push({
        name: 'Route Emails',
        status: totalFailed > 0 && totalSent === 0 ? 'error' : 'ok',
        detail: summary.files.map(f => `${f.name}: ${f.emailsSent} sent, ${f.emailsFailed} failed`).join(' | ')
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

// ── Report runner ─────────────────────────────────────────────────────────────
async function runReport() {
  const summary = { steps: [], files: [] };
  console.log('\n📊 Starting report process...');

  try { await sendProcessStartEmail('report'); } catch (e) { console.error('❌ Start email:', e.message); }

  // Step 1 — Wialon report generation
  try {
    execSync('node src/report/wialon-report.js', { stdio: 'inherit', cwd: ROOT, shell: '/bin/sh', env: { ...process.env, PATH: process.env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' } });
    summary.steps.push({ name: 'Wialon Report Generation', status: 'ok', detail: 'Report generated successfully' });
  } catch (err) {
    summary.steps.push({ name: 'Wialon Report Generation', status: 'error', detail: err.message.split('\n')[0] });
  }

  // Step 2 — Collect uploaded rapport files
  try {
    const fiveMinAgo = Date.now() - 5 * 60 * 1000;
    summary.files = fs.readdirSync(path.join(ROOT, 'downloads'))
      .filter(f => f.includes('rapport-effectue') &&
                   fs.statSync(path.join(ROOT, 'downloads', f)).mtimeMs > fiveMinAgo);

    summary.steps.push({
      name: 'SFTP Upload (rapport)',
      status: summary.files.length ? 'ok' : 'skipped',
      detail: summary.files.length ? `${summary.files.length} file(s) uploaded to /OUT` : 'No rapport file found in last 5 min'
    });
  } catch (err) {
    summary.steps.push({ name: 'SFTP Upload (rapport)', status: 'error', detail: err.message });
  }

  try { await sendProcessEndEmail('report', summary); } catch (e) { console.error('❌ End email:', e.message); }
}

// ── Manual / immediate launch (bypass schedule) ───────────────────────────────
if (process.argv.includes('--now')) {
  const isReport   = process.argv.includes('--report');
  const isMorning  = process.argv.includes('--morning');
  const isAfternoon = process.argv.includes('--afternoon');

  if (isReport) {
    console.log('🚀 Manual launch: report now...');
    runReport().then(() => process.exit(0));
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

  // ── MORNING routing — TODAY's files — 06h00→12h00 Madagascar (UTC 03:00→09:00) every 30 min ──
  // Warnings at :45 and :15 (15 min before each :00 and :30 run)
  cron.schedule('45  2 * * *', () => sendWarningEmail('routing', '06h00 🌅 matin').catch(console.error));  // UTC 02:45 → warn before 06h00 Mada
  cron.schedule('15  3 * * *', () => sendWarningEmail('routing', '06h30 🌅 matin').catch(console.error));  // UTC 03:15 → warn before 06h30 Mada
  cron.schedule('45  3 * * *', () => sendWarningEmail('routing', '07h00 🌅 matin').catch(console.error));  // UTC 03:45 → warn before 07h00 Mada
  cron.schedule('15  4 * * *', () => sendWarningEmail('routing', '07h30 🌅 matin').catch(console.error));  // UTC 04:15 → warn before 07h30 Mada
  cron.schedule('45  4 * * *', () => sendWarningEmail('routing', '08h00 🌅 matin').catch(console.error));  // UTC 04:45 → warn before 08h00 Mada
  cron.schedule('15  5 * * *', () => sendWarningEmail('routing', '08h30 🌅 matin').catch(console.error));  // UTC 05:15 → warn before 08h30 Mada
  cron.schedule('45  5 * * *', () => sendWarningEmail('routing', '09h00 🌅 matin').catch(console.error));  // UTC 05:45 → warn before 09h00 Mada
  cron.schedule('15  6 * * *', () => sendWarningEmail('routing', '09h30 🌅 matin').catch(console.error));  // UTC 06:15 → warn before 09h30 Mada
  cron.schedule('45  6 * * *', () => sendWarningEmail('routing', '10h00 🌅 matin').catch(console.error));  // UTC 06:45 → warn before 10h00 Mada
  cron.schedule('15  7 * * *', () => sendWarningEmail('routing', '10h30 🌅 matin').catch(console.error));  // UTC 07:15 → warn before 10h30 Mada
  cron.schedule('45  7 * * *', () => sendWarningEmail('routing', '11h00 🌅 matin').catch(console.error));  // UTC 07:45 → warn before 11h00 Mada
  cron.schedule('15  8 * * *', () => sendWarningEmail('routing', '11h30 🌅 matin').catch(console.error));  // UTC 08:15 → warn before 11h30 Mada
  cron.schedule('45  8 * * *', () => sendWarningEmail('routing', '12h00 🌅 matin').catch(console.error));  // UTC 08:45 → warn before 12h00 Mada

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
  cron.schedule(' 0  9 * * *', runMorningRouting);  // UTC 09:00 → 12h00 Madagascar

  // ── AFTERNOON routing — TOMORROW's files — 13h00→19h00 Madagascar (UTC 10:00→16:00) every 30 min ──
  // Warnings at :45 and :15 (15 min before each :00 and :30 run)
  cron.schedule('45  9 * * *', () => sendWarningEmail('routing', '13h00 🌇 après-midi').catch(console.error)); // UTC 09:45 → warn before 13h00 Mada
  cron.schedule('15 10 * * *', () => sendWarningEmail('routing', '13h30 🌇 après-midi').catch(console.error)); // UTC 10:15 → warn before 13h30 Mada
  cron.schedule('45 10 * * *', () => sendWarningEmail('routing', '14h00 🌇 après-midi').catch(console.error)); // UTC 10:45 → warn before 14h00 Mada
  cron.schedule('15 11 * * *', () => sendWarningEmail('routing', '14h30 🌇 après-midi').catch(console.error)); // UTC 11:15 → warn before 14h30 Mada
  cron.schedule('45 11 * * *', () => sendWarningEmail('routing', '15h00 🌇 après-midi').catch(console.error)); // UTC 11:45 → warn before 15h00 Mada
  cron.schedule('15 12 * * *', () => sendWarningEmail('routing', '15h30 🌇 après-midi').catch(console.error)); // UTC 12:15 → warn before 15h30 Mada
  cron.schedule('45 12 * * *', () => sendWarningEmail('routing', '16h00 🌇 après-midi').catch(console.error)); // UTC 12:45 → warn before 16h00 Mada
  cron.schedule('15 13 * * *', () => sendWarningEmail('routing', '16h30 🌇 après-midi').catch(console.error)); // UTC 13:15 → warn before 16h30 Mada
  cron.schedule('45 13 * * *', () => sendWarningEmail('routing', '17h00 🌇 après-midi').catch(console.error)); // UTC 13:45 → warn before 17h00 Mada
  cron.schedule('15 14 * * *', () => sendWarningEmail('routing', '17h30 🌇 après-midi').catch(console.error)); // UTC 14:15 → warn before 17h30 Mada
  cron.schedule('45 14 * * *', () => sendWarningEmail('routing', '18h00 🌇 après-midi').catch(console.error)); // UTC 14:45 → warn before 18h00 Mada
  cron.schedule('15 15 * * *', () => sendWarningEmail('routing', '18h30 🌇 après-midi').catch(console.error)); // UTC 15:15 → warn before 18h30 Mada
  cron.schedule('45 15 * * *', () => sendWarningEmail('routing', '19h00 🌇 après-midi').catch(console.error)); // UTC 15:45 → warn before 19h00 Mada

  cron.schedule(' 0 10 * * *', runAfternoonRouting); // UTC 10:00 → 13h00 Madagascar
  cron.schedule('30 10 * * *', runAfternoonRouting); // UTC 10:30 → 13h30 Madagascar
  cron.schedule(' 0 11 * * *', runAfternoonRouting); // UTC 11:00 → 14h00 Madagascar
  cron.schedule('30 11 * * *', runAfternoonRouting); // UTC 11:30 → 14h30 Madagascar
  cron.schedule(' 0 12 * * *', runAfternoonRouting); // UTC 12:00 → 15h00 Madagascar
  cron.schedule('30 12 * * *', runAfternoonRouting); // UTC 12:30 → 15h30 Madagascar
  cron.schedule(' 0 13 * * *', runAfternoonRouting); // UTC 13:00 → 16h00 Madagascar
  cron.schedule('30 13 * * *', runAfternoonRouting); // UTC 13:30 → 16h30 Madagascar
  cron.schedule(' 0 14 * * *', runAfternoonRouting); // UTC 14:00 → 17h00 Madagascar
  cron.schedule('30 14 * * *', runAfternoonRouting); // UTC 14:30 → 17h30 Madagascar
  cron.schedule(' 0 15 * * *', runAfternoonRouting); // UTC 15:00 → 18h00 Madagascar
  cron.schedule('30 15 * * *', runAfternoonRouting); // UTC 15:30 → 18h30 Madagascar
  cron.schedule(' 0 16 * * *', runAfternoonRouting); // UTC 16:00 → 19h00 Madagascar

  // ── Report — 00h00 Madagascar = UTC 21:00 ────────────────────────────────────
  cron.schedule('45 20 * * *', () => sendWarningEmail('report', '00h00').catch(console.error)); // UTC 20:45 → warn 23h45 Mada
  cron.schedule(' 0 21 * * *', runReport);

  console.log('⏰ Scheduler started (UTC times):');
  console.log('');
  console.log('  🌅 MORNING ROUTING  — TODAY\'s files — every 30 min');
  console.log('  ├─ ⚠️  Warnings  → 15 min before each run (:45 and :15)');
  console.log('  │                   UTC 02:45 → 08:45  (Mada 05h45 → 11h45)');
  console.log('  └─ 🔄 Runs      → UTC 03:00, 03:30, 04:00 … 08:30, 09:00');
  console.log('                     Mada 06h00, 06h30, 07h00 … 11h30, 12h00');
  console.log('');
  console.log('  🌇 AFTERNOON ROUTING  — TOMORROW\'s files — every 30 min');
  console.log('  ├─ ⚠️  Warnings  → 15 min before each run (:45 and :15)');
  console.log('  │                   UTC 09:45 → 15:45  (Mada 12h45 → 18h45)');
  console.log('  └─ 🔄 Runs      → UTC 10:00, 10:30, 11:00 … 15:30, 16:00');
  console.log('                     Mada 13h00, 13h30, 14h00 … 18h30, 19h00');
  console.log('');
  console.log('  REPORT   (Madagascar UTC+3)');
  console.log('  ├─ ⚠️  Warning   → 20:45 UTC  (23h45 Madagascar)');
  console.log('  └─ 📊 Run       → 21:00 UTC  (00h00 Madagascar)');
  console.log('');
  console.log('💡 Manual launch (no schedule):');
  console.log('   node src/report/schedule-report.js --now                → morning routing (today\'s files)');
  console.log('   node src/report/schedule-report.js --now --morning      → morning routing (today\'s files)');
  console.log('   node src/report/schedule-report.js --now --afternoon    → afternoon routing (tomorrow\'s files)');
  console.log('   node src/report/schedule-report.js --now --report       → report');
  console.log('');
}
