const XLSX = require('xlsx');
const { sendMail } = require('./graph-mailer');
const SftpClient = require('ssh2-sftp-client');
const path = require('path');
require('dotenv').config();

const { configA } = require('../sftp/sftp-config');

const remotePath = process.env.SOURCE_DIR || '/IN';

// ─── INDIVIDUAL EMAIL (commented out — kept for reference) ───────────────────
/*
function generateEmailHTML(vehicleData) {
  const { transporteur, vehicule, camionCiterne, chauffeur, depotDepart, heureArrivee, routes } = vehicleData;
  let routesHTML = '';
  routes.forEach((route, index) => {
    const go    = route.GO ? parseFloat(route.GO).toFixed(3) : '0.000';
    const sc    = route.SC ? parseFloat(route.SC).toFixed(3) : '0.000';
    const pl    = route.PL ? parseFloat(route.PL).toFixed(3) : '0.000';
    const total = (parseFloat(go) + parseFloat(sc) + parseFloat(pl)).toFixed(3);
    routesHTML += `
    <tr>
      <td style="border:1px solid #000;padding:8px;text-align:center;">${index + 1}</td>
      <td style="border:1px solid #000;padding:8px;">${route.pointLivraison}</td>
      <td style="border:1px solid #000;padding:8px;text-align:right;">${go}</td>
      <td style="border:1px solid #000;padding:8px;text-align:right;">${sc}</td>
      <td style="border:1px solid #000;padding:8px;text-align:right;">${pl}</td>
      <td style="border:1px solid #000;padding:8px;text-align:right;">${total}</td>
    </tr>`;
  });
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body>
    <div style="background:#4472C4;color:white;padding:10px;text-align:center;font-weight:bold;">
      📍 PLAN DE TRAJET – LIVRAISON CARBURANT
    </div>
    <p><b>Transporteur :</b> ${transporteur}</p>
    <p><b>Véhicule :</b> ${vehicule}</p>
    <p><b>Chauffeur :</b> ${chauffeur}</p>
    <p><b>Dépôt de départ :</b> ${depotDepart}</p>
    <p><b>Heure d'arrivée dépôt :</b> ${heureArrivee}</p>
    <p style="color:red;font-weight:bold;">● Itinéraire optimisé (ordre consécutif)</p>
    <table style="width:100%;border-collapse:collapse;">
      <thead><tr>
        <th style="background:#4472C4;color:white;border:1px solid #000;padding:8px;">Ordre</th>
        <th style="background:#4472C4;color:white;border:1px solid #000;padding:8px;">Point de livraison</th>
        <th style="background:#4472C4;color:white;border:1px solid #000;padding:8px;">GO</th>
        <th style="background:#4472C4;color:white;border:1px solid #000;padding:8px;">SC</th>
        <th style="background:#4472C4;color:white;border:1px solid #000;padding:8px;">PL</th>
        <th style="background:#4472C4;color:white;border:1px solid #000;padding:8px;">Total (m³)</th>
      </tr></thead>
      <tbody>${routesHTML}</tbody>
    </table>
  </body></html>`;
}

async function sendRouteEmail(vehicleData, recipientEmail) {
  const subject = `Plan de Trajet - ${vehicleData.transporteur} - ${vehicleData.vehicule}`;
  try {
    const info = await transporter.sendMail({
      from: process.env.EMAIL_FROM || process.env.EMAIL_USER,
      to: recipientEmail,
      subject,
      html: generateEmailHTML(vehicleData)
    });
    console.log(`✅ Email sent to ${recipientEmail} for ${vehicleData.transporteur} - ${vehicleData.vehicule}`);
    return { success: true, messageId: info.messageId };
  } catch (error) {
    console.error(`❌ Failed to send email to ${recipientEmail}:`, error.message);
    return { success: false, error: error.message };
  }
}
*/
// ─────────────────────────────────────────────────────────────────────────────

