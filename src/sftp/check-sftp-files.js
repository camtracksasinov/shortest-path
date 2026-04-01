const SftpClient = require('ssh2-sftp-client');
require('dotenv').config();

const { configA: sftpConfig } = require('./sftp-config');

// ── Camtrack server config (COMMENTED OUT — now using Galana via sftp-config.js)
// const sftpConfig = {
//   host: process.env.SFTP_HOST,       // bi.camtrack.mg
//   port: process.env.SFTP_PORT || 22,
//   username: process.env.SFTP_USERNAME, // usertestgalana
//   password: process.env.SFTP_PASSWORD
// };

async function listFiles() {
  const sftp = new SftpClient();
  try {
    await sftp.connect(sftpConfig);
    console.log('📂 Files in /IN folder:');
    const list = await sftp.list('/IN');
    list.forEach(file => {
      console.log(`  - ${file.name}`);
    });
  } catch (error) {
    console.error('Error:', error.message);
  } finally {
    await sftp.end();
  }
}

listFiles();
