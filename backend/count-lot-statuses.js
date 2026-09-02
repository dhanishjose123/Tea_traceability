const fs = require("fs");
const path = require("path");
const { channelName: defaultChannelName } = require("../caliper-bench_9/experiment-matrix");

const CHANNEL_NAME = process.env.CHANNEL_NAME || defaultChannelName;
const CHAINCODE_NAME = process.env.CHAINCODE_NAME || process.env.CC_NAME || "tea_traceability";
const USER_COUNT = Math.max(0, Number(process.env.USER_COUNT || process.env.SIM_USER_COUNT || 0));

function parseArgs(argv) {
  const args = {
    org: process.env.QUERY_ORG || "farmers",
    user: process.env.QUERY_USER || "Admin",
    json: null,
    csv: null
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--org") args.org = argv[++i];
    else if (arg === "--user") args.user = argv[++i];
    else if (arg === "--json") args.json = argv[++i] || "lot-status-summary.json";
    else if (arg === "--csv") args.csv = argv[++i] || "lot-status-summary.csv";
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
  CHANNEL_NAME=agrochannel0106 CHAINCODE_NAME=tea_traceability node count-lot-statuses.js [options]

Options:
  --org <org>       Query identity org. Default: farmers
  --user <user>     Query identity user. Default: Admin
  --json <file>     Save full summary as JSON
  --csv <file>      Save farmer and retailer summaries as CSV

Examples:
  node count-lot-statuses.js
  CHANNEL_NAME=agrochannel0106 node count-lot-statuses.js --json results/lot-status-summary.json --csv results/lot-status-summary.csv
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
    discovery: { enabled: true, asLocalhost: true }
  });

  const network = await gateway.getNetwork(CHANNEL_NAME);
  const contract = network.getContract(CHAINCODE_NAME);
  return { gateway, contract };
}

function emptyFarmerSummary(farmerId) {
  return {
    farmerId,
    total: 0,
    submitted: 0,
    approvedNoBids: 0,
    bid: 0,
    sold: 0,
    packed: 0,
    rejected: 0,
    other: 0
  };
}

function emptyRetailerSummary(retailerId) {
  return {
    retailerId,
    sold: 0,
    packed: 0,
    bidLots: 0
  };
}

function hasBid(lot) {
  return lot.hasOffers === true ||
    (lot.highestOffer && Number(lot.highestOffer.offerPrice) > 0) ||
    (Array.isArray(lot.offers) && lot.offers.length > 0);
}

function normalizeRetailerId(lot) {
  return lot.acceptedOffer?.retailerId ||
    lot.highestOffer?.retailerId ||
    (String(lot.owner || "").startsWith("User") ? lot.owner : null);
}

function summarizeLots(lots) {
  const farmers = new Map();
  const retailers = new Map();
  const totals = emptyFarmerSummary("ALL");

  for (const lot of lots) {
    const farmerId = lot.farmerId || lot.owner || "UNKNOWN";
    const status = String(lot.status || "UNKNOWN").toUpperCase();
    const farmer = farmers.get(farmerId) || emptyFarmerSummary(farmerId);
    const bid = hasBid(lot);

    farmer.total++;
    totals.total++;

    if (status === "SUBMITTED") {
      farmer.submitted++;
      totals.submitted++;
    } else if (status === "APPROVED" && bid) {
      farmer.bid++;
      totals.bid++;
    } else if (status === "APPROVED") {
      farmer.approvedNoBids++;
      totals.approvedNoBids++;
    } else if (status === "SOLD") {
      farmer.sold++;
      totals.sold++;
    } else if (status === "PACKED") {
      farmer.packed++;
      farmer.sold++;
      totals.packed++;
      totals.sold++;
    } else if (status === "REJECTED") {
      farmer.rejected++;
      totals.rejected++;
    } else {
      farmer.other++;
      totals.other++;
    }

    if (bid) {
      const bidderId = lot.highestOffer?.retailerId;
      if (bidderId) {
        const retailer = retailers.get(bidderId) || emptyRetailerSummary(bidderId);
        retailer.bidLots++;
        retailers.set(bidderId, retailer);
      }
    }

    if (status === "SOLD" || status === "PACKED") {
      const retailerId = normalizeRetailerId(lot);
      if (retailerId) {
        const retailer = retailers.get(retailerId) || emptyRetailerSummary(retailerId);
        retailer.sold++;
        if (status === "PACKED") retailer.packed++;
        retailers.set(retailerId, retailer);
      }
    }

    farmers.set(farmerId, farmer);
  }

  const sortByUserNumber = (left, right, key) => {
    const leftMatch = String(left[key]).match(/User(\d+)/i);
    const rightMatch = String(right[key]).match(/User(\d+)/i);
    if (leftMatch && rightMatch) return Number(leftMatch[1]) - Number(rightMatch[1]);
    return String(left[key]).localeCompare(String(right[key]), undefined, { numeric: true });
  };

  return {
    channel: CHANNEL_NAME,
    chaincode: CHAINCODE_NAME,
    generatedAt: new Date().toISOString(),
    totals,
    farmers: Array.from(farmers.values()).sort((a, b) => sortByUserNumber(a, b, "farmerId")),
    retailers: Array.from(retailers.values()).sort((a, b) => sortByUserNumber(a, b, "retailerId"))
  };
}

