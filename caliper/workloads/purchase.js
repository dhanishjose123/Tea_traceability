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

class PurchasePacketWorkload extends WorkloadModuleBase {

    constructor() {
        super();

        // 📦 Cached AVAILABLE packets
        this.availablePackets = [];
        this.packetsLoaded = 0;
        this.partitionExhausted = false;

        // 🔒 Prevent repeat attempts. Claims prevent different workers from
        // competing for the same packet while still allowing different packets
        // from the same packed lot to be purchased.
        this.usedPacketIds = new Set();
        this.claimDir = path.resolve(__dirname, '../tmp/purchase-claims');

        // 📊 Counters
        this.txAttempted = 0;
        this.txSucceeded = 0;
        this.txMVCCFailed = 0;
        this.txOtherFailed = 0;

        this._lastRoundIndex = -1;

        // 📏 Payload tracking
        this.txIndex = 0;
        this.payloadFile = './payload_sizes.csv';

        if (!fs.existsSync(this.payloadFile)) {
            fs.writeFileSync(this.payloadFile, 'function,payload_bytes,payload_kb\n');
        }

        if (!fs.existsSync(this.claimDir)) {
            fs.mkdirSync(this.claimDir, { recursive: true });
        }
    }

    resetClaimDirAtBenchmarkStart() {
        if (this.workerIndex !== 0 || this.roundIndex !== 0) {
            return;
        }

        fs.rmSync(this.claimDir, { recursive: true, force: true });
        fs.mkdirSync(this.claimDir, { recursive: true });
        console.log(`[PURCHASE][claims] Cleared claim directory ${this.claimDir}`);
    }

    async initializeWorkloadModule(workerIndex, totalWorkers, roundIndex, roundArguments, sutAdapter) {

        this.workerIndex = workerIndex;
        this.totalWorkers = totalWorkers;
        this.roundIndex = roundIndex;
        this.roundArguments = roundArguments;
        this.sutAdapter = sutAdapter;
        this.contractId = roundArguments.contractId;
        this.partitionExhausted = false;
        this.consumerCount = Math.max(1, Number(roundArguments.consumerCount) || totalWorkers || 1);
        this.retailerCount = Math.max(0, Number(roundArguments.retailerCount) || 0);
        this.retailerSelectionMode = String(roundArguments.retailerSelectionMode || 'range').toLowerCase();
        const requestedLimit = Number(roundArguments.packetQueryLimit || roundArguments.limit);
        this.packetQueryLimit = String(Number.isFinite(requestedLimit) && requestedLimit > 0 ? requestedLimit : 20);

        const consumerIndex = (workerIndex % this.consumerCount) + 1;
        this.userId = `User${consumerIndex}`;
        this.resetClaimDirAtBenchmarkStart();

        console.log(
            `✅ Worker ${this.workerIndex}: Initialized consumer ${this.userId}, consumerCount=${this.consumerCount}, retailerOwnerRange=${this.retailerCount > 0 ? `User1..User${this.retailerCount}` : 'all'}, mode=${this.retailerSelectionMode}`
        );
        const loadStartedAt = Date.now();
        const staggerDelayMs = await staggerInitialLoad(workerIndex, 'purchase');
        const queryStartedAt = Date.now();
        const cacheKey = [
            'purchase',
            this.contractId,
            roundArguments.channel || process.env.CHANNEL_NAME || 'channel',
            this.userId,
            this.retailerCount > 0 ? `retailers1-${this.retailerCount}` : 'all-retailers',
            this.retailerSelectionMode
        ];

        if (preloadCache.isReadMode()) {
            this.availablePackets = preloadCache.read(cacheKey) || [];
            this.packetsLoaded = this.availablePackets.length;
            console.log(`[LOAD_TIME][purchase][Worker ${this.workerIndex}] source=preload-cache staggerMs=${staggerDelayMs} totalMs=${Date.now() - loadStartedAt} packets=${this.availablePackets.length}`);
            return;
        }

        /* ---------------------------------
           🔹 INITIAL QUERY
        ---------------------------------- */
        const queryTx = this.createAvailablePacketQuery();

        try {

            const res = await this.sutAdapter.sendRequests(queryTx);

            if (!res?.status?.result) {
                console.log(
                    `[INIT][Worker ${this.workerIndex}] ❌ No packets returned`
                );
                return;
            }

            const allPackets = JSON.parse(res.status.result.toString());

            this.availablePackets = this.partitionPackets(
                (Array.isArray(allPackets) ? allPackets : (allPackets.data || []))
                    .filter(p => p.status === 'AVAILABLE')
                    .filter(p => this.isAllowedRetailerOwner(p.owner))
            );
            this.packetsLoaded = this.availablePackets.length;
            if (preloadCache.isWriteMode()) {
                preloadCache.write(cacheKey, this.availablePackets);
            }

            console.log(
                `[INIT][Worker ${this.workerIndex}] 📦 Cached ${this.availablePackets.length} AVAILABLE packets`
            );
            console.log(`[LOAD_TIME][purchase][Worker ${this.workerIndex}] staggerMs=${staggerDelayMs} queryMs=${Date.now() - queryStartedAt} totalMs=${Date.now() - loadStartedAt} packets=${this.availablePackets.length}`);

        } catch (err) {
            console.error(
                `[INIT][Worker ${this.workerIndex}] ❌ Failed to load packets`,
                err.message || err
            );
            console.log(`[LOAD_TIME][purchase][Worker ${this.workerIndex}] staggerMs=${staggerDelayMs} queryMs=${Date.now() - queryStartedAt} totalMs=${Date.now() - loadStartedAt} packets=0 failed=true`);
        }
    }

