const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const { Gateway, Wallets } = require("fabric-network");

const app = express();
const PORT = 5000;
const CHANNEL_NAME = process.env.CHANNEL_NAME || "agrochannel2905";
const CHAINCODE_NAME = process.env.CHAINCODE_NAME || process.env.CC_NAME || "tea_traceability";
const USER_COUNT = Number(process.env.SIM_USER_COUNT || process.env.USER_COUNT || 10);

const { create } = require('ipfs-http-client');

const ipfs = create({
    url: 'http://127.0.0.1:5001'
});
const multer = require('multer');
const storage = multer.memoryStorage();

const upload = multer({
    storage: storage,
    limits: { fileSize: 100 * 1024 * 1024 } // 100MB
});



app.use(express.json());
app.use(cors());

async function importIdentity(org, userId) {
  const walletPath = path.join(__dirname, "wallet", org);
  const wallet = await Wallets.newFileSystemWallet(walletPath);
  const identityExists = await wallet.get(userId);
  if (identityExists) return;

  const mspPath = path.resolve(
    __dirname,
    `../fabric-test/test-network/organizations/peerOrganizations/${org}.example.com/users/${userId}@${org}.example.com/msp`
  );
  const signcertsPath = path.join(mspPath, "signcerts");
  const keystorePath = path.join(mspPath, "keystore");

  if (!fs.existsSync(signcertsPath) || !fs.existsSync(keystorePath)) {
    console.warn(`⚠️ Skipping missing identity for ${userId}@${org}: ${mspPath}`);
    return false;
  }

  const certFile = fs.readdirSync(signcertsPath)[0];
  const keyFile = fs.readdirSync(keystorePath)[0];

  if (!certFile || !keyFile) {
    console.warn(`⚠️ Skipping incomplete identity for ${userId}@${org}: ${mspPath}`);
    return false;
  }

  const certPath = path.join(signcertsPath, certFile);
  const keyPath = path.join(keystorePath, keyFile);

  const identity = {
    credentials: {
      certificate: fs.readFileSync(certPath).toString(),
      privateKey: fs.readFileSync(keyPath).toString()
    },
    mspId: `${org.charAt(0).toUpperCase()}${org.slice(1)}MSP`,
    type: "X.509"
  };

  await wallet.put(userId, identity);
  console.log(`✅ Imported identity for ${userId}@${org}`);
  return true;
}

const identityImportReady = (async () => {
  const walletRoot = path.join(__dirname, "wallet");
  if (fs.existsSync(walletRoot)) {
    fs.rmSync(walletRoot, { recursive: true, force: true });
    console.log("🗑️  Cleared existing wallet");
  }
  const orgs = ["farmers", "retailers", "aggregators", "consumers", "bank"];
  let importedCount = 0;
  let skippedCount = 0;

  for (const org of orgs) {
  // Import Admin identity
  if (await importIdentity(org, "Admin")) {
    importedCount++;
  } else {
    skippedCount++;
  }}
  for (const org of orgs) {
    for (let i = 1; i <= USER_COUNT; i++) {
      const userId = `User${i}`;
      if (await importIdentity(org, userId)) {
        importedCount++;
      } else {
        skippedCount++;
      }
    }
  }
  console.log(`✅ Backend identity import completed for requested User1..User${USER_COUNT}. Imported=${importedCount}, skipped=${skippedCount}`);
})();

async function getContract(org, userId) {
  await identityImportReady;

  const ccpPath = path.resolve(__dirname, `./connections/connection-${org}.json`);
  const walletPath = path.join(__dirname, "wallet", org);
  const ccp = JSON.parse(fs.readFileSync(ccpPath, "utf8"));
  const wallet = await Wallets.newFileSystemWallet(walletPath);
  const identity = await wallet.get(userId);
  if (!identity) throw new Error(`Identity '${userId}' not found in wallet for org '${org}'`);
  const gateway = new Gateway();
  await gateway.connect(ccp, {
    wallet,
    identity: userId,
    discovery: { enabled: true, asLocalhost: true }
  });
  const network = await gateway.getNetwork(CHANNEL_NAME);
  const contract = network.getContract(CHAINCODE_NAME);
  console.log(`✅ Network connection established for ${userId}@${org}`);
  return { gateway, contract };
}

