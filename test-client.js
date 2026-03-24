const axios = require('axios');

// Test data: Mix of point locations and geofence zones
const testZones = [
  {
    name: "Base Station (Point)",
    latitude: 40.7128,
    longitude: -74.0060
  },
  {
    name: "Zone A (Geofence)",
    coordinates: [
      { latitude: 40.7589, longitude: -73.9851 },
      { latitude: 40.7599, longitude: -73.9841 },
      { latitude: 40.7579, longitude: -73.9831 },
      { latitude: 40.7569, longitude: -73.9841 }
    ]
  },
  {
    name: "Zone B (Point)",
    latitude: 40.7614,
    longitude: -73.9776
  },
  {
    name: "Zone C (Geofence)",
    coordinates: [
      { latitude: 40.7489, longitude: -73.9680 },
      { latitude: 40.7499, longitude: -73.9670 },
      { latitude: 40.7479, longitude: -73.9660 }
    ]
  }
];

async function testShortestPath() {
  try {
    console.log('Testing shortest path API with mixed zone types...\n');
    console.log('Zones:', JSON.stringify(testZones, null, 2));
    
    const response = await axios.post('http://localhost:3000/shortest-path', {
      zones: testZones
    });
    
    console.log('\n=== RESULT ===');
    console.log(`Total Distance: ${response.data.totalDistanceKm} km`);
    console.log('\nOptimal Route:');
    response.data.route.forEach(step => {
      const type = step.isGeofence ? 'Geofence' : 'Point';
      console.log(`  ${step.step}. ${step.zoneName} [${type}]`);
      console.log(`     Location: (${step.location.latitude.toFixed(4)}, ${step.location.longitude.toFixed(4)})`);
      if (step.isGeofence) {
        console.log(`     Geofence: ${step.geofence.length} coordinates`);
      }
    });
    
  } catch (error) {
    console.error('Error:', error.response?.data || error.message);
  }
}

testShortestPath();
