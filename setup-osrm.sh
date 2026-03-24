#!/bin/bash

echo "=== OSRM Self-Hosted Setup Script ==="
echo ""

# Check if Docker is installed
if ! command -v docker &> /dev/null; then
    echo "Docker not found. Installing Docker..."
    sudo apt update
    sudo apt install -y docker.io
    sudo systemctl start docker
    sudo systemctl enable docker
    sudo usermod -aG docker $USER
    echo "Docker installed. You may need to log out and back in."
fi

# Create data directory
echo "Creating OSRM data directory..."
mkdir -p osrm-data
cd osrm-data

# Download Cameroon map data
if [ ! -f "cameroon-latest.osm.pbf" ]; then
    echo "Downloading Cameroon map data..."
    wget http://download.geofabrik.de/africa/cameroon-latest.osm.pbf
else
    echo "Map data already exists."
fi

# Process map data
echo "Processing map data (this may take a few minutes)..."

echo "Step 1/3: Extracting..."
docker run -t -v "${PWD}:/data" ghcr.io/project-osrm/osrm-backend osrm-extract -p /opt/car.lua /data/cameroon-latest.osm.pbf

echo "Step 2/3: Partitioning..."
docker run -t -v "${PWD}:/data" ghcr.io/project-osrm/osrm-backend osrm-partition /data/cameroon-latest.osrm

echo "Step 3/3: Customizing..."
docker run -t -v "${PWD}:/data" ghcr.io/project-osrm/osrm-backend osrm-customize /data/cameroon-latest.osrm

echo ""
echo "=== Setup Complete! ==="
echo ""
echo "To start OSRM server, run:"
echo "docker run -t -i -p 5000:5000 -v \"\${PWD}:/data\" ghcr.io/project-osrm/osrm-backend osrm-routed --algorithm mld /data/cameroon-latest.osrm"
echo ""
echo "Or use docker-compose:"
echo "cd .. && docker-compose up -d"
echo ""
echo "OSRM will be available at: http://localhost:5000"
