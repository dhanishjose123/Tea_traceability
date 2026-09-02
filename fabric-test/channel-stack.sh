#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
TEST_NETWORK_DIR="${ROOT_DIR}/fabric-test/test-network"
BACKEND_DIR="${ROOT_DIR}/backend"
CALIPER_DIR="${ROOT_DIR}/caliper-bench"
CHAINCODE_DIR="${TEST_NETWORK_DIR}/chaincode-javascript"

CHAINCODE_NAME="${CHAINCODE_NAME:-tea_traceability}"
CHAINCODE_PATH="${CHAINCODE_PATH:-./chaincode-javascript}"
CHAINCODE_LANGUAGE="${CHAINCODE_LANGUAGE:-javascript}"
ENDORSEMENT_POLICY="${ENDORSEMENT_POLICY:-OR('BankMSP.peer','ConsumersMSP.peer','AuctioncentersMSP.peer','FarmersMSP.peer','AggregatorsMSP.peer','RetailersMSP.peer')}"
TC_INSTALL_CONTAINERS=(
  orderer.example.com
  peer0.farmers.example.com
  peer0.aggregators.example.com
  peer0.retailers.example.com
  peer0.consumers.example.com
  peer0.bank.example.com
)
TC_PEER_CONTAINERS=(
  peer0.farmers.example.com
  peer0.aggregators.example.com
  peer0.retailers.example.com
  peer0.consumers.example.com
  peer0.bank.example.com
)

usage() {
  cat <<EOF
Usage:
  ./channel-stack.sh <channel-name> <mode> [chaincode-name] [latency-ms] [jitter-ms] [loss-percent] [caliper-workers] [user-count]

Modes:
  fresh    Bring network down, prune Docker, bring network up, create channel
  deploy   Deploy chaincode to the given channel
  server   Start backend/server.js with CHANNEL_NAME set
  start    Run backend/sim-setup.js after the server is up
  caliper  Run caliper-bench/run.js with CHANNEL_NAME set
  netem    Apply or remove network latency/loss only
  verify-netem  Show tc qdisc for peer containers
  all      Fresh network, deploy chaincode, start backend, then run Caliper

You can also combine modes with +, for example:
  fresh+deploy+server+start
  deploy+server+caliper
  fresh+deploy
  fresh+deploy+server+caliper

Examples:
  ./channel-stack.sh agrochannel2604 fresh
  ./channel-stack.sh agrochannel2604 deploy
  ./channel-stack.sh agrochannel2604 deploy tea_traceability
  ./channel-stack.sh agrochannel2604 server+start+caliper tea_traceability 50 10 1
  ./channel-stack.sh agrochannel2604 server+start+caliper tea_traceability 50 10 1 10
  ./channel-stack.sh agrochannel2604 server+start+caliper tea_traceability 50 10 1 auto 10
  ./channel-stack.sh agrochannel2604 server+start+caliper tea_traceability 0
  ./channel-stack.sh agrochannel2604 server
  ./channel-stack.sh agrochannel2604 fresh+deploy+server+start
  ./channel-stack.sh agrochannel2604 fresh+deploy+server+start tea_traceability
  ./channel-stack.sh agrochannel2604 caliper
  ./channel-stack.sh agrochannel2604 all

Network impairment args:
  latency-ms    0 disables/removes tc netem latency. Example: 50 or 50ms
  jitter-ms     Optional jitter. Example: 10 or 10ms
  loss-percent  Optional packet loss. Example: 1 or 1%
  caliper-workers Optional Caliper workers. Default: auto from workload name
  user-count      Optional identities to import/setup per org. Default: 10
EOF
}

if [ "$#" -lt 2 ]; then
  usage
  exit 1
fi

CHANNEL_NAME="$1"
MODE="$2"
CHAINCODE_NAME="${3:-${CHAINCODE_NAME}}"
NETEM_LATENCY="${4:-0}"
NETEM_JITTER="${5:-0}"
NETEM_LOSS="${6:-0}"
CALIPER_WORKERS="${7:-${CALIPER_WORKERS:-auto}}"
USER_COUNT="${8:-${SIM_USER_COUNT:-${USER_COUNT:-10}}}"
BACKEND_PID=""
SERVER_PORT="${SERVER_PORT:-5000}"
NETEM_CONFIGURED=0
NETEM_REQUESTED=0

if [ "$#" -ge 4 ]; then
  NETEM_REQUESTED=1
fi

normalize_ms() {
  local value="$1"
  if [[ "${value}" == *ms ]]; then
    echo "${value}"
  else
    echo "${value}ms"
  fi
}

normalize_loss() {
  local value="$1"
  if [[ "${value}" == *% ]]; then
    echo "${value}"
  else
    echo "${value}%"
  fi
}

is_zero_value() {
  local value="$1"
  value="${value%ms}"
  value="${value%\%}"
  [[ "${value}" == "0" || "${value}" == "0.0" || -z "${value}" ]]
}

