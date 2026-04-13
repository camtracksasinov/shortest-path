const readline = require('readline');
const path = require('path');
const fs = require('fs');
const SftpClient = require('ssh2-sftp-client');
require('dotenv').config();

const { configA: sftpConfig } = require('./src/sftp/sftp-config');
const { matchCoordinates } = require('./src/routing/wialon-zones');
const { calculateOptimalRoute } = require('./src/routing/calculate-routes');
const { updateExcelWithRouteOrder } = require('./src/routing/update-excel-order');
const { generateReport } = require('./src/report/wialon-report');

const DOWNLOADS = path.join(__dirname, 'downloads');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = q => new Promise(resolve => rl.question(q, resolve));

// ── Parse Excel for coordinates (same logic as run-all.js) ───────────────────
async function parseExcelForCoordinates(filePath) {
  const XLSX = require('xlsx');
  const workbook = XLSX.readFile(filePath);
  const data = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { header: 1 });
  const headers = data[0];
  const coordIdx      = headers.findIndex(h => h && h.toString().toLowerCase().includes('coordonnees zone'));
  const transporteurIdx = headers.findIndex(h => h && h.toString().toLowerCase().includes('transporteur'));
  const camionIdx     = headers.findIndex(h => h && (h.toString().toLowerCase().includes('camion') || h.toString().toLowerCase().includes('vehicule')));
  const goIdx         = headers.findIndex(h => h === 'GO');
  const scIdx         = headers.findIndex(h => h === 'SC');
  const plIdx         = headers.findIndex(h => h === 'PL');
  const foIdx         = headers.findIndex(h => h === 'FO');
  const prioriteIdx   = headers.findIndex(h => h && h.toString().toLowerCase().includes('priorite'));

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

function getMonthFolderName() {
  const MONTHS_FR = ['JANVIER','FEVRIER','MARS','AVRIL','MAI','JUIN',
                     'JUILLET','AOUT','SEPTEMBRE','OCTOBRE','NOVEMBRE','DECEMBRE'];
  const now = new Date();
  return `${MONTHS_FR[now.getMonth()]}${now.getFullYear()}`;
}

// ── Download a specific file from SFTP ───────────────────────────────────────
async function downloadFile(fileName) {
  const sftp = new SftpClient();
  await sftp.connect(sftpConfig);

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

  // Look in month folder first, then fall back to root
  const monthList = await sftp.list(monthPath);
  const found = monthList.find(f => f.name === fileName)
    ? { path: `${monthPath}/${fileName}` }
    : rootList.find(f => f.name === fileName)
      ? { path: `/IN/${fileName}` }
      : null;

  if (!found) {
    await sftp.end();
    return null;
  }

  const localPath = path.join(DOWNLOADS, fileName);
  await sftp.get(found.path, localPath);
  await sftp.end();
  return localPath;
}

// ── Upload updated file back to SFTP ─────────────────────────────────────────
async function uploadFile(localPath) {
  const sftp = new SftpClient();
  await sftp.connect(sftpConfig);
  const monthFolder = getMonthFolderName();
  const remotePath = `/IN/${monthFolder}/${path.basename(localPath)}`;
  await sftp.put(localPath, remotePath);
  console.log(`  ✅ Uploaded: ${path.basename(localPath)} → /IN/${monthFolder}`);
  await sftp.end();
}

