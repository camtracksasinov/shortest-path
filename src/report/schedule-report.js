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
//   06h → 12h Madagascar  →  UTC 03:00 → 09:00
//   Warnings 30 min before  →  UTC 02:30 → 08:30
//
// AFTERNOON Routing — processes TOMORROW's files (next day)
//   13h → 19h Madagascar  →  UTC 10:00 → 16:00
//   Warnings 30 min before  →  UTC 09:30 → 15:30
//
// Report   : 00h00 Madagascar  →  UTC 21:00
// Warning  : 23h30 Madagascar  →  UTC 20:30
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
  try { await sendProcessStartEmail('routing'); } catch (e) { console.error('❌ Start email:', e.message); }

  let output = '';
  try {
    output = execSync(cmd, { cwd: ROOT, encoding: 'utf8', shell: '/bin/sh', env: { ...process.env, PATH: process.env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' } });
    console.log(output);

    const fiveMinAgo = Date.now() - 5 * 60 * 1000;
    summary.files = fs.readdirSync(path.join(ROOT, 'downloads'))
      .filter(f => f.includes('_updated-with-order') &&
                   fs.statSync(path.join(ROOT, 'downloads', f)).mtimeMs > fiveMinAgo);

    const noFiles = output.includes('No Livraison') || output.includes('nothing to do');
    summary.steps.push({
      name: 'SFTP Download',
      status: noFiles ? 'skipped' : 'ok',
      detail: noFiles ? `No matching file found on server for ${targetLabel}` : `${summary.files.length} file(s) downloaded`
    });

    if (!noFiles) {
      summary.steps.push({ name: 'Wialon Coordinates', status: 'ok', detail: 'Zones matched successfully' });
      summary.steps.push({ name: 'Route Calculation',  status: 'ok', detail: 'Optimal routes computed' });
      summary.steps.push({ name: 'Excel Update',       status: 'ok', detail: 'Order written to file(s)' });
      summary.steps.push({ name: 'SFTP Upload',        status: 'ok', detail: 'Updated file(s) uploaded to /IN' });
      summary.steps.push({ name: 'Route Emails',       status: 'ok', detail: 'Emails sent to transporters' });
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

  // ── MORNING routing — TODAY's files — 06h→12h Madagascar (UTC 03:00→09:00) ──
  cron.schedule('30  2 * * *', () => sendWarningEmail('routing', '06h00 🌅 matin').catch(console.error));  // UTC 02:30 → warn 06h Mada
  cron.schedule('30  3 * * *', () => sendWarningEmail('routing', '07h00 🌅 matin').catch(console.error));  // UTC 03:30 → warn 07h Mada
  cron.schedule('30  4 * * *', () => sendWarningEmail('routing', '08h00 🌅 matin').catch(console.error));  // UTC 04:30 → warn 08h Mada
  cron.schedule('30  5 * * *', () => sendWarningEmail('routing', '09h00 🌅 matin').catch(console.error));  // UTC 05:30 → warn 09h Mada
  cron.schedule('30  6 * * *', () => sendWarningEmail('routing', '10h00 🌅 matin').catch(console.error));  // UTC 06:30 → warn 10h Mada
  cron.schedule('30  7 * * *', () => sendWarningEmail('routing', '11h00 🌅 matin').catch(console.error));  // UTC 07:30 → warn 11h Mada
  cron.schedule('30  8 * * *', () => sendWarningEmail('routing', '12h00 🌅 matin').catch(console.error));  // UTC 08:30 → warn 12h Mada

  cron.schedule('0  3 * * *', runMorningRouting);  // UTC 03:00 → 06h Madagascar
  cron.schedule('0  4 * * *', runMorningRouting);  // UTC 04:00 → 07h Madagascar
  cron.schedule('0  5 * * *', runMorningRouting);  // UTC 05:00 → 08h Madagascar
  cron.schedule('0  6 * * *', runMorningRouting);  // UTC 06:00 → 09h Madagascar
  cron.schedule('0  7 * * *', runMorningRouting);  // UTC 07:00 → 10h Madagascar
  cron.schedule('0  8 * * *', runMorningRouting);  // UTC 08:00 → 11h Madagascar
  cron.schedule('0  9 * * *', runMorningRouting);  // UTC 09:00 → 12h Madagascar

  // ── AFTERNOON routing — TOMORROW's files — 13h→19h Madagascar (UTC 10:00→16:00) ──
  cron.schedule('30  9 * * *', () => sendWarningEmail('routing', '13h00 🌇 après-midi').catch(console.error)); // UTC 09:30 → warn 13h Mada
  cron.schedule('30 10 * * *', () => sendWarningEmail('routing', '14h00 🌇 après-midi').catch(console.error)); // UTC 10:30 → warn 14h Mada
  cron.schedule('30 11 * * *', () => sendWarningEmail('routing', '15h00 🌇 après-midi').catch(console.error)); // UTC 11:30 → warn 15h Mada
  cron.schedule('30 12 * * *', () => sendWarningEmail('routing', '16h00 🌇 après-midi').catch(console.error)); // UTC 12:30 → warn 16h Mada
  cron.schedule('30 13 * * *', () => sendWarningEmail('routing', '17h00 🌇 après-midi').catch(console.error)); // UTC 13:30 → warn 17h Mada
  cron.schedule('30 14 * * *', () => sendWarningEmail('routing', '18h00 🌇 après-midi').catch(console.error)); // UTC 14:30 → warn 18h Mada
  cron.schedule('30 15 * * *', () => sendWarningEmail('routing', '19h00 🌇 après-midi').catch(console.error)); // UTC 15:30 → warn 19h Mada

  cron.schedule('0 10 * * *', runAfternoonRouting); // UTC 10:00 → 13h Madagascar
  cron.schedule('0 11 * * *', runAfternoonRouting); // UTC 11:00 → 14h Madagascar
  cron.schedule('0 12 * * *', runAfternoonRouting); // UTC 12:00 → 15h Madagascar
  cron.schedule('0 13 * * *', runAfternoonRouting); // UTC 13:00 → 16h Madagascar
  cron.schedule('0 14 * * *', runAfternoonRouting); // UTC 14:00 → 17h Madagascar
  cron.schedule('0 15 * * *', runAfternoonRouting); // UTC 15:00 → 18h Madagascar
  cron.schedule('0 16 * * *', runAfternoonRouting); // UTC 16:00 → 19h Madagascar

  // ── Report — 00h00 Madagascar = UTC 21:00 ────────────────────────────────────
  cron.schedule('30 20 * * *', () => sendWarningEmail('report', '00h00').catch(console.error));
  cron.schedule('0 21 * * *', runReport);

  console.log('⏰ Scheduler started (UTC times):');
  console.log('');
  console.log('  🌅 MORNING ROUTING  — TODAY\'s files (--today flag)');
  console.log('  ├─ ⚠️  Warnings  → 02:30 / 03:30 / 04:30 / 05:30 / 06:30 / 07:30 / 08:30 UTC');
  console.log('  │                   (05h30→11h30 Madagascar)');
  console.log('  └─ 🔄 Runs      → 03:00 / 04:00 / 05:00 / 06:00 / 07:00 / 08:00 / 09:00 UTC');
  console.log('                     (06h00 → 12h00 Madagascar)');
  console.log('');
  console.log('  🌇 AFTERNOON ROUTING  — TOMORROW\'s files');
  console.log('  ├─ ⚠️  Warnings  → 09:30 / 10:30 / 11:30 / 12:30 / 13:30 / 14:30 / 15:30 UTC');
  console.log('  │                   (12h30 → 18h30 Madagascar)');
  console.log('  └─ 🔄 Runs      → 10:00 / 11:00 / 12:00 / 13:00 / 14:00 / 15:00 / 16:00 UTC');
  console.log('                     (13h00 → 19h00 Madagascar)');
  console.log('');
  console.log('  REPORT   (Madagascar UTC+3)');
  console.log('  ├─ ⚠️  Warning   → 20:30 UTC  (23h30 Madagascar)');
  console.log('  └─ 📊 Run       → 21:00 UTC  (00h00 Madagascar)');
  console.log('');
  console.log('💡 Manual launch (no schedule):');
  console.log('   node src/report/schedule-report.js --now                → morning routing (today\'s files)');
  console.log('   node src/report/schedule-report.js --now --morning      → morning routing (today\'s files)');
  console.log('   node src/report/schedule-report.js --now --afternoon    → afternoon routing (tomorrow\'s files)');
  console.log('   node src/report/schedule-report.js --now --report       → report');
  console.log('');
}
