'use strict';

const fs = require('fs');
const path = require('path');

function getChaincodeSuffix(chaincodeName) {
    const match = chaincodeName.match(/_(\d+)$/);
    return match ? match[1] : null;
}

function getWorkloadDir(contractId) {
    if (process.env.WORKLOAD_DIR) {
        return process.env.WORKLOAD_DIR;
    }

    const suffix = getChaincodeSuffix(contractId);
    const preferredDir = suffix ? `workload_${suffix}` : 'workload_11';
    const preferredPath = path.join(__dirname, preferredDir);

    if (fs.existsSync(preferredPath)) {
        return preferredDir;
    }

    console.warn(`⚠️ Workload folder ${preferredDir} not found, using workload_11`);
    return 'workload_11';
}

function generateBenchmarkFile({
    filePath = './benchmarks',
    fileName = 'benchmark.yaml',
    functions = ['makeoffer'],
    contractId = process.env.CHAINCODE_NAME || process.env.CC_NAME || 'tea_traceability',
    channel = 'tea1003',
    txNumber = 5000,
    startRate = 50,
    rateStep = 50,
    rounds = 5,
    tps,   // single TPS value or array of TPS values
    tpsLevels,
    transactionLoads,
    userId = 'User1',
    limits,
    workers = process.env.CALIPER_WORKERS || 5,
    txDurationSeconds,
    setupLotQueryDivisor = process.env.SETUP_LOT_QUERY_DIVISOR || 5,
    submitNoMvccLotQueryLimit = process.env.SUBMIT_NO_MVCC_LOT_QUERY_LIMIT || 20,
    submitNoMvccMaxLotQueryLimit = process.env.SUBMIT_NO_MVCC_MAX_LOT_QUERY_LIMIT || 3000,
    submitNoMvccLotQueryBuffer = process.env.SUBMIT_NO_MVCC_LOT_QUERY_BUFFER || 1.5,
    makeOfferAllRetailerCount = 24,
    makeOfferAllLotQueryLimit = process.env.MAKEOFFERALL_LOT_QUERY_LIMIT || 20,
    makeOfferAllMaxLotQueryLimit = process.env.MAKEOFFERALL_MAX_LOT_QUERY_LIMIT || 3000,
    makeOfferAllLotQueryBuffer = process.env.MAKEOFFERALL_LOT_QUERY_BUFFER || 1.5,
    makeOfferAllLotQueryDivisor = process.env.MAKEOFFERALL_LOT_QUERY_DIVISOR || setupLotQueryDivisor,
    testTeaLotLotQueryLimit = process.env.TEST_TEA_LOT_LOT_QUERY_LIMIT || 20,
    testTeaLotMaxLotQueryLimit = process.env.TEST_TEA_LOT_MAX_LOT_QUERY_LIMIT || 3000,
    testTeaLotLotQueryBuffer = process.env.TEST_TEA_LOT_LOT_QUERY_BUFFER || 1.5,
    testTeaLotSetupLotQueryDivisor = process.env.TEST_TEA_LOT_SETUP_LOT_QUERY_DIVISOR || setupLotQueryDivisor,
    acceptOfferLotQueryLimit = process.env.ACCEPT_OFFER_LOT_QUERY_LIMIT || 20,
    acceptOfferMaxLotQueryLimit = process.env.ACCEPT_OFFER_MAX_LOT_QUERY_LIMIT || 3000,
    acceptOfferLotQueryBuffer = process.env.ACCEPT_OFFER_LOT_QUERY_BUFFER || 1.2,
    acceptOfferNoMvccLotQueryDivisor = process.env.ACCEPT_OFFER_NO_MVCC_LOT_QUERY_DIVISOR || setupLotQueryDivisor,
    packLotQueryLimit = process.env.PACK_LOT_QUERY_LIMIT || 20,
    packMaxLotQueryLimit = process.env.PACK_MAX_LOT_QUERY_LIMIT || 3000,
    packLotQueryBuffer = process.env.PACK_LOT_QUERY_BUFFER || 1.2,
    purchasePacketQueryLimit = process.env.PURCHASE_PACKET_QUERY_LIMIT || 20,
    purchaseMaxPacketQueryLimit = process.env.PURCHASE_MAX_PACKET_QUERY_LIMIT || 3000,
    purchasePacketQueryBuffer = process.env.PURCHASE_PACKET_QUERY_BUFFER || 1.2,
	}) {

    // Ensure directory exists
    if (!fs.existsSync(filePath)) {
        fs.mkdirSync(filePath, { recursive: true });
    }

    const fullPath = path.join(filePath, fileName);

    const loads = Array.isArray(tpsLevels) && tpsLevels.length > 0
        ? tpsLevels
        : Array.isArray(transactionLoads) && transactionLoads.length > 0
            ? transactionLoads
            : Array.isArray(tps) && tps.length > 0
                ? tps
                : tps !== undefined && tps !== null && tps !== ''
                    ? [tps]
                    : Array.from({ length: rounds }, (_, index) => startRate + index * rateStep);

    // ✅ Debug (VERY IMPORTANT)
    console.log(`🔥 Using TPS levels: ${loads.join(', ')}`);
    const workloadDir = getWorkloadDir(contractId);
    console.log(`🧩 Using workload folder: ${workloadDir}`);

    const argumentLines = [
        `          contractId: ${contractId}`,
        `          channel: ${channel}`,
        `          userId: ${userId}`
    ];

    const functionName = String(functions[0]);
    const submitProduceNoMvccMatch = functionName.match(/^submitproduce_(?:no|n0)_mvcc_f(\d+)_a(\d+)(?:_s(\d+))?$/i);
    const matrixMatch = functionName.match(/submitproduce_f(\d+)_a(\d+)(?:_s(\d+))?$/i);
    const aggregatorMatch = functionName.match(/submitproduce_agg(\d+)$/i);
    const testTeaLotMatch = functionName.match(/testTeaLot_a(\d+)(?:_s(\d+))?$/i);
    const makeOfferMatch = functionName.match(/makeoffer_r(\d+)(?:_(\d+))?$/i);
    const makeOfferAllMatch = functionName.match(/^makeofferall(?:_r(\d+)_f(\d+)|_f(\d+)_r(\d+))?(?:_s(\d+))?$/i);
    const packMatch = functionName.match(/^pack_r(\d+)(?:_s(\d+))?$/i);
    const purchaseMatch = functionName.match(/purchase_c(\d+)(?:_r(\d+))?$/i);
    const acceptOfferNoMvccMatch = functionName.match(/^acceptoffer_(?:no|n0)_mvcc_f(\d+)_r(\d+)(?:_s(\d+))?$/i);
    const acceptOfferMatch = functionName.match(/acceptoffer_f(\d+)_r(\d+)(?:_s(\d+))?$/i);
    const workloadModuleName = submitProduceNoMvccMatch || matrixMatch
        ? 'submitproduce_matrix'
        : testTeaLotMatch
            ? 'testTeaLot'
            : makeOfferMatch
                ? 'makeoffer_matrix'
                : makeOfferAllMatch
                    ? 'makeofferall'
                    : packMatch
                        ? 'pack'
                        : purchaseMatch
                            ? 'purchase'
                            : acceptOfferNoMvccMatch || acceptOfferMatch
                            ? 'acceptoffer'
                            : functionName;

    if (submitProduceNoMvccMatch) {
        argumentLines.push(`          farmerCount: ${submitProduceNoMvccMatch[1]}`);
        argumentLines.push(`          aggregatorCount: ${submitProduceNoMvccMatch[2]}`);
        if (submitProduceNoMvccMatch[3]) {
            argumentLines.push(`          farmerStartIndex: ${submitProduceNoMvccMatch[3]}`);
            argumentLines.push(`          aggregatorStartIndex: ${submitProduceNoMvccMatch[3]}`);
        }
        argumentLines.push(`          aggregatorSelectionMode: paired`);
        argumentLines.push(`          contractFunction: submitProduceNoMVCC`);
    }

    if (matrixMatch) {
        argumentLines.push(`          farmerCount: ${matrixMatch[1]}`);
        argumentLines.push(`          aggregatorCount: ${matrixMatch[2]}`);
        if (matrixMatch[3]) {
            argumentLines.push(`          farmerStartIndex: ${matrixMatch[3]}`);
            argumentLines.push(`          aggregatorStartIndex: ${matrixMatch[3]}`);
        }
    }

    if (aggregatorMatch) {
        argumentLines.push(`          aggregatorCount: ${aggregatorMatch[1]}`);
    }

    if (testTeaLotMatch) {
        argumentLines.push(`          aggregatorCount: ${testTeaLotMatch[1]}`);
        if (testTeaLotMatch[2]) {
            argumentLines.push(`          aggregatorStartIndex: ${testTeaLotMatch[2]}`);
        }
    }

    if (makeOfferMatch) {
        argumentLines.push(`          retailerCount: ${makeOfferMatch[1]}`);
        if (makeOfferMatch[2]) {
            argumentLines.push(`          lotCount: ${makeOfferMatch[2]}`);
        }
    }

    if (makeOfferAllMatch) {
        const retailerCount = Number(makeOfferAllMatch[1] || makeOfferAllMatch[4] || makeOfferAllRetailerCount);
        const farmerCount = Number(makeOfferAllMatch[2] || makeOfferAllMatch[3] || 0);
        const startIndex = Number(makeOfferAllMatch[5] || 1);
        const allowedRetailers = Array.from({ length: retailerCount }, (_, index) => startIndex + index).join(',');

        if (farmerCount > 0) {
            argumentLines.push(`          farmerCount: ${farmerCount}`);
        }

        argumentLines.push(`          retailerCount: ${retailerCount}`);
        argumentLines.push(`          farmerStartIndex: ${startIndex}`);
        argumentLines.push(`          retailerStartIndex: ${startIndex}`);
        argumentLines.push(`          minRetailerIndex: ${startIndex}`);
        argumentLines.push(`          allowedRetailerIndexes: ${allowedRetailers}`);
        argumentLines.push(`          retailerSelectionMode: paired`);
    }

    if (packMatch) {
        argumentLines.push(`          retailerCount: ${packMatch[1]}`);
        if (packMatch[2]) {
            argumentLines.push(`          retailerStartIndex: ${packMatch[2]}`);
        }
    }

    if (purchaseMatch) {
        argumentLines.push(`          consumerCount: ${purchaseMatch[1]}`);
        if (purchaseMatch[2]) {
            argumentLines.push(`          retailerCount: ${purchaseMatch[2]}`);
            argumentLines.push(`          retailerSelectionMode: ${process.env.PURCHASE_RETAILER_SELECTION_MODE || 'paired'}`);
        }
    }

    if (acceptOfferNoMvccMatch) {
        argumentLines.push(`          farmerCount: ${acceptOfferNoMvccMatch[1]}`);
        argumentLines.push(`          retailerCount: ${acceptOfferNoMvccMatch[2]}`);
        if (acceptOfferNoMvccMatch[3]) {
            argumentLines.push(`          farmerStartIndex: ${acceptOfferNoMvccMatch[3]}`);
            argumentLines.push(`          retailerStartIndex: ${acceptOfferNoMvccMatch[3]}`);
        }
        argumentLines.push(`          retailerSelectionMode: paired`);
        argumentLines.push(`          contractFunction: acceptOfferNoMVCC`);
    }

    if (acceptOfferMatch) {
        argumentLines.push(`          farmerCount: ${acceptOfferMatch[1]}`);
        argumentLines.push(`          retailerCount: ${acceptOfferMatch[2]}`);
        if (acceptOfferMatch[3]) {
            argumentLines.push(`          farmerStartIndex: ${acceptOfferMatch[3]}`);
            argumentLines.push(`          retailerStartIndex: ${acceptOfferMatch[3]}`);
        }
    }

    if (limits !== undefined && limits !== null && limits !== '') {
        argumentLines.push(`          limit: ${limits}`);
    }

    const duration = Number(txDurationSeconds);
    const roundLengthLine = Number.isFinite(duration) && duration > 0
        ? `      txDuration: ${duration}`
        : `      txNumber: ${txNumber}`;

    function getRoundArgumentLines(currentTps) {
        const lines = [...argumentLines];
        const activeDuration = Number.isFinite(duration) && duration > 0
            ? duration
            : Math.ceil(txNumber / Math.max(1, Number(currentTps) || 1));

        function getDynamicLimit(participantCount, minValue, maxValue, bufferValue) {
            const participants = Math.max(1, Number(participantCount) || 1);
            const minLimit = Math.max(1, Number(minValue) || 20);
            const maxLimit = Math.max(minLimit, Number(maxValue) || 3000);
            const buffer = Math.max(1, Number(bufferValue) || 1.2);
            const estimatedPerWorker = Math.ceil((Number(currentTps) * activeDuration * buffer) / participants);
            return Math.min(maxLimit, Math.max(minLimit, estimatedPerWorker));
        }

        function getDynamicTotalLimit(minValue, maxValue, bufferValue) {
            const minLimit = Math.max(1, Number(minValue) || 20);
            const maxLimit = Math.max(minLimit, Number(maxValue) || 3000);
            const buffer = Math.max(1, Number(bufferValue) || 1.2);
            const estimatedTotal = Math.ceil(Number(currentTps) * activeDuration * buffer);
            return Math.min(maxLimit, Math.max(minLimit, estimatedTotal));
        }

        if (testTeaLotMatch) {
            const aggregatorCount = Math.max(
                1,
                testTeaLotMatch[2]
                    ? Number(testTeaLotSetupLotQueryDivisor)
                    : Number(testTeaLotMatch[1]) || 1
            );
            const minLimit = Math.max(1, Number(testTeaLotLotQueryLimit) || 1);
            const maxLimit = Math.max(minLimit, Number(testTeaLotMaxLotQueryLimit) || 3000);
            const buffer = Math.max(1, Number(testTeaLotLotQueryBuffer) || 1);
            const neededPerWorker = Math.ceil((Number(currentTps) * activeDuration * buffer) / aggregatorCount);
            const dynamicLimit = Math.min(maxLimit, Math.max(minLimit, neededPerWorker));

            lines.push(`          lotQueryLimit: ${dynamicLimit}`);
        }

        if (submitProduceNoMvccMatch) {
            const dynamicLimit = getDynamicLimit(
                setupLotQueryDivisor,
                submitNoMvccLotQueryLimit,
                submitNoMvccMaxLotQueryLimit,
                submitNoMvccLotQueryBuffer
            );

            lines.push(`          lotQueryLimit: ${dynamicLimit}`);
            lines.push(`          maxTransactions: ${dynamicLimit}`);
        }

        if (acceptOfferNoMvccMatch) {
            const dynamicLimit = getDynamicLimit(
                acceptOfferNoMvccLotQueryDivisor,
                process.env.ACCEPT_OFFER_NO_MVCC_LOT_QUERY_LIMIT || acceptOfferLotQueryLimit,
                process.env.ACCEPT_OFFER_NO_MVCC_MAX_LOT_QUERY_LIMIT || acceptOfferMaxLotQueryLimit,
                process.env.ACCEPT_OFFER_NO_MVCC_LOT_QUERY_BUFFER || acceptOfferLotQueryBuffer
            );

            lines.push(`          lotQueryLimit: ${dynamicLimit}`);
        }

        if (makeOfferAllMatch) {
            const divisor = Math.max(
                1,
                Number(makeOfferAllLotQueryDivisor) ||
                Number(makeOfferAllMatch[2] || makeOfferAllMatch[3] || makeOfferAllMatch[1] || makeOfferAllMatch[4] || makeOfferAllRetailerCount) ||
                1
            );
            const dynamicLimit = getDynamicLimit(
                divisor,
                makeOfferAllLotQueryLimit,
                makeOfferAllMaxLotQueryLimit,
                makeOfferAllLotQueryBuffer
            );

            lines.push(`          lotQueryLimit: ${dynamicLimit}`);
        }

        if (acceptOfferMatch && !acceptOfferNoMvccMatch) {
            const farmerCount = Math.max(1, Number(acceptOfferMatch[1]) || 1);
            const dynamicLimit = getDynamicLimit(
                farmerCount,
                acceptOfferLotQueryLimit,
                acceptOfferMaxLotQueryLimit,
                acceptOfferLotQueryBuffer
            );

            lines.push(`          lotQueryLimit: ${dynamicLimit}`);
        }

        if (packMatch) {
            const retailerCount = Math.max(1, Number(packMatch[1]) || 1);
            const dynamicLimit = getDynamicLimit(
                retailerCount,
                packLotQueryLimit,
                packMaxLotQueryLimit,
                packLotQueryBuffer
            );

            lines.push(`          lotQueryLimit: ${dynamicLimit}`);
        }

        if (purchaseMatch) {
            const dynamicLimit = getDynamicTotalLimit(
                purchasePacketQueryLimit,
                purchaseMaxPacketQueryLimit,
                purchasePacketQueryBuffer
            );

            lines.push(`          packetQueryLimit: ${dynamicLimit}`);
        }

        return lines;
    }

    const seenTps = new Map();
    const hasDuplicateTps = loads.some((value, index) => loads.indexOf(value) !== index);
    const roundsYaml = loads.map(currentTps => {
        const previousCount = seenTps.get(currentTps) || 0;
        const roundCount = previousCount + 1;
        seenTps.set(currentTps, roundCount);
        const labelSuffix = hasDuplicateTps
            ? `round${roundCount}@${currentTps}`
            : `Load@${currentTps}`;

        return `
    - label: ${functions[0]}_${labelSuffix}
      description: Load @${currentTps} TPS for ${functions[0]}
${roundLengthLine}
      rateControl:
        type: fixed-rate
        opts:
          tps: ${currentTps}
      workload:
        module: ./${workloadDir}/${workloadModuleName}.js
        arguments:
${getRoundArgumentLines(currentTps).join('\n')}
`;
    }).join('');

    // ✅ Generate YAML
    const yamlContent = `
test:
  name: Tea Chaincode Load Test
  description: Benchmarking under increasing load
  workers:
    type: local
    number: ${workers}
  rounds:
${roundsYaml}
`;

    // Write file
    fs.writeFileSync(fullPath, yamlContent.trim(), 'utf8');

    console.log(`✅ Benchmark file generated at: ${fullPath}`);
}

module.exports = generateBenchmarkFile;
