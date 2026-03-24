# Self-Hosted OSRM Setup Guide

## Option 1: Docker (Easiest - Recommended)

### Step 1: Install Docker
```bash
# Ubuntu/Debian
sudo apt update
sudo apt install docker.io docker-compose
sudo systemctl start docker
sudo systemctl enable docker
```

### Step 2: Download Map Data
Download OpenStreetMap data for your region (Madagascar):
```bash
# Create directory
mkdir -p osrm-data
cd osrm-data

# Download Madagascar map
wget http://download.geofabrik.de/africa/madagascar-latest.osm.pbf

# Or download Cameroon map
wget http://download.geofabrik.de/africa/cameroon-latest.osm.pbf
```

### Step 3: Process Map Data
```bash
# Extract road network
docker run -t -v "${PWD}:/data" ghcr.io/project-osrm/osrm-backend osrm-extract -p /opt/car.lua /data/madagascar-latest.osm.pbf

# Partition data
docker run -t -v "${PWD}:/data" ghcr.io/project-osrm/osrm-backend osrm-partition /data/madagascar-latest.osrm

# Customize data
docker run -t -v "${PWD}:/data" ghcr.io/project-osrm/osrm-backend osrm-customize /data/madagascar-latest.osrm
```

### Step 4: Run OSRM Server
```bash
docker run -t -i -p 5000:5000 -v "${PWD}:/data" ghcr.io/project-osrm/osrm-backend osrm-routed --algorithm mld /data/madagascar-latest.osrm
```

Your OSRM server will be available at: `http://localhost:5000`

### Step 5: Update Your App
Change the OSRM URL in `server.js`:
```javascript
// From:
const url = `http://router.project-osrm.org/route/v1/driving/...`;

// To:
const url = `http://localhost:5000/route/v1/driving/...`;
```

---

## Option 2: Docker Compose (Production)

Create `docker-compose.yml` in your project:

```yaml
version: '3'
services:
  osrm:
    image: ghcr.io/project-osrm/osrm-backend
    ports:
      - "5000:5000"
    volumes:
      - ./osrm-data:/data
    command: osrm-routed --algorithm mld /data/madagascar-latest.osrm
    restart: unless-stopped
```

Run with:
```bash
docker-compose up -d
```

---

## Option 3: AWS/Cloud Deployment

### AWS EC2:
1. Launch Ubuntu EC2 instance (t3.medium or larger)
2. Install Docker
3. Follow Docker steps above
4. Open port 5000 in Security Group
5. Use EC2 public IP: `http://YOUR_EC2_IP:5000`

### DigitalOcean/Linode:
Same as AWS, use their droplet/instance

---

## Map Data Sources

Download from Geofabrik (free):
- **Madagascar**: http://download.geofabrik.de/africa/madagascar-latest.osm.pbf
- **Cameroon**: http://download.geofabrik.de/africa/cameroon-latest.osm.pbf
- **All Africa**: http://download.geofabrik.de/africa-latest.osm.pbf
- **Specific country**: http://download.geofabrik.de/

---

## Testing Your OSRM Server

```bash
# Test route
curl "http://localhost:5000/route/v1/driving/9.7367,4.0994;9.7071,4.0646?overview=false"
```

---

## System Requirements

- **RAM**: 2GB minimum (4GB+ recommended)
- **Storage**: 
  - Madagascar: ~200MB
  - Cameroon: ~500MB
  - Africa: ~10GB
  - World: ~300GB
- **CPU**: 2+ cores recommended

---

## Advantages

✅ Unlimited requests
✅ No rate limits
✅ Full control
✅ Faster (local network)
✅ Privacy (your data stays local)
✅ Free forever

## Disadvantages

❌ Requires server/infrastructure
❌ Need to update map data periodically
❌ Initial setup complexity
