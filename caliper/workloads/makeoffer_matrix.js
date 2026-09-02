'use strict';

const { WorkloadModuleBase } = require('@hyperledger/caliper-core');
const fs = require('fs');
const preloadCache = require('./preload-cache');

class MakeOfferMatrixWorkload extends WorkloadModuleBase {
    constructor() {
        super();
        this.contractId = '';
        this.lots = [];
        this.retailerCount = 1;
        this.lotCount = 5;
        this.retailerId = 'User1';
        this.txAttempted = 0;
        this.txSucceeded = 0;
        this.txFailed = 0;
        this.txMVCCFailed = 0;
        this.payloadFile = './payload_sizes.csv';

        if (!fs.existsSync(this.payloadFile)) {
            fs.writeFileSync(this.payloadFile, 'function,payload_bytes,payload_kb\n');
        }
    }

    async initializeWorkloadModule(workerIndex, totalWorkers, roundIndex, roundArguments, sutAdapter) {
        this.workerIndex = workerIndex;
        this.roundIndex = roundIndex;
        this.sutAdapter = sutAdapter;
        this.contractId = roundArguments.contractId;
        this.retailerCount = Math.max(1, Number(roundArguments.retailerCount) || 1);
        this.lotCount = Math.max(1, Number(roundArguments.lotCount) || 5);
        const retailerIndex = (workerIndex % this.retailerCount) + 1;
        this.retailerId = `User${retailerIndex}`;
        this.lots = [];

        const cacheKey = [
            'makeoffer_matrix',
            process.env.CHANNEL_NAME || 'unknown-channel',
            this.contractId,
            `r${this.retailerCount}`,
            `lots${this.lotCount}`
        ];

        if (preloadCache.isReadMode()) {
            const cachedLots = preloadCache.read(cacheKey);
            this.lots = cachedLots && cachedLots.length > 0 ? cachedLots.slice(0, this.lotCount) : [];
            const lotIds = this.lots.map(l => l.lotId).join(', ');
            console.log(`[MakeOfferMatrix][Worker ${workerIndex}] LOADED FROM CACHE: ${lotIds || 'none'}`);
            return;
        }

        const queryTx = {
            contractId: this.contractId,
            contractFunction: 'getProduceByStatusAndOwner',
            contractArguments: ['APPROVED', 'User2', String(this.lotCount)], // Load approved lots even if they already have offers
            readOnly: true
        };

        try {
            const response = await this.sutAdapter.sendRequests(queryTx);
            const resultBuffer =
                response?.status?.result ||
                response?.status?.payload ||
                response?.[0]?.status?.result ||
                response?.[0]?.status?.payload;

            const parsedLots = resultBuffer ? JSON.parse(resultBuffer.toString()) : [];
            const lots = Array.isArray(parsedLots) ? parsedLots : (parsedLots.data || []);
            this.lots = Array.isArray(lots) ? lots.slice(0, this.lotCount) : [];

            if (preloadCache.isWriteMode()) {
                preloadCache.write(cacheKey, this.lots);
            }

            console.log(
                `[MakeOfferMatrix][Worker ${workerIndex}] retailerCount=${this.retailerCount}, ` +
                `retailer=${this.retailerId}, ` +
                `loadedLots=${this.lots.length} (from CouchDB)`
            );
        } catch (err) {
            console.error(`[MakeOfferMatrix][Worker ${workerIndex}] failed to load lots: ${err.message}`);
            this.lots = [];
        }
    }

    async getHighestOffer(lotId) {
        try {
            const tx = {
                contractId: this.contractId,
                contractFunction: 'getHighestOfferForLot',
                contractArguments: [lotId],
                readOnly: true
            };

            const response = await this.sutAdapter.sendRequests(tx);
            const resultBuffer =
                response?.status?.result ||
                response?.status?.payload ||
                response?.[0]?.status?.result ||
                response?.[0]?.status?.payload;

            if (!resultBuffer) {
                return 0;
            }

            const parsed = JSON.parse(resultBuffer.toString());
            return Number(parsed.highestOffer?.offerPrice || parsed.offerPrice || 0);
        } catch {
            return 0;
        }
    }

    async submitTransaction() {
        if (!this.lots || this.lots.length === 0) {
            return;
        }

        const randomIndex = Math.floor(Math.random() * this.lots.length);
        const currentLot = this.lots[randomIndex];
        const retailerId = this.retailerId;
        const retailerNumber = Number(retailerId.replace('User', '')) || 1;
        const highestOffer = await this.getHighestOffer(currentLot.lotId);
        const offerPrice = highestOffer === 0 ? 100 : highestOffer + 5;
        const args = [currentLot.lotId, retailerId, offerPrice.toString()];

        const tx = {
            contractId: this.contractId,
            contractFunction: 'makeOffer',
            invokerIdentity: retailerId,
            contractArguments: args,
            readOnly: false
        };

        const payloadBytes = Buffer.byteLength(JSON.stringify(args), 'utf8');
        fs.appendFileSync(
            this.payloadFile,
            `makeoffer_r${this.retailerCount},${payloadBytes},${(payloadBytes / 1024).toFixed(4)}\n`
        );

        this.txAttempted++;

        try {
            await this.sutAdapter.sendRequests(tx);
            this.txSucceeded++;
            console.log(`[MakeOfferMatrix] ${retailerId} bid ${offerPrice} on ${currentLot.lotId}`);
        } catch (err) {
            this.txFailed++;
            const msg = err?.message || '';
            if (msg.includes('MVCC') || msg.includes('PHANTOM') || msg.includes('CONFLICT')) {
                this.txMVCCFailed++;
            }
            console.log(`[MakeOfferMatrix] ${retailerId} failed on ${currentLot.lotId}: ${msg}`);
        }
    }

    async cleanupWorkloadModule() {
        console.log(`
================ MakeOffer Matrix Summary ================
Worker          : ${this.workerIndex}
Lot             : ${this.lot?.lotId || 'none'}
Retailer Count  : ${this.retailerCount}
Retailer        : ${this.retailerId}
Attempted       : ${this.txAttempted}
Success         : ${this.txSucceeded}
Failed          : ${this.txFailed}
MVCC Failed     : ${this.txMVCCFailed}
Dummy TX        : 0
==========================================================
`);
    }
}

module.exports.createWorkloadModule = () => new MakeOfferMatrixWorkload();
