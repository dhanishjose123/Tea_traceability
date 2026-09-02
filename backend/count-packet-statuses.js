const fs = require("fs");
const path = require("path");
const { normalizeUserId, queryPacketsByUsers } = require("./query-packets-by-user");
const { countPacketsByUsers } = require("./query-packet-counts-by-user");

const CHANNEL_NAME = process.env.CHANNEL_NAME || "agrochannel2406";
const CHAINCODE_NAME = process.env.CHAINCODE_NAME || process.env.CC_NAME || "tea_traceability";
const USER_COUNT = Math.max(0, Number(process.env.USER_COUNT || process.env.SIM_USER_COUNT || 25));
const PACKET_QUERY_LIMIT = Math.max(1, Number(process.env.PACKET_QUERY_LIMIT || 5000));
const LIST_PACKET_LIMIT = Math.max(0, Number(process.env.LIST_PACKET_LIMIT || 50));
const EVALUATE_TIMEOUT_SECONDS = Math.max(1, Number(process.env.EVALUATE_TIMEOUT_SECONDS || 300));
const SHOW_PACKET_LISTS = String(process.env.SHOW_PACKET_LISTS || "false").toLowerCase() === "true";
const PACKET_QUERY_MODE = String(process.env.PACKET_QUERY_MODE || "count").toLowerCase();
const PURCHASE_PACKET_STATUSES = String(process.env.PURCHASE_PACKET_STATUSES || "PURCHASED")
  .split(",")
  .map(status => status.trim())
  .filter(Boolean);
const RETAILER_PACKET_STATUSES = String(process.env.RETAILER_PACKET_STATUSES || "AVAILABLE")
  .split(",")
  .map(status => status.trim())
  .filter(Boolean);

function parseArgs(argv) {
  const args = {
    org: process.env.QUERY_ORG || "consumers",
    user: process.env.QUERY_USER || "Admin",
    json: null,
    csv: null
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--org") args.org = argv[++i];
    else if (arg === "--user") args.user = argv[++i];
    else if (arg === "--json") args.json = argv[++i] || "packet-status-summary.json";
    else if (arg === "--csv") args.csv = argv[++i] || "packet-status-summary.csv";
    else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
  }

  return args;
}

function printHelp() {
  console.log(`
Usage:
  CHANNEL_NAME=agrochannel0106 CHAINCODE_NAME=tea_traceability node count-packet-statuses.js [options]

Options:
  --org <org>       Query identity org. Default: consumers
  --user <user>     Query identity user. Default: Admin
  --json <file>     Save full summary as JSON
  --csv <file>      Save packet summaries as CSV

Environment:
  PACKET_QUERY_LIMIT=5000
  LIST_PACKET_LIMIT=50
  EVALUATE_TIMEOUT_SECONDS=300
  USER_COUNT=25
  SHOW_PACKET_LISTS=false
  PACKET_QUERY_MODE=count
  PURCHASE_PACKET_STATUSES=PURCHASED
  RETAILER_PACKET_STATUSES=AVAILABLE
`);
}

async function importIdentityIfMissing(org, userId) {
  const { Wallets } = require("fabric-network");
  const walletPath = path.join(__dirname, "wallet", org);
  const wallet = await Wallets.newFileSystemWallet(walletPath);
  const existing = await wallet.get(userId);
  if (existing) return;

  const mspPath = path.resolve(
    __dirname,
    `../fabric-test/test-network/organizations/peerOrganizations/${org}.example.com/users/${userId}@${org}.example.com/msp`
  );
  const signcertsPath = path.join(mspPath, "signcerts");
  const keystorePath = path.join(mspPath, "keystore");

  if (!fs.existsSync(signcertsPath) || !fs.existsSync(keystorePath)) {
    throw new Error(`Identity '${userId}' not found in wallet and MSP path is missing: ${mspPath}`);
  }

  const certFile = fs.readdirSync(signcertsPath).find(file => file.endsWith(".pem"));
  const keyFile = fs.readdirSync(keystorePath).find(file => !file.startsWith("."));

  if (!certFile || !keyFile) {
    throw new Error(`Incomplete MSP material for ${userId}@${org}: ${mspPath}`);
  }

  const identity = {
    credentials: {
      certificate: fs.readFileSync(path.join(signcertsPath, certFile), "utf8"),
      privateKey: fs.readFileSync(path.join(keystorePath, keyFile), "utf8")
    },
    mspId: `${org.charAt(0).toUpperCase()}${org.slice(1)}MSP`,
    type: "X.509"
  };

  await wallet.put(userId, identity);
}

