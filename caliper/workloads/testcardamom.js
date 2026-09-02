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

/* ============================================================
   🔹 RANDOM GRADING GENERATOR
============================================================ */
function generateRandomGrading(weightKg) {
    const sizeGrades = {};
    const sizeCategories = ["8+mm", "7-8mm", "6-7mm", "<6mm"];
    let remainingPercent = 100;

    for (let i = 0; i < sizeCategories.length; i++) {
        const total = i === sizeCategories.length - 1
            ? remainingPercent
            : Math.floor(Math.random() * (remainingPercent / 2) + 5);

        remainingPercent -= total;

        const clean = Math.floor(total * 0.5 + Math.random() * 10);
        const sick = Math.floor(total * 0.2 + Math.random() * 5);
        const split = Math.max(0, total - clean - sick);

        sizeGrades[sizeCategories[i]] = {
            clean,
            sick,
            split,
            total: clean + sick + split
        };
    }

    const greenPercent = Math.floor(Math.random() * 40 + 30);
    const averagePercent = Math.floor(Math.random() * (100 - greenPercent));
    const fruitPercent = Math.floor(Math.random() * (100 - greenPercent - averagePercent));
    const belowAveragePercent = 100 - greenPercent - averagePercent - fruitPercent;

    return {
        sizeGrades,
        greenPercent,
        averagePercent,
        fruitPercent,
        belowAveragePercent,
        literWeight: Math.floor(Math.random() * 40 + 320),
        moisture: parseFloat((Math.random() * 2 + 6).toFixed(2)),
        numberOfBags: Math.floor(Math.random() * 6 + 10),
        netWeight: weightKg || Math.floor(Math.random() * 101 + 500)
    };
}

/* ============================================================
   🔹 WORKLOAD CLASS
============================================================ */
class TestTeaLotWorkload extends WorkloadModuleBase {

    constructor() {
        super();

        // 📊 Counters
        this.dummyTxCount = 0;
        this.realTxCount = 0;

        // 🧾 Logs
        this.failedTxLog = [];
        this.dummyTxLog = [];

        // 📦 State
        this.packedLotIds = [];
        this.cachedLots = [];
        this.allLots = [];
        this.txIndex = 0;
        this.aggregatorCount = 5;
        this.aggregatorStartIndex = 1;

        // 📁 Payload file
        this.payloadFile = './payload_sizes.csv';

        if (!fs.existsSync(this.payloadFile)) {
            fs.writeFileSync(this.payloadFile, 'function,payload_bytes,payload_kb\n');
        }
    }

