const SftpClient = require('ssh2-sftp-client');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const { configA: sftpConfig } = require('./sftp-config');

function getMonthFolderName() {
  const MONTHS_FR = ['JANVIER','FEVRIER','MARS','AVRIL','MAI','JUIN',
                     'JUILLET','AOUT','SEPTEMBRE','OCTOBRE','NOVEMBRE','DECEMBRE'];
  const now = new Date();
  return `${MONTHS_FR[now.getMonth()]}${now.getFullYear()}`;
}

async function uploadUpdatedFile() {
  const sftp = new SftpClient();

  try {
    const downloadDir = path.join(__dirname, '../../downloads');
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

    const monthFolder = getMonthFolderName();
    const monthPath = `/IN/${monthFolder}`;
    await sftp.mkdir(monthPath, true).catch(() => {});

    for (const fileToUpload of files) {
      console.log(`📤 Uploading: ${fileToUpload.name}...`);
      const remoteFilePath = `${monthPath}/${fileToUpload.name}`;
      await sftp.put(fileToUpload.path, remoteFilePath);
      console.log(`✅ Uploaded to: ${remoteFilePath}`);
    }

    await sftp.end();
    console.log('🔌 SFTP connection closed.\n');

  } catch (error) {
    console.error('❌ Error:', error.message);
  } finally {
    await sftp.end().catch(() => {});
  }
}

if (require.main === module) {
  uploadUpdatedFile();
}

module.exports = { uploadUpdatedFile };
