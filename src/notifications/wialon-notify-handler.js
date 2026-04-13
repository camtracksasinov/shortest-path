const XLSX = require('xlsx');
const nodemailer = require('nodemailer');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const SftpClient = require('ssh2-sftp-client');
require('dotenv').config();

const { configA } = require('../sftp/sftp-config');

const DOWNLOADS = path.join(__dirname, '../../downloads');
const ACTIVE_DIR = path.join(__dirname, '../../active');
const OSRM_URL = process.env.OSRM_URL || 'http://router.project-osrm.org';
const TIMEZONE_OFFSET = parseInt(process.env.TIMEZONE_OFFSET || '2');
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'ulrich.kamsu@camtrack.net';

const mailer = nodemailer.createTransport({
  host: process.env.EMAIL_HOST || 'smtp.office365.com',
  port: parseInt(process.env.EMAIL_PORT || '587'),
  secure: false,
  auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASSWORD }
});

function nowMadagascar() {
  return new Date().toLocaleString('fr-FR', { timeZone: 'Indian/Antananarivo', hour12: false });
}

async function sendAdminEmail(subject, html) {
  try {
    await mailer.sendMail({
      from: process.env.EMAIL_FROM || process.env.EMAIL_USER,
      to: ADMIN_EMAIL,
      subject,
      html
    });
  } catch (e) {
    console.error('❌ Admin email failed:', e.message);
  }
}