container_running() {
  local container="$1"
  docker inspect -f '{{.State.Running}}' "${container}" 2>/dev/null | grep -q true
}

install_tc_dependencies() {
  local container
  for container in "${TC_INSTALL_CONTAINERS[@]}"; do
    if container_running "${container}"; then
      echo "===== Ensuring tc dependencies on ${container} ====="
      docker exec "${container}" bash -c \
        "command -v tc >/dev/null 2>&1 && command -v ping >/dev/null 2>&1 || (apt update && apt install -y iproute2 iputils-ping)"
    else
      echo "Skipping tc install; container not running: ${container}"
    fi
  done
}

remove_network_impairment() {
  local container
  for container in "${TC_PEER_CONTAINERS[@]}"; do
    if container_running "${container}"; then
      echo "===== Removing latency on ${container} ====="
      docker exec "${container}" bash -c "command -v tc >/dev/null 2>&1 && tc qdisc del dev eth0 root 2>/dev/null || true"
    else
      echo "Skipping latency removal; container not running: ${container}"
    fi
  done
}

apply_network_impairment() {
  local container
  local latency
  local jitter
  local loss

  latency="$(normalize_ms "${NETEM_LATENCY}")"
  jitter="$(normalize_ms "${NETEM_JITTER}")"
  loss="$(normalize_loss "${NETEM_LOSS}")"

  install_tc_dependencies

  for container in "${TC_PEER_CONTAINERS[@]}"; do
    if container_running "${container}"; then
      echo "===== Applying latency on ${container}: delay ${latency} ${jitter}, loss ${loss} ====="
      docker exec "${container}" tc qdisc replace dev eth0 root netem delay "${latency}" "${jitter}" loss "${loss}"
    else
      echo "Skipping latency apply; container not running: ${container}"
    fi
  done
}

configure_network_impairment() {
  if [ "${NETEM_REQUESTED}" -eq 0 ]; then
    return
  fi

  if [ "${NETEM_CONFIGURED}" -eq 1 ]; then
    return
  fi

  if is_zero_value "${NETEM_LATENCY}" && is_zero_value "${NETEM_LOSS}"; then
    echo "Network impairment disabled; removing any existing tc netem rules"
    install_tc_dependencies
    remove_network_impairment
  else
    apply_network_impairment
  fi

  NETEM_CONFIGURED=1
}

verify_network_impairment() {
  local container
  for container in "${TC_PEER_CONTAINERS[@]}"; do
    if container_running "${container}"; then
      echo "===== Checking ${container} ====="
      docker exec "${container}" bash -c "command -v tc >/dev/null 2>&1 && tc qdisc show dev eth0 || echo 'tc not installed in this container'"
    else
      echo "Skipping tc check; container not running: ${container}"
    fi
  done
}

sync_chaincode_index() {
  local contract_file
  local index_file

  contract_file="${CHAINCODE_DIR}/lib/${CHAINCODE_NAME}.js"
  index_file="${CHAINCODE_DIR}/index.js"

  if [ ! -f "${contract_file}" ]; then
    echo "Chaincode contract file not found: ${contract_file}"
    exit 1
  fi

  cat > "${index_file}" <<EOF
'use strict';

const TeaTraceabilityContract = require('./lib/${CHAINCODE_NAME}');

module.exports.contracts = [TeaTraceabilityContract];
EOF

  echo "Updated chaincode index.js to use ./lib/${CHAINCODE_NAME}"
}

fresh_network() {
  echo "Stopping existing network"
  (
    cd "${TEST_NETWORK_DIR}"
    ./network.sh down
  )

  echo "Pruning Docker system"
  docker system prune -f

  echo "Regenerating Fabric network files with USER_COUNT=${USER_COUNT}"
  (
    cd "${TEST_NETWORK_DIR}/yaml"
    ./generate.sh \
      "farmers=${USER_COUNT}" \
      "aggregators=${USER_COUNT}" \
      "retailers=${USER_COUNT}" \
      "consumers=${USER_COUNT}" \
      "bank=${USER_COUNT}"
  )

  echo "Starting network and creating channel ${CHANNEL_NAME}"
  (
    cd "${TEST_NETWORK_DIR}"
    ./network.sh up createChannel -c "${CHANNEL_NAME}"
  )
}

stop_existing_server() {
  local existing_pids
  existing_pids="$(lsof -ti tcp:${SERVER_PORT} 2>/dev/null || true)"

  if [ -n "${existing_pids}" ]; then
    echo "Stopping existing server process(es) on port ${SERVER_PORT}: ${existing_pids}"
    kill ${existing_pids} >/dev/null 2>&1 || true
    sleep 2
  fi
}

deploy_chaincode() {
  echo "Deploying ${CHAINCODE_NAME} to channel ${CHANNEL_NAME}"
  sync_chaincode_index
  (
    cd "${TEST_NETWORK_DIR}"
    ./network.sh deployCC \
      -c "${CHANNEL_NAME}" \
      -ccn "${CHAINCODE_NAME}" \
      -ccp "${CHAINCODE_PATH}" \
      -ccl "${CHAINCODE_LANGUAGE}" \
      -ccep "${ENDORSEMENT_POLICY}"
  )
}

