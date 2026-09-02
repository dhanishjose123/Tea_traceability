const axios = require("axios");

const BASE_URL = process.env.BASE_URL || "http://localhost:5000";
const ORG = process.env.TESTING_FEE_ORG || "aggregators";
const userCount = Number(process.env.SIM_USER_COUNT || process.env.USER_COUNT || 10);
const users = Array.from({ length: userCount }, (_, index) => `User${index + 1}`);

async function setTestingFees() {
  for (const userId of users) {
    try {
      const feeAmount = String(10 + Math.floor(Math.random() * 91));

      const response = await axios.post(`${BASE_URL}/set-testing-fee`, {
        org: ORG,
        userId,
        feeAmount
      });

      console.log(`Set testing fee for ${ORG}.${userId} to ₹${feeAmount}: ${response.data.message}`);
    } catch (error) {
      console.error(`Error setting testing fee for ${ORG}.${userId}:`, error.response?.data || error.message);
    }
  }
}

setTestingFees();
