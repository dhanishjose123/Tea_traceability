#!/bin/bash

set -euo pipefail

DEFAULT_ORGS=(financiers consumers auctioncenters farmers wholesalers retailers bank)
DEFAULT_USER_COUNT=${DEFAULT_USER_COUNT:-5}
PEER_BASE_PORT=${PEER_BASE_PORT:-7051}
CA_BASE_PORT=${CA_BASE_PORT:-15051}
OPS_BASE_PORT=${OPS_BASE_PORT:-25051}
PORT_STEP=${PORT_STEP:-1000}
ORDERER_CA_PORT=${ORDERER_CA_PORT:-12051}
ORDERER_CA_OP_PORT=${ORDERER_CA_OP_PORT:-19054}
ORDERER_CA_NAME=${ORDERER_CA_NAME:-ca-orderer}
PROJECT_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
declare -A ORG_USER_COUNT_MAP=()

to_lower() {
  echo "$1" | tr '[:upper:]' '[:lower:]'
}

to_proper_case() {
  local value
  value="$(to_lower "$1")"
  echo "${value^}"
}

join_by() {
  local delimiter=$1
  shift
  local first=1
  for item in "$@"; do
    if [ $first -eq 1 ]; then
      printf '%s' "$item"
      first=0
    else
      printf '%s%s' "$delimiter" "$item"
    fi
  done
}

collect_orgs() {
  local raw_orgs=()
  local raw_org org user_count

  if [ "$#" -gt 0 ]; then
    raw_orgs=("$@")
  else
    raw_orgs=("${DEFAULT_ORGS[@]}")
  fi

  ORG_NAMES=()
  for raw_org in "${raw_orgs[@]}"; do
    user_count="${DEFAULT_USER_COUNT}"

    if [[ "$raw_org" == *=* ]]; then
      org="${raw_org%%=*}"
      user_count="${raw_org#*=}"
    elif [[ "$raw_org" == *:* ]]; then
      org="${raw_org%%:*}"
      user_count="${raw_org#*:}"
    else
      org="$raw_org"
    fi

    org="$(to_lower "$org")"

    if [ -n "${raw_org// }" ]; then
      if ! [[ "$user_count" =~ ^[0-9]+$ ]] || [ "$user_count" -lt 0 ]; then
        echo "ERROR: Invalid user count '$user_count' for org '$org'. Use a non-negative integer."
        exit 1
      fi

      ORG_NAMES+=("$org")
      ORG_USER_COUNT_MAP[$org]="$user_count"
    fi
  done

  if [ "${#ORG_NAMES[@]}" -eq 0 ]; then
    echo "ERROR: Please provide at least one org name."
    exit 1
  fi
}

write_env_file() {
  local target_file=$1
  shift
  local generated_orgs=("$@")
  local idx org org_cap peer_port ca_port ops_port

  cat > "$target_file" <<EOF
#!/bin/bash

# SPDX-License-Identifier: Apache-2.0

TEST_NETWORK_HOME=\${TEST_NETWORK_HOME:-\${PWD}}

export CORE_PEER_TLS_ENABLED=true
export ORDERER_CA=\${TEST_NETWORK_HOME}/organizations/ordererOrganizations/example.com/tlsca/tlsca.example.com-cert.pem
export ORDERER_CA_NAME="${ORDERER_CA_NAME}"

declare -A ORG_PORT_MAP=()
declare -A ORG_CAP_MAP=()
declare -A ORG_CA_PORT_MAP=()
declare -A ORG_CA_OP_PORT_MAP=()

ORG_NAMES=(
EOF

  for org in "${generated_orgs[@]}"; do
    printf '  "%s"\n' "$org" >> "$target_file"
  done

  cat >> "$target_file" <<EOF
)

BASE_CA_PORT=${CA_BASE_PORT}
BASE_OP_PORT=${OPS_BASE_PORT}
PORT_STEP=${PORT_STEP}
ORDERER_CA_PORT=${ORDERER_CA_PORT}
ORDERER_CA_OP_PORT=${ORDERER_CA_OP_PORT}

EOF

  for idx in "${!generated_orgs[@]}"; do
    org="${generated_orgs[$idx]}"
    org_cap="$(to_proper_case "$org")"
    peer_port=$((PEER_BASE_PORT + idx * PORT_STEP))
    ca_port=$((CA_BASE_PORT + idx * PORT_STEP))
    ops_port=$((OPS_BASE_PORT + idx * PORT_STEP))

    cat >> "$target_file" <<EOF
ORG_PORT_MAP[$org]=$peer_port
ORG_CAP_MAP[$org]=$org_cap
ORG_CA_PORT_MAP[$org]=$ca_port
ORG_CA_OP_PORT_MAP[$org]=$ops_port
EOF
  done

  cat >> "$target_file" <<'EOF'

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
EOF
}