async function getContract(org, userId) {
  const { Gateway, Wallets } = require("fabric-network");
  await importIdentityIfMissing(org, userId);

  const ccpPath = path.resolve(__dirname, `./connections/connection-${org}.json`);
  const walletPath = path.join(__dirname, "wallet", org);

  if (!fs.existsSync(ccpPath)) {
    throw new Error(`Missing connection profile: ${ccpPath}`);
  }

  const ccp = JSON.parse(fs.readFileSync(ccpPath, "utf8"));
  const wallet = await Wallets.newFileSystemWallet(walletPath);
  const gateway = new Gateway();

  await gateway.connect(ccp, {
    wallet,
    identity: userId,
    discovery: { enabled: true, asLocalhost: true },
    queryHandlerOptions: {
      timeout: EVALUATE_TIMEOUT_SECONDS
    },
    eventHandlerOptions: {
      commitTimeout: EVALUATE_TIMEOUT_SECONDS
    }
  });

  const network = await gateway.getNetwork(CHANNEL_NAME);
  const contract = network.getContract(CHAINCODE_NAME);
  return { gateway, contract };
}

function emptyConsumerSummary(consumerId) {
  return {
    consumerId,
    purchasedPackets: 0,
    purchasedWeightKg: 0
  };
}

function packetWeightKg(packet) {
  const rawWeight = packet.weight ?? packet.weightGrams ?? packet.packetWeight ?? 0;
  if (typeof rawWeight === "number") {
    return rawWeight > 100 ? rawWeight / 1000 : rawWeight;
  }

  const match = String(rawWeight || "").match(/([\d.]+)/);
  if (!match) return 0;

  const value = Number(match[1]) || 0;
  return /kg/i.test(String(rawWeight)) ? value : value / 1000;
}

function sortUserRows(rows, idKey) {
  return rows.sort((left, right) => {
    const leftMatch = String(left[idKey]).match(/User(\d+)/i);
    const rightMatch = String(right[idKey]).match(/User(\d+)/i);
    if (leftMatch && rightMatch) return Number(leftMatch[1]) - Number(rightMatch[1]);
    return String(left[idKey]).localeCompare(String(right[idKey]), undefined, { numeric: true });
  });
}

function addMissingUsers(rows, idKey, createEmptyRow) {
  if (!USER_COUNT) return;

  const existing = new Set(rows.map(row => normalizeUserId(row[idKey])));
  for (let index = 1; index <= USER_COUNT; index++) {
    const userId = `User${index}`;
    if (!existing.has(userId)) {
      rows.push(createEmptyRow(userId));
    }
  }
}

function getPacketConsumerId(packet, purchasedStatuses) {
  if (packet.customerId) return normalizeUserId(packet.customerId);
  if (packet.consumerId) return normalizeUserId(packet.consumerId);
  if (packet.buyerId) return normalizeUserId(packet.buyerId);
  if (packet.trace?.purchasedBy) return normalizeUserId(packet.trace.purchasedBy);

  const normalizedStatuses = new Set(purchasedStatuses.map(item => String(item).toUpperCase()));
  const status = String(packet.status || "").toUpperCase();
  if (normalizedStatuses.has(status) && String(packet.owner || "").startsWith("User")) {
    return normalizeUserId(packet.owner);
  }

  return null;
}

