const axios = require('axios');
const XLSX = require('xlsx');
const ExcelJS = require('exceljs');
const path = require('path');
const SftpClient = require('ssh2-sftp-client');
require('dotenv').config();

const WIALON_TOKEN = '88d76474ecf8104104e6971816190ebd7830375A8DE58679CE325865AA5FFC9763964B72';
const BASE_URL = 'https://hst-api.wialon.com/wialon/ajax.html';
const TIMEZONE_OFFSET = parseInt(process.env.TIMEZONE_OFFSET || '2'); // GMT offset in hours

const sftpConfig = {
  host: process.env.SFTP_HOST,
  port: process.env.SFTP_PORT || 22,
  username: process.env.SFTP_USERNAME,
  password: process.env.SFTP_PASSWORD
};

let sessionId = null;
let sftp = new SftpClient();

async function login() {
  console.log('🔐 Step 1: Logging in to Wialon...');
  const url = `${BASE_URL}?svc=token/login&params={"token":"${WIALON_TOKEN}"}`;
  const response = await axios.get(url);
  sessionId = response.data.eid;
  console.log(`✅ Session ID: ${sessionId}\n`);
  return sessionId;
}

async function getResourceAndTemplates() {
  console.log('📋 Step 2: Getting resource and template IDs...');
  const url = `${BASE_URL}?svc=core/update_data_flags&params={"spec":[{"type":"type","data":"avl_resource","flags":8193,"mode":1}]}&sid=${sessionId}`;
  const response = await axios.get(url);
  
  const resource = response.data.find(r => r.d.nm === 'Galana ressource');
  const resourceId = resource.i;
  const templateId = resource.d.rep['13'].id;
  
  console.log(`✅ Resource ID: ${resourceId}`);
  console.log(`✅ Template ID: ${templateId}\n`);
  
  return { resourceId, templateId };
}

async function getVehicles() {
  console.log('🚛 Step 3: Getting all vehicles...');
  const url = `${BASE_URL}?svc=core/update_data_flags&params={"spec":[{"type":"type","data":"avl_unit","flags":1025,"mode":1}]}&sid=${sessionId}`;
  const response = await axios.get(url);
  
  const vehicles = response.data.map(v => ({
    id: v.d.id,
    name: v.d.nm
  }));
  
  console.log(`✅ Found ${vehicles.length} vehicles\n`);
  return vehicles;
}

async function downloadFromSFTP() {
  console.log('📥 Downloading Excel files from SFTP server...');
  await sftp.connect(sftpConfig);

  const list = await sftp.list('/IN');

  const todayStr = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  const parseDateFromName = name => {
    const match = name.match(/(\d{2})-(\d{2})-(\d{4})/);
    if (!match) return null;
    return `${match[3]}-${match[2]}-${match[1]}`;
  };

  const targetFiles = list.filter(f =>
    f.name.startsWith('Livraison') &&
    f.name.match(/\.\d+_updated-with-order\.xlsx$/) &&
    parseDateFromName(f.name) === todayStr
  );

  if (targetFiles.length === 0) {
    throw new Error(`No "Livraison*.N_updated-with-order.xlsx" files for today (${todayStr}) found in /IN folder`);
  }
  
  console.log(`📄 Found ${targetFiles.length} file(s)`);
  
  const downloadedFiles = [];
  for (const file of targetFiles) {
    console.log(`  - ${file.name}`);
    const remoteFile = `/IN/${file.name}`;
    const localFile = path.join(__dirname, 'downloads', file.name);
    await sftp.get(remoteFile, localFile);
    downloadedFiles.push(localFile);
  }
  
  console.log('✅ Downloaded from SFTP\n');
  await sftp.end();
  return downloadedFiles;
}

async function uploadToSFTP(localFile, originalName) {
  console.log('📤 Uploading report to SFTP /OUT folder...');
  
  const sftpUpload = new SftpClient();
  await sftpUpload.connect(sftpConfig);
  
  const outputName = path.basename(originalName).replace(/(\.\d+)_updated-with-order\.xlsx$/, '$1_rapport-effectue.xlsx');
  const remoteFile = `/OUT/${outputName}`;
  
  try {
    await sftpUpload.mkdir('/OUT', true);
  } catch (err) {
    console.log('   /OUT directory already exists or created');
  }
  
  try {
    await sftpUpload.delete(remoteFile);
    console.log(`   🗑️  Deleted existing file: ${outputName}`);
  } catch (err) {
    // File doesn't exist, continue
  }
  
  await sftpUpload.put(localFile, remoteFile);
  console.log(`✅ Uploaded to: ${remoteFile}`);
  
  const list = await sftpUpload.list('/OUT');
  console.log(`📋 Files in /OUT: ${list.map(f => f.name).join(', ')}\n`);
  
  await sftpUpload.end();
}

