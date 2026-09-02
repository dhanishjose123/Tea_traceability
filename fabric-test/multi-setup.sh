#!/bin/bash

# ================================
# 🔹 CONFIGURATION (FIXED)
# ================================
BASE_CHANNEL="tea-$(date +%s)"

CHANNELS=(
    "$BASE_CHANNEL"
    "${BASE_CHANNEL}_0"
    "${BASE_CHANNEL}_50"
    "${BASE_CHANNEL}_100"
)

DELAYS=(0 50 100)

CHAINCODE_NAME="tea_traceability"

NETWORK_DIR=~/fabric_2/fabric-test/test-network
BACKEND_DIR=~/fabric_2/backend
CALIPER_DIR=~/fabric_2/caliper-bench

# ================================
# 🔁 LOOP THROUGH CHANNELS
# ================================
for i in "${!CHANNELS[@]}"
do
  CHANNEL_NAME=${CHANNELS[$i]}
  DELAY=${DELAYS[$i]}

  echo "========================================"
  echo "🚀 RUNNING: $CHANNEL_NAME | Delay: ${DELAY}ms"
  echo "========================================"

  # ================================
  # 🔹 STEP 0: CLEAN NETWORK
  # ================================
  cd $NETWORK_DIR || exit

  echo "🧹 Cleaning network..."
  ./network.sh down

  docker ps -a | grep "dev-peer\|fabric\|orderer\|peer" | awk '{print $1}' | xargs -r docker rm -f
  docker volume prune -f
  docker network prune -f

  echo "✅ Cleanup complete"

  # ================================
  # 🔹 STEP 1: START NETWORK
  # ================================
  echo "🔧 Starting network..."
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
  echo "🚀 Starting backend..."

  cd $BACKEND_DIR || exit

  pkill -f node || true

  export CHANNEL_NAME=$CHANNEL_NAME
  export CHAINCODE_NAME=$CHAINCODE_NAME

  node server.js > server_${CHANNEL_NAME}.log 2>&1 &

  echo "⏳ Waiting for backend..."
  sleep 5

  # ================================
  # 🔹 STEP 4: RUN SIMULATION
  # ================================
  echo "🎯 Running simulation..."

  node sim-create.js
  node sim-submit.js

  # ================================
  # 🔹 STEP 5: UPDATE CALIPER CONFIG
  # ================================
  echo "⚙️ Updating Caliper config..."

  NETWORK_FILE=$CALIPER_DIR/caliper-network.yaml

  sed -i "0,/channelName:/s/channelName:.*/channelName: $CHANNEL_NAME/" $NETWORK_FILE

  echo "✅ Caliper config updated"

  # ================================
  # 🔹 STEP 6: APPLY NETWORK LATENCY
  # ================================
  cd $CALIPER_DIR || exit

  echo "🌐 Configuring network latency..."

  sudo tc qdisc del dev eth0 root 2>/dev/null

  if [ "$DELAY" -eq 0 ]; then
    echo "✔ No latency (baseline)"
  else
    echo "⚡ Applying ${DELAY}ms latency"
    sudo tc qdisc add dev eth0 root netem delay ${DELAY}ms 10ms loss 1%
  fi

  # ================================
  # 🔹 STEP 7: RUN CALIPER
  # ================================
  echo "📊 Running Caliper benchmark..."

  node run.js
  node runretrievalbenchmarks.js

  # ================================
  # 🔹 STEP 8: REMOVE LATENCY
  # ================================
  echo "🧹 Removing latency..."

  sudo tc qdisc del dev eth0 root

  echo "✅ Completed: $CHANNEL_NAME"

done

# ================================
# 🔹 FINAL
# ================================
echo "========================================"
echo "🎯 ALL EXPERIMENTS COMPLETED"
echo "========================================"