// ── Parse date string DD-MM-YYYY from filename ────────────────────────────────
function parseDateFromName(name) {
  const m = name.match(/(\d{2})-(\d{2})-(\d{4})/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

// ── In-memory cache: reloaded once per day ────────────────────────────────────
let _cache = null; // { date: 'YYYY-MM-DD', allRows: [...] }

// ── Load all today's _updated-with-order files (local + SFTP) ─────────────────
async function loadTodayExcelFiles() {
  const todayStr = new Date().toISOString().split('T')[0];

  if (_cache?.date === todayStr) return _cache.allRows;

  const isTodayFile = name =>
    name.startsWith('Livraison') &&
    name.match(/\.\d+_updated-with-order\.xlsx$/) &&
    parseDateFromName(name) === todayStr;

  // 1. Read from active/ — match files whose date is today OR tomorrow
  //    (run-all.js generates tomorrow's files today, they become active at midnight)
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = tomorrow.toISOString().split('T')[0];

  const isActiveFile = name =>
    name.startsWith('Livraison') &&
    name.match(/\.\d+_updated-with-order\.xlsx$/) &&
    (parseDateFromName(name) === todayStr || parseDateFromName(name) === tomorrowStr);

  let localFiles = fs.existsSync(ACTIVE_DIR)
    ? fs.readdirSync(ACTIVE_DIR).filter(isActiveFile).map(n => path.join(ACTIVE_DIR, n))
    : [];

  // 2. Fall back to SFTP only if active/ has nothing for today/tomorrow
  if (localFiles.length === 0) {
    const sftp = new SftpClient();
    try {
      await sftp.connect(configA);
      const list = await sftp.list('/IN');
      for (const f of list.filter(f => isActiveFile(f.name))) {
        const local = path.join(ACTIVE_DIR, f.name);
        console.log(`  📥 Fetching from SFTP: ${f.name}`);
        await sftp.get(`/IN/${f.name}`, local);
        localFiles.push(local);
      }
      await sftp.end();
    } catch (err) {
      console.error('  ⚠️  SFTP fallback failed:', err.message);
      try { await sftp.end(); } catch (_) {}
    }
  }

  if (localFiles.length === 0) {
    console.log(`  ℹ️  No today's updated files found for ${todayStr}`);
    return null;
  }

  // 3. Parse and merge all files into one row array
  const allRows = [];
  for (const filePath of localFiles) {
    try {
      const wb = XLSX.readFile(filePath);
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
      allRows.push({ file: path.basename(filePath), rows });
      console.log(`  ✅ Loaded: ${path.basename(filePath)} (${rows.length - 1} data rows)`);
    } catch (e) {
      console.error(`  ❌ Failed to read ${path.basename(filePath)}:`, e.message);
    }
  }

  if (allRows.length === 0) return null;

  _cache = { date: todayStr, allRows };
  return allRows;
}

// ── Time helpers ──────────────────────────────────────────────────────────────

function nowLocal() {
  const d = new Date();
  d.setMinutes(d.getMinutes() + TIMEZONE_OFFSET * 60);
  return d;
}

function fmt24(date) {
  return `${String(date.getUTCHours()).padStart(2,'0')}:${String(date.getUTCMinutes()).padStart(2,'0')}`;
}

function estimatedArrival(distanceKm, speedKmh) {
  const speed = speedKmh > 0 ? speedKmh : 40;
  const d = nowLocal();
  d.setMinutes(d.getUTCMinutes() + Math.round((distanceKm / speed) * 60));
  return fmt24(d);
}

// ── Build lookup from multiple file datasets ─────────────────────────────────
// Each entry in allRows: { file, rows } where rows[0] = headers
// vehicles[camion] = [ { trajet, zone, clientDepot, emailClient, chauffeur, sourceFile } ]

function buildExcelLookup(allRows) {
  const vehicles = {};

  for (const { file, rows } of allRows) {
    const headers = rows[0];
    const col = name => headers.findIndex(h => h && h.toString().toLowerCase().includes(name));
    const idx = {
      camion:      col('camion'),
      zone:        col('coordonnees zone'),
      clientDepot: col('client/depot'),
      trajet:      col('trajet order'),
      emailClient: col('email client'),
      chauffeur:   col('chauffeur'),
    };

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const camion = row[idx.camion]?.toString().trim();
      if (!camion) continue;
      if (!vehicles[camion]) vehicles[camion] = [];
      vehicles[camion].push({
        trajet:      row[idx.trajet],
        zone:        row[idx.zone]?.toString().trim() || '',
        clientDepot: row[idx.clientDepot]?.toString().trim() || '',
        emailClient: row[idx.emailClient]?.toString().trim() || '',
        chauffeur:   row[idx.chauffeur]?.toString().trim() || '',
        sourceFile:  file,
      });
    }
  }
  return vehicles;
}

// ── Vehicle name extraction ───────────────────────────────────────────────────
// "Le véhicule 5427 TBL-RENAULT KWID-GALANA" → "5427 TBL"
// "Le véhicule 0092 TBV a débuté"            → "0092 TBV"

function extractVehicleName(text) {
  const m = text.match(/Le v[eé]hicule\s+(.+?)(?:\s+(?:est|a)\s)/i);
  if (!m) return null;
  const raw = m[1].trim();
  const dashIdx = raw.indexOf('-');
  return dashIdx !== -1 ? raw.substring(0, dashIdx).trim() : raw;
}

// ── Notification parser ───────────────────────────────────────────────────────

function parseNotification(text) {
  const speedMatch = text.match(/vitesse de ([\d.]+)\s*km\/h/i);
  const speed = speedMatch ? parseFloat(speedMatch[1]) : 40;

  const distMatch = text.match(/([\d.]+)\s*km\s+from/i);
  const distanceKm = distMatch ? parseFloat(distMatch[1]) : null;

  const locMatch = text.match(/pr[eè]s de '([^']+)'/i);
  const location = locMatch ? locMatch[1].trim() : '';

  if (text.includes('est arrivé au point de livraison')) {
    // destination is between "livraison " and ". A YYYY"
    const destMatch = text.match(/livraison\s+(.+?)\.\s+A\s+\d{4}/i);
    const destination = destMatch ? destMatch[1].trim() : null;
    if (!destination) return null;

    const isParking = /parking/i.test(destination);
    const isDepot   = /depot/i.test(destination) && !isParking;
    const type = isParking ? 'arrived_parking' : isDepot ? 'arrived_depot' : 'arrived_client';
    return { type, destination, speed, distanceKm, location };
  }

  if (text.includes('a débuté la livraison')) {
    const destMatch = text.match(/a d[eé]but[eé] la livraison\s+(.+?)\.\s+A\s+\d{4}/i);
    const destination = destMatch ? destMatch[1].trim() : null;
    if (!destination) return null;

    const isParking = /parking/i.test(destination);
    const isDepot   = /depot/i.test(destination) && !isParking;
    const type = (isParking || isDepot) ? 'enroute_depot' : 'enroute_client';
    return { type, destination, speed, distanceKm, location };
  }

  return null;
}

// ── OSRM distance between two zone names ─────────────────────────────────────

