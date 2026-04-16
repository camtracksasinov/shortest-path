const SftpClient = require('ssh2-sftp-client');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const { matchCoordinates } = require('./src/routing/wialon-zones');
const { calculateOptimalRoute } = require('./src/routing/calculate-routes');
const { updateExcelWithRouteOrder } = require('./src/routing/update-excel-order');
const { processExcelAndSendEmails } = require('./src/emails/send-route-emails');
const { configA: sftpConfig } = require('./src/sftp/sftp-config');

// ── Camtrack server config (COMMENTED OUT — now using Galana via sftp-config.js)
// const sftpConfig = {
//   host: process.env.SFTP_HOST,       // bi.camtrack.mg
//   port: process.env.SFTP_PORT || 22,
//   username: process.env.SFTP_USERNAME, // usertestgalana
//   password: process.env.SFTP_PASSWORD
// };

// Returns e.g. "AVRIL2026" for the current month
function getMonthFolderName() {
  const MONTHS_FR = ['JANVIER','FEVRIER','MARS','AVRIL','MAI','JUIN',
                     'JUILLET','AOUT','SEPTEMBRE','OCTOBRE','NOVEMBRE','DECEMBRE'];
  const now = new Date();
  return `${MONTHS_FR[now.getMonth()]}${now.getFullYear()}`;
}

async function downloadAllFiles() {
  const sftp = new SftpClient();
  await sftp.connect(sftpConfig);

  // ── TEST MODE: use specific file instead of tomorrow's date filter ──────────
  // const TEST_FILE = 'Livraison 26-03-2026.1.xlsx';
  // const localPath = path.join(__dirname, 'downloads', TEST_FILE);
  // await sftp.get(`/IN/${TEST_FILE}`, localPath);
  // console.log(`  ✅ Downloaded (test): ${TEST_FILE}`);
  // await sftp.end();
  // return [localPath];
  // ────────────────────────────────────────────────────────────────────────────

  const monthFolder = getMonthFolderName();
  const monthPath = `/IN/${monthFolder}`;

  // Move any stray Livraison*.xlsx files from /IN root into the month folder
  const rootList = await sftp.list('/IN');
  for (const f of rootList) {
    if (f.type === '-' && f.name.startsWith('Livraison') && f.name.endsWith('.xlsx')) {
      try {
        await sftp.rename(`/IN/${f.name}`, `${monthPath}/${f.name}`);
        console.log(`  📁 Moved to ${monthFolder}: ${f.name}`);
      } catch (e) {
        console.warn(`  ⚠️  Could not move ${f.name}: ${e.message}`);
      }
    }
  }

  const list = await sftp.list(monthPath);

  const todayStr  = new Date().toLocaleDateString('en-CA', { timeZone: 'Indian/Antananarivo' });
  const todayDate  = new Date(todayStr);
  const tomorrow   = new Date(todayDate);
  tomorrow.setDate(todayDate.getDate() + 1);
  const fmt = d => d.toISOString().split('T')[0];

  const useToday = process.argv.includes('--today');
  const targetDate = useToday ? fmt(todayDate) : fmt(tomorrow);
  const targetLabel = useToday ? 'today' : 'tomorrow';

  const parseDateFromName = name => {
    const match = name.match(/(\d{2})-(\d{2})-(\d{4})/);
    if (!match) return null;
    return `${match[3]}-${match[2]}-${match[1]}`;
  };

  // If a specific file was requested via --file, only return that one
  const specificFile = (() => {
    const idx = process.argv.indexOf('--file');
    return idx !== -1 ? process.argv[idx + 1] : null;
  })();

  const serverFileNames = new Set(list.map(f => f.name));

  let targets = list.filter(f => {
    if (!f.name.startsWith('Livraison') || !f.name.match(/\.\d+\.xlsx$/)) return false;
    const d = parseDateFromName(f.name);
    return d === targetDate;
  });

  if (specificFile) {
    targets = targets.filter(f => f.name === specificFile);
  }

  if (targets.length === 0) {
    console.log(`\nℹ️  No Livraison*.N.xlsx file for ${targetLabel} (${targetDate}) found in ${monthPath} — nothing to do.`);
    await sftp.end();
    return [];
  }

  // Filter out files that already have a corresponding _updated-with-order file on the server
  const pending = targets.filter(f => {
    const updatedName = f.name.replace(/(\.\d+)\.xlsx$/, '$1_updated-with-order.xlsx');
    if (serverFileNames.has(updatedName)) {
      console.log(`  ⏭️  Skipping (already processed): ${f.name} → ${updatedName} exists`);
      return false;
    }
    return true;
  });

  if (pending.length === 0) {
    console.log(`\nℹ️  All files for ${targetLabel} (${targetDate}) have already been processed — nothing to do.`);
    await sftp.end();
    return [];
  }

  console.log(`\n📊 Found ${pending.length} new file(s) to process for ${targetLabel} (${targetDate}):`);
  const downloaded = [];
  for (const file of pending) {
    const localPath = path.join(__dirname, 'downloads', file.name);
    await sftp.get(`${monthPath}/${file.name}`, localPath);
    console.log(`  ✅ Downloaded: ${file.name}`);
    downloaded.push(localPath);
  }
  await sftp.end();
  return downloaded;
}

