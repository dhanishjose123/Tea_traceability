'use strict';

const fs = require('fs');
const path = require('path');

function getChaincodeSuffix(chaincodeName) {
    const match = chaincodeName.match(/_(\d+)$/);
    return match ? match[1] : null;
}

function getWorkloadDir(contractId) {
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
    tps,   // ✅ NEW
    userId = 'User1',
}) {

    if (!fs.existsSync(filePath)) {
        fs.mkdirSync(filePath, { recursive: true });
    }

    const fullPath = path.join(filePath, fileName);
    const workloadDir = getWorkloadDir(contractId);

    const loads = transactionLoads && transactionLoads.length > 0
        ? transactionLoads
        : Array.from({ length: rounds }, (_, i) => startRate + i * rateStep);

    const roundsYaml = [];

    for (let i = 0; i < loads.length; i++) {

        const currentRate = loads[i];

        roundsYaml.push(`
    - label: ${functions[0]}_Load@${currentRate}
      description: Load @${currentRate} TPS for ${functions[0]}
      txNumber: ${txNumber}
      rateControl:
        type: fixed-rate
        opts:
          tps: ${currentRate}
      workload:
        module: ./${workloadDir}/${functions[0]}.js
        arguments:
          contractId: ${contractId}
          channel: ${channel}
          userId: ${userId}
`);
    }

    const yamlContent = `
test:
  name: Tea Chaincode Load Test
  description: Benchmarking under increasing load
  workers:
    type: local
    number: 5
  rounds:
${roundsYaml.join('')}
`;

    fs.writeFileSync(fullPath, yamlContent.trim(), 'utf8');

    console.log(`✅ Benchmark file generated at: ${fullPath}`);
}
module.exports = generateBenchmarkFile;