app.post("/submit-lot", async (req, res) => {
  try {
    const { org, userId, lotId, farmerId, weightKg, lotDate, bags,aggregatorId } = req.body;

    if (!org || !userId || !lotId || !farmerId || !weightKg || !lotDate || !bags) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    console.log("📦 Submitting lot with payload:", req.body);
    console.log(`🚀 Calling chaincode function: submitProduce`);
    console.log(`🧾 Args: lotId=${lotId}, farmerId=${farmerId}, weightKg=${weightKg}, date=${lotDate}, bags=${bags}`);

    const { gateway, contract } = await getContract(org, userId);
    const result = await contract.submitTransaction(
      "submitProduce",
      lotId,
      farmerId,
      weightKg.toString(),
      lotDate,
      bags.toString(),
      aggregatorId.toString()  // ✅ Added aggregatorId
    );
    await gateway.disconnect();

    res.status(200).json({ message: result.toString() });  // ✅ Fixed response
  } catch (err) {
    console.error("❌ submitProduce error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/test-function", async (req, res) => {
  try {
    const {
      org = "bank",
      userId = "User1",
      testId = "default",
      readCount = 0,
      writeCount = 0,
      hotWrite = false,
      valueSize = 0
    } = req.body;

    const { gateway, contract } = await getContract(org, userId);
    const result = await contract.submitTransaction(
      "testFunction",
      testId.toString(),
      readCount.toString(),
      writeCount.toString(),
      hotWrite.toString(),
      valueSize.toString()
    );
    await gateway.disconnect();

    res.status(200).json(JSON.parse(result.toString()));
  } catch (err) {
    console.error("testFunction error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/upload-video', upload.single('file'), async (req, res) => {

    try {

        const file = req.file.buffer;

        const result = await ipfs.add(file);

        const cid = result.cid.toString();

        res.json({
            success: true,
            ipfsHash: cid
        });

    } catch (err) {
        console.error(err);
        res.status(500).send("IPFS upload failed");
    }

});


app.post('/make-offer', async (req, res) => {
  try {
    const { org, userId, lotId, retailerId, offerPrice } = req.body;

    if (!org || !userId || !lotId || !retailerId || !offerPrice) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const { gateway, contract } = await getContract(org, userId);

    const result = await contract.submitTransaction('makeOffer', lotId, retailerId, offerPrice);
    await gateway.disconnect();

    res.status(200).json({ message: result.toString() });
  } catch (err) {
    console.error('❌ /make-offer error:', err);
    res.status(500).json({ error: err.message });
  }
});


app.post('/accept-offer', async (req, res) => {
  try {
    const { org, userId, lotId, selectedRetailerId } = req.body;

    if (!org || !userId || !lotId || !selectedRetailerId) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const { gateway, contract } = await getContract(org, userId);

    const result = await contract.submitTransaction('acceptOffer', lotId, selectedRetailerId);
    await gateway.disconnect();

    res.status(200).json({ message: result.toString() });
  } catch (err) {
    console.error('❌ /accept-offer error:', err);
    res.status(500).json({ error: err.message });
  }
});



app.post("/create-wallet", async (req, res) => {
  try {
    const { org, userId, targetOrg, targetUserId } = req.body;
    const { gateway, contract } = await getContract(org, userId);
    const result = await contract.submitTransaction("createWallet", targetOrg, targetUserId);
    await gateway.disconnect();
    res.status(200).json({ message: result.toString() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/deposit-money", async (req, res) => {
  try {
    const { org, userId, targetOrg, targetUserId, amount } = req.body;
    const { gateway, contract } = await getContract(org, userId);
    const result = await contract.submitTransaction("depositMoney", targetOrg, targetUserId, amount);
    await gateway.disconnect();
    res.status(200).json({ message: result.toString() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/get-wallet-balance/:org/:userId", async (req, res) => {
  try {
    const { org, userId } = req.params;
    const { gateway, contract } = await getContract(org, userId);

    const result = await contract.evaluateTransaction("getWalletBalance", org, userId);
    await gateway.disconnect();

    const wallet = JSON.parse(result.toString());

    res.status(200).json(wallet);

    
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


app.post("/set-testing-fee", async (req, res) => {
  try {
    const { org, userId, feeAmount } = req.body;
    const { gateway, contract } = await getContract(org, userId);
    const result = await contract.submitTransaction("setTestingFee", userId, feeAmount);
    await gateway.disconnect();
    res.status(200).json({ message: result.toString() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/get-testing-fee/:org/:userId", async (req, res) => {
  try {
    const { org, userId } = req.params;
    const { gateway, contract } = await getContract(org, userId);
    const result = await contract.evaluateTransaction("getTestingFee", userId);
    await gateway.disconnect();
    res.status(200).json(JSON.parse(result.toString()));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/test-tea-lot", async (req, res) => {
  try {
    const { org, userId, lotId, result, videoHash, grading } = req.body;

    // Ensure required fields exist
    if (!org || !userId || !lotId || !result || !videoHash) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const { gateway, contract } = await getContract(org, userId);

    // Convert grading to JSON string if provided
    const gradingJson = grading ? JSON.stringify(grading) : "";

    const resultBuffer = await contract.submitTransaction(
      "testTeaLot",
      lotId,
      result,
      videoHash,
      gradingJson
    );

    await gateway.disconnect();
    res.status(200).json({ message: resultBuffer.toString() });
  } catch (err) {
    console.error("❌ testTeaLot error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/pack-lot", async (req, res) => {
  try {
    const {
      org,
      userId,
      lotId,
      price1kg,
      price500g,
      price250g,
      price100g,
      packingVideoHash // optional, can be null or string
    } = req.body;

    if (!org || !userId || !lotId || !price1kg || !price500g || !price250g || !price100g) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const { gateway, contract } = await getContract(org, userId);

    const result = await contract.submitTransaction(
      "packLotIntoPackets",
      lotId,
      price1kg.toString(),
      price500g.toString(),
      price250g.toString(),
      price100g.toString(),
      packingVideoHash || "" // pass empty string if not provided
    );

    await gateway.disconnect();
    res.status(200).json({ message: result.toString() });
  } catch (err) {
    console.error("❌ /pack-lot error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/purchase-packet", async (req, res) => {
  try {
    const { org, userId, packetId } = req.body;

    if (!org || !userId || !packetId) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const { gateway, contract } = await getContract(org, userId);

    const result = await contract.submitTransaction("purchasePacket", packetId, userId);

    await gateway.disconnect();
    res.status(200).json({ message: result.toString() });

  } catch (err) {
    console.error("❌ purchasePacket error:", err);
    res.status(500).json({ error: err.message });
  }
});


app.get("/get-all-produce/:org/:userId/:limit", async (req, res) => {

  try {

    const { org, userId, limit } = req.params;

    const { gateway, contract } = await getContract(org, userId);

    const result = await contract.evaluateTransaction(
        "getAllProduce",
        limit
    );

    await gateway.disconnect();

    const payloadSize = Buffer.byteLength(result);

    res.status(200).json({
        recordCount: JSON.parse(result.toString()).length,
        payloadSizeBytes: payloadSize,
        data: JSON.parse(result.toString())
    });

  } catch (err) {

    res.status(500).json({ error: err.message });
  }
});
app.get("/get-all-packets/:org/:userId/:limit", async (req, res) => {
  try {

    const { org, userId, limit } = req.params;

    const { gateway, contract } = await getContract(org, userId);

    const result = await contract.evaluateTransaction(
        "getAllPackets1",
        limit
    );

    await gateway.disconnect();

    const raw = result.toString();

    if (!raw) {
        return res.status(200).json([]);
    }

    let parsed;
    console.log("RAW CHAINCODE RESPONSE:");
    console.log(result.toString());
    try {
        parsed = JSON.parse(raw);
    } catch (err) {
        console.error("JSON parse failed:", raw);
        return res.status(500).json({ error: "Invalid JSON returned from chaincode" });
    }

    res.status(200).json(parsed);

  } catch (err) {

    console.error("❌ getAllPackets error:", err);
    res.status(500).json({ error: err.message });

  }
});

app.get("/get-farmer-rating/:org/:farmerId", async (req, res) => {
  try {
    const { org, farmerId } = req.params;

    if (!org || !farmerId) {
      return res.status(400).json({ error: "Missing org or farmerId" });
    }

    const { gateway, contract } = await getContract(org, farmerId);
    const result = await contract.evaluateTransaction("getFarmerRating", farmerId);
    await gateway.disconnect();

    const parsed = JSON.parse(result.toString());
    res.status(200).json(parsed);
  } catch (err) {
    console.error("❌ getFarmerRating error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/get-all-lots-with-offers/:org/:userId', async (req, res) => {
    try {
        const { org, userId } = req.params;
        const { gateway, contract } = await getContract(org, userId);

        const result = await contract.evaluateTransaction('getAllLotsWithOffers');
        await gateway.disconnect();

        res.json(JSON.parse(result.toString()));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ===============================
// GET Approved Lots Without Offers
// ===============================



app.get("/get-random-lot/:org/:userId/:status", async (req, res) => {
  try {
    const { org, userId, status } = req.params;

    const { gateway, contract } = await getContract(org, userId);

    const result = await contract.evaluateTransaction(
      "getRandomLotByStatus",
      status
    );

    await gateway.disconnect();

    const parsed =
      result && result.length > 0 ? JSON.parse(result.toString()) : null;

    res.status(200).json(parsed);
  } catch (err) {
    console.error("❌ get-random-lot error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get(
  "/get-random-lot-highest-offer/:org/:userId/:status",
  async (req, res) => {
    try {
      const { org, userId, status } = req.params;

      const { gateway, contract } = await getContract(org, userId);

      const result = await contract.evaluateTransaction(
        "getRandomLotHighestOfferByStatusAndOwner",
        status,
        userId
      );

      await gateway.disconnect();

      const parsed = JSON.parse(result.toString());

      if (!parsed) {
        return res.status(200).json({
          message: "No matching lots or no offers found",
          data: null
        });
      }

      res.status(200).json(parsed);
    } catch (err) {
      console.error("❌ get-random-lot-highest-offer failed:", err);
      res.status(500).json({
        error: err.message
      });
    }
  }
);


app.get("/get-stats/global", async (req, res) => {
  try {
    const org = "farmers";
    const userId = "User1";
    const { gateway, contract } = await getContract(org, userId);
    const result = await contract.evaluateTransaction("getStats");
    await gateway.disconnect();
    res.status(200).json(JSON.parse(result.toString()));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});



app.post("/transfer-money", async (req, res) => {
  const { org, userId, from, to, amount } = req.body;

  if (!org || !userId || !from || !to || !amount) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  try {
    const { gateway, contract } = await getContract(org, userId);
    const result = await contract.submitTransaction("transfermoney", from, to, amount);
    await gateway.disconnect();
    res.status(200).json({ message: result.toString() });
  } catch (err) {
    console.error("❌ transfer error:", err);
    res.status(500).json({ error: err.message });
  }
});
app.get("/get-packet-history/:org/:userId/:packetId", async (req, res) => {
  try {
    const { org, userId, packetId } = req.params;

    const { gateway, contract } = await getContract(org, userId);
    const result = await contract.evaluateTransaction("getPacketHistory", packetId);
    await gateway.disconnect();

    const history = JSON.parse(result.toString());
    res.status(200).json({ history });
  } catch (err) {
    console.error("❌ getPacketHistory error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/purchase-packet", async (req, res) => {
  try {
    const { org, userId, packetId } = req.body;

    if (!org || !userId || !packetId) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const { gateway, contract } = await getContract(org, userId);

    const result = await contract.submitTransaction("purchasePacket", packetId, userId);
    await gateway.disconnect();

    res.status(200).json({ message: result.toString() });
  } catch (err) {
    console.error("❌ purchasePacket error:", err);
    res.status(500).json({ error: err.message });
  }
});

const { Client } = require("fabric-common");
const { getGatewayAndIdentity } = require("./getContract"); // helper should return { gateway, identity, ccp }

// Assuming CHANNEL_NAME is defined elsewhere, e.g.:
// const CHANNEL_NAME = 'mychannel';

// routes/offers.js (or inside server.js)

app.get('/get-highest-offer/:lotId', async (req, res) => {
    const { lotId } = req.params;

    try {
        const { contract, gateway } = await getContract(
            'retailers',     // org can be any read-permitted org
            'User1'
        );

        const result = await contract.evaluateTransaction(
            'getHighestOfferForLot',
            lotId
        );

        await gateway.disconnect();

        res.json({
            lotId,
            highestOfferPerKg: parseFloat(result.toString())
        });

    } catch (err) {
        console.error('❌ getHighestOfferForLot failed:', err);
        res.status(500).json({ error: err.message });
    }
});

app.get("/get-random-packable-lot/:retailerId", async (req, res) => {
    try {

        const retailerId = req.params.retailerId;

        const { contract, gateway } = await getContract("retailers", retailerId);

        const result = await contract.evaluateTransaction(
            "getRandomPackableLotByRetailer",
            retailerId
        );

        const lot = JSON.parse(result.toString());

        await gateway.disconnect();

        if (!lot) {
            return res.status(404).json({
                success: false,
                message: "No packable lot found"
            });
        }

        res.json({
            success: true,
            data: lot
        });

    } catch (error) {

        console.error("Error fetching packable lot:", error);

        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});
app.get('/reconstruct-packet/:org/:userId/:packetId', async (req, res) => {
    try {
        const { org, userId, packetId } = req.params;

        const { contract, gateway } = await getContract(org, userId);

        const result = await contract.evaluateTransaction(
            'reconstructPacketLifecycle',
            packetId
        );

        await gateway.disconnect();

        res.json({
            success: true,
            lifecycle: JSON.parse(result.toString())
        });

    } catch (error) {
        console.error("❌ reconstruct packet error:", error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});


app.get('/lot-lifecycle/:lotId', async (req, res) => {
    try {
        const { lotId } = req.params;
        const userId = req.query.user || "User1";
        const org = req.query.org || "aggregators";

        const { contract, gateway } = await getContract(org, userId);

        const result = await contract.evaluateTransaction(
            'reconstructLotLifecycle',
            lotId
        );

        await gateway.disconnect();

        res.json({
            success: true,
            data: JSON.parse(result.toString())
        });

    } catch (error) {
        console.error("❌ Lot lifecycle error:", error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});


app.get('/get-submitted-produce/:aggregatorId', async (req, res) => {
  try {
    const { aggregatorId } = req.params;
    const limit = req.query.limit || "";

    const { contract, gateway } = await getContract('aggregators', 'User1');

    const result = await contract.evaluateTransaction(
      'getSubmittedProduceByAggregator',
      aggregatorId,
      limit.toString()
    );

    await gateway.disconnect();

    res.json(JSON.parse(result.toString()));

  } catch (error) {
    console.error("❌ Error:", error);
    res.status(500).send(error.message);
  }
});
app.get('/get-produce/:status/:ownerId', async (req, res) => {
  try {
    const { status, ownerId } = req.params;
    const limit = req.query.limit || "";

    const { contract, gateway } = await getContract('farmers', 'User1');

    const result = await contract.evaluateTransaction(
      'getProduceByStatusAndOwner',
      status,
      ownerId,
      limit.toString()
    );

    await gateway.disconnect();

    res.json(JSON.parse(result.toString()));

  } catch (error) {
    console.error("❌ Error:", error);
    res.status(500).send(error.message);
  }
});

app.get('/get-produce-by-owner/:org/:userId/:ownerId', async (req, res) => {
  try {
    const { org, userId, ownerId } = req.params;
    const limit = req.query.limit || "";

    // 🔗 Connect to Fabric
    const { contract, gateway } = await getContract(org, userId);

    // 📦 Call chaincode
    const result = await contract.evaluateTransaction(
      'getProduceByOwner',
      ownerId,
      limit.toString()
    );

    const parsed = JSON.parse(result.toString());

    res.json({
      success: true,
      ...parsed
    });

    await gateway.disconnect();

  } catch (error) {
    console.error("❌ Error fetching produce by owner:", error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});



app.get('/get-lots-with-offers/:ownerId', async (req, res) => {
  try {
    const { ownerId } = req.params;
    const limit = req.query.limit || "";

    const { contract, gateway } = await getContract('farmers', 'User1');

    const result = await contract.evaluateTransaction(
      'getLotsWithOffersByOwner',
      ownerId,
      limit.toString()
    );

    res.json(JSON.parse(result.toString()));

    await gateway.disconnect();

  } catch (error) {
    console.error("❌ Error:", error);
    res.status(500).send(error.message);
  }
});



app.get('/get-available-produce/:ownerId', async (req, res) => {
  try {
    const { ownerId } = req.params;
    const limit = req.query.limit || "";

    const { contract, gateway } = await getContract('retailers', 'User1');

    const result = await contract.evaluateTransaction(
      'getAvailableProduceByOwner',
      ownerId,
      limit.toString()
    );

    await gateway.disconnect();

    res.json(JSON.parse(result.toString()));

  } catch (error) {
    console.error("❌ Error:", error);
    res.status(500).send(error.message);
  }
});
app.get('/packet-provenance/:packetId', async (req, res) => {
    try {
        const { packetId } = req.params;
        const userId = req.query.user || "User1";
        const org = req.query.org || "retailers";

        const { contract, gateway } = await getContract(org, userId);

        const result = await contract.evaluateTransaction(
            'getPacketLifecycle',
            packetId
        );

        await gateway.disconnect();

        res.json({
            success: true,
            provenance: JSON.parse(result.toString())
        });

    } catch (error) {
        console.error("❌ Provenance error:", error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});


// GET approved lots without offers
app.get('/get-approved-lots-no-offers/:org/:userId', async (req, res) => {
  try {
    const { org, userId } = req.params;
    const limit = req.query.limit || "10";

    // 🔗 Connect to Fabric
    const { contract, gateway } = await getContract(org, userId);

    // ✅ Pass ownerId (userId) + limit
    const result = await contract.evaluateTransaction(
      'getApprovedLotsWithoutOffers',
      userId,              // 🔥 NEW (ownerId)
      limit.toString()
    );

    const lots = JSON.parse(result.toString());

    res.json({
      success: true,
      count: lots.length,
      data: lots
    });

    await gateway.disconnect();

  } catch (error) {
    console.error("❌ Error fetching approved lots without offers:", error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});





app.listen(PORT, async () => {
  console.log(`✅ API server running at http://localhost:${PORT}`);

  try {
    const org = "retailers";
    const userId = "User1";
    const walletPath = path.join(__dirname, "wallet", org);
    const wallet = await Wallets.newFileSystemWallet(walletPath);
    const identity = await wallet.get(userId);
    if (!identity) throw new Error("Identity not found");

    const ccpPath = path.resolve(__dirname, `./connections/connection-${org}.json`);
    const ccp = JSON.parse(fs.readFileSync(ccpPath, "utf8"));

    const gateway = new Gateway();
    await gateway.connect(ccp, {
      wallet,
      identity: userId,
      discovery: { enabled: true, asLocalhost: true },
    });

    const network = await gateway.getNetwork(CHANNEL_NAME);
    await network.addBlockListener(
      async (event) => {
        console.log("🧱 Block received:", event.blockNumber.toString());

        const txs = event.blockData.data.map((tx) => ({
          txId: tx.payload.header.channel_header.tx_id,
          timestamp: tx.payload.header.channel_header.timestamp,
        }));

        console.log("📋 Transactions:", txs);
      },
      { type: "full" }
    );

    console.log("👂 Listening to new blocks on", CHANNEL_NAME);
  } catch (err) {
    console.error("❌ Error starting block listener:", err);
  }
});
