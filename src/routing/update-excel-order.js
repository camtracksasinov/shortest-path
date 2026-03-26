const XLSX = require('xlsx');
const ExcelJS = require('exceljs');
const fs = require('fs');
const path = require('path');

async function updateExcelWithRouteOrder(excelPath, optimalRoutesPath) {
  console.log('📝 Updating Excel with optimal route order...\n');
  
  const workbook = XLSX.readFile(excelPath, { cellStyles: true });
  const sheetName = workbook.SheetNames[0];
  const worksheet = workbook.Sheets[sheetName];
  const data = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: '' });
  
  const optimalRoutes = JSON.parse(fs.readFileSync(optimalRoutesPath, 'utf8'));
  
  const headers = data[0];
  let coordIdx = headers.findIndex(h => h && h.toString().toLowerCase().includes('coordonnees zone'));
  let numCommandeIdx = headers.findIndex(h => h && h.toString().toLowerCase().includes('num commande'));
  let numBUIdx = headers.findIndex(h => h && h.toString().toLowerCase().includes('num bu'));
  let trajectIdx = headers.findIndex(h => h && h.toString().toLowerCase().includes('trajet'));
  let transporteurIdx = headers.findIndex(h => h && h.toString().toLowerCase().includes('transporteur'));
  let camionIdx = headers.findIndex(h => h && (h.toString().toLowerCase().includes('camion') || h.toString().toLowerCase().includes('vehicule')));
  let goIdx = headers.findIndex(h => h === 'GO');
  let scIdx = headers.findIndex(h => h === 'SC');
  let plIdx = headers.findIndex(h => h === 'PL');
  let foIdx = headers.findIndex(h => h === 'FO');
  let prioriteIdx = headers.findIndex(h => h && h.toString().toLowerCase().includes('priorite'));

  // Add "Trajet" column if missing — insert before "Coordonnees Zone"
  if (trajectIdx === -1) {
    const insertAt = coordIdx;
    headers.splice(insertAt, 0, 'Trajet');
    for (let i = 1; i < data.length; i++) {
      data[i].splice(insertAt, 0, '');
    }
    trajectIdx = insertAt;
    // Shift all column indices that were at or after the insertion point
    const shiftIfNeeded = idx => (idx !== -1 && idx >= insertAt) ? idx + 1 : idx;
    coordIdx = shiftIfNeeded(coordIdx);
    numCommandeIdx = shiftIfNeeded(numCommandeIdx);
    numBUIdx = shiftIfNeeded(numBUIdx);
    transporteurIdx = shiftIfNeeded(transporteurIdx);
    camionIdx = shiftIfNeeded(camionIdx);
    goIdx = shiftIfNeeded(goIdx);
    scIdx = shiftIfNeeded(scIdx);
    plIdx = shiftIfNeeded(plIdx);
    foIdx = shiftIfNeeded(foIdx);
    prioriteIdx = shiftIfNeeded(prioriteIdx);
    console.log('  ℹ️  "Trajet" column not found — added before "Coordonnees Zone"');
  }
  
  // Group rows by vehicle
  const vehicleGroups = {};
  for (let i = 1; i < data.length; i++) {
    const transporteur = data[i][transporteurIdx];
    const camion = data[i][camionIdx];
    const key = `${transporteur}|${camion}`;
    if (!vehicleGroups[key]) vehicleGroups[key] = [];
    vehicleGroups[key].push({ index: i, coord: data[i][coordIdx], row: [...data[i]] });
  }
  
  const newData = [headers];
  
  // Process each vehicle group
  for (const [key, rows] of Object.entries(vehicleGroups)) {
    const route = optimalRoutes[key.split('|')[0]]?.[key.split('|')[1]]?.route;
    if (!route) {
      rows.forEach(r => newData.push(r.row));
      continue;
    }
    
    const processed = new Set();
    const ordered = [];
    
    // Add parking rows first
    rows.filter(r => r.coord && r.coord.toString().toLowerCase().includes('parking')).forEach(r => {
      ordered.push(r);
      processed.add(r.index);
    });
    
    // Process route stops and merge duplicates
    for (const stop of route) {
      const matches = rows.filter(r => r.coord === stop.name && !processed.has(r.index));
      
      if (matches.length > 1) {
        const mergedRow = [...matches[0].row];
        const numCommandes = [];
        const numBUs = [];
        let goSum = 0, scSum = 0, plSum = 0, foSum = 0;
        let prioriteValue = '';
        
        matches.forEach(m => {
          if (m.row[numCommandeIdx]) numCommandes.push(m.row[numCommandeIdx]);
          if (m.row[numBUIdx]) numBUs.push(m.row[numBUIdx]);
          goSum += (parseFloat(m.row[goIdx]) || 0);
          scSum += (parseFloat(m.row[scIdx]) || 0);
          plSum += (parseFloat(m.row[plIdx]) || 0);
          foSum += (parseFloat(m.row[foIdx]) || 0);
          if (prioriteIdx !== -1 && m.row[prioriteIdx] && !prioriteValue) prioriteValue = m.row[prioriteIdx];
          processed.add(m.index);
        });
        
        if (numCommandeIdx !== -1) mergedRow[numCommandeIdx] = numCommandes.join('-');
        if (numBUIdx !== -1) mergedRow[numBUIdx] = numBUs.join('-');
        if (goIdx !== -1 && goSum > 0) mergedRow[goIdx] = goSum.toFixed(2);
        if (scIdx !== -1 && scSum > 0) mergedRow[scIdx] = scSum.toFixed(2);
        if (plIdx !== -1 && plSum > 0) mergedRow[plIdx] = plSum.toFixed(2);
        if (foIdx !== -1 && foSum > 0) mergedRow[foIdx] = foSum.toFixed(2);
        if (prioriteIdx !== -1 && prioriteValue) mergedRow[prioriteIdx] = prioriteValue;
        
        ordered.push({ index: matches[0].index, coord: matches[0].coord, row: mergedRow });
      } else if (matches.length === 1) {
        ordered.push({ index: matches[0].index, coord: matches[0].coord, row: [...matches[0].row] });
        processed.add(matches[0].index);
      }
    }
    
    // Add remaining unprocessed rows
    rows.forEach(r => { 
      if (!processed.has(r.index)) ordered.push(r); 
    });
    
    // Set trajectory numbers after merging
    let trajectCount = 0;
    ordered.forEach(item => {
      const isParking = item.row[coordIdx] && item.row[coordIdx].toString().toLowerCase().includes('parking');
      const isDepot = item.row[coordIdx] && item.row[coordIdx].toString().toLowerCase().includes('depot') && !isParking;
      if (isDepot || (!isParking && !isDepot)) {
        trajectCount++;
        if (trajectIdx !== -1) item.row[trajectIdx] = trajectCount;
      }
    });
    
    ordered.forEach(r => newData.push(r.row));
  }
  
  const baseName = path.basename(excelPath, '.xlsx');
  const outputPath = path.join(path.dirname(excelPath), `${baseName}_updated-with-order.xlsx`);
  
  const ejWorkbook = new ExcelJS.Workbook();
  const ejWorksheet = ejWorkbook.addWorksheet(sheetName);
  
  ejWorksheet.addRows(newData);
  
  const headerRow = ejWorksheet.getRow(1);
  headerRow.height = 45;
  headerRow.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFB0C4DE' } };
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    cell.border = {
      top: { style: 'thin' },
      left: { style: 'thin' },
      bottom: { style: 'thin' },
      right: { style: 'thin' }
    };
  });
  
  const originalColWidths = worksheet['!cols'] || [];
  for (let i = 0; i < headers.length; i++) {
    ejWorksheet.getColumn(i + 1).width = originalColWidths[i]?.wch || 15;
  }
  
  await ejWorkbook.xlsx.writeFile(outputPath);
  
  console.log(`✅ Excel updated with route order`);
  console.log(`💾 Saved to: ${outputPath}`);
  console.log(`📊 Reordered all fields (except Coordonnees Zone) based on optimal route\n`);
  
  return outputPath;
}

if (require.main === module) {
  const downloadDir = path.join(__dirname, '../../downloads');
  // Only process files that match the SFTP download pattern (Livraison*.N.xlsx)
  const files = fs.readdirSync(downloadDir)
    .filter(f => f.startsWith('Livraison') && f.match(/\.\d+\.xlsx$/))
    .map(f => ({ name: f, path: path.join(downloadDir, f), time: fs.statSync(path.join(downloadDir, f)).mtime.getTime() }))
    .sort((a, b) => b.time - a.time);

  if (files.length === 0) {
    console.log('❌ No Livraison Excel file found.');
    process.exit(1);
  }
  
  const optimalRoutesPath = './downloads/optimal-routes.json';
  if (!fs.existsSync(optimalRoutesPath)) {
    console.log('❌ Optimal routes not found.');
    process.exit(1);
  }
  
  (async () => {
    for (const file of files) {
      console.log(`📄 Processing file: ${file.name}\n`);
      await updateExcelWithRouteOrder(file.path, optimalRoutesPath);
    }
  })();
}

module.exports = { updateExcelWithRouteOrder };
