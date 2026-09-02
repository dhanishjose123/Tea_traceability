'use strict';

const { WorkloadModuleBase } = require('@hyperledger/caliper-core');

class GetAllPacketsWorkload extends WorkloadModuleBase {

    async initializeWorkloadModule(workerIndex, totalWorkers, roundIndex, roundArguments, sutAdapter) {

        this.workerIndex = workerIndex;
        this.roundIndex = roundIndex;
        this.sutAdapter = sutAdapter;
        this.contractId = roundArguments.contractId;

        this.invokerIdentity = `_ConsumersMSP_User${workerIndex + 1}`;

        // Payload control parameter from benchmark config
        this.limit = roundArguments.limit ;

        console.log(
            `📦 Worker ${this.workerIndex}: Initialized with payloadLimit = ${this.limit}`
        );
    }

    async submitTransaction() {

        const tx = {
            contractId: this.contractId,
            contractFunction: 'getAllPackets1',
            invokerIdentity: this.invokerIdentity,
            contractArguments: [this.limit],   // PAYLOAD ARGUMENT
            readOnly: true
        };

        try {

            const res = await this.sutAdapter.sendRequests(tx);

            const resultBuffer =
                res?.status?.result || res?.status?.payload;

            if (!resultBuffer) {
                console.log(
                    `⚠️ Worker ${this.workerIndex}: getAllPackets returned empty result`
                );
                return;
            }

            const payloadSizeBytes = Buffer.byteLength(resultBuffer);
            const payloadSizeKB = (payloadSizeBytes / 1024).toFixed(2);

            const packets = JSON.parse(resultBuffer.toString());

            console.log(
                `📦 Worker ${this.workerIndex}: ${packets.length} packets | Payload = ${payloadSizeKB} KB`
            );

        } catch (err) {

            console.error(
                `❌ Worker ${this.workerIndex}: Error calling getAllPackets`,
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

module.exports.createWorkloadModule = () => new GetAllPacketsWorkload();