function getPacketRetailerId(packet, retailerStatuses) {
  if (packet.retailerId) return normalizeUserId(packet.retailerId);
  if (packet.ownerRetailerId) return normalizeUserId(packet.ownerRetailerId);
  if (packet.trace?.retailerId) return normalizeUserId(packet.trace.retailerId);
  if (packet.trace?.packedBy) return normalizeUserId(packet.trace.packedBy);

  const normalizedStatuses = new Set(retailerStatuses.map(item => String(item).toUpperCase()));
  const status = String(packet.status || "").toUpperCase();
  if (normalizedStatuses.has(status) && /(?:^|\.)User\d+$/i.test(String(packet.owner || ""))) {
    return normalizeUserId(packet.owner);
  }

  return null;
}

function packetId(packet) {
  return packet.packetId || packet.id || packet.key || "";
}

function lotId(packet) {
  return packet.lotId || packet.produceId || packet.sourceLotId || packet.parentLotId || "";
}

function compactPacketRow(packet, ownerId, ownerType) {
  return {
    packetId: packetId(packet),
    lotId: lotId(packet),
    status: packet.status || "",
    ownerType,
    ownerId,
    weightKg: Number(packetWeightKg(packet).toFixed(3))
  };
}

function summarizePackets(packets) {
  const consumers = new Map();
  const retailers = new Map();
  const statusTotals = {};
  const normalizedPurchasedStatuses = new Set(PURCHASE_PACKET_STATUSES.map(status => status.toUpperCase()));
  const retailerPacketRows = [];
  const consumerPacketRows = [];
  const totals = {
    totalPackets: packets.length,
    retailerOwnedPackets: 0,
    retailerOwnedWeightKg: 0,
    purchasedPackets: 0,
    purchasedWeightKg: 0
  };

  for (const packet of packets) {
    const status = String(packet.status || "UNKNOWN").toUpperCase();
    statusTotals[status] = (statusTotals[status] || 0) + 1;

    const retailerId = getPacketRetailerId(packet, RETAILER_PACKET_STATUSES);
    if (retailerId) {
      const retailer = retailers.get(retailerId) || {
        retailerId,
        ownedPackets: 0,
        ownedWeightKg: 0
      };
      const weightKg = packetWeightKg(packet);

      retailer.ownedPackets += 1;
      retailer.ownedWeightKg += weightKg;
      totals.retailerOwnedPackets += 1;
      totals.retailerOwnedWeightKg += weightKg;
      retailerPacketRows.push(compactPacketRow(packet, retailerId, "retailer"));

      retailers.set(retailerId, retailer);
    }

    if (!normalizedPurchasedStatuses.has(status)) continue;

    const consumerId = getPacketConsumerId(packet, PURCHASE_PACKET_STATUSES);
    if (!consumerId) continue;

    const consumer = consumers.get(consumerId) || emptyConsumerSummary(consumerId);
    const weightKg = packetWeightKg(packet);

    consumer.purchasedPackets += 1;
    consumer.purchasedWeightKg += weightKg;
    totals.purchasedPackets += 1;
    totals.purchasedWeightKg += weightKg;
    consumerPacketRows.push(compactPacketRow(packet, consumerId, "consumer"));

    consumers.set(consumerId, consumer);
  }

  const retailerRows = Array.from(retailers.values()).map(row => ({
    ...row,
    ownedWeightKg: Number(row.ownedWeightKg.toFixed(3))
  }));
  const consumerRows = Array.from(consumers.values()).map(row => ({
    ...row,
    purchasedWeightKg: Number(row.purchasedWeightKg.toFixed(3))
  }));
  addMissingUsers(retailerRows, "retailerId", retailerId => ({
    retailerId,
    ownedPackets: 0,
    ownedWeightKg: 0
  }));
  addMissingUsers(consumerRows, "consumerId", emptyConsumerSummary);

  return {
    channel: CHANNEL_NAME,
    chaincode: CHAINCODE_NAME,
    generatedAt: new Date().toISOString(),
    queriedStatuses: PURCHASE_PACKET_STATUSES.join(","),
    retailerStatuses: RETAILER_PACKET_STATUSES.join(","),
    totals: {
      ...totals,
      retailerOwnedWeightKg: Number(totals.retailerOwnedWeightKg.toFixed(3)),
      purchasedWeightKg: Number(totals.purchasedWeightKg.toFixed(3))
    },
    statusTotals,
    retailers: sortUserRows(retailerRows, "retailerId"),
    consumers: sortUserRows(consumerRows, "consumerId"),
    retailerPackets: retailerPacketRows,
    consumerPackets: consumerPacketRows
  };
}