function readUpdatedExcel(filePath) {
  console.log('📖 Step 4: Reading updated Excel file...');
  const workbook = XLSX.readFile(filePath);
  const worksheet = workbook.Sheets[workbook.SheetNames[0]];
  const data = XLSX.utils.sheet_to_json(worksheet, { header: 1 });
  
  const headers = data[0];
  const camionIdx = headers.findIndex(h => h && h.toString().toLowerCase().includes('camion'));
  const clientDepotIdx = headers.findIndex(h => h && h.toString().toLowerCase().includes('client/depot'));
  const dateIdx = headers.findIndex(h => h && h.toString().toLowerCase().includes('date tournée'));
  
  // Get date from first row
  let reportDate = null;
  if (dateIdx !== -1 && data[1] && data[1][dateIdx]) {
    const excelDate = data[1][dateIdx];
    if (typeof excelDate === 'number') {
      reportDate = new Date((excelDate - 25569) * 86400 * 1000);
    } else if (typeof excelDate === 'string') {
      reportDate = new Date(excelDate);
    }
    if (reportDate && isNaN(reportDate.getTime())) {
      reportDate = null;
    }
  }
  
  const vehicleMap = {};
  let order = 1;
  
  for (let i = 1; i < data.length; i++) {
    const camion = data[i][camionIdx];
    const clientDepot = data[i][clientDepotIdx];
    
    if (camion && clientDepot) {
      if (!vehicleMap[camion]) {
        vehicleMap[camion] = [];
        order = 1;
      }
      vehicleMap[camion].push({ clientDepot, order: order++ });
    }
  }
  
  console.log(`✅ Loaded ${Object.keys(vehicleMap).length} vehicles from Excel`);
  console.log(`📅 Report date: ${reportDate ? reportDate.toISOString().split('T')[0] : 'Not found'}\n`);
  
  return { vehicleMap, reportDate };
}

async function executeReport(resourceId, templateId, vehicleId, from, to) {
  const url = `${BASE_URL}?svc=report/exec_report&params={"reportResourceId":${resourceId},"reportTemplateId":${templateId},"reportObjectId":${vehicleId},"reportObjectSecId":0,"interval":{"flags":16777216,"from":${from},"to":${to}}}&sid=${sessionId}`;
  const response = await axios.get(url);
  return response.data;
}

async function executeTripsReport(resourceId, vehicleId, from, to) {
  const url = `${BASE_URL}?svc=report/exec_report&params={"reportResourceId":${resourceId},"reportTemplateId":14,"reportObjectId":${vehicleId},"reportObjectSecId":0,"interval":{"flags":16777216,"from":${from},"to":${to}}}&sid=${sessionId}`;
  const response = await axios.get(url);
  return response.data;
}

async function executeConducteContinueReport(vehicleId, from, to) {
  const url = `${BASE_URL}?svc=report/exec_report&params={"reportResourceId":27616618,"reportTemplateId":17,"reportObjectId":${vehicleId},"reportObjectSecId":0,"interval":{"flags":16777216,"from":${from},"to":${to}}}&sid=${sessionId}`;
  const response = await axios.get(url);
  return response.data;
}

async function getConducteContinueRows() {
  const url = `${BASE_URL}?svc=report/select_result_rows&params={"tableIndex":0,"config":{"type":"range","data":{"from":0,"to":10,"level":1,"unitInfo":1}}}&sid=${sessionId}`;
  const response = await axios.get(url);
  return response.data;
}

async function executeNightDrivingReport(vehicleId, from, to) {
  const url = `${BASE_URL}?svc=report/exec_report&params={"reportResourceId":27616618,"reportTemplateId":15,"reportObjectId":${vehicleId},"reportObjectSecId":0,"interval":{"flags":16777216,"from":${from},"to":${to}}}&sid=${sessionId}`;
  const response = await axios.get(url);
  return response.data;
}

async function getNightDrivingRows() {
  const url = `${BASE_URL}?svc=report/select_result_rows&params={"tableIndex":0,"config":{"type":"range","data":{"from":0,"to":10000,"level":2,"unitInfo":1}}}&sid=${sessionId}`;
  const response = await axios.get(url);
  return response.data;
}

async function executeSpeedingReport(vehicleId, from, to) {
  const url = `${BASE_URL}?svc=report/exec_report&params={"reportResourceId":27616618,"reportTemplateId":16,"reportObjectId":${vehicleId},"reportObjectSecId":0,"interval":{"flags":16777216,"from":${from},"to":${to}}}&sid=${sessionId}`;
  const response = await axios.get(url);
  return response.data;
}

async function getSpeedingRows(tableIndex) {
  const url = `${BASE_URL}?svc=report/select_result_rows&params={"tableIndex":${tableIndex},"config":{"type":"range","data":{"from":0,"to":10000,"level":2,"unitInfo":1}}}&sid=${sessionId}`;
  const response = await axios.get(url);
  return response.data;
}

async function getSpeedingDetailRows(tableIndex) {
  const url = `${BASE_URL}?svc=report/select_result_rows&params={"tableIndex":${tableIndex},"config":{"type":"range","data":{"from":0,"to":10000,"level":2,"unitInfo":1}}}&sid=${sessionId}`;
  const response = await axios.get(url);
  return response.data;
}

function isValidConducteContinueRow(sub) {
  // c[6]=Engine hours, c[10]=Mileage — skip if both are zero/empty/dashes
  const engineHours = sub.c?.[6]?.t ?? sub.c?.[6] ?? '';
  const mileage = sub.c?.[10]?.t ?? sub.c?.[10] ?? '';
  if (!engineHours || engineHours === '-----' || engineHours === '0:00:00') return false;
  if (!mileage || mileage === '-----' || mileage === '0.00 km') return false;
  return true;
}

