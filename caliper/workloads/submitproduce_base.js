'use strict';

const { WorkloadModuleBase } = require('@hyperledger/caliper-core');
const fs = require('fs');
const crypto = require('crypto');

if (!process.__submitProduceUnhandledRejectionHandler) {
    process.__submitProduceUnhandledRejectionHandler = true;
    process.on('unhandledRejection', reason => {
        const message = reason?.message || String(reason);
        const code = reason?.transactionCode || '';

        if (
            code === 'MVCC_READ_CONFLICT' ||
            message.includes('MVCC_READ_CONFLICT') ||
            message.includes('No successful events received') ||
            message.includes('Event service timed out') ||
            message.includes('Unable to start listening')
        ) {
            console.warn(`[SubmitProduce] Ignored unhandled Fabric event rejection: ${message}`);
            return;
        }

        throw reason;
    });
}

class SubmitProduceWorkload extends WorkloadModuleBase {

    constructor(aggregatorCount = 5, farmerCount = 5) {
        super();

        this.aggregatorCount = Math.max(1, Number(aggregatorCount) || 5);
        this.farmerCount = Math.max(1, Number(farmerCount) || 5);
        this.farmerStartIndex = 1;
        this.aggregatorStartIndex = 1;
        this.aggregatorSelectionMode = 'random';
        this.txCounter = 0;
        this.dummyTxCount = 0;
        this.successTxCount = 0;
        this.failedTxCount = 0;
        this.submittedByAggregator = {};
        this.maxTransactions = 0;
        this.payloadFile = './payload_sizes.csv';

        if (!fs.existsSync(this.payloadFile)) {
            fs.writeFileSync(this.payloadFile, 'function,payload_bytes,payload_kb\n');
        }
    }

    async initializeWorkloadModule(workerIndex, totalWorkers, roundIndex, roundArguments, sutAdapter) {
        this.workerIndex = workerIndex;
        this.totalWorkers = totalWorkers;
        this.sutAdapter = sutAdapter;
        this.contractId = roundArguments.contractId;
        this.contractFunction = roundArguments.contractFunction || 'submitProduce';

        if (roundArguments.aggregatorCount !== undefined) {
            this.aggregatorCount = Math.max(1, Number(roundArguments.aggregatorCount) || this.aggregatorCount);
        }
        if (roundArguments.farmerCount !== undefined) {
            this.farmerCount = Math.max(1, Number(roundArguments.farmerCount) || this.farmerCount);
        }
        if (roundArguments.farmerStartIndex !== undefined) {
            this.farmerStartIndex = Math.max(1, Number(roundArguments.farmerStartIndex) || this.farmerStartIndex);
        }
        if (roundArguments.aggregatorStartIndex !== undefined) {
            this.aggregatorStartIndex = Math.max(1, Number(roundArguments.aggregatorStartIndex) || this.aggregatorStartIndex);
        }
        this.aggregatorSelectionMode = String(roundArguments.aggregatorSelectionMode || process.env.SUBMITPRODUCE_AGGREGATOR_SELECTION_MODE || 'random').toLowerCase();
        this.maxTransactions = Math.max(0, Number(roundArguments.maxTransactions || roundArguments.lotQueryLimit || roundArguments.limit || 0));

        this.userId = this.getFarmerId();
        this.invokerIdentity = this.userId;

        const aggregatorEndIndex = this.aggregatorStartIndex + this.aggregatorCount - 1;
        console.log(`Worker ${workerIndex} initialized as ${this.userId}, aggregatorMode=${this.aggregatorSelectionMode}, aggregators=User${this.aggregatorStartIndex}..User${aggregatorEndIndex}`);
    }

    getFarmerId() {
        const farmerIndex = this.farmerStartIndex + (this.workerIndex % this.farmerCount);
        return `User${farmerIndex}`;
    }

    getAggregatorId() {
        if (this.aggregatorSelectionMode === 'paired' || this.aggregatorSelectionMode === 'matching') {
            const farmerMatch = String(this.userId || '').match(/^User(\d+)$/i);
            const farmerIndex = farmerMatch ? Number(farmerMatch[1]) : NaN;
            const aggregatorEndIndex = this.aggregatorStartIndex + this.aggregatorCount - 1;

            if (farmerIndex >= this.aggregatorStartIndex && farmerIndex <= aggregatorEndIndex) {
                return `User${farmerIndex}`;
            }
        }

        const aggregatorIndex = crypto.randomInt(
            this.aggregatorStartIndex,
            this.aggregatorStartIndex + this.aggregatorCount
        );
        return `User${aggregatorIndex}`;
    }

    async submitTransaction() {
        if (this.maxTransactions > 0 && this.txCounter >= this.maxTransactions) {
            return;
        }

        const lotId = `LOT-${this.workerIndex}-${this.txCounter}-${Date.now()}`;
        const farmerId = this.userId;
        const aggregatorId = this.getAggregatorId();

        const args = [
            lotId,
            farmerId,
            '10',
            '2025-07-21',
            '1',
            aggregatorId
        ];

        const request = {
            contractId: this.contractId,
            contractFunction: this.contractFunction,
            invokerIdentity: this.invokerIdentity,
            contractArguments: args,
            readOnly: false
        };

        const payloadString = JSON.stringify(args);
        const payloadBytes = Buffer.byteLength(payloadString, 'utf8');
        const payloadKB = payloadBytes / 1024;

        fs.appendFileSync(
            this.payloadFile,
            `${this.contractFunction}_f${this.farmerCount}_a${this.aggregatorCount},${payloadBytes},${payloadKB.toFixed(4)}\n`
        );

        try {
            await this.sutAdapter.sendRequests(request);
            this.successTxCount++;
            this.submittedByAggregator[aggregatorId] = (this.submittedByAggregator[aggregatorId] || 0) + 1;
        } catch (error) {
            // Keep Caliper running; failures are captured in the benchmark report.
            this.failedTxCount++;
        }

        this.txCounter++;
    }

    async cleanupWorkloadModule() {
        const aggregatorSummary = Array.from({ length: this.aggregatorCount }, (_, index) => {
            const aggregatorId = `User${this.aggregatorStartIndex + index}`;
            return `${aggregatorId}: ${this.submittedByAggregator[aggregatorId] || 0}`;
        }).join(', ');

        console.log(`Dummy TX           : ${this.dummyTxCount || 0}\nDummy Ratio        : 0.00%`);

        console.log(`
==============================
SubmitProduce Worker ${this.workerIndex} Summary
------------------------------
User: ${this.userId}
Farmer Count: ${this.farmerCount}
Aggregator Count: ${this.aggregatorCount}
Farmer Range: User${this.farmerStartIndex}..User${this.farmerStartIndex + this.farmerCount - 1}
Aggregator Range: User${this.aggregatorStartIndex}..User${this.aggregatorStartIndex + this.aggregatorCount - 1}
	Selection Mode: One farmer per worker, ${this.aggregatorSelectionMode} aggregator per transaction
Contract Function: ${this.contractFunction}
Total Transactions: ${this.txCounter}
Successful Transactions: ${this.successTxCount}
Failed Transactions: ${this.failedTxCount}
Submitted Lots By Aggregator: ${aggregatorSummary}
==============================
	`);
    }
}

function createSubmitProduceWorkload(aggregatorCount, farmerCount) {
    return new SubmitProduceWorkload(aggregatorCount, farmerCount);
}

module.exports = {
    SubmitProduceWorkload,
    createSubmitProduceWorkload
};
