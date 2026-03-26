const XLSX = require('xlsx');
const nodemailer = require('nodemailer');
const SftpClient = require('ssh2-sftp-client');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const sftpConfig = {
  host: process.env.SFTP_HOST,
  port: process.env.SFTP_PORT || 22,
  username: process.env.SFTP_USERNAME,
  password: process.env.SFTP_PASSWORD,
};

const remotePath = process.env.SFTP_REMOTE_PATH || '/IN';

// Email transporter configuration
const transporter = nodemailer.createTransport({
  host: process.env.EMAIL_HOST || 'smtp.gmail.com',
  port: process.env.EMAIL_PORT || 587,
  secure: false,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASSWORD
  }
});

function generateEmailHTML(vehicleData) {
  const { transporteur, vehicule, camionCiterne, chauffeur, depotDepart, heureArrivee, routes } = vehicleData;
  
  let routesHTML = '';
  routes.forEach((route, index) => {
    const step = index + 1;
    const go = route.GO ? parseFloat(route.GO).toFixed(3) : '0.000';
    const sc = route.SC ? parseFloat(route.SC).toFixed(3) : '0.000';
    const pl = route.PL ? parseFloat(route.PL).toFixed(3) : '0.000';
    const total = (parseFloat(go) + parseFloat(sc) + parseFloat(pl)).toFixed(3);
    
    routesHTML += `
    <tr>
      <td style="border: 1px solid #000; padding: 8px; text-align: center;">${step}</td>
      <td style="border: 1px solid #000; padding: 8px;">${route.pointLivraison}</td>
      <td style="border: 1px solid #000; padding: 8px; text-align: right;">${go}</td>
      <td style="border: 1px solid #000; padding: 8px; text-align: right;">${sc}</td>
      <td style="border: 1px solid #000; padding: 8px; text-align: right;">${pl}</td>
      <td style="border: 1px solid #000; padding: 8px; text-align: right;">${total}</td>
    </tr>`;
  });
  
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    body { font-family: Arial, sans-serif; }
    .header { background-color: #4472C4; color: white; padding: 10px; text-align: center; font-size: 14px; font-weight: bold; }
    .info-section { margin: 20px 0; }
    .info-row { margin: 5px 0; }
    .label { font-weight: bold; }
    table { width: 100%; border-collapse: collapse; margin-top: 20px; }
    th { background-color: #4472C4; color: white; border: 1px solid #000; padding: 8px; text-align: center; }
    td { border: 1px solid #000; padding: 8px; }
  </style>
</head>
<body>
  <div class="header">📍 PLAN DE TRAJET – LIVRAISON CARBURANT</div>
  
  <div class="info-section">
    <div class="info-row"><span class="label">Transporteur :</span> ${transporteur}</div>
    <div class="info-row"><span class="label">Véhicule:</span> ${vehicule}</div>
    <div class="info-row"><span class="label">Camion-citerne :</span> ${camionCiterne}</div>
    <div class="info-row"><span class="label">Chauffeur :</span> ${chauffeur}</div>
  </div>
  
  <div class="info-section">
    <div class="info-row"><span class="label">Dépôt de départ :</span> ${depotDepart}</div>
    <div class="info-row"><span class="label">Heure D'arrivée Dépôt:</span> ${heureArrivee}</div>
  </div>
  
  <div style="margin-top: 20px;">
    <div style="color: red; font-weight: bold;">● Itinéraire optimisé (ordre consécutif)</div>
  </div>
  
  <table>
    <thead>
      <tr>
        <th>Ordre</th>
        <th>Point de livraison</th>
        <th>GO</th>
        <th>SC</th>
        <th>PL</th>
        <th>Total (m³)</th>
      </tr>
    </thead>
    <tbody>
      ${routesHTML}
    </tbody>
  </table>
</body>
</html>
  `;
}

async function sendRouteEmail(vehicleData, recipientEmail) {
  const subject = `Plan de Trajet - ${vehicleData.transporteur} - ${vehicleData.vehicule}`;
  const html = generateEmailHTML(vehicleData);
  
  const mailOptions = {
    from: process.env.EMAIL_FROM || process.env.EMAIL_USER,
    to: recipientEmail,
    subject: subject,
    html: html
  };
  
  try {
    const info = await transporter.sendMail(mailOptions);
    console.log(`✅ Email sent to ${recipientEmail} for ${vehicleData.transporteur} - ${vehicleData.vehicule}`);
    return { success: true, messageId: info.messageId };
  } catch (error) {
    console.error(`❌ Failed to send email to ${recipientEmail}:`, error.message);
    return { success: false, error: error.message };
  }
}

async function downloadUpdatedFileFromSFTP() {
  const sftp = new SftpClient();
  
  try {
    console.log('📥 Connecting to SFTP to download updated file...\n');
    await sftp.connect(sftpConfig);
    
    const fileList = await sftp.list(remotePath);
    const updatedFiles = fileList
      .filter(f => f.name.includes('_updated-with-order.xlsx'))
      .sort((a, b) => b.modifyTime - a.modifyTime);
    
    if (updatedFiles.length === 0) {
      console.log('❌ No updated file found on SFTP server.');
      await sftp.end();
      return null;
    }
    
    const latestFile = updatedFiles[0];
    const remoteFilePath = `${remotePath}/${latestFile.name}`;
    const localPath = path.join(__dirname, '../../downloads', latestFile.name);
    
    console.log(`📥 Downloading: ${latestFile.name}...`);
    await sftp.get(remoteFilePath, localPath);
    console.log(`✅ Downloaded to: ${localPath}\n`);
    
    await sftp.end();
    return localPath;
    
  } catch (error) {
    console.error('❌ SFTP Error:', error.message);
    await sftp.end();
    return null;
  }
}

async function processExcelAndSendEmails(excelPath) {
  console.log('📧 Processing Excel file and sending route emails...\n');
  
  const workbook = XLSX.readFile(excelPath);
  const sheetName = workbook.SheetNames[0];
  const worksheet = workbook.Sheets[sheetName];
  const data = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: '' });
  
  const headers = data[0];
  const transporteurIdx = headers.findIndex(h => h && h.toString().toLowerCase().includes('transporteur'));
  const vehiculeIdx = headers.findIndex(h => h && (h.toString().toLowerCase().includes('camion') || h.toString().toLowerCase().includes('vehicule')));
  const emailIdx = headers.findIndex(h => h && h.toString().toLowerCase().includes('email transp'));
  const dateIdx = headers.findIndex(h => h && h.toString().toLowerCase().includes('date'));
  const chauffeurIdx = headers.findIndex(h => h && h.toString().toLowerCase().includes('chauffeur'));
  const rvArriveIdx = headers.findIndex(h => h && h.toString().toLowerCase().includes('rv arrivé parking'));
  const coordIdx = headers.findIndex(h => h && h.toString().toLowerCase().includes('coordonnees zone'));
  const villeIdx = headers.findIndex(h => h && h.toString().toLowerCase().includes('ville'));
  const trajectIdx = headers.findIndex(h => h && h.toString().toLowerCase().includes('trajet'));
  const goIdx = headers.findIndex(h => h === 'GO');
  const scIdx = headers.findIndex(h => h === 'SC');
  const plIdx = headers.findIndex(h => h === 'PL');
  
  // Group by vehicle
  const vehicleGroups = {};
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const transporteur = row[transporteurIdx];
    const vehicule = row[vehiculeIdx];
    const key = `${transporteur}|${vehicule}`;
    
    if (!vehicleGroups[key]) {
      vehicleGroups[key] = {
        transporteur,
        vehicule,
        email: row[emailIdx],
        date: row[dateIdx],
        chauffeur: row[chauffeurIdx],
        depotDepart: '',
        heureArrivee: row[rvArriveIdx],
        camionCiterne: '',
        routes: []
      };
    }
    
    // Set depot depart from first trajectory (trajet 1)
    if (row[trajectIdx] === 1 && row[coordIdx]) {
      vehicleGroups[key].depotDepart = row[coordIdx];
    }
    
    // Only add rows with trajectory numbers (actual delivery points)
    if (row[trajectIdx] && row[coordIdx] && !row[coordIdx].toString().toLowerCase().includes('parking')) {
      vehicleGroups[key].routes.push({
        ordre: row[trajectIdx],
        pointLivraison: row[coordIdx],
        ville: row[villeIdx] || '',
        GO: row[goIdx] || 0,
        SC: row[scIdx] || 0,
        PL: row[plIdx] || 0
      });
    }
  }
  
  // Send emails to all vehicles with their actual emails
  const vehicles = Object.values(vehicleGroups);
  
  if (vehicles.length === 0) {
    console.log('❌ No vehicles found in Excel file');
    return;
  }
  
  console.log(`\n📨 Sending emails to ${vehicles.length} transporters...\n`);
  
  let successCount = 0;
  let failCount = 0;
  
  for (const vehicle of vehicles) {
    if (vehicle.email && vehicle.routes.length > 0) {
      console.log(`📧 Sending to ${vehicle.email} (${vehicle.transporteur} - ${vehicle.vehicule})...`);
      const result = await sendRouteEmail(vehicle, vehicle.email);
      
      if (result.success) {
        successCount++;
      } else {
        failCount++;
      }
      
      // Add delay to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 1000));
    } else {
      console.log(`⚠️  Skipping ${vehicle.transporteur} - ${vehicle.vehicule}: ${!vehicle.email ? 'No email' : 'No routes'}`);
    }
  }
  
  console.log(`\n📊 Summary: ${successCount} emails sent successfully, ${failCount} failed`);
}

if (require.main === module) {
  (async () => {
    // Download updated file from SFTP
    const excelPath = await downloadUpdatedFileFromSFTP();
    
    if (!excelPath) {
      console.log('❌ Could not retrieve updated file from SFTP.');
      process.exit(1);
    }
    
    // Process and send emails
    await processExcelAndSendEmails(excelPath);
    console.log('\n✅ Email processing completed');
  })().catch(error => {
    console.error('\n❌ Error:', error.message);
    process.exit(1);
  });
}

module.exports = { sendRouteEmail, processExcelAndSendEmails };