function normalizeSummary(summary) {
  const farmers = Array.isArray(summary.farmers) ? summary.farmers : [];
  const retailers = Array.isArray(summary.retailers) ? summary.retailers : [];

  addMissingUsers(farmers, "farmerId", emptyFarmerSummary);
  addMissingUsers(retailers, "retailerId", emptyRetailerSummary);

  return {
    channel: CHANNEL_NAME,
    chaincode: CHAINCODE_NAME,
    generatedAt: summary.generatedAt || new Date().toISOString(),
    totals: summary.totals || emptyFarmerSummary("ALL"),
    farmers: sortUserRows(farmers, "farmerId"),
    retailers: sortUserRows(retailers, "retailerId")
  };
}

function addMissingUsers(rows, idKey, createEmptyRow) {
  if (!USER_COUNT) return;

  const existing = new Set(rows.map(row => row[idKey]));
  for (let index = 1; index <= USER_COUNT; index++) {
    const userId = `User${index}`;
    if (!existing.has(userId)) {
      rows.push(createEmptyRow(userId));
    }
  }
}

function sortUserRows(rows, idKey) {
  return rows.sort((left, right) => {
    const leftMatch = String(left[idKey]).match(/User(\d+)/i);
    const rightMatch = String(right[idKey]).match(/User(\d+)/i);
    if (leftMatch && rightMatch) return Number(leftMatch[1]) - Number(rightMatch[1]);
    return String(left[idKey]).localeCompare(String(right[idKey]), undefined, { numeric: true });
  });
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
    const farmerColumns = ["farmerId", "total", "submitted", "approvedNoBids", "bid", "sold", "packed", "rejected", "other"];
    const retailerColumns = ["retailerId", "sold", "packed", "bidLots"];
    const csv = [
      "Farmer Summary",
      toCsv(summary.farmers, farmerColumns),
      "",
      "Retailer Summary",
      toCsv(summary.retailers, retailerColumns)
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
  console.log(`Querying lots from channel=${CHANNEL_NAME}, chaincode=${CHAINCODE_NAME}, identity=${options.org}.${options.user}`);

  const { gateway, contract } = await getContract(options.org, options.user);
  try {
    let summary;
      const result = await contract.evaluateTransaction("countLotStatuses");
      summary = JSON.parse(result.toString());
      summary = normalizeSummary(summary);

    printTable("Totals", [summary.totals]);
    printTable("Lots By Farmer", summary.farmers);
    printTable("Retailer Sold/Bid Counts", summary.retailers);
    writeOutputs(summary, options);
  } finally {
    await gateway.disconnect();
  }
}

main().catch(error => {
  console.error("Failed to count lot statuses:", error);
  process.exit(1);
});
