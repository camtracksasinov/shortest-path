const axios = require('axios');

// Test data: Real locations in Cameroon (Douala area)
const testZones = [
  
  {
    name: "Bonapriso",
    coordinates: [
      { latitude: 4.024750186048322, longitude:9.70023748023412 },
   
    ]
  },
    {
    name: "Ndokoti",
    coordinates: [
      { latitude: 4.044185469749134, longitude: 9.742552007583472 }
    ]
  },
  
];

async function testShortestPath() {
  try {
    console.log('Testing shortest path with Cameroon locations...\n');
    console.log('Starting calculation...\n');
    
    const response = await axios.post('http://localhost:3000/shortest-path', {
      zones: testZones
    });
    
    console.log('=== RESULT ===');
    console.log(`Total Distance: ${response.data.totalDistanceKm} km (${response.data.totalDistance} meters)`);
    console.log('\nOptimal Route:');
    response.data.route.forEach(step => {
      const type = step.isGeofence ? 'Geofence' : 'Point';
      console.log(`\n${step.step}. ${step.zoneName} [${type}]`);
      console.log(`   Location: (${step.location.latitude.toFixed(6)}, ${step.location.longitude.toFixed(6)})`);
      if (step.isGeofence) {
        console.log(`   Geofence: ${step.geofence.length} coordinates`);
      }
    });
    
    console.log('\n=== SUMMARY ===');
    console.log('Route order:', response.data.route.map(r => r.zoneName).join(' → '));
    
  } catch (error) {
    if (error.response) {
      console.error('Error:', error.response.data);
    } else {
      console.error('Error:', error.message);
    }
  }
}

testShortestPath();
