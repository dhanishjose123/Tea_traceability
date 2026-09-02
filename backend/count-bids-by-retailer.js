const fs = require("fs");
const path = require("path");

const CHANNEL_NAME = process.env.CHANNEL_NAME || "agrochannel0106";
const CHAINCODE_NAME = process.env.CHAINCODE_NAME || process.env.CC_NAME || "tea_traceability";

function parseArgs(argv) {
  const args = {
    org: process.env.QUERY_ORG || "farmers",
    user: process.env.QUERY_USER || "Admin",
    csv: null
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--org") args.org = argv[++i];
    else if (arg === "--user") args.user = argv[++i];
    else if (arg === "--csv") args.csv = argv[++i] || "farmer-bids-summary.csv";
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
  CHANNEL_NAME=agrochannel0106 CHAINCODE_NAME=tea_traceability node count-bids-by-retailer.js [options]

Options:
  --org <org>       Query identity org. Default: farmers
  --user <user>     Query identity user. Default: Admin
  --csv <file>      Save output as CSV

Examples:
  node count-bids-by-retailer.js
  CHANNEL_NAME=agrochannel0106 node count-bids-by-retailer.js --csv results/farmer-bids.csv
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

function summarizeBids(summary) {
  const farmersData = summary.farmers || [];
  const farmerStats = new Map();
  const allRetailers = new Set();

  for (const farmer of farmersData) {
    if (!farmer.bidsByRetailer) continue;
    const fMap = new Map();
    for (const [retailerId, count] of Object.entries(farmer.bidsByRetailer)) {
      if (count > 0) {
        fMap.set(retailerId, count);
        allRetailers.add(retailerId);
      }
    }
    if (fMap.size > 0) {
      farmerStats.set(farmer.farmerId, fMap);
    }
  }

  const sortByUserNumber = (left, right) => {
    const leftMatch = String(left).match(/User(\d+)/i);
    const rightMatch = String(right).match(/User(\d+)/i);
    if (leftMatch && rightMatch) return Number(leftMatch[1]) - Number(rightMatch[1]);
    return String(left).localeCompare(String(right), undefined, { numeric: true });
  };

  const sortedFarmers = Array.from(farmerStats.keys()).sort(sortByUserNumber);
  const sortedRetailers = Array.from(allRetailers).sort(sortByUserNumber);

  const rows = [];
  for (const farmer of sortedFarmers) {
    const row = { farmerId: farmer };
    let totalBidsReceived = 0;
    
    for (const retailer of sortedRetailers) {
      const count = farmerStats.get(farmer).get(retailer) || 0;
      if (count > 0) {
        row[retailer] = count;
        totalBidsReceived += count;
      }
    }
    
    if (totalBidsReceived > 0) {
      row['Total_Bids'] = totalBidsReceived;
      rows.push(row);
    }
  }

  return {
    rows,
    columns: ["farmerId", "Total_Bids", ...sortedRetailers]
  };
}

function toCsv(rows, columns) {
  const escape = value => {
    const text = String(value ?? "");
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };

  const activeColumns = columns.filter(col => 
    col === 'farmerId' || col === 'Total_Bids' || rows.some(row => row[col] > 0)
  );

  return [
    activeColumns.join(","),
    ...rows.map(row => activeColumns.map(col => escape(row[col] || 0)).join(","))
  ].join("\n");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  console.log(`Querying lots from channel=${CHANNEL_NAME}, chaincode=${CHAINCODE_NAME}, identity=${options.org}.${options.user}`);

  const { gateway, contract } = await getContract(options.org, options.user);
  try {
    const result = await contract.evaluateTransaction("countLotStatuses");
    const summaryData = JSON.parse(result.toString() || "{}");
    
    console.log("Fetched lot statuses successfully. Calculating bid statistics...");
    const summary = summarizeBids(summaryData);

    if (summary.rows.length === 0) {
      console.log("\nNo bids found for any farmers.");
    } else {
      console.log("\n=== Number of Lots Bid on by Retailers (Per Farmer) ===");
      console.table(summary.rows);
    }

    if (options.csv && summary.rows.length > 0) {
      const csvPath = path.resolve(process.cwd(), options.csv);
      fs.mkdirSync(path.dirname(csvPath), { recursive: true });
      const csvData = toCsv(summary.rows, summary.columns);
      fs.writeFileSync(csvPath, `${csvData}\n`);
      console.log(`\nCSV saved: ${csvPath}`);
    }

  } catch (error) {
    console.error("Failed to query lots:", error.message);
  } finally {
    await gateway.disconnect();
  }
}

main().catch(error => {
  console.error("Fatal error:", error);
  process.exit(1);
});
