const express = require('express');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const { handleWialonNotification } = require('./src/notifications/wialon-notify-handler');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const WIALON_LOG = path.join(__dirname, 'logs', 'wialon-notifications.txt');

app.post('/wialon-notify', async (req, res) => {
  const raw = req.body;
  const logLine = `[${new Date().toLocaleString()}] ${JSON.stringify(raw)}\n`;
  fs.appendFileSync(WIALON_LOG, logLine, 'utf8');
  console.log('\n📩 Received:', JSON.stringify(raw));
  res.status(200).send('OK');
  try {
    const result = await handleWialonNotification(raw);
    if (result.skipped) {
      console.log(`⏭  Skipped: ${result.reason}`);
    } else {
      console.log(`✅ Email sent [${result.type}] → ${result.to?.join(', ')} (${result.vehicle})`);
    }
  } catch (e) {
    console.error('❌ Handler error:', e.message);
  }
});

const PORT = 5458;
app.listen(PORT, () => {
  console.log(`🔧 Notification test server running on http://localhost:${PORT}`);
  console.log(`   POST /wialon-notify`);
  console.log(`   Run tests with: bash test-wialon-notify.sh\n`);
});