async function getDistanceBetweenZones(fromZone, toZone) {
  try {
    const zonesPath = path.join(DOWNLOADS, 'zones-with-coordinates.json');
    if (!fs.existsSync(zonesPath)) return null;
    const zonesData = JSON.parse(fs.readFileSync(zonesPath, 'utf8'));

    let from = null, to = null;
    for (const vehicles of Object.values(zonesData)) {
      for (const zoneList of Object.values(vehicles)) {
        for (const z of zoneList) {
          if (!from && z.name?.toUpperCase() === fromZone.toUpperCase() && z.coordinates?.length)
            from = z.coordinates[0];
          if (!to && z.name?.toUpperCase() === toZone.toUpperCase() && z.coordinates?.length)
            to = z.coordinates[0];
        }
      }
    }
    if (!from || !to) return null;

    const url = `${OSRM_URL}/route/v1/driving/${from.longitude},${from.latitude};${to.longitude},${to.latitude}?overview=false`;
    const res = await axios.get(url, { timeout: 10000 });
    return res.data.routes[0].distance / 1000; // km
  } catch {
    return null;
  }
}

// ── Excel context lookup ──────────────────────────────────────────────────────

// ── Find vehicle context across all merged rows ───────────────────────────────
// Rules:
//  - Vehicle must exist in the lookup
//  - Destination must match a trajectory row (zone) — otherwise skip
//  - If multiple files have the same trajectory for the same vehicle,
//    collect all emails and deduplicate before sending

function findVehicleContext(vehicles, vehicleName, destination) {
  const nameUp = vehicleName.toUpperCase();
  const camionKey = Object.keys(vehicles).find(k => {
    const kUp = k.toUpperCase();
    return kUp === nameUp || kUp.includes(nameUp) || nameUp.includes(kUp);
  });
  if (!camionKey) return null;

  const rows = vehicles[camionKey];
  const destUp = destination.toUpperCase();

  // All rows whose zone matches the destination (across all source files)
  const matchedRows = rows.filter(r =>
    r.zone && (r.zone.toUpperCase().includes(destUp) || destUp.includes(r.zone.toUpperCase()))
  );

  // No trajectory match → ignore notification
  if (matchedRows.length === 0) return null;

  // Collect and deduplicate emails across all matched rows
  const emailSet = new Set();
  for (const r of matchedRows) {
    if (r.emailClient) r.emailClient.split(';').map(e => e.trim()).filter(Boolean).forEach(e => emailSet.add(e));
  }
  const emails = [...emailSet];

  const chauffeur = rows.find(r => r.chauffeur)?.chauffeur || '';
  const matchedRow = matchedRows[0]; // use first match for display/distance

  // Previous zone by trajet order (for distance calculation)
  let prevZone = null;
  if (matchedRow?.trajet) {
    const prevOrder = parseInt(matchedRow.trajet) - 1;
    prevZone = rows.find(r => parseInt(r.trajet) === prevOrder)?.zone || null;
  }

  return { camionKey, emails, chauffeur, matchedRow, prevZone, rows };
}

// ── Email builders ────────────────────────────────────────────────────────────

function buildEmail(vehicleName, event, context, distanceToNext) {
  const { type, destination, distanceKm, speed, location } = event;
  const { chauffeur, matchedRow } = context;
  const clientLabel = matchedRow?.clientDepot || destination;
  const distLabel = distanceToNext != null
    ? `${distanceToNext.toFixed(1)} Km`
    : distanceKm != null ? `${distanceKm} Km` : 'N/A';
  const pos = `Position actuel:${location || 'N/A'}`;
  const footer = '\nCamtrack Madagascar,';

  let subject, body;

  switch (type) {
    case 'arrived_client':
      subject = `---------- ${vehicleName} Arrivée à l'étape ${destination} ----------`;
      body = [`Lieu:${destination}`, `Distance: ${distLabel}`, `Client:${clientLabel}`, `Chauffeur:${chauffeur}`, pos, footer].join('\n');
      break;

    case 'arrived_parking':
      subject = `---------- ${vehicleName} Arrivée à l'étape ${destination} ----------`;
      body = [`Lieu:${destination}`, `Distance: ${distLabel}`, `Client:${destination}`, `Chauffeur:${chauffeur}`, pos, footer].join('\n');
      break;

    case 'arrived_depot':
      subject = `---------- ${vehicleName} Arrivée à l'étape ${destination} ----------`;
      body = [`Lieu:${destination}`, `Distance: ${distLabel}`, `Client:${clientLabel}`, `Chauffeur:${chauffeur}`, pos, footer].join('\n');
      break;

    case 'enroute_depot': {
      const eta = distanceToNext != null ? estimatedArrival(distanceToNext, speed) : fmt24(nowLocal());
      subject = `---------- Temps restant jusqu'à la livraison estimé: ${eta} ----------`;
      body = [`Destination:${destination}`, `Distance:${distLabel}`, `Client:${clientLabel}`, `Chauffeur:${chauffeur}`, pos, footer].join('\n');
      break;
    }

    case 'enroute_client': {
      const eta = distanceToNext != null ? estimatedArrival(distanceToNext, speed) : fmt24(nowLocal());
      subject = `---------- ${vehicleName} en cours de route... ----------`;
      body = [`Destination:${destination}`, `Distance: ${distLabel}`, `Heure d'arrivée estimée: ${eta}`, `Client:${clientLabel}`, `Chauffeur:${chauffeur}`, pos, footer].join('\n');
      break;
    }

    default: return null;
  }

  return { subject, body };
}

