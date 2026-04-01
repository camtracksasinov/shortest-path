const fs = require('fs');
require('dotenv').config();

// ── Galana server (ftp.galana.mg) — private key authentication ──────────────
// privateKey is read lazily (getter) so a missing key path does not crash on require()
const configA = {
  host: process.env.SOURCE_HOST,
  port: 22,
  username: process.env.SOURCE_USER,
  get privateKey() { return fs.readFileSync(process.env.SFTP_PRIVATE_KEY_PATH); },
  readyTimeout: 20000
};

// ── Camtrack server (bi.camtrack.mg) — password authentication ───────────────
// const configA = {
//   host: process.env.SFTP_HOST,       // bi.camtrack.mg
//   port: process.env.SFTP_PORT || 22,
//   username: process.env.SFTP_USERNAME, // usertestgalana
//   password: process.env.SFTP_PASSWORD
// };

const configB = {
  host: process.env.DEST_HOST,
  port: 22,
  username: process.env.DEST_USER,
  password: process.env.DEST_PASSWORD
};

const remotePath = process.env.SOURCE_DIR || '/IN';

module.exports = { configA, configB, remotePath };
