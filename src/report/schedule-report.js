require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const cron = require('node-cron');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const { sendWarningEmail, sendProcessStartEmail, sendProcessEndEmail } = require('./notify');

const ROOT = path.join(__dirname, '../..');

// ── Timezone mapping ──────────────────────────────────────────────────────────
// Madagascar UTC+3
//
// Routing  : 13h → 19h Madagascar (every hour)  →  UTC 10:00 → 16:00
// Warning  : 30 min before each run              →  UTC 09:30 → 15:30
//
// Report   : 22h Madagascar                      →  UTC 19:00
// Warning  : 21h30 Madagascar                    →  UTC 18:30
// ─────────────────────────────────────────────────────────────────────────────

// ── Routing runner ────────────────────────────────────────────────────────────
async function runRouting() {
  const summary = { steps: [], files: [] };

  const track = (name, fn) => async () => {
    try {
      const result = await fn();
      summary.steps.push({ name, status: 'ok', detail: result || '' });
    } catch (err) {
      summary.steps.push({ name, status: 'error', detail: err.message });
      throw err; // re-throw so the caller knows this step failed
    }
  };

  console.log('\n🔄 Starting routing process...');

  try { await sendProcessStartEmail('routing'); } catch (e) { console.error('❌ Start email:', e.message); }

  // Step 1 — Download + process files via run-all.js --no-report
  let output = '';
  try {
    output = execSync('node run-all.js --no-report', { cwd: ROOT, encoding: 'utf8', shell: '/bin/sh', env: { ...process.env, PATH: process.env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' } });
    console.log(output);

    // Collect files that were processed (updated-with-order)
    const fiveMinAgo = Date.now() - 5 * 60 * 1000;
    summary.files = fs.readdirSync(path.join(ROOT, 'downloads'))
      .filter(f => f.includes('_updated-with-order') &&
                   fs.statSync(path.join(ROOT, 'downloads', f)).mtimeMs > fiveMinAgo);

    const noFiles = output.includes('No Livraison') || output.includes('nothing to do');

    summary.steps.push({
      name: 'SFTP Download',
      status: noFiles ? 'skipped' : 'ok',
      detail: noFiles ? 'No matching file found on server for tomorrow' : `${summary.files.length} file(s) downloaded`
    });

    if (!noFiles) {
      summary.steps.push({ name: 'Wialon Coordinates', status: 'ok', detail: 'Zones matched successfully' });
      summary.steps.push({ name: 'Route Calculation',  status: 'ok', detail: 'Optimal routes computed' });
      summary.steps.push({ name: 'Excel Update',       status: 'ok', detail: 'Order written to file(s)' });
      summary.steps.push({ name: 'SFTP Upload',        status: 'ok', detail: 'Updated file(s) uploaded to /IN' });
      summary.steps.push({ name: 'Route Emails',       status: 'ok', detail: 'Emails sent to transporters' });
    }

  } catch (err) {
    // Parse which step failed from the error output
    const msg = err.message || '';
    const failedStep =
      msg.includes('Wialon')   ? 'Wialon Coordinates' :
      msg.includes('route')    ? 'Route Calculation'  :
      msg.includes('Excel')    ? 'Excel Update'       :
      msg.includes('upload')   ? 'SFTP Upload'        :
      msg.includes('email')    ? 'Route Emails'       : 'SFTP Download';

    summary.steps.push({ name: failedStep, status: 'error', detail: msg.split('\n')[0] });
    console.error('❌ Routing process failed:', msg);
  }

  try { await sendProcessEndEmail('routing', summary); } catch (e) { console.error('❌ End email:', e.message); }
}

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
  const target = process.argv.includes('--report') ? 'report' : 'routing';
  console.log(`🚀 Manual launch: running ${target} now (no schedule)...`);
  (target === 'report' ? runReport() : runRouting()).then(() => process.exit(0));

} else {
  // ── Scheduled launch ─────────────────────────────────────────────────────────

  // Routing warnings (30 min before each run) — Madagascar UTC+3
  cron.schedule('30  9 * * *', () => sendWarningEmail('routing', '13h00').catch(console.error)); // before 13h Mada
  cron.schedule('30 10 * * *', () => sendWarningEmail('routing', '14h00').catch(console.error)); // before 14h Mada
  cron.schedule('30 11 * * *', () => sendWarningEmail('routing', '15h00').catch(console.error)); // before 15h Mada
  cron.schedule('30 12 * * *', () => sendWarningEmail('routing', '16h00').catch(console.error)); // before 16h Mada
  cron.schedule('30 13 * * *', () => sendWarningEmail('routing', '17h00').catch(console.error)); // before 17h Mada
  cron.schedule('30 14 * * *', () => sendWarningEmail('routing', '18h00').catch(console.error)); // before 18h Mada
  cron.schedule('30 15 * * *', () => sendWarningEmail('routing', '19h00').catch(console.error)); // before 19h Mada

  // Routing runs — every hour from 13h to 19h Madagascar (UTC 10:00 → 16:00)
  cron.schedule('0 10 * * *', runRouting); // 13h Madagascar
  cron.schedule('0 11 * * *', runRouting); // 14h Madagascar
  cron.schedule('0 12 * * *', runRouting); // 15h Madagascar
  cron.schedule('0 13 * * *', runRouting); // 16h Madagascar
  cron.schedule('0 14 * * *', runRouting); // 17h Madagascar
  cron.schedule('0 15 * * *', runRouting); // 18h Madagascar
  cron.schedule('0 16 * * *', runRouting); // 19h Madagascar

  // Report warning (30 min before)
  cron.schedule('30 18 * * *', () => sendWarningEmail('report', '22h00').catch(console.error)); // 21h30 Madagascar

  // Report run
  cron.schedule('0 19 * * *', runReport); // 22h Madagascar

  console.log('⏰ Scheduler started (UTC times):');
  console.log('');
  console.log('  ROUTING  (Madagascar UTC+3)');
  console.log('  ├─ ⚠️  Warnings  → 09:30 / 10:30 / 11:30 / 12:30 / 13:30 / 14:30 / 15:30 UTC');
  console.log('  │                   (13h30 / 14h30 / 15h30 / 16h30 / 17h30 / 18h30 / 19h30 Mada)');
  console.log('  └─ 🔄 Runs      → 10:00 / 11:00 / 12:00 / 13:00 / 14:00 / 15:00 / 16:00 UTC');
  console.log('                     (13h00 / 14h00 / 15h00 / 16h00 / 17h00 / 18h00 / 19h00 Mada)');
  console.log('');
  console.log('  REPORT   (Madagascar UTC+3)');
  console.log('  ├─ ⚠️  Warning   → 18:30 UTC  (21h30 Madagascar)');
  console.log('  └─ 📊 Run       → 19:00 UTC  (22h00 Madagascar)');
  console.log('');
  console.log('💡 Manual launch (no schedule):');
  console.log('   node src/report/schedule-report.js --now           → routing');
  console.log('   node src/report/schedule-report.js --now --report  → report');
  console.log('');
}
