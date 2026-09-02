'use strict';

const { WorkloadModuleBase } = require('@hyperledger/caliper-core');
const fs = require('fs');

class MakeOfferAllWorkload extends WorkloadModuleBase {

    constructor() {
        super();

        // 📦 Cached APPROVED lots
        this.approvedLots = [];
        this.usedLotIds = new Set();
        this.dummyTxCount = 0;

        // 📊 Counters
        this.txSeq = 0;
        this.txAttempted = 0;
        this.txSucceeded = 0;
        this.txPhantomFailed = 0;
        this.txOtherFailed = 0;

        // 📏 Payload tracking
        this.txIndex = 0;
        this.payloadFile = './payload_sizes.csv';

        // Create CSV header once
        if (!fs.existsSync(this.payloadFile)) {
            fs.writeFileSync(this.payloadFile, 'function,payload_bytes,payload_kb\n');
        }
    }

async initializeWorkloadModule(workerIndex, totalWorkers, roundIndex, roundArguments, sutAdapter) {

    this.workerIndex = workerIndex;
    this.roundIndex = roundIndex;
    this.sutAdapter = sutAdapter;
        this.contractId = roundArguments.contractId;

    this.retailerUserId = `User${workerIndex + 1}`;
    this.invokerIdentity = `_RetailersMSP_User${workerIndex + 1}`;

    console.log(`🔧 Worker ${workerIndex} initialized as ${this.retailerUserId}`);

    const lotQuery = {
        contractId: this.contractId,
        contractFunction: 'getApprovedLotsWithoutOffers',
        contractArguments: [`User${workerIndex + 1}`, '1000'],
        readOnly: true
    };

    try {

        const response = await this.sutAdapter.sendRequests(lotQuery);

        let buffer;

        /* ---------------------------------
           🔥 HANDLE CALIPER RESPONSE TYPES
        ---------------------------------- */

        // Case 1: Standard response
        if (response?.status?.result) {
            buffer = response.status.result;
        }
        // Case 2: Array response (common in Caliper)
        else if (Array.isArray(response) && response[0]?.status?.result) {
            buffer = response[0].status.result;
        }
        // Case 3: Direct object (already parsed)
        else if (Array.isArray(response) && response[0]) {
            buffer = response[0];
        }
        // Case 4: Direct buffer/object
        else {
            buffer = response;
        }

        if (!buffer) {
            console.error(`⚠️ Worker ${this.workerIndex}: No buffer result`);
            
            this.availableLots = [];
            return;
        }

        let parsed;

        /* ---------------------------------
           🔥 HANDLE BUFFER vs OBJECT
        ---------------------------------- */

        if (Buffer.isBuffer(buffer)) {

            const resultString = buffer.toString();
            console.log("📄 Raw (buffer preview):", resultString.slice(0, 200));

            try {
                parsed = JSON.parse(resultString);
            } catch (err) {
                console.error(`❌ Worker ${this.workerIndex}: JSON parse failed`);
                console.error("Raw:", resultString.slice(0, 500));
                this.availableLots = [];
                return;
            }

        } else if (typeof buffer === 'object') {

           
            parsed = buffer;

        } else {
            console.error(`❌ Unknown response type`);
            this.availableLots = [];
            return;
        }

        /* ---------------------------------
           🔥 NORMALIZE RESULT → ARRAY
        ---------------------------------- */

        if (Array.isArray(parsed)) {
            this.availableLots = parsed;

        } else if (parsed.data && Array.isArray(parsed.data)) {
            this.availableLots = parsed.data;

        } else if (typeof parsed === 'object' && parsed !== null) {
            this.availableLots = [parsed];

        } else {
            this.availableLots = [];
        }

        console.log(`✅ Loaded ${this.availableLots.length} lots`);

        console.log(
            `[INIT][Worker ${this.workerIndex}] 📦 Cached ${this.availableLots.length} lots with NO offers`
        );

    } catch (err) {
        console.error(
            `[INIT][Worker ${this.workerIndex}] ❌ Failed`,
            err.message || err
        );
        this.availableLots = [];
    }
}
async submitTransaction() {

    /* ---------------------------------
       1️⃣ Stop if no available lots
    ---------------------------------- */
    if (this.availableLots.length === 0) {
        console.log(`No unused lots left for worker ${this.workerIndex}`);
        return;
    }

    /* ---------------------------------
       2️⃣ Filter unused lots
    ---------------------------------- */
    const unusedLots = this.availableLots.filter(
        l => !this.usedLotIds.has(l.lotId)
    );

    if (unusedLots.length === 0) {
        console.log(`No unused lots left for worker ${this.workerIndex}`);
        return;
    }

    /* ---------------------------------
       3️⃣ Pick random unused lot
    ---------------------------------- */
    const lot = unusedLots[
        Math.floor(Math.random() * unusedLots.length)
    ];

    if (!lot?.lotId) return;

    const lotId = lot.lotId;

    /* ---------------------------------
       🔥 MARK AS USED (IMPORTANT)
    ---------------------------------- */
    this.usedLotIds.add(lotId);

    /* ---------------------------------
       4️⃣ Generate offer
    ---------------------------------- */
    const highestOffer = lot.highestOffer?.offerPrice || 0;

    const increment = Math.floor(Math.random() * 100 + 50);
    const offerPrice = highestOffer + increment;

    const users = ['User1', 'User2', 'User3', 'User4', 'User5'];
    const randomUserId = users[Math.floor(Math.random() * users.length)];

    const args = [lotId, randomUserId, offerPrice.toString()];

    const makeOfferTx = {
        contractId: this.contractId,
        contractFunction: 'makeOffer',
        invokerIdentity: this.invokerIdentity,
        contractArguments: args,
        readOnly: false
    };

    this.txAttempted++;

    try {
        await this.sutAdapter.sendRequests(makeOfferTx);
        this.txSucceeded++;
    } catch (err) {
        const msg = err?.message || '';
        if (msg.includes('MVCC')) this.txPhantomFailed++;
        else this.txOtherFailed++;
    }
}

async cleanupWorkloadModule() {

    console.log(`
==============================
📊 Worker ${this.workerIndex} Summary
------------------------------
👤 User: ${this.retailerUserId}
🟡 Dummy Transactions: ${this.dummyTxCount}
Dummy TX           : ${this.dummyTxCount}
Dummy Ratio        : ${this.txAttempted > 0 ? ((this.dummyTxCount / this.txAttempted) * 100).toFixed(2) : '0.00'}%
==============================
`);
}

}

module.exports.createWorkloadModule = () => new MakeOfferAllWorkload();