async function uploadUpdatedFile(localPath) {
  const sftp = new SftpClient();
  await sftp.connect(sftpConfig);
  const monthFolder = getMonthFolderName();
  const remotePath = `/IN/${monthFolder}/${path.basename(localPath)}`;
  await sftp.put(localPath, remotePath);
  console.log(`  ✅ Uploaded: ${path.basename(localPath)} → /IN/${monthFolder}`);
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

  // Keep a local active copy for Wialon notifications (no SFTP needed at runtime)
  const activePath = path.join(__dirname, 'active', path.basename(updatedPath));
  fs.copyFileSync(updatedPath, activePath);
  console.log(`  📋 Active copy saved: active/${path.basename(updatedPath)}`);

  console.log('\n📤 Step 5: Uploading updated file to SFTP...');
  await uploadUpdatedFile(updatedPath);

  console.log('\n📧 Step 5b: Sending route emails to transporters...');
  await processExcelAndSendEmails(updatedPath);

  // Clean up: remove original downloaded file and its optimal-routes JSON
  try { fs.unlinkSync(filePath); console.log(`  🗑️  Deleted: ${fileName}`); } catch (_) {}
  const routesPath2 = path.join(__dirname, 'downloads', `optimal-routes-${path.basename(filePath, '.xlsx')}.json`);
  try { fs.unlinkSync(routesPath2); } catch (_) {}

  // Step 6: Run report only if the updated file's date matches today AND --no-report not passed
  const noReport = process.argv.includes('--no-report') || process.argv.includes('--today');
  const baseName = path.basename(updatedPath);
  const isUpdatedFile = baseName.includes('_updated-with-order');
  const dateMatch = baseName.match(/(\d{2})-(\d{2})-(\d{4})/);
  const fileDate = dateMatch ? `${dateMatch[3]}-${dateMatch[2]}-${dateMatch[1]}` : null;
  const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Indian/Antananarivo' }); // YYYY-MM-DD in Madagascar time

  if (noReport) {
    console.log(`\nℹ️  Step 6: Report skipped (--no-report flag).`);
  } else if (isUpdatedFile && fileDate === todayStr) {
    console.log(`\n📊 Step 6: Running report for today's file (${baseName})...`);
    const { execSync } = require('child_process');
    execSync(`node src/report/wialon-report.js --file "${updatedPath}"`, { stdio: 'inherit' });

    // Delete only this file's active copy after report — tomorrow's stays untouched
    const activeDir = path.join(__dirname, 'active');
    try {
      const activeFile = path.join(activeDir, path.basename(updatedPath));
      if (fs.existsSync(activeFile)) {
        fs.unlinkSync(activeFile);
        console.log(`  🗑️  Active file deleted after report — ready for next delivery day.`);
      }
    } catch (_) {}
  } else {
    console.log(`\nℹ️  Step 6: Report skipped — file date (${fileDate}) ≠ today (${todayStr}). Will run on delivery day.`);
  }
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