function isValidSpeedingRow(sub) {
  const t1 = sub.c?.[2]?.v ?? sub.t1;
  // c[5] is Max.speed for tableIndex 0 (8-col), c[4] for tableIndex 1 (5-col details)
  const maxSpeed5 = sub.c?.[5]?.t ?? sub.c?.[5] ?? '';
  const maxSpeed4 = sub.c?.[4]?.t ?? sub.c?.[4] ?? '';
  const maxSpeed = maxSpeed5 || maxSpeed4;
  if (!t1) return false;
  if (typeof maxSpeed === 'string' && (maxSpeed === '0 km/h' || maxSpeed === '-----')) return false;
  const duration = sub.c?.[4]?.t ?? sub.c?.[4] ?? '';
  if (duration === '0:00:00') return false;
  return true;
}

function countInWindow(rows, windowStart, windowEnd, validator = isValidSpeedingRow, t2ColIdx = 3) {
  let count = 0;
  if (!rows || !rows.length) return 0;
  for (const row of rows) {
    const subs = row.r && Array.isArray(row.r) ? row.r : [row];
    for (const sub of subs) {
      if (!validator(sub)) continue;
      const t1 = sub.c?.[2]?.v ?? sub.t1;
      const t2 = sub.c?.[t2ColIdx]?.v ?? sub.t2;
      if (!t1 || !t2) continue;
      if (t1 <= windowEnd && t2 >= windowStart) count++;
    }
  }
  return count;
}

async function getReportRows() {
  const url = `${BASE_URL}?svc=report/select_result_rows&params={"tableIndex":0,"config":{"type":"range","data":{"from":0,"to":10000,"level":0,"unitInfo":1}}}&sid=${sessionId}`;
  const response = await axios.get(url);
  return response.data;
}

async function getTripDetailRows(rowIndex) {
  const url = `${BASE_URL}?svc=report/select_result_rows&params={"tableIndex":0,"config":{"type":"range","data":{"from":${rowIndex},"to":${rowIndex},"level":1}}}&sid=${sessionId}`;
  const response = await axios.get(url);
  return response.data;
}

