'use strict';

const { WorkloadModuleBase } = require('@hyperledger/caliper-core');
const fs = require('fs');
const path = require('path');
const preloadCache = require('./preload-cache');

class MakeOfferAllWorkload extends WorkloadModuleBase {

    constructor() {
        super();

        this.availableLots = []; // âœ… only unused lots

        this.txSeq = 0;
        this.txAttempted = 0;
        this.txSucceeded = 0;
        this.txPhantomFailed = 0;
        this.txOtherFailed = 0;
        this.currentIndex = 0;
        this.dummyTxCount = 0;
        this.usedLotIds = new Set();
        this.retailerCount = 9;
        this.minRetailerIndex = 20;
        this.allowedRetailerIndexes = [20, 24];
        this.lotQueryLimit = '20';
        this.farmerCount = 0;
        this.farmerStartIndex = 1;
        this.retailerStartIndex = 1;
        this.farmerUserId = '';
        this.retailerSelectionMode = 'random';
        this.claimDir = path.resolve(__dirname, '../tmp/makeofferall-claims');

        if (!fs.existsSync(this.claimDir)) {
            fs.mkdirSync(this.claimDir, { recursive: true });
        }
    }

    async initializeWorkloadModule(workerIndex, totalWorkers, roundIndex, roundArguments, sutAdapter) {

        this.workerIndex = workerIndex;
        this.roundIndex = roundIndex;
        this.sutAdapter = sutAdapter;
        this.contractId = roundArguments.contractId;
        this.farmerCount = Math.max(0, Number(roundArguments.farmerCount) || 0);
        this.retailerCount = Math.max(1, Number(roundArguments.retailerCount) || 9);
        this.farmerStartIndex = Math.max(1, Number(roundArguments.farmerStartIndex) || 1);
        this.retailerStartIndex = Math.max(1, Number(roundArguments.retailerStartIndex) || 1);
        this.retailerSelectionMode = String(roundArguments.retailerSelectionMode || process.env.MAKEOFFERALL_RETAILER_SELECTION_MODE || 'random').toLowerCase();
        const maxRetailerIndex = this.retailerStartIndex + this.retailerCount - 1;
        this.minRetailerIndex = Math.max(1, Number(roundArguments.minRetailerIndex) || this.retailerStartIndex);
        const allowedString = roundArguments.allowedRetailerIndexes || process.env.MAKEOFFERALL_ALLOWED_RETAILERS;

        if (allowedString) {
            this.allowedRetailerIndexes = String(allowedString)
                .split(',')
                .map(value => Number(value.trim()))
                .filter(value => Number.isInteger(value) && value >= this.retailerStartIndex && value <= maxRetailerIndex);
        } else {
            // Default to all retailers in the current range
            this.allowedRetailerIndexes = Array.from(
                { length: this.retailerCount }, 
                (_, i) => this.retailerStartIndex + i
            );
        }

        if (this.allowedRetailerIndexes.length === 0) {
            this.allowedRetailerIndexes = [Math.min(this.minRetailerIndex, maxRetailerIndex)];
        }

        this.lotQueryLimit = String(Number(roundArguments.limit || roundArguments.lotQueryLimit) || 20);
        this.farmerUserId = this.farmerCount > 0
            ? `User${this.farmerStartIndex + (workerIndex % this.farmerCount)}`
            : '';

        console.log(`Worker ${workerIndex} initialized, farmer=${this.farmerUserId || 'all'}, retailerMode=${this.retailerSelectionMode}, retailers=${this.allowedRetailerIndexes.map(index => `User${index}`).join(',')}`);

        /* ---------------------------------
           🔹 Fetch APPROVED lots WITHOUT offers
        ---------------------------------- */
        const cacheKey = [
            'makeofferall',
            this.contractId,
            this.farmerUserId || 'all',
            this.lotQueryLimit
        ];

        if (preloadCache.isReadMode()) {
            this.availableLots = preloadCache.read(cacheKey) || [];
            console.log(`[MakeOfferAll][Worker ${this.workerIndex}] LOADED FROM CACHE: ${this.availableLots.length} lots`);
            return;
        }

        const lotQuery = {
            contractId: this.contractId,
            contractFunction: 'getApprovedLotsWithoutOffers',
            contractArguments: [this.farmerUserId, this.lotQueryLimit],
            readOnly: true
        };

        try {
            const response = await this.sutAdapter.sendRequests(lotQuery);

            const resultBuffer =
                response?.status?.result ||
                response?.status?.payload ||
                response?.[0]?.status?.result ||
                response?.[0]?.status?.payload;

            const resultString = resultBuffer?.toString() || '';

            if (!resultString) {
                console.warn(`⚠️  Worker ${this.workerIndex}: Empty response`);
                return;
            }

            const allLots = JSON.parse(resultString);

            // ✅ Direct assignment (already filtered)
            this.availableLots = [...allLots];

            if (preloadCache.isWriteMode()) {
                preloadCache.write(cacheKey, this.availableLots);
            }

            console.log(
                `[INIT][Worker ${this.workerIndex}] 📦 Loaded ${this.availableLots.length} lots for ${this.farmerUserId || 'all farmers'}`
            );

        } catch (err) {
            console.error(`[INIT] Worker ${this.workerIndex} failed`, err.message);
        }
    }

