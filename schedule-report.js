const cron = require('node-cron');
const { execSync } = require('child_process');

console.log('⏰ Report scheduler started — will run daily at 20:47...');

cron.schedule('18 21 * * *', () => {
  console.log(`\n🚀 [${new Date().toLocaleString()}] Running scheduled Wialon report...`);
  try {
    execSync('node wialon-report.js', { stdio: 'inherit', cwd: __dirname });
    console.log('✅ Scheduled report completed.');
  } catch (err) {
    console.error('❌ Scheduled report failed:', err.message);
  }
});