// ── Run routing only (no emails, no active copy) ──────────────────────────────
async function runRoutingOnly(localPath) {
  const fileName = path.basename(localPath);
  console.log(`\n${'='.repeat(70)}`);
  console.log(`📄 ROUTING: ${fileName}`);
  console.log('='.repeat(70));

  console.log('\n📍 Fetching coordinates from Wialon...');
  const coordData = await parseExcelForCoordinates(localPath);
  const zonesData = await matchCoordinates(coordData);

  console.log('\n🗺️  Calculating optimal routes...');
  const optimalRoutes = await calculateOptimalRoute(zonesData);

  console.log('\n📝 Updating Excel with optimal order...');
  const routesPath = path.join(DOWNLOADS, `optimal-routes-${path.basename(localPath, '.xlsx')}.json`);
  fs.writeFileSync(routesPath, JSON.stringify(optimalRoutes, null, 2));
  const updatedPath = await updateExcelWithRouteOrder(localPath, routesPath);

  console.log('\n📤 Uploading updated file to SFTP...');
  await uploadFile(updatedPath);

  // Clean up: remove original downloaded file and its optimal-routes JSON
  try { fs.unlinkSync(localPath); console.log(`  🗑️  Deleted: ${fileName}`); } catch (_) {}
  const routesPath2 = path.join(DOWNLOADS, `optimal-routes-${path.basename(localPath, '.xlsx')}.json`);
  try { fs.unlinkSync(routesPath2); } catch (_) {}

  console.log(`\n✅ Routing done. Updated file: ${path.basename(updatedPath)}`);
  console.log('ℹ️  No emails sent, no active copy saved (past date).\n');
  return updatedPath;
}

// ── Ask about report ──────────────────────────────────────────────────────────
async function askReport(updatedPath) {
  const ans = (await ask('📊 Run the end-of-day report for this file? (yes/no): ')).trim().toLowerCase();
  if (ans === 'yes' || ans === 'y') {
    console.log('\n📊 Running report...\n');
    await generateReport(updatedPath);
    return;
  }

  // No → ask for another file or quit
  const ans2 = (await ask('Run report for a different file? (yes/no): ')).trim().toLowerCase();
  if (ans2 === 'yes' || ans2 === 'y') {
    const otherName = (await ask('Enter the exact file name (e.g. Livraison 26-03-2026.1_updated-with-order.xlsx): ')).trim();
    const otherPath = await resolveFile(otherName);
    if (otherPath) {
      console.log('\n📊 Running report...\n');
      await generateReport(otherPath);
    }
  } else {
    console.log('\n👋 Exiting.');
  }
}

// ── Resolve file: check locally first, then download from SFTP /IN ──────────
async function resolveFile(fileName) {
  const localPath = path.join(DOWNLOADS, fileName);
  if (fs.existsSync(localPath)) return localPath;

  console.log(`🔍 Not found locally — checking SFTP server...`);
  const downloaded = await downloadFile(fileName);
  if (!downloaded) {
    console.log(`❌ File "${fileName}" not found locally or in /IN/${getMonthFolderName()} on the server.`);
    return null;
  }
  console.log(`✅ Downloaded: ${fileName}`);
  return downloaded;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n========================================');
  console.log('  Manual Process — Routing & Report');
  console.log('========================================\n');

  const action = (await ask('What do you want to do?\n  [1] Routing order for a past date\n  [2] Report only for a specific file\nChoice (1/2): ')).trim();

  if (action === '1') {
    // ── Routing ──
    const fileName = (await ask('\nEnter the exact file name on the server\n(e.g. Livraison 26-03-2026.1.xlsx): ')).trim();

    console.log(`\n🔍 Checking file on SFTP server...`);
    const localPath = await downloadFile(fileName);
    if (!localPath) {
      console.log(`❌ File "${fileName}" not found in /IN on the server.`);
      rl.close();
      return;
    }
    console.log(`✅ Downloaded: ${fileName}\n`);

    const updatedPath = await runRoutingOnly(localPath);
    await askReport(updatedPath);

  } else if (action === '2') {
    // ── Report only ──
    const fileName = (await ask('\nEnter the exact file name\n(e.g. Livraison 26-03-2026.1_updated-with-order.xlsx): ')).trim();
    const localPath = await resolveFile(fileName);
    if (!localPath) { rl.close(); return; }
    console.log('\n📊 Running report...\n');
    await generateReport(localPath);

  } else {
    console.log('❌ Invalid choice.');
  }

  rl.close();
}

main().catch(err => {
  console.error('\n❌ Error:', err.message);
  rl.close();
  process.exit(1);
});