    async submitTransaction() {
        if (preloadCache.isPreloadOnly()) {
            return;
        }

        /* ---------------------------------
           📊 Round logging
        ---------------------------------- */
        if (this.roundIndex !== this._lastRoundIndex) {
            this._lastRoundIndex = this.roundIndex;

            console.log(
                `📊 [PurchasePacket][Worker ${this.workerIndex}] ` +
                `Attempts=${this.txAttempted}, Success=${this.txSucceeded}, ` +
                `MVCC=${this.txMVCCFailed}, OtherFail=${this.txOtherFailed}`
            );
        }

        /* ---------------------------------
           1️⃣ Pick from cached batch, then verify availability
        ---------------------------------- */
        const packet = await this.pickPacketFromBatch();

        if (!packet || !packet.packetId) {
            return;
        }

        const packetId = packet.packetId;

        this.usedPacketIds.add(packetId);
        this.availablePackets = this.availablePackets.filter(candidate => candidate.packetId !== packetId);

        /* ---------------------------------
           2️⃣ Prepare transaction
        ---------------------------------- */
        const args = [
            packetId,
            this.userId
        ];

        const purchaseTx = {
            contractId: this.contractId,
            contractFunction: 'purchasePacket',
            invokerIdentity: this.userId,
            contractArguments: args,
            readOnly: false
        };

        /* ---------------------------------

        /* ---------------------------------
           📏 PAYLOAD MEASUREMENT
        ---------------------------------- */
        const payloadString = JSON.stringify(args);
        const payloadBytes = Buffer.byteLength(payloadString, 'utf8');
        const payloadKB = payloadBytes / 1024;

        if (this.txIndex < 50) {
            fs.appendFileSync(
                this.payloadFile,
                `purchasePacket,${payloadBytes},${payloadKB.toFixed(4)}\n`
            );
        }

        this.txIndex++;

        /* ---------------------------------
           🚀 Execute transaction
        ---------------------------------- */
        this.txAttempted++;
        const retailerId = packet.retailerId || packet.owner || packet.currentOwner || 'unknown';
        console.log(
            `[PURCHASE][attempt] Worker=${this.workerIndex} Consumer=${this.userId} ` +
            `Retailer=${retailerId} Packet=${packetId}`
        );

        try {

            const response = await this.sutAdapter.sendRequests(purchaseTx);
            this.assertTransactionSucceeded(response);

            this.txSucceeded++;
            console.log(
                `[PURCHASE][success] Worker=${this.workerIndex} Consumer=${this.userId} ` +
                `Retailer=${retailerId} Packet=${packetId}`
            );

        } catch (err) {

            const msg = err?.message || '';

            if (
                msg.includes('MVCC') ||
                msg.includes('PHANTOM') ||
                msg.includes('CONFLICT')
            ) {
                this.txMVCCFailed++;
            } else {
                this.txOtherFailed++;
            }

            console.error(
                `[PURCHASE][failure] Worker=${this.workerIndex} Consumer=${this.userId} ` +
                `Retailer=${retailerId} Packet=${packetId} Error=${msg.replace(/\s+/g, ' ').trim() || 'unknown'}`
            );
        }

        /* ---------------------------------
           📊 Periodic stats
        ---------------------------------- */
        if (this.txAttempted % 10 === 0) {

            console.log(
                `📊 [PurchasePacket][Worker ${this.workerIndex}] ` +
                `Attempts=${this.txAttempted}, Success=${this.txSucceeded}, ` +
                `MVCC=${this.txMVCCFailed}, OtherFail=${this.txOtherFailed}`
            );
        }
    }

    async pickPacketFromBatch() {
        while (this.availablePackets.length > 0) {
            const candidate = this.availablePackets.shift();

            if (
                candidate?.status === 'AVAILABLE' &&
                candidate.packetId &&
                !this.usedPacketIds.has(candidate.packetId) &&
                this.claimPacket(candidate.packetId)
            ) {
                return candidate;
            }
        }

        this.partitionExhausted = true;
        return null;
    }

    partitionPackets(packets) {
        return packets.filter((packet, index) =>
            packet?.packetId &&
            packet.status === 'AVAILABLE' &&
            this.isAllowedRetailerOwner(packet.owner) &&
            !this.usedPacketIds.has(packet.packetId) &&
            (
                this.retailerSelectionMode === 'paired' ||
                (index % this.totalWorkers) === this.workerIndex
            )
        );
    }

