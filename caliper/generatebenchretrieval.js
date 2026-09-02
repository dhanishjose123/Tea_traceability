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
    tps,   // single TPS value
    userId = 'User1',
    limits,
}) {

    // Ensure directory exists
    if (!fs.existsSync(filePath)) {
        fs.mkdirSync(filePath, { recursive: true });
    }

    const fullPath = path.join(filePath, fileName);

    // ✅ Determine TPS safely
   

    // ✅ Debug (VERY IMPORTANT)
    console.log(`🔥 Using TPS: ${tps}`);
    const workloadDir = getWorkloadDir(contractId);
    console.log(`🧩 Using workload folder: ${workloadDir}`);

    // ✅ Generate YAML (single round)
    const yamlContent = `
test:
  name: Tea Chaincode Load Test
  description: Benchmarking under increasing load
  workers:
    type: local
    number: 5
  rounds:
    - label: ${functions[0]}_Load@${tps}
      description: Load @${tps} TPS for ${functions[0]}
      txNumber: ${txNumber}
      rateControl:
        type: fixed-rate
        opts:
          tps: ${tps}
      workload:
        module: ./${workloadDir}/${functions[0]}.js
        arguments:
          contractId: ${contractId}
          channel: ${channel}
          userId: ${userId}
          limit: ${limits}
`;

    // Write file
    fs.writeFileSync(fullPath, yamlContent.trim(), 'utf8');

    console.log(`✅ Benchmark file generated at: ${fullPath}`);
}

module.exports = generateBenchmarkFile;
