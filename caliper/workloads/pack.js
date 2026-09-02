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

class PackLotWorkload extends WorkloadModuleBase {

    constructor() {
        super();

        // 🔒 Prevent duplicate packing
        this.usedLotIds = new Set();

        // 📦 Cached SOLD lots
        this.soldLots = [];
        this.lotIndex = 0;

        // 📊 Counters
        this.txAttempted = 0;
        this.txSucceeded = 0;
        this.txFailed = 0;
        this.txMVCCFailed = 0;

        this.dummyTxCount = 0;   // ✅ NEW
        this.realTxCount = 0;    // ✅ NEW
        this.retailerCount = 1;

        // 📏 Payload tracking
        this.txIndex = 0;
        this.payloadFile = './payload_sizes.csv';
        this.packetCountFile = './pack_packet_counts.csv';
        this.claimDir = path.resolve(__dirname, '../tmp/pack-claims');
        this.totalPacketsCreated = 0;
        this.totalEstimatedLedgerWrites = 0;

        if (!fs.existsSync(this.payloadFile)) {
            fs.writeFileSync(this.payloadFile, 'function,payload_bytes,payload_kb\n');
        }

        if (!fs.existsSync(this.packetCountFile)) {
            fs.writeFileSync(
                this.packetCountFile,
                'worker,lotId,weightKg,packets1000g,packets500g,packets250g,packets100g,totalPackets,estimatedLedgerWrites\n'
            );
        }

        if (!fs.existsSync(this.claimDir)) {
            fs.mkdirSync(this.claimDir, { recursive: true });
        }
    }

    calculatePacketCounts(lot) {
        const weightKg = Number(lot.weightKg || 0);
        const totalWeight = weightKg * 1000;
        const packetCounts = {
            packets1000g: Math.floor(totalWeight * 0.10 / 1000),
            packets500g: Math.floor(totalWeight * 0.20 / 500),
            packets250g: Math.floor(totalWeight * 0.30 / 250),
            packets100g: Math.floor(totalWeight * 0.40 / 100)
        };

        const totalPackets = Object.values(packetCounts).reduce((sum, count) => sum + count, 0);
        const estimatedLedgerWrites = totalPackets + 1; // one packet write per packet plus one lot update

        return {
            weightKg,
            ...packetCounts,
            totalPackets,
            estimatedLedgerWrites
        };
    }