write_manual_file() {
  local target_file=$1
  shift
  local generated_orgs=("$@")
  local org org_cap first_org
  local org_args install_hosts peer_hosts policy_terms

  first_org="${generated_orgs[0]}"
  org_args="$(join_by " " "${generated_orgs[@]}")"
  install_hosts=("orderer.example.com")
  peer_hosts=()
  policy_terms=()

  for org in "${generated_orgs[@]}"; do
    org_cap="$(to_proper_case "$org")"
    install_hosts+=("peer0.${org}.example.com")
    peer_hosts+=("peer0.${org}.example.com")
    policy_terms+=("'${org_cap}MSP.peer'")
  done

  cat > "$target_file" <<EOF
HYPERLEDGER FABRIC NETWORK - SETUP MANUAL
Fabric v2.5.9 | Custom Generated Network

Generated orgs
$(for org in "${generated_orgs[@]}"; do printf -- '- %s users=%s\n' "$org" "${ORG_USER_COUNT_MAP[$org]:-$DEFAULT_USER_COUNT}"; done)

Automated Script
./generate.sh ${org_args}

Per-org user count examples:
./generate.sh farmers=20 aggregators=10 retailers=10 consumers=10 bank=5
./generate.sh farmers:20 aggregators:10 retailers:10 consumers:10 bank:5

1. PREREQUISITES
docker --version
docker compose version
git --version
go version
node --version
npm --version

open docker desktop

2. DOWNLOAD FABRIC BINARIES
curl -sSL https://bit.ly/2ysbOFE | bash -s -- 2.5.9

3. NETWORK CUSTOMIZATION
cd fabric-test/test-network/yaml
provide org names directly to generate.sh

4. GENERATE NETWORK FILES
chmod +x generate.sh
./generate.sh ${org_args}

generate.sh also copies:
- network.sh to test-network
- ccp-generate.sh to organizations
- envVar.sh to scripts

5. CCP (CONNECTION PROFILE) SETUP
check chaincode name in chaincode/test/index

make scripts executable:
find . -type f -name "*.sh" -exec chmod +x {} \;
find . -type f -path "*/bin/*" -exec chmod +x {} \;

6. DOCKER COMPOSE UPDATE
compose-test-net.yaml is generated correctly by generate.sh

7. START NETWORK
cd ..
./network.sh up -ca

8. CREATE CHANNELS & DEPLOY CHAINCODE
Example endorsement policy:
OR($(join_by "," "${policy_terms[@]}"))

Example:
./network.sh up createChannel -c mychannel
./network.sh deployCC \\
-c mychannel \\
-ccn mycc \\
-ccp ./chaincode-javascript \\
-ccl javascript \\
-ccep "OR($(join_by "," "${policy_terms[@]}"))"

9. ENVIRONMENT SETUP
. ./scripts/envVar.sh
setGlobals ${first_org}

10. BACKEND SETUP
cd ${PROJECT_ROOT}/backend
npm init -y
npm install express cors fabric-network fabric-ca-client

11. API EXAMPLE
GET http://localhost:5000/get-auctions

12. DOCKER DEBUG
docker ps --format "{{.Names}}"
docker logs -f peer0.${first_org}.example.com
docker stop \$(docker ps -aq)
docker rm \$(docker ps -aq)
docker volume prune -f
docker network prune -f

13. INSTALL TC INSIDE CONTAINERS
for c in $(join_by " " "${install_hosts[@]}"); do
  echo "===== Installing tc on \$c ====="
  docker exec \$c bash -c "apt update && apt install -y iproute2 iputils-ping"
done

14. APPLY LATENCY
for c in $(join_by " " "${peer_hosts[@]}"); do
  echo "===== Applying latency on \$c ====="
  docker exec \$c tc qdisc add dev eth0 root netem delay 50ms
done

15. REMOVE LATENCY
for c in $(join_by " " "${peer_hosts[@]}"); do
  echo "===== Removing latency on \$c ====="
  docker exec \$c tc qdisc del dev eth0 root
done

16. VERIFY LATENCY
for c in $(join_by " " "${peer_hosts[@]}"); do
  echo "===== Checking \$c ====="
  docker exec \$c tc qdisc show dev eth0
done
EOF
}

