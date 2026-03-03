#!/bin/bash
# Deploys claude-strava MCP server to the Hostinger VPS
set -e

VPS_IP="187.77.203.66"
VPS_USER="root"
REMOTE_DIR="/opt/claude-strava"

echo "→ Copying files to VPS..."
ssh "$VPS_USER@$VPS_IP" "mkdir -p $REMOTE_DIR"
scp server.js db.js package.json .env "$VPS_USER@$VPS_IP:$REMOTE_DIR/"

echo "→ Installing dependencies on VPS..."
ssh "$VPS_USER@$VPS_IP" "cd $REMOTE_DIR && npm install --omit=dev"

echo "→ Restarting service..."
ssh "$VPS_USER@$VPS_IP" "systemctl restart claude-strava"

echo "✓ Deploy complete"
