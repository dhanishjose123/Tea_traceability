'use strict';

const { WorkloadModuleBase } = require('@hyperledger/caliper-core');
const fs = require('fs');
const path = require('path');
const preloadCache = require('./preload-cache');

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function staggerInitialLoad(workerIndex, label) {
    const staggerMs = Number(process.env.LOAD_STAGGER_MS || process.env.INIT_LOAD_STAGGER_MS || 250);
    const delayMs = Math.max(0, workerIndex * staggerMs);

    if (delayMs > 0) {
        console.log(`[INIT][Worker ${workerIndex}] ${label} load stagger ${delayMs}ms`);
        await sleep(delayMs);
    }

    return delayMs;
}

class AcceptOfferWorkload extends WorkloadModuleBase {

    constructor() {
        super();

        // 🔒 Track processed lots
        this.usedLotIds = new Set();

        // 📦 Cached lots
        this.allLots = [];
        this.lotIndex = 0;

        // 📊 Counters
        this.txAttempted = 0;
        this.txSucceeded = 0;
        this.txFailed = 0;
        this.txMVCCFailed = 0;

        this.dummyTxCount = 0;   // ✅ NEW
        this.realTxCount = 0;    // ✅ NEW
        this.farmerCount = 5;
        this.retailerCount = 5;
        this.farmerStartIndex = 1;
        this.retailerStartIndex = 1;
        this.retailerSelectionMode = 'range';
        // 📏 Payload tracking
        this.txIndex = 0;
        this.payloadFile = './payload_sizes.csv';
        this.claimDir = path.resolve(__dirname, '../tmp/acceptoffer-claims');

        if (!fs.existsSync(this.payloadFile)) {
            fs.writeFileSync(this.payloadFile, 'function,payload_bytes,payload_kb\n');
        }

        if (!fs.existsSync(this.claimDir)) {
            fs.mkdirSync(this.claimDir, { recursive: true });
        }
    }