collect_orgs "$@"
write_env_file "./envVar.sh" "${ORG_NAMES[@]}"
write_manual_file "${PROJECT_ROOT}/manual" "${ORG_NAMES[@]}"
source ./envVar.sh

# ─────────────────────────────
# Generate compose-test-net.yaml
# ─────────────────────────────

TEMPLATE="compose-test-net.yaml"
HEADER="compose-test-net-header.yaml"
OUTPUT_DIR="../compose"
OUTPUT_FILE="${OUTPUT_DIR}/compose-test-net.yaml"

if [ ! -f "$TEMPLATE" ]; then
  echo "❌ ERROR: Template file '$TEMPLATE' not found!"
  exit 1
fi

mkdir -p "$OUTPUT_DIR"
{
  while IFS= read -r line; do
    clean_line="${line%$'\r'}"
    if [ "$clean_line" = "networks:" ]; then
      for ORG in "${ORG_NAMES[@]}"; do
        echo "  peer0.${ORG}.example.com:"
      done
      echo
    fi
    echo "$clean_line"
  done < "$HEADER"
} > "$OUTPUT_FILE"

for ORG in "${ORG_NAMES[@]}"; do
  PORT="${ORG_PORT_MAP[$ORG]}"
  CHAINCODE_PORT=$((PORT + 1))
  METRICS_PORT=$((PORT + 3443))
  ORGMSP="${ORG^}MSP"

  sed \
    -e "s|\${ORG}|$ORG|g" \
    -e "s|\${PORT}|$PORT|g" \
    -e "s|\${CHAINCODE_PORT}|$CHAINCODE_PORT|g" \
    -e "s|\${METRICS_PORT}|$METRICS_PORT|g" \
    -e "s|\${ORGMSP}|$ORGMSP|g" \
    "$TEMPLATE" >> "$OUTPUT_FILE"

  echo >> "$OUTPUT_FILE"
done

echo -e "\n✅ Compose test-net file generated at: $OUTPUT_FILE"


# ────────────────────────────────────────────────
# Generate docker-compose-test-net.yaml (generic)
# ────────────────────────────────────────────────

GENERIC_TEMPLATE="./docker-compose-test-net.yaml"
GENERIC_OUTPUT_FILE="../compose/docker/docker-compose-test-net.yaml"
rm -f "$GENERIC_OUTPUT_FILE"

echo "version: '3.7'" >> "$GENERIC_OUTPUT_FILE"
echo "" >> "$GENERIC_OUTPUT_FILE"
echo "services:" >> "$GENERIC_OUTPUT_FILE"
echo "" >> "$GENERIC_OUTPUT_FILE"

for ORG in "${ORG_NAMES[@]}"; do
  sed -e "s|\${ORG}|$ORG|g" "$GENERIC_TEMPLATE" >> "$GENERIC_OUTPUT_FILE"
  echo >> "$GENERIC_OUTPUT_FILE"
done

echo -e "\n✅ Generic Docker Compose generated at: $GENERIC_OUTPUT_FILE"


# ─────────────────────────────
# Generate configtx.yaml
# ─────────────────────────────

TOP_FILE="configtx-header.yaml"
ORG_TEMPLATE="configtx-middle.yaml"
CONFIGTX_OUTPUT="../configtx/configtx.yaml"