    getLotIdFromPacket(packet) {
        const packetId = String(packet?.packetId || '');
        if (packet?.lotId) {
            return String(packet.lotId);
        }

        const packetSuffix = packetId.match(/^(.*)-PKT-\d+$/);
        return packetSuffix ? packetSuffix[1] : '';
    }

    isAllowedRetailerOwner(ownerId) {
        if (this.retailerSelectionMode === 'paired') {
            return ownerId === this.userId;
        }

        if (this.retailerCount <= 0) {
            return true;
        }

        const match = String(ownerId || '').match(/^User(\d+)$/i);
        return Boolean(match) && Number(match[1]) >= 1 && Number(match[1]) <= this.retailerCount;
    }

    claimPacket(packetId) {
        const safePacketId = String(packetId).replace(/[^a-zA-Z0-9_.-]/g, '_');
        const claimPath = path.join(this.claimDir, `${safePacketId}.claim`);

        try {
            const fd = fs.openSync(claimPath, 'wx');
            fs.writeFileSync(fd, `worker=${this.workerIndex}\ntime=${new Date().toISOString()}\npacketId=${packetId}\n`);
            fs.closeSync(fd);
            return true;
        } catch (error) {
            if (error.code === 'EEXIST') {
                return false;
            }
            throw error;
        }
    }

    assertTransactionSucceeded(response) {
        const responses = Array.isArray(response) ? response : [response];
        const failed = responses.find(item => {
            const status = item?.status?.status ?? item?.status;
            return String(status || '').toLowerCase() === 'failed';
        });

        if (failed) {
            const message = failed?.status?.error_messages?.join('; ') ||
                failed?.status?.result ||
                'Caliper returned a failed transaction status';
            throw new Error(String(message));
        }
    }

    async refreshAvailablePackets() {
        if (preloadCache.isReadMode()) {
            this.availablePackets = [];
            this.partitionExhausted = true;
            return;
        }

        const queryTx = this.createAvailablePacketQuery();

        try {
            const res = await this.sutAdapter.sendRequests(queryTx);
            if (!res?.status?.result) {
                this.availablePackets = [];
                return;
            }

            const packets = JSON.parse(res.status.result.toString());
            this.availablePackets = this.partitionPackets(
                (Array.isArray(packets) ? packets : (packets.data || []))
                    .filter(packet => packet.status === 'AVAILABLE')
            );
            this.partitionExhausted = this.availablePackets.length === 0;

        } catch (err) {
            console.error(`[QUERY][Worker ${this.workerIndex}] Failed to refresh available packets`, err.message || err);
            this.availablePackets = [];
            this.partitionExhausted = true;
        }
    }

    async isPacketStillAvailable(packetId) {
        const queryTx = this.createAvailablePacketQuery();

        try {
            const res = await this.sutAdapter.sendRequests(queryTx);
            if (!res?.status?.result) {
                return false;
            }

            const packets = JSON.parse(res.status.result.toString());
            const availablePackets = Array.isArray(packets) ? packets : (packets.data || []);
            return availablePackets.some(packet => packet.packetId === packetId && packet.status === 'AVAILABLE');
        } catch (err) {
            console.error(`[CHECK][Worker ${this.workerIndex}] Failed to check packet ${packetId}`, err.message || err);
            return false;
        }
    }

    createAvailablePacketQuery() {
        const queryLimit = preloadCache.isWriteMode() ? '3000' : this.packetQueryLimit;

        if (this.retailerSelectionMode === 'paired') {
            return {
                contractId: this.contractId,
                contractFunction: 'getAllPacketsByRetailer',
                contractArguments: [this.userId, 'AVAILABLE', queryLimit],
                readOnly: true
            };
        }

        if (this.retailerCount > 0) {
            return {
                contractId: this.contractId,
                contractFunction: 'getAllPacketsByRetailerRange',
                contractArguments: ['User1', `User${this.retailerCount}`, 'AVAILABLE', queryLimit],
                readOnly: true
            };
        }

        return {
            contractId: this.contractId,
            contractFunction: 'getAllPackets',
            contractArguments: ['AVAILABLE', queryLimit],
            readOnly: true
        };
    }

    async cleanupWorkloadModule() {
        const dummy = this.dummyTxCount || 0;
        const total = this.txAttempted || this.txCounter || this.txIndex || this.txSucceeded || 0;
        const dummyRatio = total > 0 ? ((dummy / total) * 100).toFixed(2) : '0.00';

        console.log(`
==============================
📊 Worker ${this.workerIndex} Dummy Summary
------------------------------
Dummy TX           : ${dummy}
Dummy Ratio        : ${dummyRatio}%
Packets Loaded     : ${this.packetsLoaded}
==============================
`);
    }

}

module.exports.createWorkloadModule = () => new PurchasePacketWorkload();
