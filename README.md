# Shortest Path Way App

A Node.js backend service that calculates the shortest path through multiple zones using real road distances and Dijkstra's algorithm.

## Features

- Uses OSRM (Open Source Routing Machine) for real road distances
- Implements Dijkstra-inspired greedy nearest neighbor algorithm
- Returns organized route with step-by-step directions
- Starts from base position and visits all zones without returning

## Installation

```bash
npm install express axios nodemon
```

## Usage

### Start the server:
```bash
npm start
# or for development with auto-reload:
npm run dev
```

### Test the API:
```bash
npm test
```

## API Endpoint

**POST** `/shortest-path`

### Request Body:

Supports two zone formats:

**1. Point Location (single lat/long):**
```json
{
  "zones": [
    {
      "name": "Base Station",
      "latitude": 40.7128,
      "longitude": -74.0060
    }
  ]
}
```

**2. Geofence Zone (multiple coordinates):**
```json
{
  "zones": [
    {
      "name": "Zone A",
      "coordinates": [
        { "latitude": 40.7589, "longitude": -73.9851 },
        { "latitude": 40.7599, "longitude": -73.9841 },
        { "latitude": 40.7579, "longitude": -73.9831 }
      ]
    }
  ]
}
```

**3. Mixed (both types):**
```json
{
  "zones": [
    {
      "name": "Base Station",
      "latitude": 40.7128,
      "longitude": -74.0060
    },
    {
      "name": "Zone A (Geofence)",
      "coordinates": [
        { "latitude": 40.7589, "longitude": -73.9851 },
        { "latitude": 40.7599, "longitude": -73.9841 },
        { "latitude": 40.7579, "longitude": -73.9831 }
      ]
    }
  ]
}
```

### Response:
```json
{
  "success": true,
  "totalDistance": 8543,
  "totalDistanceKm": "8.54",
  "route": [
    {
      "step": 1,
      "zoneIndex": 0,
      "zoneName": "Base Station",
      "location": {
        "latitude": 40.7128,
        "longitude": -74.0060
      },
      "isGeofence": false
    },
    {
      "step": 2,
      "zoneIndex": 1,
      "zoneName": "Zone A",
      "location": {
        "latitude": 40.7589,
        "longitude": -73.9841
      },
      "isGeofence": true,
      "geofence": [
        { "latitude": 40.7589, "longitude": -73.9851 },
        { "latitude": 40.7599, "longitude": -73.9841 }
      ]
    }
  ]
}
```

## Algorithm

The service uses a greedy nearest neighbor approach inspired by Dijkstra's algorithm:
1. Start at the base position (first zone)
2. For geofence zones, calculate the centroid as the representative point
3. At each step, select the nearest unvisited zone
4. Continue until all zones are visited
5. Uses actual road distances from OSRM API