    /* ============================================================
       🔹 INIT
    ============================================================ */
    async initializeWorkloadModule(workerIndex, totalWorkers, roundIndex, roundArguments, sutAdapter) {

    this.workerIndex = workerIndex;
    this.sutAdapter = sutAdapter;
        this.contractId = roundArguments.contractId;
    this.contractFunction = roundArguments.contractFunction || 'acceptOffer';
    this.farmerCount = Math.max(1, Number(roundArguments.farmerCount) || this.farmerCount);
    this.retailerCount = Math.max(1, Number(roundArguments.retailerCount) || this.retailerCount);
    this.farmerStartIndex = Math.max(1, Number(roundArguments.farmerStartIndex) || 1);
    this.retailerStartIndex = Math.max(1, Number(roundArguments.retailerStartIndex) || 1);
    this.retailerSelectionMode = String(roundArguments.retailerSelectionMode || process.env.ACCEPT_OFFER_RETAILER_SELECTION_MODE || 'range').toLowerCase();
    
    // 🧮 Dynamic lot query limit calculation
    const duration = Number(roundArguments.txDuration || 5);
    const tps = Number(roundArguments.tps || 500);
    const calculatedLimit = Math.ceil((duration * tps) / totalWorkers);
    
    const defaultLimit = Math.max(20, Number(roundArguments.txNumber) || calculatedLimit);
    this.lotQueryLimit = Math.max(1, Number(roundArguments.lotQueryLimit || roundArguments.limit || process.env.ACCEPT_OFFER_LOT_QUERY_LIMIT || defaultLimit));
    this.queryLimit = preloadCache.isWriteMode()
        ? Math.max(this.lotQueryLimit, Number(process.env.ACCEPT_OFFER_PRELOAD_LIMIT || 3000))
        : this.lotQueryLimit;

    const farmerUserIndex = this.farmerStartIndex + (workerIndex % this.farmerCount);
    this.farmerUserId = `User${farmerUserIndex}`;

    // 🔥 ALWAYS initialize
    this.availableLots = [];

    console.log(`Worker ${this.workerIndex}: Initialized farmer ${this.farmerUserId}, farmerRange=User${this.farmerStartIndex}..User${this.farmerStartIndex + this.farmerCount - 1}, retailerMode=${this.retailerSelectionMode}, retailerRange=User${this.retailerStartIndex}..User${this.retailerStartIndex + this.retailerCount - 1}`);
    const loadStartedAt = Date.now();
    const staggerDelayMs = await staggerInitialLoad(workerIndex, 'acceptoffer');
    const queryStartedAt = Date.now();
    const cacheKey = [
        'acceptoffer',
        this.contractId,
        roundArguments.channel || process.env.CHANNEL_NAME || 'channel',
        this.farmerUserId,
        `${this.retailerStartIndex}-${this.retailerStartIndex + this.retailerCount - 1}`,
        this.retailerSelectionMode
    ];

    if (preloadCache.isReadMode()) {
        this.availableLots = preloadCache.read(cacheKey) || [];
        console.log(`[LOAD_TIME][acceptoffer][Worker ${this.workerIndex}] source=preload-cache staggerMs=${staggerDelayMs} totalMs=${Date.now() - loadStartedAt} lots=${this.availableLots.length}`);
        return;
    }

    const queryTx = {
        contractId: this.contractId,
        contractFunction: 'getLotsWithOffersByOwner',
        contractArguments: [this.farmerUserId, String(this.queryLimit)],
        readOnly: true
    };

    try {
        const res = await this.sutAdapter.sendRequests(queryTx);

        if (!res?.status?.result) {
            console.log(`[INIT][Worker ${this.workerIndex}] ❌ No lots`);
            return;
        }

        const resultBuffer = res.status.result;
        const resultString = resultBuffer.toString();

        // ✅ Payload info
        console.log(`[Worker ${this.workerIndex}] 📏 Payload bytes: ${resultBuffer.length}`);

        let parsed;

        try {
            parsed = JSON.parse(resultString);
        } catch (err) {
            console.error(`[INIT][Worker ${this.workerIndex}] ❌ JSON parse failed`);
            return;
        }

        // 🔥 Normalize (important)
        if (Array.isArray(parsed)) {
            this.availableLots = parsed;

        } else if (parsed.data && Array.isArray(parsed.data)) {
            this.availableLots = parsed.data;

        } else if (typeof parsed === 'object' && parsed !== null) {
            this.availableLots = [parsed];

        } else {
            this.availableLots = [];
        }

        this.availableLots = this.availableLots.filter(lot => this.isAllowedRetailer(lot?.highestOffer?.retailerId));
        if (preloadCache.isWriteMode()) {
            preloadCache.write(cacheKey, this.availableLots);
        }

        console.log(
            `[INIT][Worker ${this.workerIndex}] 📦 Loaded ${this.availableLots.length} lots`
        );
        console.log(`[LOAD_TIME][acceptoffer][Worker ${this.workerIndex}] staggerMs=${staggerDelayMs} queryMs=${Date.now() - queryStartedAt} totalMs=${Date.now() - loadStartedAt} lots=${this.availableLots.length}`);

    } catch (err) {
        console.error(`[INIT][Worker ${this.workerIndex}] ❌ Error`, err.message);
        this.availableLots = [];
        console.log(`[LOAD_TIME][acceptoffer][Worker ${this.workerIndex}] staggerMs=${staggerDelayMs} queryMs=${Date.now() - queryStartedAt} totalMs=${Date.now() - loadStartedAt} lots=0 failed=true`);
    }
}

    isAllowedRetailer(retailerId) {
        const match = String(retailerId || '').match(/^User(\d+)$/i);
        if (!match) {
            return false;
        }
        const retailerIndex = Number(match[1]);

        if (this.retailerSelectionMode === 'paired' || this.retailerSelectionMode === 'matching') {
            const farmerMatch = String(this.farmerUserId || '').match(/^User(\d+)$/i);
            const farmerIndex = farmerMatch ? Number(farmerMatch[1]) : NaN;
            return retailerIndex === farmerIndex;
        }

        return retailerIndex >= this.retailerStartIndex && retailerIndex <= this.retailerStartIndex + this.retailerCount - 1;
    }

    claimLot(lotId) {
        const safeLotId = String(lotId).replace(/[^a-zA-Z0-9_.-]/g, '_');
        const claimPath = path.join(this.claimDir, `${safeLotId}.claim`);

        try {
            const fd = fs.openSync(claimPath, 'wx');
            fs.writeFileSync(fd, `worker=${this.workerIndex}\ntime=${new Date().toISOString()}\nlotId=${lotId}\n`);
            fs.closeSync(fd);
            return true;
        } catch (error) {
            if (error.code === 'EEXIST') {
                return false;
            }
            throw error;
        }
    }

