const cron = require('node-cron');
const { execSync } = require('child_process');

console.log('⏰ Report scheduler started — will run daily at 22:07...');

cron.schedule('07 22 * * *', () => {
  console.log(`\n🚀 [${new Date().toLocaleString()}] Running scheduled Wialon report...`);
  try {
    execSync('node wialon-report.js', { stdio: 'inherit', cwd: __dirname });
    console.log('✅ Scheduled report completed.');
  } catch (err) {
    console.error('❌ Scheduled report failed:', err.message);
  }
});
