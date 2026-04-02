const https = require('https');
// const http = require('http');
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── SSL certificates ──────────────────────────────────────────────────────────
const sslOptions = {
  key:  fs.readFileSync('./ssl/camtrack_net.key'),
  cert: fs.readFileSync('./ssl/camtrack_net.crt'),
  ca:   fs.readFileSync('./ssl/camtrack_net.ca-bundle')
};

// ── HTTP (local/dev) — commented out for production ──────────────────────────
// const PORT = process.env.PORT || 5458;
// const server = http.createServer(app);
// server.listen(PORT, () => console.log(`Server running on http port ${PORT}`));

// ── HTTPS (production) ────────────────────────────────────────────────────────
const PORT = process.env.PORT || 443;
const server = https.createServer(sslOptions, app);

async function startServer() {
  server.listen(PORT, () =>
    console.log(`🔒 Server running on HTTPS port ${PORT}`)
  );
}

startServer();

const { handleWialonNotification } = require('./src/notifications/wialon-notify-handler');

const WIALON_LOG = path.join(__dirname, 'logs', 'wialon-notifications.txt');

function appendLog(text) {
  const line = `[${new Date().toLocaleString()}] ${text}\n`;
  fs.appendFileSync(WIALON_LOG, line, 'utf8');
}

// Wialon notification receiver
app.post('/wialon-notify', async (req, res) => {
  const raw = req.body;
  const logText = typeof raw === 'string' ? raw : JSON.stringify(raw);
  appendLog(logText);
  console.log('📩 Wialon notification received:', logText);

  res.status(200).send('OK'); // respond immediately so Wialon doesn't retry

  try {
    const result = await handleWialonNotification(raw);
    if (result.skipped) {
      console.log(`⏭  Notification skipped: ${result.reason}`);
    }
  } catch (err) {
    console.error('❌ Notification handler error:', err.message);
  }
});

// Calculate centroid of a geofence (polygon)
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

// Convert zone to point location (handle both point and geofence)
function getZoneLocation(zone) {
  // If zone has coordinates array (geofence), calculate centroid
  if (zone.coordinates && Array.isArray(zone.coordinates) && zone.coordinates.length > 0) {
    return calculateCentroid(zone.coordinates);
  }
  
  // If zone has single lat/long (point)
  if (zone.latitude && zone.longitude) {
    return { latitude: zone.latitude, longitude: zone.longitude };
  }
  
  throw new Error('Invalid zone format');
}

// Get road distance between two points using OSRM
async function getRoadDistance(from, to) {
  try {
    const osrmUrl = process.env.OSRM_URL;
    const url = `${osrmUrl}/route/v1/driving/${from.longitude},${from.latitude};${to.longitude},${to.latitude}?overview=false`;
    const response = await axios.get(url);
    return response.data.routes[0].distance; // meters
  } catch (error) {
    console.error('Error fetching distance:', error.message);
    return Infinity;
  }
}

// Build distance matrix using actual road distances
async function buildDistanceMatrix(zones) {
  const n = zones.length;
  const matrix = Array(n).fill(null).map(() => Array(n).fill(0));
  const locations = zones.map(zone => getZoneLocation(zone));
  
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const distance = await getRoadDistance(locations[i], locations[j]);
      matrix[i][j] = distance;
      matrix[j][i] = distance;
    }
  }
  
  return matrix;
}

// Find shortest path using greedy nearest neighbor (Dijkstra-inspired)
function findShortestPath(distanceMatrix, startIndex) {
  const n = distanceMatrix.length;
  const visited = new Array(n).fill(false);
  const path = [startIndex];
  visited[startIndex] = true;
  
  let currentIndex = startIndex;
  let totalDistance = 0;
  
  for (let i = 1; i < n; i++) {
    let minDistance = Infinity;
    let nextIndex = -1;
    
    // Find nearest unvisited node (Dijkstra's greedy approach)
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

// Main endpoint
app.post('/shortest-path', async (req, res) => {
  try {
    const { zones } = req.body;
    
    if (!zones || !Array.isArray(zones) || zones.length < 2) {
      return res.status(400).json({ error: 'At least 2 zones required' });
    }
    
    // Validate zone format
    for (const zone of zones) {
      try {
        getZoneLocation(zone);
      } catch (error) {
        return res.status(400).json({ 
          error: 'Each zone must have either latitude/longitude or coordinates array' 
        });
      }
    }
    
    console.log(`Processing ${zones.length} zones...`);
    
    // Build distance matrix with real road distances
    const distanceMatrix = await buildDistanceMatrix(zones);
    
    // Find shortest path starting from first zone (index 0)
    const { path, totalDistance } = findShortestPath(distanceMatrix, 0);
    
    // Build organized response
    const route = path.map((index, step) => {
      const zone = zones[index];
      const location = getZoneLocation(zone);
      
      return {
        step: step + 1,
        zoneIndex: index,
        zoneName: zone.name || `Zone ${index}`,
        location,
        isGeofence: !!(zone.coordinates && zone.coordinates.length > 1),
        ...(zone.coordinates && zone.coordinates.length > 1 && {
          geofence: zone.coordinates
        })
      };
    });
    
    res.json({
      success: true,
      totalDistance: Math.round(totalDistance),
      totalDistanceKm: (totalDistance / 1000).toFixed(2),
      route
    });
    
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'Internal server error', message: error.message });
  }
});


