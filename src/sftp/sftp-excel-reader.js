const SftpClient = require('ssh2-sftp-client');
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const { configA: sftpConfig, remotePath } = require('./sftp-config');

// ── Camtrack server config (COMMENTED OUT — now using Galana via sftp-config.js)
// const sftpConfig = {
//   host: process.env.SFTP_HOST || 'bi.camtrack.mg',
//   port: process.env.SFTP_PORT || 22,
//   username: process.env.SFTP_USERNAME || 'usertestgalana',
//   password: process.env.SFTP_PASSWORD
// };
const localDownloadPath = path.join(__dirname, '../../downloads');

// Ensure download directory exists
if (!fs.existsSync(localDownloadPath)) {
  fs.mkdirSync(localDownloadPath, { recursive: true });
}

async function connectAndDownloadExcel() {
  const sftp = new SftpClient();
  
  try {
    console.log('🔌 Connecting to SFTP server...');
    console.log(`   Host: ${sftpConfig.host}`);
    console.log(`   User: ${sftpConfig.username}\n`);
    
    await sftp.connect(sftpConfig);
    console.log('✅ Connected successfully!\n');
    
    // List files in the IN folder
    console.log(`📂 Listing files in ${remotePath}...`);
    const fileList = await sftp.list(remotePath);
    
    // Filter Excel files starting with "Livraison" and exclude updated files
    const excelFiles = fileList.filter(file => 
      file.name.startsWith('Livraison') && 
      file.name.match(/\.\d+\.xlsx$/) &&
      !file.name.includes('_updated-with-order')
    );
    
    if (excelFiles.length === 0) {
      console.log('❌ No Excel files matching pattern "Livraison*.N.xlsx" found in the IN folder.');
      return;
    }
    
    console.log(`\n📊 Found ${excelFiles.length} Excel file(s):`);
    excelFiles.forEach((file, index) => {
      console.log(`   ${index + 1}. ${file.name} (${(file.size / 1024).toFixed(2)} KB)`);
    });
    
    // Download the first Excel file (or you can modify to download all)
    const fileToDownload = excelFiles[0];
    const remoteFilePath = `${remotePath}/${fileToDownload.name}`;
    const localFilePath = path.join(localDownloadPath, fileToDownload.name);
    
    console.log(`\n⬇️  Downloading: ${fileToDownload.name}...`);
    await sftp.get(remoteFilePath, localFilePath);
    console.log(`✅ Downloaded to: ${localFilePath}\n`);
    
    await sftp.end();
    console.log('🔌 SFTP connection closed.\n');
    
    // Parse the Excel file
    parseExcelFile(localFilePath);
    
  } catch (error) {
    console.error('❌ Error:', error.message);
    if (error.code === 'ENOTFOUND') {
      console.error('   → Check your SFTP host address');
    } else if (error.code === 'ECONNREFUSED') {
      console.error('   → Connection refused. Check host and port');
    } else if (error.message.includes('authentication')) {
      console.error('   → Check your username and password');
    }
  } finally {
    await sftp.end();
  }
}