async function queryPackets(contract) {
  const packetsById = new Map();
  const statusesToQuery = Array.from(new Set([
    ...PURCHASE_PACKET_STATUSES,
    ...RETAILER_PACKET_STATUSES
  ]));

  async function addPackets(label, packets) {
    console.log(`Packet query ${label} returned ${Array.isArray(packets) ? packets.length : 0}`);
    for (const packet of Array.isArray(packets) ? packets : []) {
      packetsById.set(packet.packetId || JSON.stringify(packet), packet);
    }
  }

  async function queryStatus(status) {
    try {
      const result = await contract.evaluateTransaction("getAllPackets", status, String(PACKET_QUERY_LIMIT));
      const packets = JSON.parse(result.toString());
      await addPackets(`status=${status || "ALL"}`, packets);
    } catch (error) {
      console.warn(`Packet query status=${status || "ALL"} failed: ${error.message}`);
    }
  }

  if (PACKET_QUERY_MODE === "per-user") {
    const maxUser = USER_COUNT || 25;
    const userIds = Array.from({ length: maxUser }, (_, index) => `User${index + 1}`);
    return queryPacketsByUsers(contract, userIds, statusesToQuery, PACKET_QUERY_LIMIT);
  }

  for (const status of statusesToQuery) {
    await queryStatus(status);
  }

  if (packetsById.size === 0 || String(process.env.PACKET_QUERY_ALL || "").toLowerCase() === "true") {
    await queryStatus("");
  }

  return Array.from(packetsById.values());
}

async function queryPacketCounts(contract) {
  const maxUser = USER_COUNT || 25;
  const userIds = Array.from({ length: maxUser }, (_, index) => `User${index + 1}`);
  const statusesToQuery = Array.from(new Set([
    ...PURCHASE_PACKET_STATUSES,
    ...RETAILER_PACKET_STATUSES
  ]));

  return countPacketsByUsers(contract, userIds, statusesToQuery);
}

function summarizePacketCounts(countRows) {
  const retailers = new Map();
  const consumers = new Map();
  const statusTotals = {};
  const normalizedPurchasedStatuses = new Set(PURCHASE_PACKET_STATUSES.map(status => status.toUpperCase()));
  const normalizedRetailerStatuses = new Set(RETAILER_PACKET_STATUSES.map(status => status.toUpperCase()));
  const totals = {
    totalPackets: 0,
    retailerOwnedPackets: 0,
    retailerOwnedWeightKg: 0,
    purchasedPackets: 0,
    purchasedWeightKg: 0
  };

  for (const row of countRows) {
    const ownerId = normalizeUserId(row.ownerId);
    const status = String(row.status || "ALL").toUpperCase();
    const count = Number(row.count || 0);
    const weightKg = Number(row.totalWeightKg || 0);

    statusTotals[status] = (statusTotals[status] || 0) + count;
    totals.totalPackets += count;

    if (normalizedRetailerStatuses.has(status)) {
      retailers.set(ownerId, {
        retailerId: ownerId,
        ownedPackets: count,
        ownedWeightKg: Number(weightKg.toFixed(3))
      });
      totals.retailerOwnedPackets += count;
      totals.retailerOwnedWeightKg += weightKg;
    }

    if (normalizedPurchasedStatuses.has(status)) {
      consumers.set(ownerId, {
        consumerId: ownerId,
        purchasedPackets: count,
        purchasedWeightKg: Number(weightKg.toFixed(3))
      });
      totals.purchasedPackets += count;
      totals.purchasedWeightKg += weightKg;
    }
  }

  const retailerRows = Array.from(retailers.values());
  const consumerRows = Array.from(consumers.values());
  addMissingUsers(retailerRows, "retailerId", retailerId => ({
    retailerId,
    ownedPackets: 0,
    ownedWeightKg: 0
  }));
  addMissingUsers(consumerRows, "consumerId", emptyConsumerSummary);

  return {
    channel: CHANNEL_NAME,
    chaincode: CHAINCODE_NAME,
    generatedAt: new Date().toISOString(),
    queryMode: "count",
    queriedStatuses: PURCHASE_PACKET_STATUSES.join(","),
    retailerStatuses: RETAILER_PACKET_STATUSES.join(","),
    totals: {
      ...totals,
      retailerOwnedWeightKg: Number(totals.retailerOwnedWeightKg.toFixed(3)),
      purchasedWeightKg: Number(totals.purchasedWeightKg.toFixed(3))
    },
    statusTotals,
    retailers: sortUserRows(retailerRows, "retailerId"),
    consumers: sortUserRows(consumerRows, "consumerId"),
    retailerPackets: [],
    consumerPackets: []
  };
}

