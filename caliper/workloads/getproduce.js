'use strict';

const { WorkloadModuleBase } = require('@hyperledger/caliper-core');

class GetAllProduceWorkload extends WorkloadModuleBase {

    async initializeWorkloadModule(workerIndex, totalWorkers, roundIndex, roundArguments, sutAdapter) {
        this.workerIndex = workerIndex;
        this.sutAdapter = sutAdapter;
        this.contractId = roundArguments.contractId;

        // 🔥 safe init
        this.roundArguments = roundArguments || {};

        // Read-only identity
        this.invokerIdentity = `_AggregatorsMSP_User${workerIndex + 1}`;

        // 🔥 safe + string
        this.limit = (this.roundArguments.limit || 10000).toString();

        console.log(
            `✅ Worker ${this.workerIndex}: Initialized getAllProduce workload (limit=${this.limit})`
        );
    }

    async submitTransaction() {

        const tx = {
            contractId: this.contractId,
            contractFunction: 'getAllProduce',
            contractArguments: [this.limit],
            invokerIdentity: this.invokerIdentity,
            readOnly: true
        };

        try {

            const res = await this.sutAdapter.sendRequests(tx);

            const resultBuffer =
                res?.status?.result || res?.status?.payload;

            if (!resultBuffer) return;

            const payloadSizeBytes = Buffer.byteLength(resultBuffer);
            const payloadSizeKB = (payloadSizeBytes / 1024).toFixed(2);

            const lots = JSON.parse(resultBuffer.toString());

            console.log(
                `📦 Worker ${this.workerIndex}: ${lots.length} lots | Payload = ${payloadSizeKB} KB`
            );

        } catch (err) {

            console.error(
                `❌ Worker ${this.workerIndex}: Error calling getAllProduce`,
                err.message
            );
        }
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
==============================
`);
    }

}

function createWorkloadModule() {
    return new GetAllProduceWorkload();
}

module.exports.createWorkloadModule = createWorkloadModule;