'use strict';

const { exec, spawn } = require('child_process');
const generateBenchmarkFile = require('./generatebenchretrieval');
const fs = require('fs');
const path = require('path');

// ==============================
// 🔹 CONFIGURATION
// ==============================

// Payload sizes (query limits)
const payloads = [100,110,120,130,140];

// TPS levels
const transactionLoads = [10];





// Channel + chaincode
const channelName = process.env.CHANNEL_NAME || 'agrochannel0304';
const contractId = process.env.CHAINCODE_NAME || process.env.CC_NAME || 'tea_traceability';
// Logging folder


// Functions to test
const benchmarks = [
    { functionName: 'getproduce', logLevel: 'info' },
    { functionName: 'getallpackets', logLevel: 'info' }
    
];

// Base config
const baseConfig = {
    contractId: contractId,
    channel: channelName,
    userId: 'User1',
    workers: 5
};

// Create log directory

function startMonitoring(logPrefix) {

    const dockerStats = spawn('docker', ['stats'], { shell: true });
    const cpuStats = spawn('top', ['-b', '-d', '1'], { shell: true });

    const dockerLog = fs.createWriteStream(`${logPrefix}-docker.log`);
    const cpuLog = fs.createWriteStream(`${logPrefix}-cpu.log`);

    dockerStats.stdout.on('data', data => {
        dockerLog.write(`[${new Date().toISOString()}] ${data}`);
    });

    cpuStats.stdout.on('data', data => {
        cpuLog.write(`[${new Date().toISOString()}] ${data}`);
    });

    dockerStats.stderr.pipe(dockerLog);
    cpuStats.stderr.pipe(cpuLog);

    return { dockerStats, cpuStats };
}

function stopMonitoring(monitors) {
    if (monitors.dockerStats) monitors.dockerStats.kill('SIGINT');
    if (monitors.cpuStats) monitors.cpuStats.kill('SIGINT');
}

// ===============================
// 🔹 OPTIONAL: READ TPS FROM YAML
// ===============================

function getTPSFromYaml(yamlFilePath) {
    const fileContents = fs.readFileSync(yamlFilePath, 'utf8');
    const config = yaml.load(fileContents);

    return config.test.rounds.map(r => r.rateControl.opts.tps);
}

// ==============================
// 🔹 EXECUTION
// ==============================

(async () => {

    for (const { functionName, logLevel } of benchmarks) {

        for (const payload of payloads) {

            for (const tps of transactionLoads ) {
                const logDirname = `logs_retrieval_${payload}`;
                const logDir = path.join(__dirname, logDirname);
                if (!fs.existsSync(logDir)) {
                        fs.mkdirSync(logDir);
                }

                const yamlFile = `benchmark-${functionName}-T${tps}-P${payload}.yaml`;
                const logPrefix = `${logDir}/${functionName}-T${tps}-P${payload}`;
                const logFile = `${logPrefix}.log`;

                console.log(`\n📄 Generating YAML: ${yamlFile}`);
                console.log(`🔧 Function: ${functionName} | Payload: ${payload} `);

                // ============================
                // Generate YAML
                // ============================
                generateBenchmarkFile({
                    ...baseConfig,
                    functions: [functionName],
                    filePath: './benchmarks',
                    fileName: yamlFile,
                    tps:tps,   // TPS
                    limits: payload          // Payload
                });

                console.log(`📄 YAML ready`);

                // ============================
                // Build Caliper command
                // ============================
                const caliperCommand = [
                    `npx caliper launch manager`,
                    `--caliper-networkconfig ./caliper-network.yaml`,
                    `--caliper-benchconfig ./benchmarks/${yamlFile}`,
                    `--logLevel ${logLevel}`,
                    `> ${logFile} 2>&1`
                ].join(' ');

                console.log(`🚀 Running benchmark...`);

                // ---------------------------
                // 4️⃣ Start monitoring
                // ---------------------------
                // const monitors = startMonitoring(logPrefix);


                // ============================
                // Execute benchmark
                // ============================
                await new Promise((resolve, reject) => {

                    exec(caliperCommand, (error) => {

                        // stopMonitoring(monitors);

                        if (error) {
                            console.error(`❌ FAILED: ${functionName} | P=${payload} `);
                            return reject(error);
                        }

                        console.log(`✅ DONE: ${functionName} | P=${payload} `);
                        console.log(`📂 Log saved: ${logFile}`);

                        resolve();
                    });

                });

            
            }    
        }
    }
    console.log(`\n🎉 ALL BENCHMARKS COMPLETED`);

})();