function toCsv(rows, columns) {
  const escape = value => {
    const text = String(value ?? "");
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };

  return [
    columns.join(","),
    ...rows.map(row => columns.map(column => escape(row[column])).join(","))
  ].join("\n");
}

function writeOutputs(summary, options) {
  if (options.json) {
    const jsonPath = path.resolve(process.cwd(), options.json);
    fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
    fs.writeFileSync(jsonPath, `${JSON.stringify(summary, null, 2)}\n`);
    console.log(`JSON saved: ${jsonPath}`);
  }

  if (options.csv) {
    const csvPath = path.resolve(process.cwd(), options.csv);
    fs.mkdirSync(path.dirname(csvPath), { recursive: true });
    const csv = [
      "Packet Status Totals",
      toCsv([summary.statusTotals], Object.keys(summary.statusTotals)),
      "",
      "Packets Owned By Retailer",
      toCsv(summary.retailers, ["retailerId", "ownedPackets", "ownedWeightKg"]),
      "",
      "Consumer Purchased Packets",
      toCsv(summary.consumers, ["consumerId", "purchasedPackets", "purchasedWeightKg"])
    ].join("\n");
    fs.writeFileSync(csvPath, `${csv}\n`);
    console.log(`CSV saved: ${csvPath}`);
  }
}

function printTable(title, rows) {
  console.log(`\n${title}`);
  console.table(rows);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  console.log(`Querying packets from channel=${CHANNEL_NAME}, chaincode=${CHAINCODE_NAME}, identity=${options.org}.${options.user}`);
  console.log(`Statuses=${PURCHASE_PACKET_STATUSES.join(",")} PACKET_QUERY_LIMIT=${PACKET_QUERY_LIMIT}`);
  console.log(`Retailer statuses=${RETAILER_PACKET_STATUSES.join(",")} LIST_PACKET_LIMIT=${LIST_PACKET_LIMIT}`);
  console.log(`Packet query mode=${PACKET_QUERY_MODE}`);

  const { gateway, contract } = await getContract(options.org, options.user);
  try {
    const summary = PACKET_QUERY_MODE === "count"
      ? summarizePacketCounts(await queryPacketCounts(contract))
      : summarizePackets(await queryPackets(contract));

    printTable("Packet Totals", [summary.totals]);
    printTable("Packet Status Totals", [summary.statusTotals]);
    printTable("Packets Owned By Retailer", summary.retailers);
    printTable("Packets Purchased By Consumer", summary.consumers);
    if (SHOW_PACKET_LISTS) {
      printTable("Retailer Owned Packet List", summary.retailerPackets.slice(0, LIST_PACKET_LIMIT));
      printTable("Consumer Purchased Packet List", summary.consumerPackets.slice(0, LIST_PACKET_LIMIT));
    }
    writeOutputs(summary, options);
  } finally {
    await gateway.disconnect();
  }
}

main().catch(error => {
  console.error("Failed to count packet statuses:", error);
  process.exit(1);
});