// ── Main handler (called from server.js) ─────────────────────────────────────

async function handleWialonNotification(rawBody) {
  // Wialon sends { "Le véhicule ...": "" } — the notification text is the key
  let text = '';
  if (typeof rawBody === 'string') {
    text = rawBody;
  } else if (rawBody.message || rawBody.text) {
    text = rawBody.message || rawBody.text;
  } else {
    text = Object.keys(rawBody)[0] || '';
  }

  if (!text) return { skipped: true, reason: 'empty body' };

  const vehicleName = extractVehicleName(text);
  if (!vehicleName) return { skipped: true, reason: 'no vehicle name' };

  const event = parseNotification(text);
  if (!event) return { skipped: true, reason: 'no actionable event or missing destination' };

  // ── 1. Load all today's updated Excel files ──────────────────────────────────
  const allRows = await loadTodayExcelFiles();
  if (!allRows) {
    await sendAdminEmail(
      `⚠️ Wialon notification — no active file`,
      `<p><strong>Time (Madagascar):</strong> ${nowMadagascar()}</p>
       <p>Received a notification for <strong>${vehicleName}</strong> → <strong>${event.destination}</strong>
          but no today's <code>_updated-with-order.xlsx</code> files were found locally or on SFTP.</p>
       <p>No client email was sent.</p>`
    );
    return { skipped: true, reason: 'no today updated files found' };
  }

  const vehicles = buildExcelLookup(allRows);
  const context = findVehicleContext(vehicles, vehicleName, event.destination);

  // Vehicle not found at all
  if (!context) return { skipped: true, reason: `vehicle "${vehicleName}" not found in any today's file` };

  // Vehicle found but no trajectory matches destination → ignore
  if (context.emails.length === 0)
    return { skipped: true, reason: `no trajectory match for "${vehicleName}" → "${event.destination}"` };

  // ── 2. Compute distance for enroute events ──────────────────────────────────
  let distanceToNext = null;
  if ((event.type === 'enroute_depot' || event.type === 'enroute_client') && context.prevZone) {
    distanceToNext = await getDistanceBetweenZones(context.prevZone, event.destination);
  }
  if (distanceToNext == null) distanceToNext = event.distanceKm;

  const mail = buildEmail(vehicleName, event, context, distanceToNext);
  if (!mail) return { skipped: true, reason: 'could not build email' };

  // ── 3. Send client email(s) ─────────────────────────────────────────────────
  await Promise.all(context.emails.map(recipient =>
    mailer.sendMail({
      from: process.env.EMAIL_FROM || process.env.EMAIL_USER,
      to: recipient,
      subject: mail.subject,
      text: mail.body
    })
  ));

  console.log(`✅ Wialon email [${event.type}] → ${context.emails.join(', ')} (${vehicleName} → ${event.destination})`);

  // ── 4. Notify admin: client email was sent ──────────────────────────────────
  await sendAdminEmail(
    `✅ Client notification sent — ${vehicleName} → ${event.destination}`,
    `<p><strong>Time (Madagascar):</strong> ${nowMadagascar()}</p>
     <p><strong>Vehicle:</strong> ${vehicleName}</p>
     <p><strong>Event type:</strong> ${event.type}</p>
     <p><strong>Destination:</strong> ${event.destination}</p>
     <p><strong>Client email(s) notified:</strong> ${context.emails.join(', ')}</p>
     <p><strong>Subject sent:</strong> ${mail.subject}</p>
     <hr style="border:none;border-top:1px solid #ddd">
     <p><strong>Message body:</strong></p>
     <pre style="background:#f5f5f5;padding:10px;border-radius:4px;font-size:13px">${mail.body}</pre>`
  );

  return { sent: true, type: event.type, vehicle: vehicleName, to: context.emails };
}

module.exports = { handleWialonNotification };