    /* ============================================================
       🔹 MAIN TX LOOP
    ============================================================ */
    async submitTransaction() {
        if (preloadCache.isPreloadOnly()) {
            return;
        }

        /* ---------------------------------
           🟡 CASE 1: No eligible lots
        ---------------------------------- */
        if (this.availableLots.length === 0) {
            return;
        }

        /* ---------------------------------
           🔹 Pick next unclaimed lot
        ---------------------------------- */
        let lot = null;
        for (let attempt = 0; attempt < this.availableLots.length; attempt++) {
            const candidate = this.availableLots[this.lotIndex];
            this.lotIndex++;

            if (this.lotIndex >= this.availableLots.length) {
                this.lotIndex = 0;
            }

            if (!candidate || !candidate.lotId || !candidate.highestOffer) {
                continue;
            }

            if (this.usedLotIds.has(candidate.lotId)) {
                continue;
            }

            if (!this.claimLot(candidate.lotId)) {
                continue;
            }

            lot = candidate;
            break;
        }

        if (!lot) {
            return;
        }

        const lotId = lot.lotId;

        /* ---------------------------------
           🟡 CASE 2: Already processed
        ---------------------------------- */
        if (this.usedLotIds.has(lotId)) {
            return;
        }

        this.usedLotIds.add(lotId);

        /* ---------------------------------
           🔹 Prepare TX
        ---------------------------------- */
        const args = [lotId, lot.highestOffer.retailerId];

        const acceptTx = {
            contractId: this.contractId,
            contractFunction: this.contractFunction,
            contractArguments: args,
            readOnly: false
        };

        /* ---------------------------------
           📏 Payload size
        ---------------------------------- */
        const payloadString = JSON.stringify(args);
        const payloadBytes = Buffer.byteLength(payloadString, 'utf8');
        const payloadKB = payloadBytes / 1024;

        if (this.txIndex < 50) {
            fs.appendFileSync(
                this.payloadFile,
                `${this.contractFunction},${payloadBytes},${payloadKB.toFixed(4)}\n`
            );
        }

        this.txIndex++;

        /* ---------------------------------
           🚀 Execute TX
        ---------------------------------- */
        this.txAttempted++;

        try {
            await this.sutAdapter.sendRequests(acceptTx);

            this.txSucceeded++;
            this.realTxCount++;   // ✅ REAL TX

        } catch (err) {

            this.txFailed++;

            const msg = err?.message || '';

            if (
                msg.includes('MVCC') ||
                msg.includes('PHANTOM') ||
                msg.includes('CONFLICT')
            ) {
                this.txMVCCFailed++;
            }
        }

        /* ---------------------------------
           📊 Periodic stats
        ---------------------------------- */
        if (this.txAttempted % 10 === 0) {

            console.log(
                `📊 [Worker ${this.workerIndex}] ` +
                `Attempt=${this.txAttempted}, ` +
                `Success=${this.txSucceeded}, ` +
                `Dummy=${this.dummyTxCount}, ` +
                `MVCC=${this.txMVCCFailed}, ` +
                `Failed=${this.txFailed}`
            );
        }
    }

    /* ============================================================
       🔹 FINAL SUMMARY
    ============================================================ */
    async cleanupWorkloadModule() {

        const total = this.realTxCount + this.dummyTxCount;
        const dummyRatio = total > 0 ? (this.dummyTxCount / total) * 100 : 0;

        console.log(`\n📊 ===== Worker ${this.workerIndex} Summary =====`);
        console.log(`   ✅ Real TX        : ${this.realTxCount}`);
        console.log(`   🟡 Dummy TX       : ${this.dummyTxCount}`);
        console.log(`   ❌ Failed TX      : ${this.txFailed}`);
        console.log(`   ⚠️ MVCC Conflicts : ${this.txMVCCFailed}`);
        console.log(`   📈 Total TX       : ${total}`);
        console.log(`   ⚖️ Dummy Ratio    : ${dummyRatio.toFixed(2)}%`);
    }
}

module.exports.createWorkloadModule = () => new AcceptOfferWorkload();