    async getHighestOffer(lotId) {
        try {
            const highestOfferTx = {
                contractId: this.contractId,
                contractFunction: 'getHighestOfferForLot',
                contractArguments: [lotId],
                readOnly: true
            };

            const res = await this.sutAdapter.sendRequests(highestOfferTx);
            const resultBuffer =
                res?.status?.result ||
                res?.status?.payload ||
                res?.[0]?.status?.result ||
                res?.[0]?.status?.payload;

            if (!resultBuffer) {
                return 0;
            }

            const parsed = JSON.parse(resultBuffer.toString());
            return Number(parsed.highestOffer?.offerPrice || parsed.offerPrice || 0);
        } catch {
            return 0;
        }
    }

    getClaimPath(lotId) {
        const safeLotId = String(lotId).replace(/[^a-zA-Z0-9_.-]/g, '_');
        return path.join(this.claimDir, `${safeLotId}.claim`);
    }

    claimLot(lotId) {
        const claimPath = this.getClaimPath(lotId);

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

    releaseLotClaim(lotId) {
        try {
            fs.unlinkSync(this.getClaimPath(lotId));
        } catch (error) {
            if (error.code !== 'ENOENT') {
                console.warn(`Unable to release claim for ${lotId}: ${error.message}`);
            }
        }
    }

    getRandomRetailerId() {
        const retailerIndex = this.allowedRetailerIndexes[
            Math.floor(Math.random() * this.allowedRetailerIndexes.length)
        ];
        return `User${retailerIndex}`;
    }

    getRetailerIdForCurrentFarmer() {
        if (this.retailerSelectionMode !== 'paired' && this.retailerSelectionMode !== 'matching') {
            return this.getRandomRetailerId();
        }

        const farmerMatch = String(this.farmerUserId || '').match(/^User(\d+)$/i);
        const farmerIndex = farmerMatch ? Number(farmerMatch[1]) : NaN;

        if (this.allowedRetailerIndexes.includes(farmerIndex)) {
            return `User${farmerIndex}`;
        }

        return this.getRandomRetailerId();
    }

    async submitTransaction() {

        if (preloadCache.isPreloadOnly()) {
            return;
        }

        if (this.availableLots.length === 0) {
            console.log(`No available lots for worker ${this.workerIndex}`);
            return;
        }

        let lot = null;
        for (let attempt = 0; attempt < this.availableLots.length; attempt++) {
            const candidate = this.availableLots[this.currentIndex];
            this.currentIndex++;

            if (this.currentIndex >= this.availableLots.length) {
                this.currentIndex = 0;
            }

            if (!candidate?.lotId || this.usedLotIds.has(candidate.lotId)) {
                continue;
            }

            if (!this.claimLot(candidate.lotId)) {
                continue;
            }

            lot = candidate;
            break;
        }

        if (!lot?.lotId) {
            console.log(`No unbid lots left for worker ${this.workerIndex}`);
            return;
        }

        const lotId = lot.lotId;
        this.usedLotIds.add(lotId);

        /* ---------------------------------
        2ï¸âƒ£ Generate offer
        ---------------------------------- */
        const highestOffer = await this.getHighestOffer(lotId);
        const increment = Math.floor(Math.random() * 100 + 50);
        const workerFloor = 1000 + (this.workerIndex * 100) + this.txSeq;
        const offerPrice = Math.max(highestOffer + increment, workerFloor);
        const retailerUserId = this.getRetailerIdForCurrentFarmer();

        const tx = {
            contractId: this.contractId,
            contractFunction: 'makeOffer',
            invokerIdentity: retailerUserId,
            contractArguments: [
                lotId,
                retailerUserId,
                offerPrice.toString()
            ],
            readOnly: false
        };

        this.txAttempted++;
        this.txSeq++;

        try {
            await this.sutAdapter.sendRequests(tx);
            this.txSucceeded++;

            console.log(
                `Offer worker ${this.workerIndex} -> ${retailerUserId} bid ${offerPrice} on ${lotId}`
            );

        } catch (err) {

            const msg = err?.message || '';
            this.usedLotIds.delete(lotId);
            this.releaseLotClaim(lotId);

            if (msg.includes('MVCC') || msg.includes('PHANTOM')) {
                this.txPhantomFailed++;
            } else {
                this.txOtherFailed++;
            }

            console.log(
                `âŒ [FAIL] Worker ${this.workerIndex} | ${msg}`
            );
        }

        /* ---------------------------------
        ðŸ“Š Stats
        ---------------------------------- */
        
    }


    async cleanupWorkloadModule() {

    const successRate = this.txAttempted > 0
        ? ((this.txSucceeded / this.txAttempted) * 100).toFixed(2)
        : 0;

    const dummyRatio = this.txAttempted > 0
        ? ((this.dummyTxCount / this.txAttempted) * 100).toFixed(2)
        : 0;

    console.log('\n================ FINAL STATS ================');
    console.log(`ðŸ‘¤ Worker ${this.workerIndex}`);
    console.log(`Total TX Attempted : ${this.txAttempted}`);
    console.log(`Successful TX      : ${this.txSucceeded}`);
    console.log(`Dummy TX           : ${this.dummyTxCount}`);
    console.log(`MVCC Failures      : ${this.txPhantomFailed}`);
    console.log(`Other Failures     : ${this.txOtherFailed}`);
    console.log(`Success Rate       : ${successRate}%`);
    console.log(`Dummy Ratio        : ${dummyRatio}%`);
    console.log('============================================\n');
    }




}

module.exports.createWorkloadModule = () => new MakeOfferAllWorkload();
