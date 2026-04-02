const XLSX = require('xlsx');
const nodemailer = require('nodemailer');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const DOWNLOADS = path.join(__dirname, '../../downloads');
const ACTIVE_DIR = path.join(__dirname, '../../active');
const OSRM_URL = process.env.OSRM_URL || 'http://router.project-osrm.org';
const TIMEZONE_OFFSET = parseInt(process.env.TIMEZONE_OFFSET || '2');

const mailer = nodemailer.createTransport({
  host: process.env.EMAIL_HOST || 'smtp.office365.com',
  port: parseInt(process.env.EMAIL_PORT || '587'),
  secure: false,
  auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASSWORD }
});

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

// ── Excel loader — reads the active copy kept by run-all.js ─────────────────

function loadActiveExcel() {
  const activePath = path.join(ACTIVE_DIR, 'active-livraison.xlsx');
  if (!fs.existsSync(activePath)) return null;
  const wb = XLSX.readFile(activePath);
  const ws = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
}

function buildExcelLookup(data) {
  const headers = data[0];
  const col = name => headers.findIndex(h => h && h.toString().toLowerCase().includes(name));
  const idx = {
    camion:      col('camion'),
    zone:        col('coordonnees zone'),
    clientDepot: col('client/depot'),
    trajet:      col('trajet order'),
    emailClient: col('email client'),
    chauffeur:   col('chauffeur'),
  };

  const vehicles = {};
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const camion = row[idx.camion]?.toString().trim();
    if (!camion) continue;
    if (!vehicles[camion]) vehicles[camion] = [];
    vehicles[camion].push({
      trajet:      row[idx.trajet],
      zone:        row[idx.zone]?.toString().trim() || '',
      clientDepot: row[idx.clientDepot]?.toString().trim() || '',
      emailClient: row[idx.emailClient]?.toString().trim() || '',
      chauffeur:   row[idx.chauffeur]?.toString().trim() || '',
    });
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

function findVehicleContext(vehicles, vehicleName, destination) {
  const nameUp = vehicleName.toUpperCase();
  const camionKey = Object.keys(vehicles).find(k => {
    const kUp = k.toUpperCase();
    return kUp === nameUp || kUp.includes(nameUp) || nameUp.includes(kUp);
  });
  if (!camionKey) return null;

  const rows = vehicles[camionKey];
  const emailRow = rows.find(r => r.emailClient);
  const emails = emailRow
    ? emailRow.emailClient.split(';').map(e => e.trim()).filter(Boolean)
    : [];
  const chauffeur = rows.find(r => r.chauffeur)?.chauffeur || '';

  const destUp = destination.toUpperCase();
  const matchedRow = rows.find(r =>
    r.zone.toUpperCase().includes(destUp) || destUp.includes(r.zone.toUpperCase())
  );

  // Previous zone by trajet order (for distance calculation)
  let prevZone = null;
  if (matchedRow && matchedRow.trajet) {
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

  const data = loadActiveExcel();
  if (!data) return { skipped: true, reason: 'no active/active-livraison.xlsx found — run routing first' };

  const vehicles = buildExcelLookup(data);
  const context = findVehicleContext(vehicles, vehicleName, event.destination);
  if (!context || context.emails.length === 0)
    return { skipped: true, reason: `no email for vehicle "${vehicleName}"` };

  // Compute distance from previous zone to destination for enroute types
  let distanceToNext = null;
  if ((event.type === 'enroute_depot' || event.type === 'enroute_client') && context.prevZone) {
    distanceToNext = await getDistanceBetweenZones(context.prevZone, event.destination);
  }
  if (distanceToNext == null) distanceToNext = event.distanceKm;

  const mail = buildEmail(vehicleName, event, context, distanceToNext);
  if (!mail) return { skipped: true, reason: 'could not build email' };

  await Promise.all(context.emails.map(recipient =>
    mailer.sendMail({
      from: process.env.EMAIL_FROM || process.env.EMAIL_USER,
      to: recipient,
      subject: mail.subject,
      text: mail.body
    })
  ));

  console.log(`✅ Wialon email [${event.type}] → ${context.emails.join(', ')} (${vehicleName} → ${event.destination})`);
  return { sent: true, type: event.type, vehicle: vehicleName, to: context.emails };
}

module.exports = { handleWialonNotification };