    /* ============================================================
       🔹 INITIALIZATION
    ============================================================ */
    async initializeWorkloadModule(workerIndex, totalWorkers, roundIndex, roundArguments, sutAdapter) {

        this.workerIndex = workerIndex;
        this.totalWorkers = totalWorkers;
        this.roundIndex = roundIndex;
        this.roundArguments = roundArguments;
        this.sutAdapter = sutAdapter;
        this.contractId = roundArguments.contractId;
        this.aggregatorCount = Math.max(1, Number(roundArguments.aggregatorCount) || this.aggregatorCount);
        this.aggregatorStartIndex = Math.max(1, Number(roundArguments.aggregatorStartIndex) || 1);
        
        // 🧮 Dynamic lot query limit calculation
        const duration = Number(roundArguments.txDuration || 5);
        const tps = Number(roundArguments.tps || 500);
        const calculatedLimit = Math.ceil((duration * tps) / totalWorkers);
        
        const defaultLimit = Number(roundArguments.txNumber) || calculatedLimit || 1000;
        this.lotQueryLimit = Math.max(1, Number(roundArguments.lotQueryLimit || process.env.TEST_TEA_LOT_LOT_QUERY_LIMIT || defaultLimit));
        const aggregatorUserIndex = this.aggregatorStartIndex + (workerIndex % this.aggregatorCount);
        this.aggregatorUserId = `User${aggregatorUserIndex}`;
        this.aggregatorId = this.aggregatorUserId;
        this.invokerIdentity = this.aggregatorUserId;
	
        console.log(`Worker ${workerIndex + 1} initialized as ${this.aggregatorUserId}, aggregatorRange=User${this.aggregatorStartIndex}..User${this.aggregatorStartIndex + this.aggregatorCount - 1}`);
        console.log(`🧮 Worker ${workerIndex + 1} calculating lot limit: (duration ${duration}s * tps ${tps}) / workers ${totalWorkers} = ${calculatedLimit}. Using limit ${this.lotQueryLimit}`);

        // -------------------------------
        // 📦 Fetch lots
        // -------------------------------
        console.log(`Worker Index: ${workerIndex + 1}`);
        const loadStartedAt = Date.now();
        const staggerDelayMs = await staggerInitialLoad(workerIndex, 'testTeaLot');
        const queryStartedAt = Date.now();
        const cacheKey = [
            'testTeaLot',
            this.contractId,
            roundArguments.channel || process.env.CHANNEL_NAME || 'channel',
            this.aggregatorUserId,
            this.lotQueryLimit
        ];

        if (preloadCache.isReadMode()) {
            this.allLots = preloadCache.read(cacheKey) || [];
            console.log(`[LOAD_TIME][testTeaLot][Worker ${this.workerIndex}] source=preload-cache staggerMs=${staggerDelayMs} totalMs=${Date.now() - loadStartedAt} lots=${this.allLots.length}`);
            return;
        }

        const lotQuery = {
            contractId: this.contractId,
            contractFunction: 'getSubmittedProduceByAggregator',
            invokerIdentity: this.invokerIdentity,
            contractArguments: [this.aggregatorUserId, String(this.lotQueryLimit)],
            readOnly: true
        };

        try {
            const response = await this.sutAdapter.sendRequests(lotQuery);

            let buffer;

            // 🔥 Case 1: Direct TxStatus
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
                this.allLots = [];
                return;
            }

            const resultString = buffer.toString();
            const parsed = JSON.parse(resultString);
            this.allLots = Array.isArray(parsed.data) ? parsed.data : [];
            if (preloadCache.isWriteMode()) {
                preloadCache.write(cacheKey, this.allLots);
            }

            console.log(`📦 Worker ${this.workerIndex}: Cached ${this.allLots.length} lots`);
            console.log(`[LOAD_TIME][testTeaLot][Worker ${this.workerIndex}] staggerMs=${staggerDelayMs} queryMs=${Date.now() - queryStartedAt} totalMs=${Date.now() - loadStartedAt} lots=${this.allLots.length}`);

        } catch (err) {
            console.error(`❌ Worker ${this.workerIndex}: Fetch failed`, err);
            this.allLots = [];
        }
    }

    /* ============================================================
       🔹 MAIN TRANSACTION LOOP
    ============================================================ */
    async submitTransaction() {
        if (preloadCache.isPreloadOnly()) {
            return;
        }

        const availableLots = (Array.isArray(this.allLots) ? this.allLots : []).filter(
            lot => !this.packedLotIds.includes(lot.lotId)
        );

        // -------------------------------
        // 🟡 DUMMY TRANSACTION
        // -------------------------------
        if (availableLots.length === 0) {
            this.dummyTxCount++;
            return;
        }

        // -------------------------------
        // ✅ REAL TRANSACTION
        // -------------------------------
        const lot = availableLots[Math.floor(Math.random() * availableLots.length)];
        const grading = generateRandomGrading(lot.weightKg);

        this.packedLotIds.push(lot.lotId);

        const args = [
            lot.lotId,
            'pass',
            'QmSampleVideoHash12345',
            JSON.stringify(grading)
        ];

        const testTx = {
            contractId: this.contractId,
            contractFunction: 'testTeaLot',
            invokerIdentity: this.invokerIdentity,
            contractArguments: args,
            readOnly: false
        };

        // -------------------------------
        // 📏 Payload measurement
        // -------------------------------
        const payloadString = JSON.stringify(args);
        const payloadBytes = Buffer.byteLength(payloadString, 'utf8');
        const payloadKB = payloadBytes / 1024;

        if (this.txIndex < 50) {
            fs.appendFileSync(
                this.payloadFile,
                `testTeaLot,${payloadBytes},${payloadKB.toFixed(4)}\n`
            );
        }

        this.txIndex++;

        // -------------------------------
        // 🚀 Execute TX
        // -------------------------------
        try {
            await this.sutAdapter.sendRequests(testTx);
            this.realTxCount++;
        } catch (err) {
            const failure = {
                timestamp: new Date().toISOString(),
                worker: this.workerIndex,
                function: 'testTeaLot',
                args,
                error: err.message
            };
            this.failedTxLog.push(failure);
            console.error(`❌ Worker ${this.workerIndex}: TX failed`, err);
        }
    }

    /* ============================================================
       🔹 CLEANUP (FINAL REPORT)
    ============================================================ */
    async cleanupWorkloadModule() {
        const dummy = this.dummyTxCount;
        const real = this.realTxCount;
        const failed = this.failedTxLog.length;
        const total = real + dummy;

        const dummyRatio = total > 0 ? (dummy / total) * 100 : 0;

        console.log(`\n📊 ===== Worker ${this.workerIndex} Summary =====`);
        console.log(`   ✅ Real Transactions   : ${real}`);
        console.log(`   🟡 Dummy Transactions  : ${dummy}`);
        console.log(`   ❌ Failed Transactions : ${failed}`);
        console.log(`   📈 Total Submitted     : ${total}`);
        console.log(`   ⚖️ Dummy Ratio        : ${dummyRatio.toFixed(2)}%`);

        if (failed > 0) {
            const filePath = path.join(__dirname, `failed_tx_worker${this.workerIndex}.json`);
            fs.writeFileSync(filePath, JSON.stringify(this.failedTxLog, null, 2));
        }

        if (this.dummyTxLog.length > 0) {
            const filePath = path.join(__dirname, `dummy_tx_worker${this.workerIndex}.json`);
            fs.writeFileSync(filePath, JSON.stringify(this.dummyTxLog, null, 2));
        }
    }
}

/* ============================================================
   🔹 EXPORT
============================================================ */
function createWorkloadModule() {
    return new TestTeaLotWorkload();
}

module.exports.createWorkloadModule = createWorkloadModule;
