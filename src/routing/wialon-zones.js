const axios = require('axios');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const WIALON_TOKEN = process.env.WIALON_TOKEN;
const WIALON_BASE_URL = process.env.WIALON_BASE_URL;

let sessionId = null;

async function getSession() {
  const url = `${WIALON_BASE_URL}/wialon/ajax.html?svc=token/login&params=${JSON.stringify({token: WIALON_TOKEN})}`;
  const response = await axios.get(url);
  if (response.data.error) throw new Error('Failed to get session');
  sessionId = response.data.eid;
  return sessionId;
}

async function getResourceId(sid) {
  const url = `${WIALON_BASE_URL}/wialon/ajax.html?svc=core/update_data_flags&params=${JSON.stringify({spec:[{type:"type",data:"avl_resource",flags:8193,mode:1}]})}&sid=${sid}`;
  const response = await axios.get(url);
  if (response.data.error) throw new Error('Session expired');
  const galanaResource = response.data.find(r => r.d.nm === "Galana ressource");
  return galanaResource ? galanaResource.d.id : null;
}

async function getZoneData(resourceId, sid) {
  const url = `${WIALON_BASE_URL}/wialon/ajax.html?svc=resource/get_zone_data&params=${JSON.stringify({itemId: resourceId})}&sid=${sid}`;
  const response = await axios.get(url);
  if (response.data.error) throw new Error('Session expired');
  return response.data;
}

async function matchCoordinates(transporteurData) {
  try {
    console.log('\n🔐 Getting Wialon session...');
    const sid = await getSession();
    console.log(`✅ Session ID: ${sid}\n`);

    console.log('📦 Getting resource ID...');
    const resourceId = await getResourceId(sid);
    if (!resourceId) throw new Error('Galana ressource not found');
    console.log(`✅ Resource ID: ${resourceId}\n`);

    console.log('🗺️  Fetching zone data...');
    const zones = await getZoneData(resourceId, sid);
    console.log(`✅ Found ${zones.length} zones\n`);

    console.log('='.repeat(70));
    console.log('🚚 MATCHING COORDINATES WITH ZONES:');
    console.log('='.repeat(70) + '\n');

    const result = {};

    for (const [transporteur, vehicles] of Object.entries(transporteurData)) {
      result[transporteur] = {};
      console.log(`\n📦 ${transporteur}`);

      for (const [camion, coordinates] of Object.entries(vehicles)) {
        result[transporteur][camion] = [];
        console.log(`   🚛 ${camion}`);

        coordinates.forEach((item, idx) => {
          const coordName = typeof item === 'string' ? item : item.coord;
          const priorite = typeof item === 'object' ? item.priorite : '';
          const hasProduct = typeof item === 'object' ? item.hasProduct : false;
          const zone = zones.find(z => z.n === coordName);
          if (zone) {
            const coords = zone.p.map(p => ({
              latitude: p.y,
              longitude: p.x,
              ...(p.r && p.r > 0 && { radius: p.r })
            }));
            result[transporteur][camion].push({name: coordName, coordinates: coords, priorite, hasProduct});
            const priorityLabel = priorite && priorite.toString().toLowerCase() === 'haute' ? ' [HAUTE]' : '';
            const depotLabel = !hasProduct ? ' [DEPOT]' : '';
            console.log(`      ${idx + 1}. ${coordName}${depotLabel}${priorityLabel} ✅ (${coords.length} points)`);
          } else {
            console.log(`      ${idx + 1}. ${coordName} ❌ (not found)`);
          }
        });
      }
    }

    const outputPath = path.join(path.join(__dirname, '../../downloads'), 'zones-with-coordinates.json');
    fs.writeFileSync(outputPath, JSON.stringify(result, null, 2));
    console.log(`\n💾 Data saved to: ${outputPath}\n`);

    return result;
  } catch (error) {
    if (error.message === 'Session expired') {
      console.log('⚠️  Session expired, retrying...');
      return matchCoordinates(transporteurData);
    }
    throw error;
  }
}

module.exports = { matchCoordinates };

if (require.main === module) {
  const dataPath = path.join(__dirname, '../../downloads/transporteurs-vehicles-coordinates.json');
  if (fs.existsSync(dataPath)) {
    const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
    matchCoordinates(data).catch(console.error);
  } else {
    console.log('❌ Run sftp-excel-reader.js first to extract data');
  }
}
