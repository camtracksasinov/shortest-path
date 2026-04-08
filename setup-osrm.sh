#!/bin/bash
set -e

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA_DIR="$PROJECT_DIR/osrm-data"
MAP_FILE="madagascar-latest.osm.pbf"
OSRM_FILE="madagascar-latest.osrm"
CONTAINER_NAME="osrm-server"
IMAGE="ghcr.io/project-osrm/osrm-backend"

echo "========================================"
echo "   OSRM Madagascar Setup"
echo "========================================"

# ── 1. Check Docker ───────────────────────────────────────────────────────────
if ! command -v docker &> /dev/null; then
  echo "▶ Docker not found. Installing..."
  sudo apt update -qq
  sudo apt install -y docker.io
  sudo systemctl start docker
  sudo systemctl enable docker
  sudo usermod -aG docker "$USER"
  echo "  ✅ Docker installed."
else
  echo "  ✅ Docker already installed."
fi

# ── 2. Create data directory ──────────────────────────────────────────────────
mkdir -p "$DATA_DIR"

# ── 3. Download map data ──────────────────────────────────────────────────────
download_map() {
  echo "▶ Downloading Madagascar map data..."
  wget --tries=3 --continue -O "$DATA_DIR/$MAP_FILE" "http://download.geofabrik.de/africa/$MAP_FILE"
  echo "  ✅ Download complete."
}

if [ ! -f "$DATA_DIR/$MAP_FILE" ]; then
  download_map
else
  # Verify the file is a valid PBF (not truncated/corrupted)
  if ! docker run --rm -v "$DATA_DIR:/data" "$IMAGE" \
      osmium fileinfo /data/$MAP_FILE > /dev/null 2>&1; then
    echo "  ⚠️  Existing map file is corrupted. Re-downloading..."
    rm -f "$DATA_DIR/$MAP_FILE"
    download_map
  else
    echo "  ✅ Map data already exists and is valid, skipping download."
  fi
fi

# ── 4. Process map data (skip if already processed) ──────────────────────────
if [ ! -f "$DATA_DIR/$OSRM_FILE" ]; then
  echo "▶ Step 1/3: Extracting road network..."
  docker run --rm -v "$DATA_DIR:/data" "$IMAGE" \
    osrm-extract -p /opt/car.lua /data/$MAP_FILE

  echo "▶ Step 2/3: Partitioning..."
  docker run --rm -v "$DATA_DIR:/data" "$IMAGE" \
    osrm-partition /data/$OSRM_FILE

  echo "▶ Step 3/3: Customizing..."
  docker run --rm -v "$DATA_DIR:/data" "$IMAGE" \
    osrm-customize /data/$OSRM_FILE

  echo "  ✅ Map processing complete."
else
  echo "  ✅ OSRM data already processed, skipping."
fi

# ── 5. Remove old container if exists ────────────────────────────────────────
if docker ps -a --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
  echo "▶ Removing existing container '$CONTAINER_NAME'..."
  docker rm -f "$CONTAINER_NAME"
fi

# ── 6. Start persistent OSRM container ───────────────────────────────────────
echo "▶ Starting OSRM container..."
docker run -d \
  --name "$CONTAINER_NAME" \
  --restart always \
  -p 5000:5000 \
  -v "$DATA_DIR:/data" \
  "$IMAGE" \
  osrm-routed --algorithm mld /data/$OSRM_FILE

# ── 7. Wait and verify ────────────────────────────────────────────────────────
echo "▶ Waiting for OSRM to be ready..."
for i in $(seq 1 15); do
  if curl -sf "http://localhost:5000/route/v1/driving/47.5079,-18.9137;47.5200,-18.9000?overview=false" > /dev/null 2>&1; then
    echo "  ✅ OSRM is up and responding at http://localhost:5000"
    break
  fi
  sleep 2
  if [ "$i" -eq 15 ]; then
    echo "  ⚠️  OSRM did not respond in time. Check: docker logs $CONTAINER_NAME"
  fi
done

# ── 8. Ensure OSRM_URL is set in .env ────────────────────────────────────────
ENV_FILE="$PROJECT_DIR/.env"
if grep -q "^OSRM_URL=" "$ENV_FILE" 2>/dev/null; then
  sed -i "s|^OSRM_URL=.*|OSRM_URL=http://localhost:5000|" "$ENV_FILE"
else
  echo "OSRM_URL=http://localhost:5000" >> "$ENV_FILE"
fi
echo "  ✅ OSRM_URL set in .env"

echo ""
echo "========================================"
echo "   Setup Complete!"
echo "   OSRM running at: http://localhost:5000"
echo "   Container '$CONTAINER_NAME' will auto-restart on reboot."
echo "========================================"
