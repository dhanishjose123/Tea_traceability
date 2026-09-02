#!/bin/bash

# ================================
# 🔹 INPUT ARGUMENTS
# ================================
CHANNEL_NAME=$1
CHAINCODE_NAME=$2

if [ -z "$CHANNEL_NAME" ] || [ -z "$CHAINCODE_NAME" ]; then
  echo "❌ Usage: ./setup-network.sh <channel-name> <chaincode-name>"
  exit 1
fi

echo "🚀 Starting setup"
echo "🌐 Channel: $CHANNEL_NAME"
echo "📦 Chaincode: $CHAINCODE_NAME"

# ================================
# 🔹 PATHS
# ================================
NETWORK_DIR=~/fabric_2/fabric-test/test-network
BACKEND_DIR=~/fabric_2/backend
CALIPER_DIR=~/fabric_2/caliper-bench



# ================================
# 🔹 STEP 0: CLEAN FABRIC ENV
# ================================
echo "🧹 Cleaning previous Fabric network..."

cd $NETWORK_DIR || exit

./network.sh down

# Remove only Fabric-related containers
docker ps -a | grep "dev-peer\|fabric\|orderer\|peer" | awk '{print $1}' | xargs -r docker rm -f

# Remove unused volumes (safe)
docker volume prune -f

# Remove unused networks (safe)
docker network prune -f

echo "✅ Fabric cleanup complete"

# ================================
# 🔹 STEP 1: START NETWORK
# ================================
echo "🔧 Bringing up network..."

cd $NETWORK_DIR || exit

./network.sh down
./network.sh up createChannel -c $CHANNEL_NAME

if [ $? -ne 0 ]; then
  echo "❌ Network setup failed"
  exit 1
fi

# ================================
# 🔹 STEP 2: DEPLOY CHAINCODE
# ================================
echo "📦 Deploying chaincode..."

./network.sh deployCC \
-c $CHANNEL_NAME \
-ccn $CHAINCODE_NAME \
-ccp ./chaincode-javascript \
-ccl javascript \
-ccep "OR('FarmersMSP.peer','RetailersMSP.peer','ConsumersMSP.peer','BankMSP.peer','AggregatorsMSP.peer')"

if [ $? -ne 0 ]; then
  echo "❌ Chaincode deployment failed"
  exit 1
fi

# ================================
# 🔹 STEP 3: START BACKEND
# ================================
echo "🚀 Starting backend server..."

cd $BACKEND_DIR || exit

pkill -f node || true
# npm install

export CHANNEL_NAME=$CHANNEL_NAME
export CHAINCODE_NAME=$CHAINCODE_NAME

node server.js > server.log 2>&1 &

echo "⏳ Waiting for backend..."
sleep 10

# ================================
# 🔹 STEP 4: RUN SIMULATION
# ================================
echo "🎯 Running simulation..."

node sim-create.js
node sim-submit.js

================================
🔹 STEP 5: UPDATE CALIPER CONFIG
================================
echo "⚙️ Updating Caliper configuration..."

NETWORK_FILE=$CALIPER_DIR/caliper-network.yaml


sed -i "0,/channelName:/s/channelName:.*/channelName: $CHANNEL_NAME/" $NETWORK_FILE


echo "✅ Caliper config updated"




# ================================
# 🔹 STEP 6: RUN CALIPER WITH LATENCY
# ================================
echo "🚀 Running Caliper benchmark with latency..."

cd $CALIPER_DIR || exit

# Ensure clean state
sudo tc qdisc del dev eth0 root 2>/dev/null

# # Apply latency (example: 100ms)
# echo "🌐 Applying 100ms latency..."
# sudo tc qdisc add dev eth0 root netem delay 100ms 20ms loss 1%

# Run Caliper
node run.js
node runretrievalbenchmarks.js

# Remove latency after run
# echo "🧹 Removing latency..."
sudo tc qdisc del dev eth0 root

echo "✅ Caliper run completed with latency"


echo "✅ CALIPER EXECUTION COMPLETE"
echo "✅ FULL SETUP COMPLETE"