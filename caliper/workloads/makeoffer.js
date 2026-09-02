'use strict';

const { WorkloadModuleBase } = require('@hyperledger/caliper-core');
const fs = require('fs');

class MakeOfferAllWorkload extends WorkloadModuleBase {

    constructor() {
        super();

        // 📦 Cached APPROVED lots
        this.approvedLots = [];

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

        /* ---------------------------------
           🔹 INITIAL QUERY (ONCE)
        ---------------------------------- */
        const lotQuery = {
            contractId: this.contractId,
            contractFunction: 'getProduceByStatusAndOwner',
            contractArguments: ['APPROVED',this.retailerUserId,'1000'],
            readOnly: true
        };

        try {
            const response = await this.sutAdapter.sendRequests(lotQuery);
            const resultString = response?.status?.result?.toString() || '';

            if (!resultString) {
                console.error(`⚠️ Worker ${this.workerIndex}: Empty result`);
                return;
            }

            const parsed = JSON.parse(resultString);
            const allLots = parsed.data || [];

            this.approvedLots = allLots.filter(l => l.status === 'APPROVED');

            console.log(
                `[INIT][Worker ${this.workerIndex}] 📦 Cached ${this.approvedLots.length} APPROVED lots`
            );

        } catch (err) {
            console.error(
                `[INIT][Worker ${this.workerIndex}] ❌ Failed to load lots`,
                err.message || err
            );
        }
    }

    async submitTransaction() {

        /* ---------------------------------
           1️⃣ Pick random APPROVED lot
        ---------------------------------- */
        if (this.approvedLots.length === 0) return;

        const lot = this.approvedLots[
            Math.floor(Math.random() * this.approvedLots.length)
        ];

        if (!lot || !lot.lotId) return;

        const lotId = lot.lotId;

        /* ---------------------------------
           2️⃣ Get highest offer
        ---------------------------------- */
        let highestOffer = 0;

        try {
            const highestOfferTx = {
                contractId: this.contractId,
                contractFunction: 'getHighestOfferForLot',
                contractArguments: [lotId],
                readOnly: true
            };

            const res = await this.sutAdapter.sendRequests(highestOfferTx);

            if (res?.status?.result) {
                const parsed = JSON.parse(res.status.result.toString());
                highestOffer = Number(parsed.offerPrice || 0);
            }

        } catch {
            highestOffer = 0;
        }

        /* ---------------------------------
           3️⃣ Generate higher offer
        ---------------------------------- */
        const increment = Math.floor(Math.random() * 100 + 50);
        const offerPrice = highestOffer + increment;

        /* ---------------------------------
           4️⃣ Prepare transaction
        ---------------------------------- */
        const users = ['User1', 'User2', 'User3', 'User4', 'User5'];

        const randomUserId = users[Math.floor(Math.random() * users.length)];

        const args = [
            lotId,
            randomUserId,
            offerPrice.toString()
        ];

        const makeOfferTx = {
            contractId: this.contractId,
            contractFunction: 'makeOffer',
            invokerIdentity: this.invokerIdentity,
            contractArguments: args,
            readOnly: false
        };

        /* ---------------------------------
           📏 PAYLOAD SIZE MEASUREMENT
        ---------------------------------- */
        const payloadString = JSON.stringify(args);
        const payloadBytes = Buffer.byteLength(payloadString, 'utf8');
        const payloadKB = payloadBytes / 1024;

        // Log only first 50 transactions
        if (this.txIndex < 50) {
            const fs = require('fs');
            fs.appendFileSync(
                this.payloadFile,
                `makeOffer,${payloadBytes},${payloadKB.toFixed(4)}\n`
            );
        }

        this.txIndex++;

        /* ---------------------------------
           🚀 Send transaction
        ---------------------------------- */
        this.txAttempted++;
        this.txSeq++;

        try {
            console.log(
                `🚀 [Worker ${this.workerIndex}] makeOffer -> Lot: ${lotId}, ` +
                `User: ${randomUserId}, Offer: ${offerPrice}`
            );
            await this.sutAdapter.sendRequests(makeOfferTx);
            this.txSucceeded++;
            console.log(`✅ makeOffer SUCCESS for Lot ${lotId}`);

        } catch (err) {

            const msg = err?.message || '';

            if (msg.includes('PHANTOM') || msg.includes('MVCC')) {
                this.txPhantomFailed++;
            } else {
                this.txOtherFailed++;
            }
        }

        /* ---------------------------------
           📊 Periodic stats
        ---------------------------------- */
        if (this.txAttempted % 10 === 0) {
            console.log(
                `📊 [Worker ${this.workerIndex}] Attempts=${this.txAttempted}, ` +
                `Success=${this.txSucceeded}, Phantom=${this.txPhantomFailed}, ` +
                `OtherFail=${this.txOtherFailed}`
            );
        }
    }
}
