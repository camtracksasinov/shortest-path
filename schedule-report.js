const cron = require('node-cron');
const { execSync } = require('child_process');
const { sendCheckupEmail, sendStartEmail, sendConfirmationEmail } = require('./notify');

console.log('⏰ Report scheduler started — checkup at 22:45, report at 23:00...');

// 22:45 — checkup email
cron.schedule('45 22 * * *', async () => {
  console.log(`\n🔍 [${new Date().toLocaleString()}] Sending checkup email...`);
  try {
    await sendCheckupEmail();
  } catch (err) {
    console.error('❌ Checkup email failed:', err.message);
  }
});

// 23:00 — run report
cron.schedule('00 23 * * *', async () => {
  console.log(`\n🚀 [${new Date().toLocaleString()}] Running scheduled Wialon report...`);

  try {
    await sendStartEmail();
  } catch (err) {
    console.error('❌ Start email failed:', err.message);
  }

  try {
    execSync('node wialon-report.js', { stdio: 'inherit', cwd: __dirname });

    // Collect uploaded file names from downloads folder (rapport-effectue files modified in last 5 min)
    const fs = require('fs');
    const path = require('path');
    const fiveMinAgo = Date.now() - 5 * 60 * 1000;
    const uploaded = fs.readdirSync(path.join(__dirname, 'downloads'))
      .filter(f => f.includes('rapport-effectue') && fs.statSync(path.join(__dirname, 'downloads', f)).mtimeMs > fiveMinAgo);

    await sendConfirmationEmail(uploaded.length ? uploaded : ['(see /OUT folder on SFTP)']);
    console.log('✅ Scheduled report completed.');
  } catch (err) {
    console.error('❌ Scheduled report failed:', err.message);
  }
});
