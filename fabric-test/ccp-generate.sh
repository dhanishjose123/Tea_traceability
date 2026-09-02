#!/bin/bash
set -euo pipefail
: ${VERBOSE:=false}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEST_NETWORK_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
PROJECT_ROOT="$(cd "${TEST_NETWORK_DIR}/../.." && pwd)"
PROJECT_NAME="$(basename "${PROJECT_ROOT}")"
FABRIC_HOME="${HOME}/${PROJECT_NAME}"

. "${TEST_NETWORK_DIR}/scripts/envVar.sh"

# ---------- helpers ----------
one_line_pem() { awk '{ if (NR==1){printf "%s",$0}else{printf "\\n%s",$0} }' "$1"; }
toProperCase(){ echo "$(tr '[:lower:]' '[:upper:]' <<< ${1:0:1})${1:1}"; }

TEMPLATE_JSON="${SCRIPT_DIR}/ccp-template.json"
TEMPLATE_YAML="${SCRIPT_DIR}/ccp-template.yaml"

[[ -f "$TEMPLATE_JSON" && -f "$TEMPLATE_YAML" ]] || { echo "❌ Missing ccp templates in $SCRIPT_DIR"; exit 1; }
command -v envsubst >/dev/null || { echo "❌ envsubst not found"; exit 1; }

json_ccp() {
  local ORG=$1 ORG_CAP=$2 P0PORT=$3 CAPORT=$4
  local PEERPEM_PATH=$5 CAPEM_PATH=$6
  local ORDERER_PORT=$7 ORDERERPEM_PATH=$8 ORDERER_CA_PORT=$9 ORDERER_CA_NAME=${10} ORDERER_CAPEM_PATH=${11}

  local PEERPEM CAPEM ORDERERPEM ORDERER_CAPEM
  PEERPEM="$(one_line_pem "$PEERPEM_PATH")"
  CAPEM="$(one_line_pem "$CAPEM_PATH")"
  ORDERERPEM="$(one_line_pem "$ORDERERPEM_PATH")"
  ORDERER_CAPEM="$(one_line_pem "$ORDERER_CAPEM_PATH")"

  export ORG ORG_CAP P0PORT CAPORT PEERPEM CAPEM ORDERER_PORT ORDERERPEM ORDERER_CA_PORT ORDERER_CA_NAME ORDERER_CAPEM
  envsubst < "$TEMPLATE_JSON"
}

yaml_ccp() {
  local ORG=$1 ORG_CAP=$2 P0PORT=$3 CAPORT=$4
  local PEERPEM_PATH=$5 CAPEM_PATH=$6
  local ORDERER_PORT=$7 ORDERERPEM_PATH=$8 ORDERER_CA_PORT=$9 ORDERER_CA_NAME=${10} ORDERER_CAPEM_PATH=${11}

  local PEERPEM CAPEM ORDERERPEM ORDERER_CAPEM
  PEERPEM="$(one_line_pem "$PEERPEM_PATH")"
  CAPEM="$(one_line_pem "$CAPEM_PATH")"
  ORDERERPEM="$(one_line_pem "$ORDERERPEM_PATH")"
  ORDERER_CAPEM="$(one_line_pem "$ORDERER_CAPEM_PATH")"

  export ORG ORG_CAP P0PORT CAPORT PEERPEM CAPEM ORDERER_PORT ORDERERPEM ORDERER_CA_PORT ORDERER_CA_NAME ORDERER_CAPEM
  envsubst < "$TEMPLATE_YAML" | sed -e $'s/\\\\n/\\\n        /g'
}

# ---------- orderer consts ----------
ORDERER_PORT="${ORDERER_PORT:-7050}"
ORDERER_CA_PORT="${ORDERER_CA_PORT:-12051}"
ORDERER_CA_NAME="${ORDERER_CA_NAME:-ca-orderer}"

ORDERER_TLS_CA="${TEST_NETWORK_DIR}/organizations/ordererOrganizations/example.com/orderers/orderer.example.com/tls/ca.crt"
ORDERER_ECA="${TEST_NETWORK_DIR}/organizations/ordererOrganizations/example.com/ca/ca.example.com-cert.pem"

# ---------- per-org generation ----------
combined_json='{
  "name": "CombinedNetwork",
  "version": "1.0.0",
  "organizations": {},
  "peers": {},
  "certificateAuthorities": {},
  "channels": { "defaultchannel": { "orderers": ["orderer.example.com"], "peers": {} } },
  "orderers": {
    "orderer.example.com": {
      "url": "grpcs://localhost:'"$ORDERER_PORT"'",
      "tlsCACerts": { "path": "'"${TEST_NETWORK_DIR}"'/organizations/ordererOrganizations/example.com/orderers/orderer.example.com/tls/ca.crt" },
      "grpcOptions": { "ssl-target-name-override": "orderer.example.com", "hostnameOverride": "orderer.example.com" }
    }
  }
}'
combined_orgs="{}"; combined_peers="{}"; combined_cas="{}"; combined_channel_peers="{}"

for ORG in "${ORG_NAMES[@]}"; do
  ORG_CAP=$(toProperCase "$ORG")
  P0PORT=${ORG_PORT_MAP[$ORG]}
  CAPORT=${ORG_CA_PORT_MAP[$ORG]}

  PEERPEM="${TEST_NETWORK_DIR}/organizations/peerOrganizations/${ORG}.example.com/tlsca/tlsca.${ORG}.example.com-cert.pem"
  CAPEM="${TEST_NETWORK_DIR}/organizations/peerOrganizations/${ORG}.example.com/ca/ca.${ORG}.example.com-cert.pem"

  echo "🔧 Generating CCP for ${ORG} (${ORG_CAP})..."
  mkdir -p "${TEST_NETWORK_DIR}/organizations/peerOrganizations/${ORG}.example.com"

  json_file="${TEST_NETWORK_DIR}/organizations/peerOrganizations/connection-${ORG}.json"
  yaml_file="${TEST_NETWORK_DIR}/organizations/peerOrganizations/connection-${ORG}.yaml"

  json_ccp "$ORG" "$ORG_CAP" "$P0PORT" "$CAPORT" "$PEERPEM" "$CAPEM" "$ORDERER_PORT" "$ORDERER_TLS_CA" "$ORDERER_CA_PORT" "$ORDERER_CA_NAME" "$ORDERER_ECA" > "$json_file"
  yaml_ccp "$ORG" "$ORG_CAP" "$P0PORT" "$CAPORT" "$PEERPEM" "$CAPEM" "$ORDERER_PORT" "$ORDERER_TLS_CA" "$ORDERER_CA_PORT" "$ORDERER_CA_NAME" "$ORDERER_ECA" > "$yaml_file"

  # (keep your jq/yq merge code here if you’re building combined files from per-org)
done

# ---------- copy generated profiles to backend/connections ----------
. "${TEST_NETWORK_DIR}/scripts/envVar.sh"
ORG_DIR="${TEST_NETWORK_DIR}/organizations/peerOrganizations"
TARGET_DIR="${PROJECT_ROOT}/backend/connections"
mkdir -p "$TARGET_DIR"

for ORG in "${ORG_NAMES[@]}"; do
  for ext in json yaml; do
    SRC="${ORG_DIR}/connection-${ORG}.${ext}"
    DST="${TARGET_DIR}/connection-${ORG}.${ext}"
    if [[ -f "$SRC" ]]; then
      cp -f "$SRC" "$DST"
      echo "✅ Copied $SRC → $DST"
    else
      echo "⚠️  Missing $SRC"
    fi
  done
done