function parseExcelFile(filePath) {
  try {
    console.log('📖 Reading Excel file...');
    
    // Read the Excel file
    const workbook = XLSX.readFile(filePath);
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    
    console.log(`   Sheet: ${sheetName}\n`);
    
    // Convert to JSON
    const data = XLSX.utils.sheet_to_json(worksheet, { header: 1 });
    
    if (data.length === 0) {
      console.log('❌ Excel file is empty.');
      return;
    }
    
    // Find columns
    const headers = data[0];
    const coordColumnIndex = headers.findIndex(header => 
      header && header.toString().toLowerCase().includes('coordonnees zone')
    );
    const prioriteColumnIndex = headers.findIndex(header => 
      header && header.toString().toLowerCase().includes('priorite')
    );
    const transporteurColumnIndex = headers.findIndex(header => 
      header && header.toString().toLowerCase().includes('transporteur')
    );
    const camionColumnIndex = headers.findIndex(header => 
      header && (header.toString().toLowerCase().includes('camion') || 
                 header.toString().toLowerCase().includes('vehicule') ||
                 header.toString().toLowerCase().includes('vehicle'))
    );
    const goIndex = headers.findIndex(h => h === 'GO');
    const scIndex = headers.findIndex(h => h === 'SC');
    const plIndex = headers.findIndex(h => h === 'PL');
    const foIndex = headers.findIndex(h => h === 'FO');
    
    if (coordColumnIndex === -1) {
      console.log('❌ Column "Coordonnees Zone" not found.');
      console.log('   Available columns:', headers.join(', '));
      return;
    }
    
    if (transporteurColumnIndex === -1) {
      console.log('❌ Column "Transporteur" not found.');
      console.log('   Available columns:', headers.join(', '));
      return;
    }
    
    if (camionColumnIndex === -1) {
      console.log('⚠️  Column "Camion" not found. Will group by Transporteur only.');
      console.log('   Available columns:', headers.join(', '));
    }
    
    console.log('✅ Found column "Coordonnees Zone" at index', coordColumnIndex);
    console.log('✅ Found column "Transporteur" at index', transporteurColumnIndex);
    if (camionColumnIndex !== -1) {
      console.log('✅ Found column "Camion" at index', camionColumnIndex);
    }
    console.log('\n' + '='.repeat(70));
    console.log('🚚 TRANSPORTEURS, VEHICLES AND COORDINATES (Filtered by GO/SC/PL/FO):');
    console.log('='.repeat(70) + '\n');
    
    // Find rows with GO/SC/PL/FO values
    const rowsToInclude = new Set();
    for (let i = 1; i < data.length; i++) {
      const hasActivity = data[i][goIndex] || data[i][scIndex] || data[i][plIndex] || data[i][foIndex];
      if (hasActivity) {
        rowsToInclude.add(i);
        if (i > 1) rowsToInclude.add(i - 1);
      }
    }
    
    // Group by transporteur -> camion -> coordinates (only filtered rows)
    const transporteurMap = {};
    
    // Group rows by vehicle
    const vehicleGroups = {};
    for (let i = 1; i < data.length; i++) {
      if (!rowsToInclude.has(i)) continue;
      
      const transporteur = data[i][transporteurColumnIndex];
      const camion = camionColumnIndex !== -1 ? data[i][camionColumnIndex] : 'N/A';
      const coordinate = data[i][coordColumnIndex];
      const priorite = prioriteColumnIndex !== -1 ? data[i][prioriteColumnIndex] : '';
      const hasProduct = data[i][goIndex] || data[i][scIndex] || data[i][plIndex] || data[i][foIndex];
      
      if (transporteur && coordinate) {
        if (!transporteurMap[transporteur]) {
          transporteurMap[transporteur] = {};
        }
        if (!transporteurMap[transporteur][camion]) {
          transporteurMap[transporteur][camion] = [];
        }
        transporteurMap[transporteur][camion].push({ coord: coordinate, priorite, hasProduct });
      }
    }
    
    // Display grouped data
    let totalTransporteurs = 0;
    let totalVehicles = 0;
    let totalCoordinates = 0;
    
    Object.keys(transporteurMap).forEach((transporteur) => {
      totalTransporteurs++;
      console.log(`\n📦 ${transporteur}`);
      
      const vehicles = transporteurMap[transporteur];
      Object.keys(vehicles).forEach((camion) => {
        totalVehicles++;
        const coords = vehicles[camion];
        console.log(`   🚛 ${camion}`);
        console.log(`      Coordinates (${coords.length}):`);
        coords.forEach((item, i) => {
          const priorityLabel = item.priorite && item.priorite.toString().toLowerCase() === 'haute' ? ' [HAUTE PRIORITÉ]' : '';
          console.log(`         ${i + 1}. ${item.coord}${priorityLabel}`);
          totalCoordinates++;
        });
      });
    });
    
    console.log('\n' + '='.repeat(70));
    console.log(`📊 Total: ${totalTransporteurs} transporteurs`);
    console.log(`📊 Total: ${totalVehicles} vehicles`);
    console.log(`📊 Total: ${totalCoordinates} coordinate entries`);
    console.log('='.repeat(70) + '\n');
    
    // Save to JSON file
    const outputPath = path.join(localDownloadPath, 'transporteurs-vehicles-coordinates.json');
    fs.writeFileSync(outputPath, JSON.stringify(transporteurMap, null, 2));
    console.log(`💾 Data saved to: ${outputPath}\n`);
    
    return transporteurMap;
    
  } catch (error) {
    console.error('❌ Error parsing Excel file:', error.message);
  }
}

// If you want to test with local file first
function testLocalFile() {
  const localFile = './Livraison 11-12-2025 - test.xlsx';
  if (fs.existsSync(localFile)) {
    console.log('🧪 Testing with local file...\n');
    parseExcelFile(localFile);
  } else {
    console.log('❌ Local test file not found.');
  }
}

// Main execution
const args = process.argv.slice(2);
if (args.includes('--local')) {
  testLocalFile();
} else {
  connectAndDownloadExcel();
}
