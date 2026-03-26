const SftpClient = require('ssh2-sftp-client');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const { matchCoordinates } = require('./src/routing/wialon-zones');
const { calculateOptimalRoute } = require('./src/routing/calculate-routes');
const { updateExcelWithRouteOrder } = require('./src/routing/update-excel-order');
const { processExcelAndSendEmails } = require('./src/emails/send-route-emails');

const sftpConfig = {
  host: process.env.SFTP_HOST,
  port: process.env.SFTP_PORT || 22,
  username: process.env.SFTP_USERNAME,
  password: process.env.SFTP_PASSWORD
};

async function downloadAllFiles() {
  const sftp = new SftpClient();
  await sftp.connect(sftpConfig);
  const list = await sftp.list('/IN');

  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);
  const fmt = d => d.toISOString().split('T')[0];

  const parseDateFromName = name => {
    const match = name.match(/(\d{2})-(\d{2})-(\d{4})/);
    if (!match) return null;
    return `${match[3]}-${match[2]}-${match[1]}`; // YYYY-MM-DD
  };

  const targets = list.filter(f => {
    if (!f.name.startsWith('Livraison') || !f.name.match(/\.\d+\.xlsx$/)) return false;
    const d = parseDateFromName(f.name);
    return d === fmt(tomorrow);
  });

  if (targets.length === 0) {
    console.log(`\nℹ️  No Livraison*.N.xlsx file for tomorrow (${fmt(tomorrow)}) found in /IN — nothing to do.`);
    await sftp.end();
    return [];
  }
  console.log(`\n📊 Found ${targets.length} file(s) for tomorrow (${fmt(tomorrow)}):`);  const downloaded = [];
  for (const file of targets) {
    const localPath = path.join(__dirname, 'downloads', file.name);
    await sftp.get(`/IN/${file.name}`, localPath);
    console.log(`  ✅ Downloaded: ${file.name}`);
    downloaded.push(localPath);
  }
  await sftp.end();
  return downloaded;
}

async function uploadUpdatedFile(localPath) {
  const sftp = new SftpClient();
  await sftp.connect(sftpConfig);
  const remotePath = `/IN/${path.basename(localPath)}`;
  await sftp.put(localPath, remotePath);
  console.log(`  ✅ Uploaded: ${path.basename(localPath)} → /IN`);
  await sftp.end();
}

async function parseExcelForCoordinates(filePath) {
  const XLSX = require('xlsx');
  const workbook = XLSX.readFile(filePath);
  const data = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { header: 1 });
  const headers = data[0];
  const coordIdx = headers.findIndex(h => h && h.toString().toLowerCase().includes('coordonnees zone'));
  const transporteurIdx = headers.findIndex(h => h && h.toString().toLowerCase().includes('transporteur'));
  const camionIdx = headers.findIndex(h => h && (h.toString().toLowerCase().includes('camion') || h.toString().toLowerCase().includes('vehicule')));
  const goIdx = headers.findIndex(h => h === 'GO');
  const scIdx = headers.findIndex(h => h === 'SC');
  const plIdx = headers.findIndex(h => h === 'PL');
  const foIdx = headers.findIndex(h => h === 'FO');
  const prioriteIdx = headers.findIndex(h => h && h.toString().toLowerCase().includes('priorite'));

  const rowsToInclude = new Set();
  for (let i = 1; i < data.length; i++) {
    if (data[i][goIdx] || data[i][scIdx] || data[i][plIdx] || data[i][foIdx]) {
      rowsToInclude.add(i);
      if (i > 1) rowsToInclude.add(i - 1);
    }
  }

  const transporteurMap = {};
  for (let i = 1; i < data.length; i++) {
    if (!rowsToInclude.has(i)) continue;
    const transporteur = data[i][transporteurIdx];
    const camion = camionIdx !== -1 ? data[i][camionIdx] : 'N/A';
    const coord = data[i][coordIdx];
    const priorite = prioriteIdx !== -1 ? data[i][prioriteIdx] : '';
    const hasProduct = !!(data[i][goIdx] || data[i][scIdx] || data[i][plIdx] || data[i][foIdx]);
    if (transporteur && coord) {
      if (!transporteurMap[transporteur]) transporteurMap[transporteur] = {};
      if (!transporteurMap[transporteur][camion]) transporteurMap[transporteur][camion] = [];
      transporteurMap[transporteur][camion].push({ coord, priorite, hasProduct });
    }
  }
  return transporteurMap;
}

async function generateReportForFile(updatedFilePath) {
  const { execSync } = require('child_process');
  execSync(`node src/report/wialon-report.js --file "${updatedFilePath}"`, { stdio: 'inherit' });
}

async function processFile(filePath) {
  const fileName = path.basename(filePath);
  console.log(`\n${'='.repeat(80)}`);
  console.log(`📄 PROCESSING FILE: ${fileName}`);
  console.log('='.repeat(80));

  console.log('\n📍 Step 2: Fetching coordinates from Wialon...');
  const coordData = await parseExcelForCoordinates(filePath);
  const zonesData = await matchCoordinates(coordData);

  console.log('\n🗺️  Step 3: Calculating optimal routes...');
  const optimalRoutes = await calculateOptimalRoute(zonesData);

  console.log('\n📝 Step 4: Updating Excel with optimal order...');
  // Save per-file optimal routes so update-excel-order uses the right data
  const routesPath = path.join(__dirname, 'downloads', `optimal-routes-${path.basename(filePath, '.xlsx')}.json`);
  fs.writeFileSync(routesPath, JSON.stringify(optimalRoutes, null, 2));
  const updatedPath = await updateExcelWithRouteOrder(filePath, routesPath);

  console.log('\n📤 Step 5: Uploading updated file to SFTP...');
  await uploadUpdatedFile(updatedPath);

  console.log('\n📧 Step 5b: Sending route emails to transporters...');
  await processExcelAndSendEmails(updatedPath);

  const { execSync } = require('child_process');
  execSync(`node src/report/wialon-report.js --file "${updatedPath}"`, { stdio: 'inherit' });
}

async function main() {
  console.log('🚀 Starting complete routing process...\n');
  try {
    console.log('📥 Step 1: Downloading all files from SFTP...');
    const files = await downloadAllFiles();
    if (files.length === 0) return;

    for (const file of files) {
      await processFile(file);
    }

    console.log(`\n${'='.repeat(80)}`);
    console.log('✅ All files processed successfully!');
    console.log('='.repeat(80));
  } catch (error) {
    console.error('\n❌ Process failed:', error.message);
    process.exit(1);
  }
}

main();
