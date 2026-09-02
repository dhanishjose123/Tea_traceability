const axios = require("axios");

const BASE_URL = "http://localhost:5000";
const farmerOrg = "farmers";
const aggregatorOrg = "aggregators";

const farmerUsers = ["User1", "User2", "User3", "User4", "User5"];
const aggregatorUsers = ["User1", "User2", "User3", "User4", "User5"];

function generateLotId(userId) {
  return `LOT-${Date.now()}-${userId}`;
}

// Step 1: Set random testing fees for all aggregators
async function setTestingFees() {
  console.log("🔧 Setting testing fees for aggregators...");
  for (const userId of aggregatorUsers) {
    const feeAmount = Math.floor(Math.random() * 40 + 10); // ₹10–₹50
    try {
      const res = await axios.post(`${BASE_URL}/set-testing-fee`, {
        org: aggregatorOrg,
        userId,
        feeAmount
      });
      console.log(`✅ ${userId}@${aggregatorOrg}: ₹${feeAmount}`);
    } catch (err) {
      console.error(`❌ Failed to set fee for ${userId}:`, err.response?.data || err.message);
    }
  }
}

// Step 2: Fetch testing fees for all aggregators
async function getTestingFees() {
  console.log("📥 Fetching aggregator testing fees...");
  const aggregatorList = [];

  for (const userId of aggregatorUsers) {
    try {
      const res = await axios.get(`${BASE_URL}/get-testing-fee/${aggregatorOrg}/${userId}`);
      aggregatorList.push({
        aggregatorId: userId,
        fee: res.data.feeAmount
      });
      console.log(`📌 ${userId} charges ₹${res.data.feeAmount}`);
    } catch (err) {
      console.error(`⚠️ Could not fetch fee for ${userId}:`, err.response?.data || err.message);
    }
  }

  return aggregatorList;
}

// Step 3: Submit tea lots from farmers
async function submitLots(aggregatorList) {
  if (aggregatorList.length === 0) {
    console.error("❌ No aggregator fees found. Aborting lot submission.");
    return;
  }

  console.log("🚜 Submitting tea lots...");

  for (const userId of farmerUsers) {
    const lotId = generateLotId(userId);
    const selectedAggregator = aggregatorList[Math.floor(Math.random() * aggregatorList.length)];

    const payload = {
      org: farmerOrg,
      userId,
      lotId,
      farmerId: userId,
      weightKg: (Math.floor(Math.random() * 10) + 5).toString(),
      lotDate: new Date().toISOString().split("T")[0],
      bags: Math.floor(Math.random() * 5 + 1).toString(),
      aggregatorId: selectedAggregator.aggregatorId
    };
    // ✅ Log the payload to console
     console.log(`📦 Payload for ${userId}:`, JSON.stringify(payload, null, 2));
    try {
      
      const res = await axios.post(`${BASE_URL}/submit-lot`, payload);
      console.log(`✅ ${userId} submitted ${lotId} → ${selectedAggregator.aggregatorId} (₹${selectedAggregator.fee})`);
    } catch (err) {
      console.error(`❌ Failed to submit for ${userId}:`, err.response?.data || err.message);
    }

    await new Promise(r => setTimeout(r, 200)); // Delay for uniqueness
  }
}

// Main runner
async function run() {
  await setTestingFees();
  const aggregatorList = await getTestingFees();
  await submitLots(aggregatorList);
}

run();
