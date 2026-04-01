require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const cron = require('node-cron');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const { sendWarningEmail, sendProcessStartEmail, sendProcessEndEmail } = require('./notify');

const ROOT = path.join(__dirname, '../..');

// ── Timezone mapping ──────────────────────────────────────────────────────────
// Cameroon UTC+1  |  Madagascar UTC+3
//
// Routing  : 13h / 14h / 15h Cameroon  →  15h / 16h / 17h Madagascar  →  UTC 12 / 13 / 14
// Warning  : 12h30/ 13h30/ 14h30 Cam   →  14h30/15h30/16h30 Mada      →  UTC 11:30/12:30/13:30
//
// Report   : 22h Cameroon              →  00h Madagascar               →  UTC 21
// Warning  : 21h30 Cameroon            →  23h30 Madagascar             →  UTC 20:30
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
    output = execSync('node run-all.js --no-report', { cwd: ROOT, encoding: 'utf8' });
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
    execSync('node src/report/wialon-report.js', { stdio: 'inherit', cwd: ROOT });
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

  // Routing warnings (30 min before each run)
  cron.schedule('30 11 * * *', () => sendWarningEmail('routing', '13h00').catch(console.error)); // before 13h Cam
  cron.schedule('30 12 * * *', () => sendWarningEmail('routing', '14h00').catch(console.error)); // before 14h Cam
  cron.schedule('30 13 * * *', () => sendWarningEmail('routing', '15h00').catch(console.error)); // before 15h Cam

  // Routing runs
  cron.schedule('0 12 * * *', runRouting); // 13h Cameroon / 15h Madagascar
  cron.schedule('0 13 * * *', runRouting); // 14h Cameroon / 16h Madagascar
  cron.schedule('0 14 * * *', runRouting); // 15h Cameroon / 17h Madagascar

  // Report warning (30 min before)
  cron.schedule('30 20 * * *', () => sendWarningEmail('report', '22h00').catch(console.error)); // 21h30 UTC = 22h30 Cam

  // Report run
  cron.schedule('0 21 * * *', runReport); // 22h Cameroon / 23h Madagascar

  console.log('⏰ Scheduler started (UTC times):');
  console.log('');
  console.log('  ROUTING');
  console.log('  ├─ ⚠️  Warnings  → 11:30 / 12:30 / 13:30 UTC  (12h30 / 13h30 / 14h30 Cameroon)');
  console.log('  └─ 🔄 Runs      → 12:00 / 13:00 / 14:00 UTC  (13h00 / 14h00 / 15h00 Cameroon)');
  console.log('');
  console.log('  REPORT');
  console.log('  ├─ ⚠️  Warning   → 20:30 UTC  (21h30 Cameroon  |  23h30 Madagascar)');
  console.log('  └─ 📊 Run       → 21:00 UTC  (22h00 Cameroon  |  00h00 Madagascar)');
  console.log('');
  console.log('💡 Manual launch (no schedule):');
  console.log('   node src/report/schedule-report.js --now           → routing');
  console.log('   node src/report/schedule-report.js --now --report  → report');
  console.log('');
}