function calculateDuration(firstIn, lastOut) {
  const diff = lastOut - firstIn;
  const hours = Math.floor(diff / 3600);
  const minutes = Math.floor((diff % 3600) / 60);
  const seconds = diff % 60;
  return `${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}

async function processReportData(rows, orderedZones, tripDetailRows) {
  const results = [];
  
  for (let zoneIdx = 0; zoneIdx < orderedZones.length; zoneIdx++) {
    const zone = orderedZones[zoneIdx];
    const zoneName = zone.clientDepot;
    const zoneVisits = [];
    
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (row.c[0] === zoneName) {
        zoneVisits.push({
          index: i,
          entryTime: row.c[1].v,
          exitTime: row.c[2].v,
          zoneName: row.c[0]
        });
      }
    }
    
    if (zoneVisits.length === 0) {
      results.push({
        zone: zoneName,
        order: zone.order,
        firstEntry: 'N/A',
        lastExit: 'N/A',
        duration: 'N/A',
        kilometrage: 'N/A',
        vitesseMoyenne: 'N/A',
        vitesseMax: 'N/A',
        trajectory: '',
        status: 'Not visited'
      });
      continue;
    }
    
    const firstVisit = zoneVisits[0];
    let lastVisit = zoneVisits[zoneVisits.length - 1];
    
    const lastVisitIndex = lastVisit.index;
    if (lastVisitIndex + 1 < rows.length) {
      const nextRow = rows[lastVisitIndex + 1];
      if (nextRow.c[0] !== zoneName) {
        lastVisit = zoneVisits[zoneVisits.length - 1];
      } else {
        for (let i = zoneVisits.length - 1; i >= 0; i--) {
          const visitIdx = zoneVisits[i].index;
          if (visitIdx + 1 < rows.length && rows[visitIdx + 1].c[0] !== zoneName) {
            lastVisit = zoneVisits[i];
            break;
          }
        }
      }
    }
    
    const duration = calculateDuration(firstVisit.entryTime, lastVisit.exitTime);
    
    const firstEntryDate = new Date(firstVisit.entryTime * 1000);
    firstEntryDate.setHours(firstEntryDate.getHours() + TIMEZONE_OFFSET);
    
    const lastExitDate = new Date(lastVisit.exitTime * 1000);
    lastExitDate.setHours(lastExitDate.getHours() + TIMEZONE_OFFSET);
    
    // Get metrics and trajectory from previous zone's exit trip
    let kilometrage = 'N/A', vitesseMoyenne = 'N/A', vitesseMax = 'N/A', trajectory = '';
    
    if (tripDetailRows && tripDetailRows.length > 0 && tripDetailRows[0].r) {
      const detailTrips = tripDetailRows[0].r;
      
      // Check if current zone is Parking or Depot
      const isParking = zoneName.toLowerCase().startsWith('parking');
      const isDepot = zoneName.toLowerCase().includes('depot') && !isParking;
      
      if (zoneIdx === 0) {
        // First zone: find first trip ending at this zone (not starting from it)
        for (let i = 0; i < detailTrips.length; i++) {
          const trip = detailTrips[i];
          const startZone = trip.c[2]?.t || '';
          const endZone = trip.c[4]?.t || '';
          
          if (endZone.includes(zoneName) && !startZone.includes(zoneName)) {
            kilometrage = trip.c[8] || '0 km';
            vitesseMoyenne = trip.c[10] || '0 km/h';
            const maxSpeedObj = trip.c[11];
            vitesseMax = (typeof maxSpeedObj === 'object' && maxSpeedObj.t) ? maxSpeedObj.t : maxSpeedObj || '0 km/h';
            trajectory = isDepot ? '1' : '';
            break;
          }
        }
      } else {
        // For other zones, find last trip from previous zone to current zone
        const prevZoneName = orderedZones[zoneIdx - 1].clientDepot;
        
        // Calculate trajectory number: count depots (not parking) up to this point
        let trajectCount = 0;
        for (let j = 0; j <= zoneIdx; j++) {
          const zName = orderedZones[j].clientDepot.toLowerCase();
          const isPark = zName.startsWith('parking');
          const isDep = zName.includes('depot') && !isPark;
          if (isDep || (!isPark && !isDep && j > 0)) {
            trajectCount++;
          }
        }
        
        for (let i = detailTrips.length - 1; i >= 0; i--) {
          const trip = detailTrips[i];
          const startZone = trip.c[2]?.t || '';
          const endZone = trip.c[4]?.t || '';
          
          if (startZone.includes(prevZoneName) && endZone.includes(zoneName)) {
            kilometrage = trip.c[8] || 'N/A';
            vitesseMoyenne = trip.c[10] || 'N/A';
            const maxSpeedObj = trip.c[11];
            vitesseMax = (typeof maxSpeedObj === 'object' && maxSpeedObj.t) ? maxSpeedObj.t : maxSpeedObj || 'N/A';
            trajectory = isParking ? '' : `${trajectCount}`;
            break;
          }
        }
      }
    }
    
    results.push({
      zone: zoneName,
      order: zone.order,
      firstEntry: firstEntryDate.toLocaleString(),
      lastExit: lastExitDate.toLocaleString(),
      firstEntryTs: firstVisit.entryTime,
      lastExitTs: lastVisit.exitTime,
      duration: duration,
      kilometrage,
      vitesseMoyenne,
      vitesseMax,
      trajectory,
      status: 'Completed'
    });
  }
  
  return results;
}

function displayTable(vehicleName, results) {
  const W = 190;
  console.log('\n' + '='.repeat(W));
  console.log(`🚛 VEHICLE: ${vehicleName}`);
  console.log('='.repeat(W));
  console.log(
    'Order'.padEnd(8) +
    'Zone'.padEnd(35) +
    'First Entry'.padEnd(22) +
    'Last Exit'.padEnd(22) +
    'Duration'.padEnd(12) +
    'Km'.padEnd(12) +
    'Avg Speed'.padEnd(14) +
    'Max Speed'.padEnd(14) +
    'Survit.Ville'.padEnd(15) +
    'Survit.Hors'.padEnd(14) +
    'Nuit'.padEnd(8) +
    'Status'
  );
  console.log('-'.repeat(W));

  results.forEach(r => {
    console.log(
      r.order.toString().padEnd(8) +
      r.zone.padEnd(35) +
      r.firstEntry.padEnd(22) +
      r.lastExit.padEnd(22) +
      r.duration.padEnd(12) +
      (r.kilometrage || 'N/A').toString().padEnd(12) +
      (r.vitesseMoyenne || 'N/A').toString().padEnd(14) +
      (r.vitesseMax || 'N/A').toString().padEnd(14) +
      (r.survitesseVille !== undefined ? r.survitesseVille : 'N/A').toString().padEnd(15) +
      (r.survitesseHors !== undefined ? r.survitesseHors : 'N/A').toString().padEnd(14) +
      (r.nightDriving !== undefined ? r.nightDriving : 'N/A').toString().padEnd(8) +
      r.status
    );
  });

  console.log('='.repeat(W) + '\n');
}

async function generateReport(targetFile = null) {
  try {
    let downloadedFiles;
    if (targetFile) {
      // Called from run-all.js with a specific file — skip SFTP download
      downloadedFiles = [targetFile];
      console.log(`📄 Generating report for: ${path.basename(targetFile)}`);
    } else {
      downloadedFiles = await downloadFromSFTP();
    }
    
    await login();
    const { resourceId, templateId } = await getResourceAndTemplates();
    const allVehicles = await getVehicles();
    
    for (const downloadedFile of downloadedFiles) {
      console.log(`\n${'='.repeat(100)}`);
      console.log(`📄 Processing: ${path.basename(downloadedFile)}`);
      console.log('='.repeat(100));
      
      const { vehicleMap, reportDate } = readUpdatedExcel(downloadedFile);
      const allSpeedingInRows = [];
      const allSpeedingOutRows = [];
      const allNightRows = [];
      const allConducteContinueRows = [];

      const workbook = XLSX.readFile(downloadedFile);
      const worksheet = workbook.Sheets[workbook.SheetNames[0]];
      const data = XLSX.utils.sheet_to_json(worksheet, { header: 1 });
      
      const headers = data[0];
      headers.push("Heure d'arrivée", "Heure de départ", "Délai de livraison", "Kilométrage effectif, km", "Vitesse moyenne", "Vitesse max", "Survitesse en ville", "Survitesse Hors Aglomération", "Conduite de nuit", "Conduite Continue");
      
      const dateStr = reportDate ? reportDate.toISOString().split('T')[0] : new Date().toISOString().split('T')[0];
      const from = Math.floor(new Date(`${dateStr}T00:00:00Z`).getTime() / 1000);
      const to = Math.floor(new Date(`${dateStr}T23:59:59Z`).getTime() / 1000);

      console.log(`🕒 Report date: ${dateStr} | timestamps: ${from} to ${to}\n`);
      console.log('📊 Step 5: Generating reports for each vehicle...\n');
      
      const camionIdx = headers.findIndex(h => h && h.toString().toLowerCase().includes('camion'));
      const clientDepotIdx = headers.findIndex(h => h && h.toString().toLowerCase().includes('client/depot'));
    
    for (const [vehicleName, orderedZones] of Object.entries(vehicleMap)) {
      const formattedName = vehicleName.length > 4 && !vehicleName.includes(' ') 
        ? vehicleName.slice(0, 4) + ' ' + vehicleName.slice(4)
        : vehicleName;
      
      const vehicle = allVehicles.find(v => v.name === formattedName);
      
      if (!vehicle) {
        console.log(`⚠️  Vehicle "${vehicleName}" (formatted: "${formattedName}") not found in Wialon system`);
        continue;
      }
      
      console.log(`\n🔄 Processing: ${formattedName} (ID: ${vehicle.id})`);
      
      const reportResult = await executeReport(resourceId, templateId, vehicle.id, from, to);
      
      if (!reportResult.reportResult || !reportResult.reportResult.tables || reportResult.reportResult.tables.length === 0) {
        console.log(`   ⚠️  No data available for ${formattedName}`);
        continue;
      }
      
      const rows = await getReportRows();
      
      if (!rows || rows.length === 0) {
        console.log(`   ⚠️  No zone visits for ${formattedName}`);
        continue;
      }
      
      // Get trips report and detailed rows
      const tripsReport = await executeTripsReport(resourceId, vehicle.id, from, to);
      
      let tripDetailRows = null;
      if (tripsReport.reportResult && tripsReport.reportResult.tables && tripsReport.reportResult.tables[0]) {
        const table = tripsReport.reportResult.tables[0];
        if (table.rows > 0) {
          tripDetailRows = await getTripDetailRows(0);
        }
      }

      // Speeding report: fetch all sub-events once per vehicle
      let speedingInRows = [], speedingOutRows = [];
      try {
        const speedingReport = await executeSpeedingReport(vehicle.id, from, to);
        if (speedingReport.reportResult && speedingReport.reportResult.tables && speedingReport.reportResult.tables.length > 0) {
          const tables = speedingReport.reportResult.tables;
          if (tables[0] && tables[0].rows > 0) speedingInRows = await getSpeedingRows(0);
          if (tables[2] && tables[2].rows > 0) speedingOutRows = await getSpeedingRows(2);
        }
      } catch (e) {
        console.log(`   ⚠️  Speeding report failed for ${formattedName}: ${e.message}`);
      }

      // Night driving: fetch all sub-events once per vehicle
      let nightDrivingRows = [];
      try {
        const nightReport = await executeNightDrivingReport(vehicle.id, from, to);
        if (nightReport.reportResult && nightReport.reportResult.tables && nightReport.reportResult.tables.length > 0 && nightReport.reportResult.tables[0].rows > 0) {
          nightDrivingRows = await getNightDrivingRows();
        }
      } catch (e) {
        console.log(`   ⚠️  Night driving report failed for ${formattedName}: ${e.message}`);
      }

      // Conduite Continue: fetch rows once per vehicle
      let conducteContinueRows = [];
      try {
        const ccReport = await executeConducteContinueReport(vehicle.id, from, to);
        if (ccReport.reportResult && ccReport.reportResult.tables && ccReport.reportResult.tables.length > 0 && ccReport.reportResult.tables[0].rows > 0) {
          conducteContinueRows = await getConducteContinueRows();
        }
      } catch (e) {
        console.log(`   ⚠️  Conduite Continue report failed for ${formattedName}: ${e.message}`);
      }

      const results = await processReportData(rows, orderedZones, tripDetailRows);

      // Compute per-zone transit window counts and store on result objects
      // Build trajectory windows: only between non-parking/depot zones
      const trajectoryWindows = [];
      for (const result of results) {
        const isParking = result.zone.toLowerCase().startsWith('parking');
        const isDepot = result.zone.toLowerCase().includes('depot') && !isParking;
        const isNonTrajectory = isParking || isDepot;
        if (result.status !== 'Completed' || isNonTrajectory) {
          result.survitesseVille = isNonTrajectory ? '--' : 0;
          result.survitesseHors = isNonTrajectory ? '--' : 0;
          result.nightDriving = isNonTrajectory ? '--' : 0;
          result.conduiteContinue = isNonTrajectory ? '--' : 0;
          continue;
        }
        const resultIdx = results.indexOf(result);
        // Find previous trajectory (non-parking/non-depot) visited zone
        let prevTrajectory = null;
        for (let j = resultIdx - 1; j >= 0; j--) {
          const r = results[j];
          const rIsParking = r.zone.toLowerCase().startsWith('parking');
          const rIsDepot = r.zone.toLowerCase().includes('depot') && !rIsParking;
          if (r.status === 'Completed' && !rIsParking && !rIsDepot && r.lastExitTs) {
            prevTrajectory = r;
            break;
          }
        }
        // windowStart: previous trajectory exit, or from if none visited yet
        const windowStart = prevTrajectory ? prevTrajectory.lastExitTs : from;
        const windowEnd = result.firstEntryTs;
        if (windowStart <= windowEnd) {
          result.survitesseVille = countInWindow(speedingInRows, windowStart, windowEnd);
          result.survitesseHors = countInWindow(speedingOutRows, windowStart, windowEnd);
          result.nightDriving = countInWindow(nightDrivingRows, windowStart, windowEnd);
          result.conduiteContinue = countInWindow(conducteContinueRows, windowStart, windowEnd, isValidConducteContinueRow, 4);
          trajectoryWindows.push({ windowStart, windowEnd });
        } else {
          result.survitesseVille = 0;
          result.survitesseHors = 0;
          result.nightDriving = 0;
          result.conduiteContinue = 0;
        }
      }

      displayTable(formattedName, results);

      // Collect speeding display rows from same source as counting (tableIndex 0 / 2)
      const inTrajectoryWindow = (t1, t2) => trajectoryWindows.some(w => t1 <= w.windowEnd && (t2 ?? t1) >= w.windowStart);
      const extractSpeedingDisplayRows = (rows, target) => {
        for (const row of rows) {
          const subs = row.r && Array.isArray(row.r) ? row.r : [row];
          for (const sub of subs) {
            if (!isValidSpeedingRow(sub)) continue;
            const t1 = sub.c?.[2]?.v ?? sub.t1;
            const t2 = sub.c?.[3]?.v ?? sub.t2;
            if (!inTrajectoryWindow(t1, t2)) continue;
            const grouping = sub.c?.[1]?.t ?? sub.c?.[1] ?? '';
            const beginning = sub.c?.[2]?.t ?? '';
            const duration = sub.c?.[4]?.t ?? sub.c?.[4] ?? '';
            // en agglomération: c[5] is max speed; hors agglomération: c[5] is distance, c[6] is max speed
            const c5 = sub.c?.[5]?.t ?? sub.c?.[5] ?? '';
            const c6 = sub.c?.[6]?.t ?? '';
            const maxSpeed = (typeof c5 === 'string' && c5.includes('km/h')) ? c5 : c6;
            target.push([grouping, beginning, duration, maxSpeed]);
          }
        }
      };
      extractSpeedingDisplayRows(speedingInRows, allSpeedingInRows);
      extractSpeedingDisplayRows(speedingOutRows, allSpeedingOutRows);

      // Collect Conduite Continue display rows
      for (const row of conducteContinueRows) {
        const subs = row.r && Array.isArray(row.r) ? row.r : [row];
        for (const sub of subs) {
          if (!isValidConducteContinueRow(sub)) continue;
          const t1 = sub.c?.[2]?.v ?? sub.t1;
          const t2 = sub.c?.[4]?.v ?? sub.t2;
          if (!t1 || !t2) continue;
          if (!inTrajectoryWindow(t1, t2)) continue;
          const grouping   = sub.c?.[1]?.t ?? sub.c?.[1] ?? '';
          const beginning  = sub.c?.[2]?.t ?? '';
          const end        = sub.c?.[4]?.t ?? '';
          const engineHours = sub.c?.[6]?.t ?? sub.c?.[6] ?? '';
          const totalTime  = sub.c?.[7]?.t ?? sub.c?.[7] ?? '';
          const inMotion   = sub.c?.[8]?.t ?? sub.c?.[8] ?? '';
          const idling     = sub.c?.[9]?.t ?? sub.c?.[9] ?? '';
          const mileage    = sub.c?.[10]?.t ?? sub.c?.[10] ?? '';
          allConducteContinueRows.push([grouping, beginning, end, engineHours, totalTime, inMotion, idling, mileage]);
        }
      }

      // Collect night driving display rows — same window filter as countInWindow
      for (const row of nightDrivingRows) {
        const subs = row.r && Array.isArray(row.r) ? row.r : [row];
        for (const sub of subs) {
          const t1 = sub.c?.[2]?.v ?? sub.t1;
          const t2 = sub.c?.[3]?.v ?? sub.t2;
          if (!t1 || !t2) continue;
          if (!inTrajectoryWindow(t1, t2)) continue;
          const beginning = sub.c?.[2]?.t ?? '';
          if (!beginning || beginning === '-----') continue;
          const vehicle   = sub.c?.[1]?.t ?? sub.c?.[1] ?? '';
          const end       = sub.c?.[3]?.t ?? '';
          const mileage   = sub.c?.[4]?.t ?? sub.c?.[4] ?? '';
          const maxSpeed  = sub.c?.[5]?.t ?? sub.c?.[5] ?? '';
          if (maxSpeed === '0 km/h') continue;
          const locStart  = sub.c?.[6]?.t ?? sub.c?.[6] ?? '';
          const locEnd    = sub.c?.[7]?.t ?? sub.c?.[7] ?? '';
          const engHours  = sub.c?.[8]?.t ?? sub.c?.[8] ?? '';
          const idling    = sub.c?.[9]?.t ?? sub.c?.[9] ?? '';
          allNightRows.push([vehicle, beginning, end, mileage, maxSpeed, locStart, locEnd, engHours, idling]);
        }
      }

      // Write to Excel
      for (let i = 1; i < data.length; i++) {
        if (data[i][camionIdx] === vehicleName) {
          const clientDepot = data[i][clientDepotIdx];
          const result = results.find(r => r.zone === clientDepot);
          if (result && result.status === 'Completed') {
            data[i].push(result.firstEntry, result.lastExit, result.duration, result.kilometrage, result.vitesseMoyenne, result.vitesseMax, result.survitesseVille, result.survitesseHors, result.nightDriving, result.conduiteContinue);
          } else {
            data[i].push('N/A', 'N/A', 'N/A', 'N/A', 'N/A', 'N/A', 0, 0, 0, 0);
          }
        }
      }
    }
    
    const workbookOut = new ExcelJS.Workbook();
    const worksheetOut = workbookOut.addWorksheet('Report');
    worksheetOut.addRows(data);
    
    const originalColWidths = worksheet['!cols'] || [];
    for (let i = 0; i < headers.length - 9; i++) {
      worksheetOut.getColumn(i + 1).width = originalColWidths[i]?.wch || 15;
    }
    worksheetOut.getColumn(headers.length - 9).width = 22;
    worksheetOut.getColumn(headers.length - 8).width = 22;
    worksheetOut.getColumn(headers.length - 7).width = 20;
    worksheetOut.getColumn(headers.length - 6).width = 25;
    worksheetOut.getColumn(headers.length - 5).width = 18;
    worksheetOut.getColumn(headers.length - 4).width = 15;
    worksheetOut.getColumn(headers.length - 3).width = 25;
    worksheetOut.getColumn(headers.length - 2).width = 30;
    worksheetOut.getColumn(headers.length - 1).width = 20;
    worksheetOut.getColumn(headers.length).width = 20;
    
    const headerRow = worksheetOut.getRow(1);
    headerRow.height = 45;
    const newColumnsStartIdx = headers.length - 9;
    const yellowColumnsStartIdx = headers.length - 3; // last 4 cols: Survitesse en ville, Survitesse Hors Aglo, Conduite de nuit, Conduite Continue
    headerRow.eachCell((cell, colNumber) => {
      if (colNumber >= yellowColumnsStartIdx) {
        // Survitesse en ville, Survitesse Hors Agglomération, Conduite de nuit, Conduite Continue - yellow
        cell.font = { bold: true, color: { argb: 'FF000000' } };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFF00' } };
      } else if (colNumber >= newColumnsStartIdx) {
        // Heure d'arrivée, Heure de départ, Délai, Kilométrage, Vitesse moy, Vitesse max - red
        cell.font = { bold: true, color: { argb: 'FF000000' } };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFF0000' } };
      } else {
        cell.font = { bold: true, color: { argb: 'FF000000' } };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFB8CCE4' } };
      }
      cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
      cell.border = {
        top: { style: 'thin' },
        left: { style: 'thin' },
        bottom: { style: 'thin' },
        right: { style: 'thin' }
      };
    });
    
    // Build Speedings sheet — two separate tables
    const speedingsSheet = workbookOut.addWorksheet('Speedings');
    const speedingHeaders = ['Camion', 'Date de début', 'Durée', 'Vitesse max.'];

    const addSpeedingTable = (sheet, title, rows, startRow) => {
      // Title row
      const titleRow = sheet.getRow(startRow);
      titleRow.getCell(1).value = title;
      titleRow.getCell(1).font = { bold: true, size: 12, color: { argb: 'FF000000' } };
      titleRow.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFBDD7EE' } };
      titleRow.getCell(1).alignment = { horizontal: 'center', vertical: 'middle' };
      sheet.mergeCells(startRow, 1, startRow, speedingHeaders.length);

      // Header row
      const headerRow = sheet.getRow(startRow + 1);
      speedingHeaders.forEach((h, i) => {
        const cell = headerRow.getCell(i + 1);
        cell.value = h;
        cell.font = { bold: true, color: { argb: 'FF000000' } };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFF00' } };
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
        cell.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
      });

      // Data rows
      rows.forEach((row, idx) => {
        const dataRow = sheet.getRow(startRow + 2 + idx);
        row.forEach((val, i) => {
          const cell = dataRow.getCell(i + 1);
          cell.value = val;
          cell.alignment = { horizontal: 'center', vertical: 'middle' };
          cell.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
        });
      });

      return startRow + 2 + rows.length; // next available row
    };

    speedingsSheet.getColumn(1).width = 18;
    speedingsSheet.getColumn(2).width = 22;
    speedingsSheet.getColumn(3).width = 12;
    speedingsSheet.getColumn(4).width = 14;

    let nextRow = 1;
    nextRow = addSpeedingTable(speedingsSheet, 'Survitesse en agglomération', allSpeedingInRows, nextRow);
    nextRow += 2;
    addSpeedingTable(speedingsSheet, 'Survitesse hors agglomération', allSpeedingOutRows, nextRow);

    // Conduite Continue sheet
    const ccSheet = workbookOut.addWorksheet('Conduite Continue');
    const ccHeaders = ['Camion', 'Début', 'Fin', 'Heures moteur', 'Temps total', 'En mouvement', 'Ralenti', 'Kilométrage'];
    const addCCTable = (sheet, title, rows, startRow) => {
      const titleRow = sheet.getRow(startRow);
      titleRow.getCell(1).value = title;
      titleRow.getCell(1).font = { bold: true, size: 12, color: { argb: 'FF000000' } };
      titleRow.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFBDD7EE' } };
      titleRow.getCell(1).alignment = { horizontal: 'center', vertical: 'middle' };
      sheet.mergeCells(startRow, 1, startRow, ccHeaders.length);
      const hRow = sheet.getRow(startRow + 1);
      ccHeaders.forEach((h, i) => {
        const cell = hRow.getCell(i + 1);
        cell.value = h;
        cell.font = { bold: true, color: { argb: 'FF000000' } };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFF00' } };
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
        cell.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
      });
      rows.forEach((row, idx) => {
        const dataRow = sheet.getRow(startRow + 2 + idx);
        row.forEach((val, i) => {
          const cell = dataRow.getCell(i + 1);
          cell.value = val;
          cell.alignment = { horizontal: 'center', vertical: 'middle' };
          cell.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
        });
      });
    };
    ccSheet.getColumn(1).width = 18;
    ccSheet.getColumn(2).width = 22;
    ccSheet.getColumn(3).width = 22;
    ccSheet.getColumn(4).width = 16;
    ccSheet.getColumn(5).width = 14;
    ccSheet.getColumn(6).width = 16;
    ccSheet.getColumn(7).width = 14;
    ccSheet.getColumn(8).width = 16;
    addCCTable(ccSheet, 'Conduite Continue', allConducteContinueRows, 1);

    // Conduite de nuit sheet
    const nightSheet = workbookOut.addWorksheet('Conduite de nuit');
    const nightHeaders = ['Camion', 'Début', 'Fin', 'Kilométrage', 'Vitesse max.', 'Lieu initial', 'Lieu final', 'Heures moteur', 'Ralenti'];
    const addNightTable = (sheet, title, rows, startRow) => {
      const titleRow = sheet.getRow(startRow);
      titleRow.getCell(1).value = title;
      titleRow.getCell(1).font = { bold: true, size: 12, color: { argb: 'FF000000' } };
      titleRow.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFBDD7EE' } };
      titleRow.getCell(1).alignment = { horizontal: 'center', vertical: 'middle' };
      sheet.mergeCells(startRow, 1, startRow, nightHeaders.length);
      const headerRow = sheet.getRow(startRow + 1);
      nightHeaders.forEach((h, i) => {
        const cell = headerRow.getCell(i + 1);
        cell.value = h;
        cell.font = { bold: true, color: { argb: 'FF000000' } };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFF00' } };
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
        cell.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
      });
      rows.forEach((row, idx) => {
        const dataRow = sheet.getRow(startRow + 2 + idx);
        row.forEach((val, i) => {
          const cell = dataRow.getCell(i + 1);
          cell.value = val;
          const isLocCol = i === 5 || i === 6; // Lieu initial / Lieu final
          cell.alignment = { horizontal: isLocCol ? 'left' : 'center', vertical: 'middle', wrapText: isLocCol };
          cell.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
        });
      });
    };
    nightSheet.getColumn(1).width = 18;
    nightSheet.getColumn(2).width = 22;
    nightSheet.getColumn(3).width = 22;
    nightSheet.getColumn(4).width = 14;
    nightSheet.getColumn(5).width = 14;
    nightSheet.getColumn(6).width = 60;
    nightSheet.getColumn(7).width = 60;
    nightSheet.getColumn(8).width = 14;
    nightSheet.getColumn(9).width = 14;
    addNightTable(nightSheet, 'Conduite de nuit', allNightRows, 1);

    const outputName = path.basename(downloadedFile).replace(/(\.\d+)_updated-with-order\.xlsx$/, '$1_rapport-effectue.xlsx');
    const outputPath = path.join(__dirname, 'downloads', outputName);
    await workbookOut.xlsx.writeFile(outputPath);
    
    console.log('\n✅ Report generation completed!');
    console.log(`💾 Excel report saved locally: ${outputPath}\n`);
    
    const originalFileName = path.basename(downloadedFile);
    await uploadToSFTP(outputPath, originalFileName);
    }
    
  } catch (error) {
    console.error('❌ Error:', error.message);
    if (error.response) {
      console.error('Response:', error.response.data);
    }
  } finally {
    try { if (sftp.sftp) await sftp.end(); } catch (_) {}
  }
}

// Run the report
const fileArg = process.argv.find(a => a.startsWith('--file='))?.split('=').slice(1).join('=') ||
  (process.argv.indexOf('--file') !== -1 ? process.argv[process.argv.indexOf('--file') + 1] : null);
generateReport(fileArg);
