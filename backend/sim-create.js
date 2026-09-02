const axios = require("axios");

const BASE_URL = process.env.BASE_URL || "http://localhost:5000";
const BANK_USER = { org: "bank", userId: "User1" }; // Bank initiates all deposits

const orgs = ["farmers", "aggregators", "retailers", "consumers"];
const userCount = Number(process.env.SIM_USER_COUNT || process.env.USER_COUNT || 10);
const depositAmount = process.env.INITIAL_WALLET_DEPOSIT || "100000000000000";
const users = ["Admin", ...Array.from({ length: userCount }, (_, index) => `User${index + 1}`)];

async function initializeWalletsAndDeposit() {
  for (const org of orgs) {
    for (const userId of users) {
      const targetUser = { targetOrg: org, targetUserId: userId };

      try {
        // 🔹 Create Wallet (writes a fixed wallet metadata key, MVCC-safe if done once)
        const walletRes = await axios.post(`${BASE_URL}/create-wallet`, {
          ...BANK_USER,
          ...targetUser
        });
        console.log(`👜 Created wallet for ${org}.${userId}: ${walletRes.data.message}`);
      } catch (error) {
        const errorMessage = error.response?.data?.error || error.message;
        if (errorMessage && errorMessage.includes("Wallet already exists")) {
          console.log(`👜 Wallet already exists for ${org}.${userId}, depositing anyway`);
        } else {
          console.error(`❌ Wallet create error for ${org}.${userId}:`, error.response?.data || error.message);
          continue;
        }
      }

      try {
        // 🕒 Random delay to stagger deposits and reduce MVCC collisions
        await new Promise(r => setTimeout(r, Math.floor(Math.random() * 100)));

        // 🔸 Deposit configured amount using new chaincode logic (append-only log)
        const depositRes = await axios.post(`${BASE_URL}/deposit-money`, {
          ...BANK_USER,
          ...targetUser,
          amount: depositAmount
        });
        console.log(`💸 Deposited ${depositAmount} tokens into ${org}.${userId}: ${depositRes.data.message}`);

        // 📊 (Optional) Fetch current balance after deposit
        const balanceRes = await axios.get(`${BASE_URL}/get-wallet-balance/${org}/${userId}`);
        console.log(`💰 Balance for ${org}.${userId}: ${balanceRes.data.balance} tokens`);

      } catch (error) {
        console.error(`❌ Deposit/balance error for ${org}.${userId}:`, error.response?.data || error.message);
      }
    }
  }
}

initializeWalletsAndDeposit();