rm -f "$CONFIGTX_OUTPUT"

# Header
cat "$TOP_FILE" >> "$CONFIGTX_OUTPUT"
echo >> "$CONFIGTX_OUTPUT"

for ORG in "${ORG_NAMES[@]}"; do
  PORT="${ORG_PORT_MAP[$ORG]}"
  ORG_CAP="${ORG^}"
  ORGMSP="${ORG^}MSP"

  sed \
  -e "s|\${ORG}|$ORG|g" \
  -e "s|\${ORG_CAP}|$ORG_CAP|g" \
  -e "s|\${ORGMSP}|$ORGMSP|g" \
  -e "s|\${PORT}|$PORT|g" \
  "$ORG_TEMPLATE" >> "$CONFIGTX_OUTPUT"

  echo >> "$CONFIGTX_OUTPUT"
done

# Profiles section
cat <<EOF >> "$CONFIGTX_OUTPUT"
Profiles:
  ChannelUsingRaft:
    <<: *ChannelDefaults
    Orderer:
      <<: *OrdererDefaults
      OrdererType: etcdraft
      EtcdRaft:
        Consenters:
          - Host: orderer.example.com
            Port: 7050
            ClientTLSCert: ../organizations/ordererOrganizations/example.com/orderers/orderer.example.com/tls/server.crt
            ServerTLSCert: ../organizations/ordererOrganizations/example.com/orderers/orderer.example.com/tls/server.crt
      Organizations:
        - *OrdererOrg
      Capabilities: *OrdererCapabilities
    Application:
      <<: *ApplicationDefaults
      Organizations:
EOF

for ORG in "${ORG_NAMES[@]}"; do
  ORG_CAP="${ORG^}"
  echo "        - *$ORG_CAP" >> "$CONFIGTX_OUTPUT"
done


echo "      Capabilities: *ApplicationCapabilities" >> "$CONFIGTX_OUTPUT"

echo "✅ Configtx file generated at: $CONFIGTX_OUTPUT"


# ─────────────────────────────
# Generate crypto-config.yaml
# ─────────────────────────────

OUTPUT_FILE="../organizations/cryptogen/crypto-config.yaml"
mkdir -p "../organizations/cryptogen"
rm -f "$OUTPUT_FILE"

echo "# ---------------------------------------------------------------------------
# 'PeerOrgs' - Definition of organizations managing peer nodes
# ---------------------------------------------------------------------------
PeerOrgs:" > "$OUTPUT_FILE"

for ORG in "${ORG_NAMES[@]}"; do
  ORG_CAP="${ORG^}"  # Capitalize first letter: farmers → Farmers
  DOMAIN="${ORG}.example.com"
  USER_COUNT="${ORG_USER_COUNT_MAP[$ORG]:-$DEFAULT_USER_COUNT}"

  cat <<EOF >> "$OUTPUT_FILE"

  # ---------------------------------------------------------------------------
  # ${ORG_CAP} Organization
  # ---------------------------------------------------------------------------
  - Name: ${ORG_CAP}
    Domain: ${DOMAIN}
    EnableNodeOUs: true
    Template:
      Count: 1
      SANS:
        - localhost
    Users:
      Count: ${USER_COUNT}
EOF
done

echo "✅ crypto-config.yaml generated at: ${OUTPUT_FILE}"
echo "✅ Manual generated at: ${PROJECT_ROOT}/manual"


cp ./envVar.sh ../scripts/envVar.sh
cp ./createChannel.sh ../scripts/createChannel.sh
cp ./ccutils.sh ../scripts/ccutils.sh
cp ./utils.sh ../scripts/utils.sh
cp ./setAnchorPeer.sh ../scripts/setAnchorPeer.sh
cp ./deployCC.sh ../scripts/deployCC.sh
cp ./ccp-generate.sh ../organizations/ccp-generate.sh
cp ./ccp-template.yaml ../organizations/ccp-template.yaml
cp ./ccp-template.json ../organizations/ccp-template.json
cp ./network.sh ../network.sh
chmod +x ../network.sh