    claimLot(lotId) {
        const safeLotId = String(lotId).replace(/[^a-zA-Z0-9_.-]/g, '_');
        const claimPath = path.join(this.claimDir, `${safeLotId}.claim`);

        try {
            const fd = fs.openSync(claimPath, 'wx');
            fs.writeFileSync(
                fd,
                [
                    `worker=${this.workerIndex}`,
                    `retailer=${this.retailerUserId}`,
                    `time=${new Date().toISOString()}`,
                    `lotId=${lotId}`
                ].join('\n') + '\n'
            );
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
       🔹 INIT
    ============================================================ */
    async initializeWorkloadModule(workerIndex, totalWorkers, roundIndex, roundArguments, sutAdapter) {

        this.workerIndex = workerIndex;
        this.sutAdapter = sutAdapter;
        this.contractId = roundArguments.contractId;
        this.retailerCount = Math.max(1, Number(roundArguments.retailerCount) || 1);
        this.retailerStartIndex = Math.max(1, Number(roundArguments.retailerStartIndex) || 1);
        this.lotQueryLimit = Math.max(1, Number(roundArguments.lotQueryLimit || roundArguments.limit || process.env.PACK_LOT_QUERY_LIMIT || 20));

        const retailerIndex = this.retailerStartIndex + (workerIndex % this.retailerCount);
        this.retailerUserId = `User${retailerIndex}`;

        console.log(`✅ Worker ${this.workerIndex}: Retailer ${this.retailerUserId}`);
        const loadStartedAt = Date.now();
        const staggerDelayMs = await staggerInitialLoad(workerIndex, 'pack');
        const queryStartedAt = Date.now();
        const cacheKey = [
            'pack',
            this.contractId,
            roundArguments.channel || process.env.CHANNEL_NAME || 'channel',
            this.retailerUserId,
            this.lotQueryLimit
        ];

        if (preloadCache.isReadMode()) {
            this.allLots = preloadCache.read(cacheKey) || [];
            console.log(`[LOAD_TIME][pack][Worker ${this.workerIndex}] source=preload-cache staggerMs=${staggerDelayMs} totalMs=${Date.now() - loadStartedAt} lots=${this.allLots.length}`);
            return;
        }

        const lotQuery = {
            contractId: this.contractId,
            contractFunction: 'getProduceByStatusAndOwner',
            contractArguments: [`SOLD`, this.retailerUserId, String(this.lotQueryLimit)],
            readOnly: true
        };


        try {
            const response = await this.sutAdapter.sendRequests(lotQuery);

            let buffer;

            // 🔥 Case 1: Direct TxStatus (your current case)
            if (response?.status?.result) {
                buffer = response.status.result;
            }
            // 🔥 Case 2: Array format
            else if (Array.isArray(response) && response[0]?.status?.result) {
                buffer = response[0].status.result;
            }
            // 🔥 Case 3: Direct buffer
            else if (Array.isArray(response) && response[0]) {
                buffer = response[0];
            }

            if (!buffer) {
                console.error(`⚠️ Worker ${this.workerIndex}: No buffer result`);
                console.log("🔍 Full response:", response);
                return;
            }

            const resultString = buffer.toString();

            console.log(`📥 Worker ${this.workerIndex} result length: ${resultString.length}`);

            const parsed = JSON.parse(resultString);

            this.allLots = parsed.data || [];
            if (preloadCache.isWriteMode()) {
                preloadCache.write(cacheKey, this.allLots);
            }

            console.log(`📦 Worker ${this.workerIndex}: Cached ${this.allLots.length} lots for ${this.retailerUserId}`);
            console.log(`[LOAD_TIME][pack][Worker ${this.workerIndex}] staggerMs=${staggerDelayMs} queryMs=${Date.now() - queryStartedAt} totalMs=${Date.now() - loadStartedAt} lots=${this.allLots.length}`);

        } catch (err) {
            console.error(`❌ Worker ${this.workerIndex}: Fetch failed`, err);
            console.log(`[LOAD_TIME][pack][Worker ${this.workerIndex}] staggerMs=${staggerDelayMs} queryMs=${Date.now() - queryStartedAt} totalMs=${Date.now() - loadStartedAt} lots=0 failed=true`);
        }

       
    }

    /* ============================================================
       🔹 MAIN TX LOOP
    ============================================================ */
    async submitTransaction() {
        if (preloadCache.isPreloadOnly() && !preloadCache.isReadMode()) {
            return;
        }


        /* ---------------------------------
           🟡 CASE 1: No SOLD lots
        ---------------------------------- */
        if (this.allLots.length === 0) {
            return;
        }
        /* ---------------------------------
           Pick next globally unclaimed lot
        ---------------------------------- */
        let lot = null;

        for (let attempt = 0; attempt < this.allLots.length; attempt++) {
            const candidate = this.allLots[this.lotIndex];
            this.lotIndex++;

            if (this.lotIndex >= this.allLots.length) {
                this.lotIndex = 0;
            }

            if (!candidate || !candidate.lotId) {
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
            console.log(`[PACK][Worker ${this.workerIndex}] No unclaimed lots left for ${this.retailerUserId}`);
            return;
        }

        const lotId = lot.lotId;
        const packetStats = this.calculatePacketCounts(lot);
        this.usedLotIds.add(lotId);

        fs.appendFileSync(
            this.packetCountFile,
            [
                this.workerIndex,
                lotId,
                packetStats.weightKg,
                packetStats.packets1000g,
                packetStats.packets500g,
                packetStats.packets250g,
                packetStats.packets100g,
                packetStats.totalPackets,
                packetStats.estimatedLedgerWrites
            ].join(',') + '\n'
        );

        /* ---------------------------------
           🔹 Generate inputs
        ---------------------------------- */
        const price1kg  = (Math.random() * 200 + 800).toFixed(2);
        const price500g = (Math.random() * 150 + 500).toFixed(2);
        const price250g = (Math.random() * 100 + 300).toFixed(2);
        const price100g = (Math.random() * 50  + 100).toFixed(2);

        const packingVideoHash = `ipfs-pack-${Date.now()}-${this.workerIndex}`;

        const args = [
            lotId,
            price1kg,
            price500g,
            price250g,
            price100g,
            packingVideoHash
        ];

        const packTx = {
            contractId: this.contractId,
            contractFunction: 'packLotIntoPackets',
            contractArguments: args,
            readOnly: false
        };

        /* ---------------------------------
           📏 Payload measurement
        ---------------------------------- */
        const payloadString = JSON.stringify(args);
        const payloadBytes = Buffer.byteLength(payloadString, 'utf8');
        const payloadKB = payloadBytes / 1024;

        if (this.txIndex < 50) {
            fs.appendFileSync(
                this.payloadFile,
                `packLotIntoPackets,${payloadBytes},${payloadKB.toFixed(4)}\n`
            );
        }

        this.txIndex++;

        /* ---------------------------------
           🚀 Execute TX
        ---------------------------------- */
        this.txAttempted++;

        try {

            await this.sutAdapter.sendRequests(packTx);

            this.txSucceeded++;
            this.realTxCount++;   // ✅ REAL TX
            this.totalPacketsCreated += packetStats.totalPackets;
            this.totalEstimatedLedgerWrites += packetStats.estimatedLedgerWrites;
            console.log(
                `Packets Created In Invocation : ${packetStats.totalPackets} | Lot: ${lotId} | Worker: ${this.workerIndex}`
            );

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
        console.log(`   📦 Packets Created: ${this.totalPacketsCreated}`);
        console.log(`Packets Created    : ${this.totalPacketsCreated}`);
        console.log(`   ✍️ Est. Writes    : ${this.totalEstimatedLedgerWrites}`);
        console.log(`   📈 Total TX       : ${total}`);
        console.log(`   ⚖️ Dummy Ratio    : ${dummyRatio.toFixed(2)}%`);
    }
}

module.exports.createWorkloadModule = () => new PackLotWorkload();
