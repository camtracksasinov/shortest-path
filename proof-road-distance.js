const axios = require('axios');

// Function to calculate straight-line distance (Haversine formula)
function calculateStraightLineDistance(from, to) {
  const R = 6371000; // Earth's radius in meters
  const lat1 = from.latitude * Math.PI / 180;
  const lat2 = to.latitude * Math.PI / 180;
  const deltaLat = (to.latitude - from.latitude) * Math.PI / 180;
  const deltaLon = (to.longitude - from.longitude) * Math.PI / 180;

  const a = Math.sin(deltaLat/2) * Math.sin(deltaLat/2) +
            Math.cos(lat1) * Math.cos(lat2) *
            Math.sin(deltaLon/2) * Math.sin(deltaLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));

  return R * c; // Distance in meters
}

// Function to get actual road distance from OSRM
async function getRoadDistance(from, to) {
  try {
    const osrmUrl = process.env.OSRM_URL || 'http://router.project-osrm.org';
    const url = `${osrmUrl}/route/v1/driving/${from.longitude},${from.latitude};${to.longitude},${to.latitude}?overview=false`;
    const response = await axios.get(url);
    return response.data.routes[0].distance;
  } catch (error) {
    console.error('Error:', error.message);
    return null;
  }
}

async function demonstrateDifference() {
  console.log('=== PROOF: Road Distance vs Straight Line Distance ===\n');
  
  // Test with your Cameroon locations
  const tests = [
    {
      name: 'Kotot to PK13',
      from: { latitude: 4.064680651574853, longitude: 9.707321115609899 },
      to: { latitude: 4.073780116646867, longitude: 9.792750788674562 }
    },
    {
      name: 'Kotot to Logbessou',
      from: { latitude: 4.064680651574853, longitude: 9.707321115609899 },
      to: { latitude: 4.0948081999840715, longitude: 9.770185560174523 }
    },
    {
      name: 'PK13 to PK14',
      from: { latitude: 4.073780116646867, longitude: 9.792750788674562 },
      to: { latitude: 4.079760499794137, longitude: 9.793931593962201 }
    }
  ];

  for (const test of tests) {
    console.log(`\n📍 ${test.name}`);
    console.log(`   From: (${test.from.latitude.toFixed(4)}, ${test.from.longitude.toFixed(4)})`);
    console.log(`   To:   (${test.to.latitude.toFixed(4)}, ${test.to.longitude.toFixed(4)})`);
    
    // Calculate straight line
    const straightLine = calculateStraightLineDistance(test.from, test.to);
    console.log(`\n   ❌ Straight Line (as the crow flies): ${(straightLine/1000).toFixed(2)} km`);
    
    // Get actual road distance
    const roadDistance = await getRoadDistance(test.from, test.to);
    if (roadDistance) {
      console.log(`   ✅ Actual Road Distance: ${(roadDistance/1000).toFixed(2)} km`);
      
      const difference = roadDistance - straightLine;
      const percentMore = ((difference / straightLine) * 100).toFixed(1);
      console.log(`\n   📊 Difference: ${(difference/1000).toFixed(2)} km (${percentMore}% longer)`);
      console.log(`   💡 Why? Roads curve, have turns, follow terrain, avoid obstacles`);
    }
    
    console.log('\n' + '─'.repeat(70));
  }
  
  console.log('\n\n🎯 CONCLUSION:');
  console.log('   Our system uses ACTUAL ROAD DISTANCES from OSRM.');
  console.log('   These distances account for:');
  console.log('   • Real road paths and curves');
  console.log('   • Highways and local roads');
  console.log('   • One-way streets');
  console.log('   • Bridges and tunnels');
  console.log('   • Actual drivable routes\n');
}

demonstrateDifference();
