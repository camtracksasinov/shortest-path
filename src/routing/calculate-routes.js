const axios = require('axios');
const fs = require('fs');
const path = require('path');

const OSRM_URL = process.env.OSRM_URL || 'http://router.project-osrm.org';

function calculateCentroid(coordinates) {
  const n = coordinates.length;
  const sum = coordinates.reduce((acc, coord) => ({
    latitude: acc.latitude + coord.latitude,
    longitude: acc.longitude + coord.longitude
  }), { latitude: 0, longitude: 0 });
  
  return {
    latitude: sum.latitude / n,
    longitude: sum.longitude / n
  };
}

async function getRoadDistance(from, to) {
  try {
    const url = `${OSRM_URL}/route/v1/driving/${from.longitude},${from.latitude};${to.longitude},${to.latitude}?overview=false`;
    const response = await axios.get(url);
    return response.data.routes[0].distance;
  } catch (error) {
    return Infinity;
  }
}

async function buildDistanceMatrix(zones) {
  const n = zones.length;
  const matrix = Array(n).fill(null).map(() => Array(n).fill(0));
  
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const distance = await getRoadDistance(zones[i].centroid, zones[j].centroid);
      matrix[i][j] = distance;
      matrix[j][i] = distance;
    }
  }
  
  return matrix;
}

function findShortestPath(distanceMatrix, depotIndices = [], highPriorityIndices = []) {
  const n = distanceMatrix.length;
  const visited = new Array(n).fill(false);
  let path = [];
  let currentIndex = 0;
  let totalDistance = 0;
  
  // Step 1: Add depot zones first (Trajet 1)
  if (depotIndices.length > 0) {
    for (const depotIdx of depotIndices) {
      path.push(depotIdx);
      visited[depotIdx] = true;
      if (path.length > 1) {
        totalDistance += distanceMatrix[currentIndex][depotIdx];
      }
      currentIndex = depotIdx;
    }
  }
  
  // Step 2: Add high priority zones (Trajet 2, 3...)
  if (highPriorityIndices.length > 0) {
    for (const hpIndex of highPriorityIndices) {
      path.push(hpIndex);
      visited[hpIndex] = true;
      if (path.length > 1) {
        totalDistance += distanceMatrix[currentIndex][hpIndex];
      }
      currentIndex = hpIndex;
    }
  }
  
  // Step 3: If no depot and no high priority, start from index 0
  if (path.length === 0) {
    path.push(0);
    visited[0] = true;
  }
  
  // Step 4: Find shortest path for remaining zones
  for (let i = path.length; i < n; i++) {
    let minDistance = Infinity;
    let nextIndex = -1;
    
    for (let j = 0; j < n; j++) {
      if (!visited[j] && distanceMatrix[currentIndex][j] < minDistance) {
        minDistance = distanceMatrix[currentIndex][j];
        nextIndex = j;
      }
    }
    
    if (nextIndex !== -1) {
      visited[nextIndex] = true;
      path.push(nextIndex);
      totalDistance += minDistance;
      currentIndex = nextIndex;
    }
  }
  
  return { path, totalDistance };
}

async function calculateOptimalRoute(vehicleData) {
  console.log('\n🗺️  CALCULATING OPTIMAL ROUTES:\n');
  console.log('='.repeat(70));
  
  const results = {};
  
  for (const [transporteur, vehicles] of Object.entries(vehicleData)) {
    results[transporteur] = {};
    console.log(`\n📦 ${transporteur}`);
    
    for (const [camion, zoneList] of Object.entries(vehicles)) {
      console.log(`   🚛 ${camion}`);

      const zones = zoneList
        .filter(zone => zone && zone.name && Array.isArray(zone.coordinates) && zone.coordinates.length > 0)
        .map(zone => ({
          name: zone.name,
          centroid: calculateCentroid(zone.coordinates),
          coordinates: zone.coordinates,
          priorite: zone.priorite || '',
          hasProduct: zone.hasProduct || false
        }));

      if (zones.length === 0) {
        console.log(`      ⚠️  No valid zones found for ${camion} — skipping.`);
        results[transporteur][camion] = { totalDistance: 0, totalDistanceKm: '0.00', route: [] };
        continue;
      }
      
      // Identify depot zones (no product) and high priority zones
      const depotZones = zones.filter(z => !z.hasProduct);
      const highPriorityZones = zones.filter(z => z.priorite && z.priorite.toString().toLowerCase() === 'haute');
      const regularZones = zones.filter(z => z.hasProduct && (!z.priorite || z.priorite.toString().toLowerCase() !== 'haute'));
      
      console.log(`      Building distance matrix for ${zones.length} zones...`);
      if (depotZones.length > 0) {
        console.log(`      Found ${depotZones.length} depot zone(s)`);
      }
      if (highPriorityZones.length > 0) {
        console.log(`      Found ${highPriorityZones.length} high priority zone(s)`);
      }
      
      const distanceMatrix = await buildDistanceMatrix(zones);
      
      console.log(`      Finding shortest path...`);
      const depotIndices = depotZones.map(dz => zones.findIndex(z => z.name === dz.name));
      const highPriorityIndices = highPriorityZones.map(hz => zones.findIndex(z => z.name === hz.name));
      const { path, totalDistance } = findShortestPath(distanceMatrix, depotIndices, highPriorityIndices);
      
      const orderedRoute = path
        .filter(idx => idx >= 0 && idx < zones.length)
        .map((idx, step) => ({
          step: step + 1,
          name: zones[idx].name,
          coordinates: zones[idx].coordinates
        }));
      
      results[transporteur][camion] = {
        totalDistance: Math.round(totalDistance),
        totalDistanceKm: (totalDistance / 1000).toFixed(2),
        route: orderedRoute
      };
      
      console.log(`      ✅ Total distance: ${(totalDistance / 1000).toFixed(2)} km`);
      console.log(`      Route order:`);
      orderedRoute.forEach(stop => {
        console.log(`         ${stop.step}. ${stop.name}`);
      });
    }
  }
  
  const outputPath = path.join(__dirname, '../../downloads', 'optimal-routes.json');
  fs.writeFileSync(outputPath, JSON.stringify(results, null, 2));
  console.log(`\n💾 Optimal routes saved to: ${outputPath}\n`);
  
  return results;
}

if (require.main === module) {
  const dataPath = './downloads/zones-with-coordinates.json';
  if (fs.existsSync(dataPath)) {
    const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
    calculateOptimalRoute(data).catch(console.error);
  } else {
    console.log('❌ Run wialon-zones.js first to fetch zone coordinates');
  }
}

module.exports = { calculateOptimalRoute };