start_server() {
  stop_existing_server
  echo "Starting backend server with CHANNEL_NAME=${CHANNEL_NAME}, USER_COUNT=${USER_COUNT}"
  cd "${BACKEND_DIR}"
  CHANNEL_NAME="${CHANNEL_NAME}" CHAINCODE_NAME="${CHAINCODE_NAME}" SIM_USER_COUNT="${USER_COUNT}" USER_COUNT="${USER_COUNT}" node server.js
}

run_caliper() {
  echo "Running Caliper with CHANNEL_NAME=${CHANNEL_NAME}, CHAINCODE_NAME=${CHAINCODE_NAME}, latency=${NETEM_LATENCY}, jitter=${NETEM_JITTER}, loss=${NETEM_LOSS}, workers=${CALIPER_WORKERS}"
  (
    cd "${CALIPER_DIR}"
    CHANNEL_NAME="${CHANNEL_NAME}" \
      CHAINCODE_NAME="${CHAINCODE_NAME}" \
      NETEM_LATENCY="${NETEM_LATENCY}" \
      NETEM_JITTER="${NETEM_JITTER}" \
      NETEM_LOSS="${NETEM_LOSS}" \
      CALIPER_WORKERS="${CALIPER_WORKERS}" \
      SIM_USER_COUNT="${USER_COUNT}" \
      USER_COUNT="${USER_COUNT}" \
      node run.js "${NETEM_LATENCY}" "${NETEM_JITTER}" "${NETEM_LOSS}" "${CALIPER_WORKERS}"
  )
}

start_server_background() {
  local log_file
  log_file="${BACKEND_DIR}/server-${CHANNEL_NAME}.log"

  stop_existing_server
  echo "Starting backend server in background with CHANNEL_NAME=${CHANNEL_NAME}, USER_COUNT=${USER_COUNT}"
  (
    cd "${BACKEND_DIR}"
    CHANNEL_NAME="${CHANNEL_NAME}" CHAINCODE_NAME="${CHAINCODE_NAME}" SIM_USER_COUNT="${USER_COUNT}" USER_COUNT="${USER_COUNT}" node server.js > "${log_file}" 2>&1
  ) &
  BACKEND_PID=$!
  echo "Backend PID: ${BACKEND_PID}"
  echo "Backend log: ${log_file}"
  sleep 5
}

run_backend_setup() {
  echo "Running backend sim-setup with CHANNEL_NAME=${CHANNEL_NAME}, USER_COUNT=${USER_COUNT}"
  (
    cd "${BACKEND_DIR}"
    CHANNEL_NAME="${CHANNEL_NAME}" CHAINCODE_NAME="${CHAINCODE_NAME}" SIM_USER_COUNT="${USER_COUNT}" USER_COUNT="${USER_COUNT}" node sim-setup.js
  )
}

cleanup() {
  if [ -n "${BACKEND_PID}" ] && kill -0 "${BACKEND_PID}" >/dev/null 2>&1; then
    echo "Stopping backend server PID ${BACKEND_PID}"
    kill "${BACKEND_PID}" >/dev/null 2>&1 || true
    wait "${BACKEND_PID}" 2>/dev/null || true
  fi
}

trap cleanup EXIT

if [ "${MODE}" = "server" ]; then
  cleanup
  start_server
  exit 0
fi

if [ "${MODE}" = "all" ]; then
  MODE="fresh+deploy+server+caliper"
fi

IFS='+' read -r -a STEPS <<< "${MODE}"
SERVER_STARTED=0

for STEP in "${STEPS[@]}"; do
  case "${STEP}" in
    fresh)
      fresh_network
      configure_network_impairment
      ;;
    deploy)
      deploy_chaincode
      ;;
    server)
      start_server_background
      SERVER_STARTED=1
      ;;
    start)
      if [ "${SERVER_STARTED}" -eq 0 ]; then
        start_server_background
        SERVER_STARTED=1
      fi
      configure_network_impairment
      run_backend_setup
      ;;
    caliper)
      if [ "${SERVER_STARTED}" -eq 0 ]; then
        echo "caliper mode now requires an explicit backend startup step."
        echo "Use one of:"
        echo "  ./channel-stack.sh ${CHANNEL_NAME} server+start+caliper"
        echo "  ./channel-stack.sh ${CHANNEL_NAME} server+caliper"
        exit 1
      fi
      configure_network_impairment
      if [ "${NETEM_REQUESTED}" -eq 1 ]; then
        verify_network_impairment
      fi
      run_caliper
      ;;
    netem)
      NETEM_REQUESTED=1
      configure_network_impairment
      ;;
    verify-netem)
      verify_network_impairment
      ;;
    "")
      ;;
    *)
      usage
      exit 1
      ;;
  esac
done
