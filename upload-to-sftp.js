const SftpClient = require('ssh2-sftp-client');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const sftpConfig = {
  host: process.env.SFTP_HOST || 'your-server-host.com',
  port: process.env.SFTP_PORT || 22,
  username: process.env.SFTP_USERNAME || 'your-username',
  password: process.env.SFTP_PASSWORD || 'your-password',
};

const remotePath = process.env.SFTP_REMOTE_PATH || '/IN';

async function uploadUpdatedFile() {
  const sftp = new SftpClient();
  
  try {
    // Find the updated file
    const downloadDir = './downloads';
    const files = fs.readdirSync(downloadDir)
      .filter(f => f.startsWith('Livraison') && f.match(/\.\d+_updated-with-order\.xlsx$/))
      .map(f => ({
        name: f,
        path: path.join(downloadDir, f),
        time: fs.statSync(path.join(downloadDir, f)).mtime.getTime()
      }))
      .sort((a, b) => b.time - a.time);
    
    if (files.length === 0) {
      console.log('❌ No updated file found to upload.');
      return;
    }
    
    await sftp.connect(sftpConfig);
    console.log('✅ Connected to SFTP server\n');

    for (const fileToUpload of files) {
      console.log(`📤 Uploading: ${fileToUpload.name}...`);
      const remoteFilePath = `${remotePath}/${fileToUpload.name}`;
      await sftp.put(fileToUpload.path, remoteFilePath);
      console.log(`✅ Uploaded to: ${remoteFilePath}`);
    }
    
    await sftp.end();
    console.log('🔌 SFTP connection closed.\n');
    
  } catch (error) {
    console.error('❌ Error:', error.message);
  } finally {
    await sftp.end();
  }
}

if (require.main === module) {
  uploadUpdatedFile();
}

module.exports = { uploadUpdatedFile };
