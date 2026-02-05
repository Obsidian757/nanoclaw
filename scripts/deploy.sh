#!/bin/bash
# Deploy Damien to VPS

set -e

echo "🚀 Deploying Damien..."

# Build
echo "Building..."
npm run build
docker build -t damien:latest .

# Deploy to VPS
echo "Deploying to VPS..."
ssh clawd@76.13.98.156 "mkdir -p /opt/damien"

# Copy files
rsync -avz --exclude 'node_modules' --exclude '.git' \
  ./ clawd@76.13.98.156:/opt/damien/

# Start on VPS
ssh clawd@76.13.98.156 "cd /opt/damien && docker-compose up -d"

echo "✅ Deployed! Check logs with:"
echo "ssh clawd@76.13.98.156 'docker-compose -f /opt/damien/docker-compose.yml logs -f'"
