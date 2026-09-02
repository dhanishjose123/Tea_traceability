#!/bin/bash

# SPDX-License-Identifier: Apache-2.0

TEST_NETWORK_HOME=${TEST_NETWORK_HOME:-${PWD}}

export CORE_PEER_TLS_ENABLED=true
export ORDERER_CA=${TEST_NETWORK_HOME}/organizations/ordererOrganizations/example.com/tlsca/tlsca.example.com-cert.pem
export ORDERER_CA_NAME="ca-orderer"

declare -A ORG_PORT_MAP=()
declare -A ORG_CAP_MAP=()
declare -A ORG_CA_PORT_MAP=()
declare -A ORG_CA_OP_PORT_MAP=()

ORG_NAMES=(
  "farmers"
  "aggregators"
  "retailers"
  "consumers"
  "bank"
)

BASE_CA_PORT=15051
BASE_OP_PORT=25051
PORT_STEP=1000
ORDERER_CA_PORT=12051
ORDERER_CA_OP_PORT=19054

ORG_PORT_MAP[farmers]=7051
ORG_CAP_MAP[farmers]=Farmers
ORG_CA_PORT_MAP[farmers]=15051
ORG_CA_OP_PORT_MAP[farmers]=25051
ORG_PORT_MAP[aggregators]=8051
ORG_CAP_MAP[aggregators]=Aggregators
ORG_CA_PORT_MAP[aggregators]=16051
ORG_CA_OP_PORT_MAP[aggregators]=26051
ORG_PORT_MAP[retailers]=9051
ORG_CAP_MAP[retailers]=Retailers
ORG_CA_PORT_MAP[retailers]=17051
ORG_CA_OP_PORT_MAP[retailers]=27051
ORG_PORT_MAP[consumers]=10051
ORG_CAP_MAP[consumers]=Consumers
ORG_CA_PORT_MAP[consumers]=18051
ORG_CA_OP_PORT_MAP[consumers]=28051
ORG_PORT_MAP[bank]=11051
ORG_CAP_MAP[bank]=Bank
ORG_CA_PORT_MAP[bank]=19051
ORG_CA_OP_PORT_MAP[bank]=29051

for ORG in "${ORG_NAMES[@]}"; do
  export PEER0_${ORG}_CA=${TEST_NETWORK_HOME}/organizations/peerOrganizations/${ORG}.example.com/tlsca/tlsca.${ORG}.example.com-cert.pem
done

setGlobals() {
  ORG=$1

  ORG_CAP=${ORG_CAP_MAP[$ORG]}
  PORT=${ORG_PORT_MAP[$ORG]}
  ROOT_CA_VAR="PEER0_${ORG}_CA"
  TLS_CA=${!ROOT_CA_VAR}

  if [ -z "$PORT" ] || [ -z "$TLS_CA" ]; then
    echo "ERROR: Unknown organization: $ORG"
    exit 1
  fi

  export CORE_PEER_LOCALMSPID="${ORG_CAP}MSP"
  export CORE_PEER_TLS_ROOTCERT_FILE=$TLS_CA
  export CORE_PEER_MSPCONFIGPATH=${TEST_NETWORK_HOME}/organizations/peerOrganizations/${ORG}.example.com/users/Admin@${ORG}.example.com/msp
  export CORE_PEER_ADDRESS=localhost:$PORT

  if [ "${VERBOSE:-false}" = "true" ]; then
    env | grep CORE
  fi
}

parsePeerConnectionParameters() {
  PEER_CONN_PARMS=()
  PEERS=""

  while [ "$#" -gt 0 ]; do
    ORG=$1
    shift

    setGlobals "$ORG"
    PEER="peer0.${ORG}"
    PEERS="$PEERS $PEER"
    PEER_CONN_PARMS+=("--peerAddresses" "$CORE_PEER_ADDRESS")
    PEER_CONN_PARMS+=("--tlsRootCertFiles" "$CORE_PEER_TLS_ROOTCERT_FILE")
  done
}
