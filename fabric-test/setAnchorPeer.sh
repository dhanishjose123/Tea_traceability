#!/bin/bash

# SPDX-License-Identifier: Apache-2.0

. scripts/envVar.sh
TEST_NETWORK_HOME=${TEST_NETWORK_HOME:-${PWD}}
. ${TEST_NETWORK_HOME}/scripts/configUpdate.sh

# This requires: jq, configtxlator

createAnchorPeerUpdate() {
  infoln "Fetching channel config for channel $CHANNEL_NAME"
  fetchChannelConfig $ORG $CHANNEL_NAME ${TEST_NETWORK_HOME}/channel-artifacts/${CORE_PEER_LOCALMSPID}config.json

  infoln "Generating anchor peer update transaction for $CORE_PEER_LOCALMSPID on channel $CHANNEL_NAME"

  HOST="peer0.${ORG}.example.com"
  PORT=${ORG_PORT_MAP[$ORG]}

  if [ -z "$PORT" ]; then
    errorln "No port mapping found for org '$ORG'"
    exit 1
  fi

  set -x
  jq '.channel_group.groups.Application.groups."'${CORE_PEER_LOCALMSPID}'".values += {
    "AnchorPeers": {
      "mod_policy": "Admins",
      "value": {
        "anchor_peers": [{
          "host": "'$HOST'",
          "port": '$PORT'
        }]
      },
      "version": "0"
    }
  }' \
  ${TEST_NETWORK_HOME}/channel-artifacts/${CORE_PEER_LOCALMSPID}config.json \
  > ${TEST_NETWORK_HOME}/channel-artifacts/${CORE_PEER_LOCALMSPID}modified_config.json
  res=$?
  { set +x; } 2>/dev/null
  verifyResult $res "Channel configuration update for anchor peer failed. Ensure jq is installed."

  createConfigUpdate \
    $CHANNEL_NAME \
    ${TEST_NETWORK_HOME}/channel-artifacts/${CORE_PEER_LOCALMSPID}config.json \
    ${TEST_NETWORK_HOME}/channel-artifacts/${CORE_PEER_LOCALMSPID}modified_config.json \
    ${TEST_NETWORK_HOME}/channel-artifacts/${CORE_PEER_LOCALMSPID}anchors.tx
}

updateAnchorPeer() {
  peer channel update \
    -o localhost:7050 \
    --ordererTLSHostnameOverride orderer.example.com \
    -c $CHANNEL_NAME \
    -f ${TEST_NETWORK_HOME}/channel-artifacts/${CORE_PEER_LOCALMSPID}anchors.tx \
    --tls \
    --cafile "$ORDERER_CA" >&log.txt
  res=$?
  cat log.txt
  verifyResult $res "Anchor peer update failed"
  successln "Anchor peer set for $CORE_PEER_LOCALMSPID on channel '$CHANNEL_NAME'"
}

# === Main Execution ===

ORG=$1          # lowercase name, e.g., farmers
CHANNEL_NAME=$2

if [ -z "$ORG" ] || [ -z "$CHANNEL_NAME" ]; then
  echo "Usage: $0 <org> <channel-name>"
  exit 1
fi

setGlobals "$ORG"
createAnchorPeerUpdate
updateAnchorPeer