// Format "DD.MM.YYYY HH:MM" or "DD/MM/YYYY HH:MM AM/PM" → "DD/MM/YYYY HHhMM" (24h)
function formatDateTime(value) {
  if (!value) return 'N/A';
  const m = value.toString().trim().match(/(\d{2})[./](\d{2})[./](\d{4})\s+(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)?/i);
  if (!m) return value;
  let hh = parseInt(m[4], 10);
  if (m[6]) {
    if (m[6].toUpperCase() === 'PM' && hh !== 12) hh += 12;
    if (m[6].toUpperCase() === 'AM' && hh === 12) hh = 0;
  }
  return `${m[1]}/${m[2]}/${m[3]} ${String(hh).padStart(2, '0')}h${m[5]}`;
}

// Generate one grouped HTML email for all vehicles of a transporter
function generateGroupedEmailHTML(transporteurName, vehicles, deliveryDate) {
  const dateLabel = deliveryDate ? `du ${deliveryDate}` : '';

  const vehicleListHTML = vehicles
    .map(v => `<li style="margin:4px 0;"><strong>${v.vehicule}</strong>${v.chauffeur ? ` — Chauffeur : ${v.chauffeur}` : ''}</li>`)
    .join('');

  const vehicleSectionsHTML = vehicles.map(v => {
    let routesHTML = '';
    v.routes.forEach((route, index) => {
      const go    = route.GO ? parseFloat(route.GO).toFixed(3) : '0.000';
      const sc    = route.SC ? parseFloat(route.SC).toFixed(3) : '0.000';
      const pl    = route.PL ? parseFloat(route.PL).toFixed(3) : '0.000';
      const total = (parseFloat(go) + parseFloat(sc) + parseFloat(pl)).toFixed(3);
      routesHTML += `
      <tr>
        <td style="border:1px solid #000;padding:6px;text-align:center;">${index + 1}</td>
        <td style="border:1px solid #000;padding:6px;">${route.pointLivraison}</td>
        <td style="border:1px solid #000;padding:6px;text-align:center;">${route.numBu || ''}</td>
        <td style="border:1px solid #000;padding:6px;text-align:right;">${go}</td>
        <td style="border:1px solid #000;padding:6px;text-align:right;">${sc}</td>
        <td style="border:1px solid #000;padding:6px;text-align:right;">${pl}</td>
        <td style="border:1px solid #000;padding:6px;text-align:right;">${total}</td>
      </tr>`;
    });

    return `
    <div style="margin-top:30px;border-top:3px solid #4472C4;padding-top:16px;">
      <div style="background:#4472C4;color:white;padding:8px 12px;font-weight:bold;font-size:14px;">
        🚛 Véhicule : ${v.vehicule}
      </div>
      <table style="width:100%;border-collapse:collapse;margin-top:8px;font-size:13px;">
        <tr>
          <td style="padding:4px 8px;width:50%;"><b>Chauffeur :</b> ${v.chauffeur || 'N/A'}</td>
          <td style="padding:4px 8px;"><b>Heure de RDV :</b> ${formatDateTime(v.heureArrivee)}</td>
        </tr>
        <tr>
          <td style="padding:4px 8px;"><b>Dépôt de chargement :</b> ${v.depotDepart || 'N/A'}</td>
          <td style="padding:4px 8px;"><b>Trajet :</b> ${v.routes.length} point(s) de livraison</td>
        </tr>
      </table>
      <p style="color:red;font-weight:bold;margin:10px 0 4px;">● Itinéraire optimisé (ordre consécutif)</p>
      <table style="width:100%;border-collapse:collapse;font-size:13px;">
        <thead>
          <tr>
            <th style="background:#4472C4;color:white;border:1px solid #000;padding:6px;">Ordre</th>
            <th style="background:#4472C4;color:white;border:1px solid #000;padding:6px;">Point de livraison</th>
            <th style="background:#4472C4;color:white;border:1px solid #000;padding:6px;">Numero Bon</th>
            <th style="background:#4472C4;color:white;border:1px solid #000;padding:6px;">GO</th>
            <th style="background:#4472C4;color:white;border:1px solid #000;padding:6px;">SC</th>
            <th style="background:#4472C4;color:white;border:1px solid #000;padding:6px;">PL</th>
            <th style="background:#4472C4;color:white;border:1px solid #000;padding:6px;">Total (m³)</th>
          </tr>
        </thead>
        <tbody>${routesHTML}</tbody>
      </table>
    </div>`;
  }).join('');

  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="font-family:Arial,sans-serif;max-width:900px;margin:auto;">
  <div style="background:#4472C4;color:white;padding:12px;text-align:center;font-size:16px;font-weight:bold;">
    📍 PLAN DE TRAJET – LIVRAISON CARBURANT ${dateLabel}
  </div>

  <div style="margin:16px 0;">
    <p style="margin:4px 0;"><b>Transporteur :</b> ${transporteurName}</p>
    <p style="margin:4px 0;"><b>Véhicules concernés :</b></p>
    <ul style="margin:4px 0 0 20px;">${vehicleListHTML}</ul>
  </div>

  ${vehicleSectionsHTML}
</body>
</html>`;
}

async function sendGroupedEmail(transporteurName, email, vehicles, deliveryDate) {
  const dateLabel = deliveryDate ? ` – ${deliveryDate}` : '';
  const subject = `Plan de Trajet de Livraison${dateLabel} – ${transporteurName}`;
  const html = generateGroupedEmailHTML(transporteurName, vehicles, deliveryDate);
  try {
    await sendMail({ to: email, subject, html });
    console.log(`✅ Grouped email sent to ${email} (${transporteurName} — ${vehicles.length} vehicle(s))`);
    return true;
  } catch (error) {
    console.error(`❌ Failed to send email to ${email} (${transporteurName}):`, error.message);
    return false;
  }
}

async function downloadUpdatedFileFromSFTP() {
  const sftp = new SftpClient();
  try {
    console.log('📥 Connecting to SFTP to download updated file...\n');
    await sftp.connect(configA);
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
    const localPath = path.join(__dirname, '../../downloads', latestFile.name);
    console.log(`📥 Downloading: ${latestFile.name}...`);
    await sftp.get(`${remotePath}/${latestFile.name}`, localPath);
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
  console.log('📧 Processing Excel file and sending grouped route emails...\n');

  const workbook = XLSX.readFile(excelPath);
  const worksheet = workbook.Sheets[workbook.SheetNames[0]];
  const data = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: '' });

  const headers = data[0];
  const transporteurIdx = headers.findIndex(h => h && h.toString().toLowerCase().includes('transporteur'));
  const vehiculeIdx     = headers.findIndex(h => h && (h.toString().toLowerCase().includes('camion') || h.toString().toLowerCase().includes('vehicule')));
  const emailIdx        = headers.findIndex(h => h && h.toString().toLowerCase().includes('email transp'));
  const chauffeurIdx    = headers.findIndex(h => h && h.toString().toLowerCase().includes('chauffeur'));
  const rvArriveIdx     = headers.findIndex(h => h && h.toString().toLowerCase().includes('rv arrivé parking'));
  const coordIdx        = headers.findIndex(h => h && h.toString().toLowerCase().includes('coordonnees zone'));
  const villeIdx        = headers.findIndex(h => h && h.toString().toLowerCase().includes('ville'));
  const trajectIdx      = headers.findIndex(h => h && h.toString().toLowerCase().includes('trajet'));
  const numBuIdx        = headers.findIndex(h => h && h.toString().toLowerCase().includes('num bu'));
  const goIdx           = headers.findIndex(h => h === 'GO');
  const scIdx           = headers.findIndex(h => h === 'SC');
  const plIdx           = headers.findIndex(h => h === 'PL');

  // Extract delivery date from first data row
  const dateIdx = headers.findIndex(h => h && h.toString().toLowerCase().includes('date'));
  let deliveryDate = '';
  if (dateIdx !== -1 && data[1] && data[1][dateIdx]) {
    const raw = data[1][dateIdx];
    let d = null;
    if (typeof raw === 'number') d = new Date((raw - 25569) * 86400 * 1000);
    else if (typeof raw === 'string') d = new Date(raw);
    if (d && !isNaN(d.getTime())) {
      deliveryDate = d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' });
    }
  }

  // Group by transporteur → then by vehicle
  const transporteurMap = {};

  for (let i = 1; i < data.length; i++) {
    const row         = data[i];
    const transporteur = row[transporteurIdx];
    const vehicule    = row[vehiculeIdx];
    if (!transporteur || !vehicule) continue;

    if (!transporteurMap[transporteur]) {
      transporteurMap[transporteur] = { email: row[emailIdx], vehicles: {} };
    }
    // Always keep the latest email found for this transporter
    if (row[emailIdx]) transporteurMap[transporteur].email = row[emailIdx];

    if (!transporteurMap[transporteur].vehicles[vehicule]) {
      transporteurMap[transporteur].vehicles[vehicule] = {
        vehicule,
        chauffeur:   row[chauffeurIdx] || '',
        heureArrivee: '',
        depotDepart: '',
        routes: []
      };
    }

    const veh = transporteurMap[transporteur].vehicles[vehicule];

    // Parking row: no trajet order, coordonnees zone contains "parking"
    const isParking = !row[trajectIdx] && row[coordIdx] && row[coordIdx].toString().toLowerCase().includes('parking');
    if (isParking) {
      if (!veh.depotDepart) veh.depotDepart = row[coordIdx];
      if (!veh.heureArrivee && row[rvArriveIdx]) veh.heureArrivee = row[rvArriveIdx];
    }

    // Fallback: if no parking row found, use Trajet 1 row
    if (row[trajectIdx] === 1 && row[coordIdx]) {
      if (!veh.depotDepart) veh.depotDepart = row[coordIdx];
      if (!veh.heureArrivee && row[rvArriveIdx]) veh.heureArrivee = row[rvArriveIdx];
    }

    if (row[trajectIdx] && row[coordIdx] && !row[coordIdx].toString().toLowerCase().includes('parking')) {
      veh.routes.push({
        ordre:          row[trajectIdx],
        pointLivraison: row[coordIdx],
        numBu:          numBuIdx !== -1 ? (row[numBuIdx] || '') : '',
        ville:          row[villeIdx] || '',
        GO:             row[goIdx] || 0,
        SC:             row[scIdx] || 0,
        PL:             row[plIdx] || 0
      });
    }
  }

  let successCount = 0, failCount = 0;
  const entries = Object.entries(transporteurMap);
  console.log(`📨 Sending grouped emails to ${entries.length} transporter(s)...\n`);

  for (const [transporteurName, { email, vehicles }] of entries) {
    const vehicleList = Object.values(vehicles).filter(v => v.routes.length > 0);
    if (!email || vehicleList.length === 0) {
      console.log(`⚠️  Skipping ${transporteurName}: ${!email ? 'no email' : 'no routes'}`);
      continue;
    }
    const ok = await sendGroupedEmail(transporteurName, email, vehicleList, deliveryDate);
    ok ? successCount++ : failCount++;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  console.log(`\n📊 Summary: ${successCount} emails sent, ${failCount} failed`);
}

if (require.main === module) {
  (async () => {
    const excelPath = await downloadUpdatedFileFromSFTP();
    if (!excelPath) { console.log('❌ Could not retrieve updated file from SFTP.'); process.exit(1); }
    await processExcelAndSendEmails(excelPath);
    console.log('\n✅ Email processing completed');
  })().catch(error => { console.error('\n❌ Error:', error.message); process.exit(1); });
}

module.exports = { processExcelAndSendEmails };
