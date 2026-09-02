'use strict';

const { WorkloadModuleBase } = require('@hyperledger/caliper-core');
const fs = require('fs');

class GetPacketHistoryWorkload extends WorkloadModuleBase {

    constructor() {
        super();

        this.availablePackets = [];

        // 📏 Payload tracking (RESPONSE payload)
        this.txIndex = 0;
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

        this.consumerUserId = `User${workerIndex + 1}`;
        this.invokerIdentity = `_ConsumersMSP_User${workerIndex + 1}`;

        console.log(
            `✅ Worker ${this.workerIndex}: Initialized consumer ${this.consumerUserId}`
        );

        /* ---------------------------------
           🔹 INITIAL QUERY
        ---------------------------------- */
        const queryTx = {
            contractId: this.contractId,
            contractFunction: 'getAllPackets1',
            contractArguments: ['1000'],
            readOnly: true
        };

        try {

            const res = await this.sutAdapter.sendRequests(queryTx);

            const resultBuffer =
                res?.status?.result || res?.status?.payload;

            if (!resultBuffer) {
                console.log(`⚠️ Worker ${this.workerIndex}: No packets returned`);
                return;
            }

            let packets;

            try {

                const parsed = JSON.parse(resultBuffer.toString());

                if (Array.isArray(parsed)) {
                    packets = parsed;
                } else if (parsed.data) {
                    packets = parsed.data;
                } else {
                    packets = [];
                }

                this.availablePackets = packets;

            } catch (err) {

                console.error(
                    `❌ Worker ${this.workerIndex}: JSON parse failed`,
                    resultBuffer.toString()
                );
                return;
            }

            console.log(
                `📦 Worker ${this.workerIndex}: Preloaded ${this.availablePackets.length} packets`
            );

        } catch (err) {

            console.error(
                `❌ Worker ${this.workerIndex}: Failed to preload packets`,
                err
            );
        }
    }

    async submitTransaction() {

        if (this.availablePackets.length === 0) {
            return;
        }

        /* ---------------------------------
           1️⃣ Select random packet
        ---------------------------------- */
        const selectedPacket =
            this.availablePackets[
                Math.floor(Math.random() * this.availablePackets.length)
            ];

        if (!selectedPacket || !selectedPacket.packetId) {
            return;
        }

        const packetId = selectedPacket.packetId;

        /* ---------------------------------
           2️⃣ Query history
        ---------------------------------- */
        const historyTx = {
            contractId: this.contractId,
            contractFunction: 'getPacketLifecycle',
            invokerIdentity: this.invokerIdentity,
            contractArguments: [packetId],
            readOnly: true
        };

        try {

            const res = await this.sutAdapter.sendRequests(historyTx);

            if (res?.status?.result) {

                const payload = res.status.result.toString();

                /* ---------------------------------
                   📏 RESPONSE PAYLOAD SIZE
                ---------------------------------- */
                const payloadBytes = Buffer.byteLength(payload, 'utf8');
                const payloadKB = payloadBytes / 1024;

                // Log only first 50 transactions
                if (this.txIndex < 50) {
                    fs.appendFileSync(
                        this.payloadFile,
                        `getPacketHistory,${payloadBytes},${payloadKB.toFixed(4)}\n`
                    );
                }

                this.txIndex++;
            }

        } catch (err) {

            console.error(
                `❌ [PacketHistory][Worker ${this.workerIndex}] Failed for ${packetId}`,
                err?.message || err
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

module.exports.createWorkloadModule = () => new GetPacketHistoryWorkload();