'use strict';

const { spawn } = require('child_process');
const generateBenchmarkFile = require('./generatebench.js');
const fs = require('fs');
const path = require('path');
const { strategicCounts, strategicPairs } = require('./experiment-matrix');
const yaml = require('js-yaml');

// ===============================
// 🔹 BENCHMARK PARAMETERS
// ===============================

const txNumber = 500;
const txDurationSeconds = 5;
const setupTxDurationSeconds = Number(process.env.SETUP_TX_DURATION_SECONDS || 10);
const channelName = process.env.CHANNEL_NAME || 'agrochannel10063';
const contractId = process.env.CHAINCODE_NAME || 'tea_traceability';
const netemLatency = process.argv[2] || process.env.NETEM_LATENCY || '0';
const netemJitter = process.argv[3] || process.env.NETEM_JITTER || '0';
const netemLoss = process.argv[4] || process.env.NETEM_LOSS || '0';
const caliperWorkersArg = process.argv[5] || process.env.CALIPER_WORKERS || 'auto';
const fixedCaliperWorkers = Number.isFinite(Number(caliperWorkersArg)) && Number(caliperWorkersArg) > 0
    ? Number(caliperWorkersArg)
    : null;
const multiRoundArg = String(process.env.MULTI_ROUND_BENCHMARK || 'true').toLowerCase();
const useMultiRoundBenchmark = !['0', 'false', 'no'].includes(multiRoundArg);
const fabricRequestTimeoutMs = Number(process.env.FABRIC_REQUEST_TIMEOUT_MS || 300000);
const fabricTransactionTimeoutSeconds = Number(process.env.FABRIC_TRANSACTION_TIMEOUT_SECONDS || 300);
const fabricEvaluateTimeoutSeconds = Number(process.env.FABRIC_EVALUATE_TIMEOUT_SECONDS || 300);
const fabricGrpcWaitForReadyMs = Number(process.env.FABRIC_GRPC_WAIT_FOR_READY_MS || 60000);
const fabricConnectionRequestTimeoutMs = Number(process.env.FABRIC_CONNECTION_REQUEST_TIMEOUT_MS || fabricRequestTimeoutMs);
const benchmarkTimeoutSeconds = Number(process.env.BENCHMARK_TIMEOUT_SECONDS || 0);
const noProgressTimeoutSeconds = Number(process.env.NO_PROGRESS_TIMEOUT_SECONDS || 300);
const skipTimedOutBenchmarks = !['0', 'false', 'no'].includes(String(process.env.SKIP_TIMED_OUT_BENCHMARKS || 'true').toLowerCase());
const timingCsvFile = path.join(
    __dirname,
    process.env.BENCHMARK_TIMING_CSV || `benchmark_timings_${getChaincodeLogSuffix(contractId)}.csv`
);

// ✅ Custom TPS loads (RESEARCH GRADE)



function parseList(value) {
    return String(value || '')
        .split(',')
        .map(item => item.trim())
        .filter(Boolean);
}

function parseNumberList(value) {
    const parsed = parseList(value)
        .map(value => Number(value))
        .filter(value => Number.isFinite(value) && value > 0);

    return parsed.length > 0 ? parsed : null;
}

const transactionLoads = parseNumberList(process.env.TRANSACTION_LOADS || process.env.TPS_FILTER) ||
    [1,4,10,20,50,100,200,500]
const setupTransactionLoads = parseNumberList(process.env.SETUP_TRANSACTION_LOADS || process.env.SETUP_TPS_FILTER) ||
    Array.from({ length: 9 }, () => 500);

// Benchmark functions
// Strategic 1..24 matrix: covers low, medium, balanced, and imbalanced
// participant counts without running every possible pair.
const submitProduceStartPair = [1, 1];
const submitProducePairs = strategicPairs.slice(
    strategicPairs.findIndex(([farmerCount, aggregatorCount]) =>
        farmerCount === submitProduceStartPair[0] && aggregatorCount === submitProduceStartPair[1]
    )
);

const submitProduceMatrix = submitProducePairs.map(([farmerCount, aggregatorCount]) => ({
    functionName: `submitproduce_f${farmerCount}_a${aggregatorCount}`,
    logLevel: 'info'
}));

const submitProduceNoMvccMatrix = [
    { functionName: 'submitproduce_no_mvcc_f24_a24', logLevel: 'info' }
];

function submitNoMvccBatches(participantCount) {
    const batches = [];
    let start = 1;
    const total = Math.max(1, Number(participantCount) || 1);

    while (start <= total) {
        const batchSize = Math.min(5, total - start + 1);
        batches.push({
            functionName: `submitproduce_no_mvcc_f${batchSize}_a${batchSize}_s${start}`,
            logLevel: 'info'
        });
        start += batchSize;
    }

    return batches;
}

function ensureTimingCsv() {
    if (!fs.existsSync(timingCsvFile)) {
        fs.writeFileSync(
            timingCsvFile,
            'timestamp,channel,chaincode,function,tps,mode,latencyMs,jitterMs,lossPercent,workers,durationSeconds,status,logFile\n',
            'utf8'
        );
    }
}

function appendTimingRow({ functionName, tps = 'multi', mode, workers, durationSeconds, status, logFile }) {
    ensureTimingCsv();

    const values = [
        new Date().toISOString(),
        channelName,
        contractId,
        functionName,
        tps,
        mode,
        netemLatency,
        netemJitter,
        netemLoss,
        workers,
        durationSeconds,
        status,
        logFile
    ].map(value => {
        const text = String(value ?? '');
        return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    });

    fs.appendFileSync(timingCsvFile, `${values.join(',')}\n`, 'utf8');
}

function terminateProcess(processHandle, label) {
    if (!processHandle) {
        return;
    }

    console.warn(`⏳ Benchmark timeout reached; stopping ${label}`);
    const killTarget = processHandle.pid ? -processHandle.pid : processHandle.pid;

    try {
        if (processHandle.pid) {
            process.kill(killTarget, 'SIGTERM');
        } else {
            processHandle.kill('SIGTERM');
        }
    } catch (error) {
        try {
            processHandle.kill('SIGTERM');
        } catch (_) {
            // Process already exited.
        }
    }

    setTimeout(() => {
        if (processHandle.exitCode === null && processHandle.signalCode === null) {
            try {
                if (processHandle.pid) {
                    process.kill(killTarget, 'SIGKILL');
                } else {
                    processHandle.kill('SIGKILL');
                }
            } catch (error) {
                try {
                    processHandle.kill('SIGKILL');
                } catch (_) {
                    // Process already exited.
                }
            }
        }
    }, 5000).unref();
}

function createNoProgressWatcher(processHandle, label, onSkip) {
    if (!processHandle || noProgressTimeoutSeconds <= 0) {
        return {
            observe() {},
            stop() {}
        };
    }

    let zeroProgressStartedAt = null;
    let triggered = false;

    const txInfoRegex = /Transaction Info\]\s*-\s*Submitted:\s*(\d+)\s+Succ:\s*(\d+)\s+Fail:\s*(\d+)\s+Unfinished:\s*(\d+)/g;
    const interval = setInterval(() => {
        if (!zeroProgressStartedAt || triggered) {
            return;
        }

        const elapsedSeconds = (Date.now() - zeroProgressStartedAt) / 1000;
        if (elapsedSeconds >= noProgressTimeoutSeconds) {
            triggered = true;
            const reason = `no-progress:${noProgressTimeoutSeconds}s`;
            console.warn(`⏭️ Skipping ${label}; no transactions submitted for ${noProgressTimeoutSeconds}s`);
            onSkip(reason);
            terminateProcess(processHandle, `${label} (${reason})`);
        }
    }, 5000);
    interval.unref();

    return {
        observe(data) {
            const text = data.toString();
            txInfoRegex.lastIndex = 0;
            let match;

            while ((match = txInfoRegex.exec(text)) !== null) {
                const submitted = Number(match[1]);
                const succ = Number(match[2]);
                const fail = Number(match[3]);
                const unfinished = Number(match[4]);
                const hasProgress = submitted > 0 || succ > 0 || fail > 0 || unfinished > 0;

                if (hasProgress) {
                    zeroProgressStartedAt = null;
                } else if (!zeroProgressStartedAt) {
                    zeroProgressStartedAt = Date.now();
                }
            }
        },
        stop() {
            clearInterval(interval);
        }
    };
}

function submitNoMvccSetup(participantCount = 24) {
    return submitNoMvccBatches(participantCount);
}

function makeOfferAllBatches(participantCount = 24, startIndex = Number(process.env.MAKEOFFERALL_BATCH_START || 1)) {
    const batches = [];
    let start = Math.max(1, Number(startIndex) || 1);
    const total = Math.max(1, Number(participantCount) || 1);

    while (start <= total) {
        const batchSize = Math.min(5, total - start + 1);
        batches.push({
            functionName: `makeofferall_r${batchSize}_f${batchSize}_s${start}`,
            logLevel: 'info'
        });
        start += batchSize;
    }

    return batches;
}

function acceptOfferNoMvccBatches(participantCount = 24) {
    const batches = [];
    let start = 1;
    const total = Math.max(1, Number(participantCount) || 1);

    while (start <= total) {
        const batchSize = Math.min(5, total - start + 1);
        batches.push({
            functionName: `acceptoffer_no_mvcc_f${batchSize}_r${batchSize}_s${start}`,
            logLevel: 'info'
        });
        start += batchSize;
    }

    return batches;
}

function testTeaLotBenchmarks() {
    return strategicCounts.map(count => ({
        functionName: `testTeaLot_a${count}`,
        logLevel: 'info'
    }));
}

function testTeaLotBatches(participantCount = 24, startIndex = Number(process.env.TEST_TEA_LOT_BATCH_START || 1)) {
    const batches = [];
    let start = Math.max(1, Number(startIndex) || 1);
    const total = Math.max(1, Number(participantCount) || 1);

    while (start <= total) {
        const batchSize = Math.min(5, total - start + 1);
        batches.push({
            functionName: `testTeaLot_a${batchSize}_s${start}`,
            logLevel: 'info'
        });
        start += batchSize;
    }

    return batches;
}

function acceptOfferSetup(participantCount = 24) {
    return makeOfferAllBatches(participantCount);
}

function packSetup(participantCount = 24) {
    return acceptOfferNoMvccBatches(participantCount);
}

function packSetupBatches(participantCount = 24) {
    const batches = [];
    let start = 1;
    const total = Math.max(1, Number(participantCount) || 1);

    while (start <= total) {
        const batchSize = Math.min(5, total - start + 1);
        batches.push({ functionName: `pack_r${batchSize}_s${start}`, logLevel: 'info' });
        start += batchSize;
    }

    return batches;
}

const testTeaLotMatrix = testTeaLotBenchmarks();
const testTeaLotAlternateMatrix = testTeaLotBatches(24);

const makeOfferLotCounts = [1, 2, 5, 10, 20, 30, 40, 50];
const makeOfferMatrix = makeOfferLotCounts.flatMap(lots =>
    strategicCounts.map(count => ({
        functionName: `makeoffer_r${count}_${lots}`,
        logLevel: 'info'
    }))
);

const packMatrix = strategicCounts.map(count => ({
    functionName: `pack_r${count}`,
    logLevel: 'info'
}));

const purchaseMatrix = submitProducePairs.map(([consumerCount, retailerCount]) => ({
    functionName: `purchase_c${consumerCount}_r${retailerCount}`,
    logLevel: 'info'
}));

const acceptOfferStartPair = [1, 1];
const acceptOfferPairs = strategicPairs.slice(
    strategicPairs.findIndex(([farmerCount, retailerCount]) =>
        farmerCount === acceptOfferStartPair[0] && retailerCount === acceptOfferStartPair[1]
    )
);

const acceptOfferMatrix = acceptOfferPairs.map(([farmerCount, retailerCount]) => ({
    functionName: `acceptoffer_f${farmerCount}_r${retailerCount}`,
    logLevel: 'info'
}));

const acceptOfferNoMvccMatrix = [
    { functionName: 'acceptoffer_no_mvcc_f24_r24', logLevel: 'info' }
];

const acceptOfferPipelineMatrix = acceptOfferPairs.flatMap(([farmerCount, retailerCount]) =>
    [
        { functionName: `acceptoffer_f${farmerCount}_r${retailerCount}`, logLevel: 'info' }
    ]
);

const acceptOfferSetupMatrix = acceptOfferSetup(24);
const packSetupMatrix = packSetup(24);
const purchaseSetupMatrix = packSetupBatches(24);
const packPipelineMatrix = strategicCounts.map(count => ({
    functionName: `pack_r${count}`,
    logLevel: 'info'
}));

const benchmarks = [
    ...submitProduceMatrix,
    ...submitProduceNoMvccMatrix,
    ...submitNoMvccSetup(24),
    ...testTeaLotMatrix,
    ...testTeaLotAlternateMatrix,
    ...makeOfferMatrix,
    { functionName: 'makeofferall', logLevel: 'info' },
    ...acceptOfferSetupMatrix,
    ...acceptOfferPipelineMatrix,
    ...acceptOfferNoMvccMatrix,
    ...packSetupMatrix,
    ...packPipelineMatrix,
    ...purchaseSetupMatrix,
    ...purchaseMatrix,
];

const benchmarkFilter = parseList(process.env.BENCHMARK_FILTER || process.env.SELECTED_BENCHMARKS);
const filteredBenchmarks = benchmarkFilter.length > 0
    ? benchmarkFilter.map(functionName => {
        const existing = benchmarks.find(benchmark => benchmark.functionName === functionName);
        return existing || { functionName, logLevel: 'info' };
    })
    : benchmarks;

// Shared config
const baseConfig = {
    contractId: contractId,
    channel: channelName,
    txNumber,
    txDurationSeconds,
    userId: 'User1'
};

function getTxDurationForFunction(functionName) {
    const name = String(functionName || '').toLowerCase();

    if (/^submitproduce_(?:no|n0)_mvcc_f\d+_a\d+_s\d+$/.test(name)) {
        return Number(process.env.SUBMIT_NO_MVCC_TX_DURATION_SECONDS || 21);
    }

    if (/^testTeaLot_a\d+_s\d+$/.test(name)) {
        return Number(process.env.TESTTEALOT_SETUP_TX_DURATION_SECONDS || 18);
    }

    if (/^makeofferall(?:_r\d+_f\d+|_f\d+_r\d+)_s\d+$/.test(name)) {
        return Number(process.env.MAKEOFFERALL_SETUP_TX_DURATION_SECONDS || 15);
    }

    if (/^acceptoffer_(?:no|n0)_mvcc_f\d+_r\d+_s\d+$/.test(name)) {
        return Number(process.env.ACCEPT_NO_MVCC_TX_DURATION_SECONDS || 12);
    }

    if (/^pack_r\d+_s\d+$/.test(name)) {
        return Number(process.env.PACK_SETUP_TX_DURATION_SECONDS || 9);
    }

    if (/^purchase_c\d+(?:_r\d+)?$/.test(name)) {
        return Number(process.env.PURCHASE_TX_DURATION_SECONDS || 6);
    }

    return isSetupLoadFunction(functionName) ? setupTxDurationSeconds : txDurationSeconds;
}

function isSetupLoadFunction(functionName) {
    const name = String(functionName || '').toLowerCase();
    return /^submitproduce_(?:no|n0)_mvcc_f\d+_a\d+(?:_s\d+)?$/.test(name) ||
        /^acceptoffer_(?:no|n0)_mvcc_f\d+_r\d+(?:_s\d+)?$/.test(name) ||
        /^makeofferall(?:_r\d+_f\d+|_f\d+_r\d+)(?:_s\d+)?$/.test(name) ||
        /^testTeaLot_a\d+_s\d+$/.test(name) ||
        /^pack_r\d+_s\d+$/.test(name);
}

function getLoadsForFunction(functionName) {
    return isSetupLoadFunction(functionName) ? setupTransactionLoads : transactionLoads;
}

// ===============================
// 🔹 CREATE UNIQUE LOG DIRECTORY
// ===============================

const timestamp = new Date().toISOString().replace(/[:.]/g, '-');



// ===============================
// 🔹 MONITORING (IMPROVED)
// ===============================

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

function resetWorkloadState(functionName) {
    if (String(functionName) === 'makeofferall') {
        const claimDir = path.join(__dirname, 'tmp', 'makeofferall-claims');
        fs.rmSync(claimDir, { recursive: true, force: true });
        fs.mkdirSync(claimDir, { recursive: true });
        console.log(`Reset makeofferall claim directory: ${claimDir}`);
        return;
    }

    if (String(functionName).startsWith('purchase_c')) {
        const claimDir = path.join(__dirname, 'tmp', 'purchase-claims');
        fs.rmSync(claimDir, { recursive: true, force: true });
        fs.mkdirSync(claimDir, { recursive: true });
        console.log(`Reset purchase claim directory: ${claimDir}`);
        return;
    }

    if (String(functionName).startsWith('pack_r')) {
        const claimDir = path.join(__dirname, 'tmp', 'pack-claims');
        fs.rmSync(claimDir, { recursive: true, force: true });
        fs.mkdirSync(claimDir, { recursive: true });
        console.log(`Reset pack claim directory: ${claimDir}`);
        return;
    }

    if (!String(functionName).startsWith('acceptoffer')) {
        return;
    }

    const claimDir = path.join(__dirname, 'tmp', 'acceptoffer-claims');
    fs.rmSync(claimDir, { recursive: true, force: true });
    fs.mkdirSync(claimDir, { recursive: true });
    console.log(`🧹 Reset acceptoffer claim directory: ${claimDir}`);
}

function getChaincodeLogSuffix(chaincodeName) {
    const match = chaincodeName.match(/_(\d+)$/);
    return match ? match[1] : chaincodeName.replace(/[^a-zA-Z0-9]/g, '');
}

function stripUnit(value, unit) {
    return String(value ?? '0').trim().replace(new RegExp(`${unit}$`, 'i'), '');
}

function normalizeMs(value) {
    const stripped = stripUnit(value, 'ms');
    return stripped === '' ? '0' : stripped;
}

function normalizeLoss(value) {
    const stripped = String(value ?? '0').trim().replace(/%$/, '');
    return stripped === '' ? '0' : stripped;
}

function isZeroValue(value) {
    const normalized = String(value ?? '0').trim().replace(/ms$/i, '').replace(/%$/, '');
    return normalized === '' || Number(normalized) === 0;
}

function getNetemFolderName() {
    if (isZeroValue(netemLatency) && isZeroValue(netemLoss)) {
        return null;
    }

    const latency = normalizeMs(netemLatency);
    const jitter = normalizeMs(netemJitter);
    const loss = normalizeLoss(netemLoss).replace('.', 'p');

    return `netem_${latency}ms_${jitter}ms_${loss}pct`;
}

function toPosixPath(filePath) {
    return filePath.split(path.sep).join('/');
}

function toMspId(orgName) {
    return `${orgName.charAt(0).toUpperCase()}${orgName.slice(1)}MSP`;
}

function getUserCertPath(orgDir, orgDomain, userDirName) {
    const certName = `${userDirName}-cert.pem`;
    const certPath = path.join(orgDir, 'users', userDirName, 'msp', 'signcerts', certName);

    if (fs.existsSync(certPath)) {
        return certPath;
    }

    const signcertsDir = path.join(orgDir, 'users', userDirName, 'msp', 'signcerts');
    const certs = fs.existsSync(signcertsDir)
        ? fs.readdirSync(signcertsDir).filter(file => file.endsWith('.pem'))
        : [];

    if (certs.length === 0) {
        throw new Error(`No signing certificate found for ${userDirName} in ${orgDomain}`);
    }

    return path.join(signcertsDir, certs[0]);
}

function getUserPrivateKeyPath(orgDir, orgDomain, userDirName) {
    const keystoreDir = path.join(orgDir, 'users', userDirName, 'msp', 'keystore');
    const keys = fs.existsSync(keystoreDir)
        ? fs.readdirSync(keystoreDir).filter(file => !file.startsWith('.'))
        : [];

    if (keys.length === 0) {
        throw new Error(`No private key found for ${userDirName} in ${orgDomain}`);
    }

    return path.join(keystoreDir, keys[0]);
}

function getIdentityNumber(userDirName) {
    const match = String(userDirName).match(/^User(\d+)@/);
    return match ? Number(match[1]) : null;
}

function getFabricTimeoutConfig(functionName = '') {
    const isTestTeaLot = String(functionName).toLowerCase().startsWith('testTeaLot_a');
    const evaluateTimeoutSeconds = isTestTeaLot
        ? Number(process.env.TEST_TEA_LOT_FABRIC_EVALUATE_TIMEOUT_SECONDS || 180)
        : fabricEvaluateTimeoutSeconds;
    const requestTimeoutMs = isTestTeaLot
        ? Number(process.env.TEST_TEA_LOT_FABRIC_REQUEST_TIMEOUT_MS || evaluateTimeoutSeconds * 1000)
        : fabricRequestTimeoutMs;
    const connectionRequestTimeoutMs = isTestTeaLot
        ? Number(process.env.TEST_TEA_LOT_FABRIC_CONNECTION_REQUEST_TIMEOUT_MS || requestTimeoutMs)
        : fabricConnectionRequestTimeoutMs;

    return {
        requestTimeoutMs,
        connectionRequestTimeoutMs,
        transactionTimeoutSeconds: fabricTransactionTimeoutSeconds,
        evaluateTimeoutSeconds,
        grpcWaitForReadyMs: fabricGrpcWaitForReadyMs
    };
}

function writeGeneratedConnectionProfile(orgName, connectionProfilePath, generatedDir, timeoutConfig = getFabricTimeoutConfig()) {
    const profile = JSON.parse(fs.readFileSync(connectionProfilePath, 'utf8'));
    profile.client = profile.client || {};
    profile.client.connection = profile.client.connection || {};
    profile.client.connection.timeout = profile.client.connection.timeout || {};
    profile.client.connection.timeout.peer = {
        ...(profile.client.connection.timeout.peer || {}),
        endorser: String(timeoutConfig.transactionTimeoutSeconds),
        eventHub: String(timeoutConfig.transactionTimeoutSeconds),
        eventReg: String(timeoutConfig.transactionTimeoutSeconds),
        query: String(timeoutConfig.evaluateTimeoutSeconds)
    };

    for (const peer of Object.values(profile.peers || {})) {
        peer.grpcOptions = peer.grpcOptions || {};
        peer.grpcOptions['grpc-wait-for-ready-timeout'] = timeoutConfig.grpcWaitForReadyMs;
        peer.grpcOptions['request-timeout'] = timeoutConfig.connectionRequestTimeoutMs;
    }

    const generatedConnectionPath = path.join(generatedDir, `connection-${orgName}-caliper.json`);
    fs.writeFileSync(generatedConnectionPath, JSON.stringify(profile, null, 2), 'utf8');
    return generatedConnectionPath;
}

function buildCaliperOrganizations(userRange = null, allowedOrgNames = null, generatedDir = path.join(__dirname, 'generated'), timeoutConfig = getFabricTimeoutConfig()) {
    const peerOrganizationsDir = path.resolve(__dirname, '../fabric-test/test-network/organizations/peerOrganizations');
    const connectionsDir = path.resolve(__dirname, '../backend/connections');
    const allowedOrgs = Array.isArray(allowedOrgNames)
        ? new Set(allowedOrgNames.map(org => String(org).toLowerCase()))
        : null;
    const userStart = userRange && Number.isFinite(Number(userRange.start))
        ? Number(userRange.start)
        : 1;
    const userEnd = userRange && Number.isFinite(Number(userRange.end))
        ? Number(userRange.end)
        : null;

    if (!fs.existsSync(peerOrganizationsDir)) {
        return [];
    }

    const orgDomains = fs.readdirSync(peerOrganizationsDir)
        .filter(entry => entry.endsWith('.example.com'))
        .filter(entry => fs.statSync(path.join(peerOrganizationsDir, entry)).isDirectory())
        .sort((left, right) => {
            if (left === 'farmers.example.com') return -1;
            if (right === 'farmers.example.com') return 1;
            return left.localeCompare(right);
        });

    return orgDomains
    .filter(orgDomain => {
        if (!allowedOrgs) {
            return true;
        }

        const orgName = orgDomain.replace('.example.com', '');
        return allowedOrgs.has(orgName);
    })
    .map(orgDomain => {
        const orgName = orgDomain.replace('.example.com', '');
        const orgDir = path.join(peerOrganizationsDir, orgDomain);
        const usersDir = path.join(orgDir, 'users');
        const connectionProfilePath = path.join(connectionsDir, `connection-${orgName}.json`);

        if (!fs.existsSync(connectionProfilePath)) {
            throw new Error(`Missing connection profile for ${orgName}: ${connectionProfilePath}`);
        }

        const userDirs = fs.readdirSync(usersDir)
            .filter(entry => fs.statSync(path.join(usersDir, entry)).isDirectory())
            .filter(entry => {
                if (entry.startsWith('Admin@')) {
                    return true;
                }

                const userNumber = getIdentityNumber(entry);
                return userNumber !== null &&
                    userNumber >= userStart &&
                    (!userEnd || userNumber <= userEnd);
            })
            .sort((left, right) => {
                if (left.startsWith('Admin@')) return -1;
                if (right.startsWith('Admin@')) return 1;
                return left.localeCompare(right, undefined, { numeric: true });
            });

        const certificates = userDirs.map(userDirName => {
            const isAdmin = userDirName.startsWith('Admin@');
            const userName = isAdmin ? 'User0' : userDirName.split('@')[0];
            const certPath = getUserCertPath(orgDir, orgDomain, userDirName);
            const privateKeyPath = getUserPrivateKeyPath(orgDir, orgDomain, userDirName);

            return {
                name: userName,
                admin: isAdmin,
                clientSignedCert: {
                    path: toPosixPath(path.relative(__dirname, certPath))
                },
                clientPrivateKey: {
                    path: toPosixPath(path.relative(__dirname, privateKeyPath))
                }
            };
        });

        const generatedConnectionProfilePath = writeGeneratedConnectionProfile(orgName, connectionProfilePath, generatedDir, timeoutConfig);

        return {
            mspid: toMspId(orgName),
            identities: {
                certificates
            },
            connectionProfile: {
                path: toPosixPath(path.relative(__dirname, generatedConnectionProfilePath)),
                discover: true
            }
        };
    });
}

function sanitizeFilePart(value) {
    return String(value).replace(/[^a-zA-Z0-9_.-]/g, '_');
}

function getNetworkUserRangeForFunction(functionName) {
    const submitProduceMatch = String(functionName).match(/^submitproduce(?:_(?:no|n0)_mvcc)?_f(\d+)_a(\d+)(?:_s(\d+))?$/i);
    if (submitProduceMatch) {
        const start = Number(submitProduceMatch[3] || 1);
        const farmerEnd = start + Number(submitProduceMatch[1]) - 1;
        const aggregatorEnd = start + Number(submitProduceMatch[2]) - 1;
        return { start, end: Math.max(farmerEnd, aggregatorEnd) };
    }

    const acceptOfferMatch = String(functionName).match(/^acceptoffer(?:_(?:no|n0)_mvcc)?_f(\d+)_r(\d+)(?:_s(\d+))?$/i);
    if (acceptOfferMatch) {
        const start = Number(acceptOfferMatch[3] || 1);
        return {
            start,
            end: Math.max(
                start + Number(acceptOfferMatch[1]) - 1,
                start + Number(acceptOfferMatch[2]) - 1
            )
        };
    }

    const makeOfferAllMatch = String(functionName).match(/^makeofferall(?:_r(\d+)_f(\d+)|_f(\d+)_r(\d+))(?:_s(\d+))?$/i);
    if (makeOfferAllMatch) {
        const start = Number(makeOfferAllMatch[5] || 1);
        return {
            start,
            end: Math.max(
                start + Number(makeOfferAllMatch[1] || makeOfferAllMatch[4]) - 1,
                start + Number(makeOfferAllMatch[2] || makeOfferAllMatch[3] || 0) - 1
            )
        };
    }

    const purchaseWithRetailerMatch = String(functionName).match(/^purchase_c(\d+)_r(\d+)$/i);
    if (purchaseWithRetailerMatch) {
        return { start: 1, end: Number(purchaseWithRetailerMatch[1]) };
    }

    const testTeaLotMatch = String(functionName).match(/^testTeaLot_a(\d+)(?:_s(\d+))?$/i);
    if (testTeaLotMatch) {
        const start = Number(testTeaLotMatch[2] || 1);
        return { start, end: start + Number(testTeaLotMatch[1]) - 1 };
    }

    const packMatch = String(functionName).match(/^pack_r(\d+)(?:_s(\d+))?$/i);
    if (packMatch) {
        const start = Number(packMatch[2] || 1);
        return { start, end: start + Number(packMatch[1]) - 1 };
    }

    const oneDimensionalMatch = String(functionName).match(/^(?:makeoffer_r|purchase_c)(\d+)(?:_\d+)?$/i);
    if (oneDimensionalMatch) {
        return { start: 1, end: Number(oneDimensionalMatch[1]) };
    }

    if (String(functionName).toLowerCase() === 'makeofferall') {
        return { start: 1, end: Math.max(...strategicCounts) };
    }

    return { start: 1, end: fixedCaliperWorkers || Math.max(...strategicCounts) };
}

function getNetworkUserLimitForFunction(functionName) {
    return getNetworkUserRangeForFunction(functionName).end;
}

function getRequiredOrgsForFunction(functionName) {
    const name = String(functionName).toLowerCase();

    if (name.startsWith('submitproduce_f') || name.startsWith('submitproduce_no_mvcc_f') || name.startsWith('submitproduce_n0_mvcc_f')) {
        return ['farmers', 'aggregators'];
    }

    if (name.startsWith('testTeaLot_a')) {
        return ['aggregators'];
    }

    if (name.startsWith('makeoffer_r') || name === 'makeofferall' || name.startsWith('makeofferall_r') || name.startsWith('makeofferall_f')) {
        return ['retailers'];
    }

    if (name.startsWith('acceptoffer_f') || name.startsWith('acceptoffer_no_mvcc_f') || name.startsWith('acceptoffer_n0_mvcc_f')) {
        return ['farmers', 'retailers'];
    }

    if (name.startsWith('pack_r') || name === 'pack') {
        return ['retailers'];
    }

    if (name.startsWith('purchase_c') || name === 'purchase') {
        return ['consumers'];
    }

    return null;
}

function generateCaliperNetworkFile(channelName, functionName = 'default') {
    const baseNetworkPath = path.join(__dirname, 'caliper-network.yaml');
    const generatedDir = path.join(__dirname, 'generated');
    const userRange = getNetworkUserRangeForFunction(functionName);
    const requiredOrgs = getRequiredOrgsForFunction(functionName);
    const timeoutConfig = getFabricTimeoutConfig(functionName);

    if (!fs.existsSync(generatedDir)) {
        fs.mkdirSync(generatedDir, { recursive: true });
    }

    const baseNetwork = yaml.load(fs.readFileSync(baseNetworkPath, 'utf8'));
    baseNetwork.caliper = baseNetwork.caliper || {};
    baseNetwork.caliper.sutOptions = baseNetwork.caliper.sutOptions || {};
    baseNetwork.caliper.sutOptions.gatewayOptions = {
        ...(baseNetwork.caliper.sutOptions.gatewayOptions || {}),
        requestTimeout: timeoutConfig.requestTimeoutMs
    };
    baseNetwork.caliper.sutOptions.timeout = {
        ...(baseNetwork.caliper.sutOptions.timeout || {}),
        transaction: timeoutConfig.transactionTimeoutSeconds,
        evaluate: timeoutConfig.evaluateTimeoutSeconds
    };

    if (Array.isArray(baseNetwork.channels)) {
        baseNetwork.channels = baseNetwork.channels.map(channel => ({
            ...channel,
            channelName,
            contracts: Array.isArray(channel.contracts)
                ? channel.contracts.map(contract => ({
                    ...contract,
                    id: contractId
                }))
                : channel.contracts
        }));
    }

    const dynamicOrganizations = buildCaliperOrganizations(userRange, requiredOrgs, generatedDir, timeoutConfig);
    if (dynamicOrganizations.length > 0) {
        baseNetwork.organizations = dynamicOrganizations;
        console.log(`🏢 Caliper orgs: ${dynamicOrganizations.map(org => org.mspid).join(', ')} | identities User0 + User${userRange.start}..User${userRange.end}`);
    }

    const generatedFileName = `caliper-network-${channelName}-${sanitizeFilePart(functionName)}.yaml`;
    const generatedPath = path.join(generatedDir, generatedFileName);
    fs.writeFileSync(generatedPath, yaml.dump(baseNetwork, { lineWidth: -1 }), 'utf8');
    return generatedPath;
}

// ===============================
// 🔹 MAIN EXECUTION
// ===============================

(async () => {
    const npxCommand = process.platform === 'win32' ? 'npx.cmd' : 'npx';

    console.log(`🔗 Channel name: ${channelName}`);
    console.log(`🌐 Netem: latency=${netemLatency}, jitter=${netemJitter}, loss=${netemLoss}`);
    console.log(`👷 Caliper workers: ${fixedCaliperWorkers || 'auto per workload'}`);
    console.log(`📚 Multi-round benchmark files: ${useMultiRoundBenchmark ? 'yes' : 'no'}`);

    if (benchmarkFilter.length > 0) {
        console.log(`🎯 Benchmark filter: ${benchmarkFilter.join(', ')}`);
        console.log(`🎯 Matched benchmarks: ${filteredBenchmarks.map(benchmark => benchmark.functionName).join(', ') || 'none'}`);
    }

    for (const { functionName, logLevel } of filteredBenchmarks) {
        resetWorkloadState(functionName);
        const benchmarkWorkers = getWorkersForFunction(functionName);
        const benchmarkTxDurationSeconds = getTxDurationForFunction(functionName);
        const benchmarkLoads = getLoadsForFunction(functionName);
        const generatedNetworkPath = generateCaliperNetworkFile(channelName, functionName);
        const generatedNetworkArg = `./${path.relative(__dirname, generatedNetworkPath).replace(/\\/g, '/')}`;
        const networkUserRange = getNetworkUserRangeForFunction(functionName);
        console.log(`📡 Using generated Caliper network file: ${generatedNetworkArg}`);
        console.log(`👥 Network identity range for ${functionName}: User${networkUserRange.start}..User${networkUserRange.end}`);
        if (String(functionName).match(/^submitproduce(?:_(?:no|n0)_mvcc)?_f\d+_a\d+(?:_s\d+)?$/i)) {
            console.log(`🌾 Submitproduce Caliper workers are based on farmer count only: ${benchmarkWorkers}`);
        }

        if (useMultiRoundBenchmark) {
            const workloadDir = process.env.WORKLOAD_DIR || `workload_${getChaincodeLogSuffix(contractId)}`;
            const chaincodeLogDirname = workloadDir.replace('workload', 'logs');
            const netemLogDirname = getNetemFolderName();
            const logDirname = 'logs_multi';
            const logDir = netemLogDirname
                ? path.join(__dirname, chaincodeLogDirname, netemLogDirname, logDirname)
                : path.join(__dirname, chaincodeLogDirname, logDirname);

            if (!fs.existsSync(logDir)) {
                fs.mkdirSync(logDir, { recursive: true });
            }

            const runId = Date.now();
            const yamlFile = `benchmark-${functionName}-multi.yaml`;
            const logPrefix = `${logDir}/${functionName}-multi-${runId}`;
            const logFile = `${logPrefix}.log`;

            console.log(`\n📄 Generating multi-round YAML for ${functionName}`);
            console.log(`👷 Workers for ${functionName}: ${benchmarkWorkers}`);
            console.log(`⏱️ txDuration for ${functionName}: ${benchmarkTxDurationSeconds}s`);
            console.log(`🔥 TPS levels for ${functionName}: ${benchmarkLoads.join(', ')}`);

            generateBenchmarkFile({
                ...baseConfig,
                txDurationSeconds: benchmarkTxDurationSeconds,
                workers: benchmarkWorkers,
                filePath: './benchmarks',
                fileName: yamlFile,
                functions: [functionName],
                tps: benchmarkLoads
            });

            const yamlPath = path.join(__dirname, 'benchmarks', yamlFile);
            console.log(`📊 TPS Levels:`, getTPSFromYaml(yamlPath));
            console.log(`🚀 Running ${functionName} multi-round benchmark`);

            await new Promise(r => setTimeout(r, 3000));

            await new Promise((resolve, reject) => {
                const logStream = fs.createWriteStream(logFile, { flags: 'a' });
                const benchmarkStartedAt = Date.now();
                const caliperArgs = [
                    'caliper',
                    'launch',
                    'manager',
                    '--caliper-networkconfig',
                    generatedNetworkArg,
                    '--caliper-benchconfig',
                    `./benchmarks/${yamlFile}`,
                    '--logLevel',
                    logLevel
                ];

                const caliperProc = spawn(npxCommand, caliperArgs, {
                    cwd: __dirname,
                    shell: false,
                    detached: true
                });
                let timedOut = false;
                let skipReason = '';
                const timeoutHandle = benchmarkTimeoutSeconds > 0
                    ? setTimeout(() => {
                        timedOut = true;
                        skipReason = `timeout:${benchmarkTimeoutSeconds}s`;
                        terminateProcess(caliperProc, `${functionName} multi-round`);
                    }, benchmarkTimeoutSeconds * 1000)
                    : null;
                const noProgressWatcher = createNoProgressWatcher(
                    caliperProc,
                    `${functionName} multi-round`,
                    reason => {
                        timedOut = true;
                        skipReason = reason;
                    }
                );

                caliperProc.stdout.on('data', data => {
                    logStream.write(data);
                    noProgressWatcher.observe(data);
                });
                caliperProc.stderr.on('data', data => {
                    logStream.write(data);
                    noProgressWatcher.observe(data);
                });

                caliperProc.on('error', async (error) => {
                    if (timeoutHandle) {
                        clearTimeout(timeoutHandle);
                    }
                    noProgressWatcher.stop();
                    const durationSeconds = ((Date.now() - benchmarkStartedAt) / 1000).toFixed(3);
                    logStream.end();
                    await new Promise(r => setTimeout(r, 2000));
                    appendTimingRow({
                        functionName,
                        mode: 'multi',
                        workers: benchmarkWorkers,
                        durationSeconds,
                        status: timedOut ? 'timeout' : 'error',
                        logFile
                    });
                    console.log(`⏱️ ${functionName} multi-round runtime: ${durationSeconds}s`);
                    console.error(`❌ Error in ${functionName} multi-round: ${error.message}`);
                    reject(error);
                });

                caliperProc.on('close', async (code) => {
                    if (timeoutHandle) {
                        clearTimeout(timeoutHandle);
                    }
                    noProgressWatcher.stop();
                    const durationSeconds = ((Date.now() - benchmarkStartedAt) / 1000).toFixed(3);
                    logStream.end();
                    await new Promise(r => setTimeout(r, 2000));

                    if (code !== 0) {
                        const error = new Error(timedOut
                            ? `Caliper skipped after ${skipReason || `${benchmarkTimeoutSeconds}s`}`
                            : `Caliper exited with code ${code}`);
                        appendTimingRow({
                            functionName,
                            mode: 'multi',
                            workers: benchmarkWorkers,
                            durationSeconds,
                            status: timedOut ? `skipped:${skipReason || 'timeout'}` : `failed:${code}`,
                            logFile
                        });
                        console.log(`⏱️ ${functionName} multi-round runtime: ${durationSeconds}s`);
                        if (timedOut && skipTimedOutBenchmarks) {
                            console.warn(`⏭️ Skipped ${functionName} multi-round: ${error.message}`);
                            return resolve();
                        }
                        console.error(`❌ Error in ${functionName} multi-round: ${error.message}`);
                        return reject(error);
                    }

                    appendTimingRow({
                        functionName,
                        mode: 'multi',
                        workers: benchmarkWorkers,
                        durationSeconds,
                        status: 'success',
                        logFile
                    });
                    console.log(`✅ Completed: ${functionName} multi-round`);
                    console.log(`⏱️ ${functionName} multi-round runtime: ${durationSeconds}s`);
                    console.log(`📂 Log file: ${logFile}`);
                    resolve();
                });
            });

            console.log(`🧊 Cooling down...`);
            await new Promise(r => setTimeout(r, 5000));
            continue;
        }

        for (const tps of benchmarkLoads) {

            const workloadDir = process.env.WORKLOAD_DIR || `workload_${getChaincodeLogSuffix(contractId)}`;
            const chaincodeLogDirname = workloadDir.replace('workload', 'logs');
            const netemLogDirname = getNetemFolderName();
            const logDirname = `logs_${tps}`;
            const logDir = netemLogDirname
                ? path.join(__dirname, chaincodeLogDirname, netemLogDirname, logDirname)
                : path.join(__dirname, chaincodeLogDirname, logDirname);

            if (!fs.existsSync(logDir)) {
                fs.mkdirSync(logDir, { recursive: true });
            }

            const runId = Date.now();

            const yamlFile = `benchmark-${functionName}-${tps}.yaml`;
            const logPrefix = `${logDir}/${functionName}-${tps}-${runId}`;
            const logFile = `${logPrefix}.log`;

            console.log(`\n📄 Generating YAML for ${functionName} @ TPS ${tps}`);
            console.log(`👷 Workers for ${functionName}: ${benchmarkWorkers}`);
            console.log(`⏱️ txDuration for ${functionName}: ${benchmarkTxDurationSeconds}s`);

            generateBenchmarkFile({
                ...baseConfig,
                txDurationSeconds: benchmarkTxDurationSeconds,
                workers: benchmarkWorkers,
                filePath: './benchmarks',
                fileName: yamlFile,
                functions: [functionName],
                tps   // 🔥 IMPORTANT
            });

            const yamlPath = path.join(__dirname, 'benchmarks', yamlFile);

            console.log(`📊 TPS Levels:`, getTPSFromYaml(yamlPath));

            console.log(`🚀 Running ${functionName} @ TPS ${tps}`);

            await new Promise(r => setTimeout(r, 3000));

            // const monitors = startMonitoring(logPrefix);

            await new Promise((resolve, reject) => {
                const logStream = fs.createWriteStream(logFile, { flags: 'a' });
                const benchmarkStartedAt = Date.now();
                const caliperArgs = [
                    'caliper',
                    'launch',
                    'manager',
                    '--caliper-networkconfig',
                    generatedNetworkArg,
                    '--caliper-benchconfig',
                    `./benchmarks/${yamlFile}`,
                    '--logLevel',
                    logLevel
                ];

                const caliperProc = spawn(npxCommand, caliperArgs, {
                    cwd: __dirname,
                    shell: false,
                    detached: true
                });
                let timedOut = false;
                let skipReason = '';
                const timeoutHandle = benchmarkTimeoutSeconds > 0
                    ? setTimeout(() => {
                        timedOut = true;
                        skipReason = `timeout:${benchmarkTimeoutSeconds}s`;
                        terminateProcess(caliperProc, `${functionName} @ TPS ${tps}`);
                    }, benchmarkTimeoutSeconds * 1000)
                    : null;
                const noProgressWatcher = createNoProgressWatcher(
                    caliperProc,
                    `${functionName} @ TPS ${tps}`,
                    reason => {
                        timedOut = true;
                        skipReason = reason;
                    }
                );

                caliperProc.stdout.on('data', data => {
                    logStream.write(data);
                    noProgressWatcher.observe(data);
                });
                caliperProc.stderr.on('data', data => {
                    logStream.write(data);
                    noProgressWatcher.observe(data);
                });

                caliperProc.on('error', async (error) => {
                    if (timeoutHandle) {
                        clearTimeout(timeoutHandle);
                    }
                    noProgressWatcher.stop();
                    const durationSeconds = ((Date.now() - benchmarkStartedAt) / 1000).toFixed(3);
                    logStream.end();
                    await new Promise(r => setTimeout(r, 2000));
                    appendTimingRow({
                        functionName,
                        tps,
                        mode: 'single',
                        workers: benchmarkWorkers,
                        durationSeconds,
                        status: timedOut ? 'timeout' : 'error',
                        logFile
                    });
                    console.log(`⏱️ ${functionName} @ TPS ${tps} runtime: ${durationSeconds}s`);
                    console.error(`❌ Error in ${functionName} @ TPS ${tps}: ${error.message}`);
                    reject(error);
                });

                caliperProc.on('close', async (code) => {
                    if (timeoutHandle) {
                        clearTimeout(timeoutHandle);
                    }
                    noProgressWatcher.stop();
                    const durationSeconds = ((Date.now() - benchmarkStartedAt) / 1000).toFixed(3);
                    logStream.end();
                    await new Promise(r => setTimeout(r, 2000));

                    if (code !== 0) {
                        const error = new Error(timedOut
                            ? `Caliper skipped after ${skipReason || `${benchmarkTimeoutSeconds}s`}`
                            : `Caliper exited with code ${code}`);
                        appendTimingRow({
                            functionName,
                            tps,
                            mode: 'single',
                            workers: benchmarkWorkers,
                            durationSeconds,
                            status: timedOut ? `skipped:${skipReason || 'timeout'}` : `failed:${code}`,
                            logFile
                        });
                        console.log(`⏱️ ${functionName} @ TPS ${tps} runtime: ${durationSeconds}s`);
                        if (timedOut && skipTimedOutBenchmarks) {
                            console.warn(`⏭️ Skipped ${functionName} @ TPS ${tps}: ${error.message}`);
                            return resolve();
                        }
                        console.error(`❌ Error in ${functionName} @ TPS ${tps}: ${error.message}`);
                        return reject(error);
                    }

                    appendTimingRow({
                        functionName,
                        tps,
                        mode: 'single',
                        workers: benchmarkWorkers,
                        durationSeconds,
                        status: 'success',
                        logFile
                    });
                    console.log(`✅ Completed: ${functionName} @ TPS ${tps}`);
                    console.log(`⏱️ ${functionName} @ TPS ${tps} runtime: ${durationSeconds}s`);
                    console.log(`📂 Log file: ${logFile}`);
                    resolve();
                });
            });

            console.log(`🧊 Cooling down...`);
            await new Promise(r => setTimeout(r, 5000));
        }
    }

    console.log(`\n🎉 ALL BENCHMARKS COMPLETED`);

})();

function getWorkersForFunction(functionName) {
    const getAlternateWorkerCount = (envName) => {
        const workers = Number(process.env[envName] || process.env.ALTERNATE_LOGICAL_WORKERS || 5);
        return Number.isFinite(workers) && workers > 0 ? workers : 5;
    };

    const regularSubmitProduceMatch = String(functionName).match(/^submitproduce_f(\d+)_a(\d+)$/i);
    if (regularSubmitProduceMatch) {
        const alternateSubmitWorkers = Number(process.env.ALTERNATE_SUBMIT_WORKERS || process.env.SUBMITPRODUCE_ALTERNATE_WORKERS || process.env.ALTERNATE_LOGICAL_WORKERS || 5);
        return Number.isFinite(alternateSubmitWorkers) && alternateSubmitWorkers > 0
            ? alternateSubmitWorkers
            : Number(regularSubmitProduceMatch[1]);
    }

    const regularTestTeaLotMatch = String(functionName).match(/^testTeaLot_a(\d+)$/i);
    if (regularTestTeaLotMatch) {
        const workers = Number(process.env.ALTERNATE_TESTTEALOT_WORKERS || process.env.ALTERNATE_LOGICAL_WORKERS || 5);
        return Number.isFinite(workers) && workers > 0 ? workers : Number(regularTestTeaLotMatch[1]);
    }

    const submitProduceMatch = String(functionName).match(/^submitproduce(?:_(?:no|n0)_mvcc)?_f(\d+)_a(\d+)(?:_s(\d+))?$/i);
    if (submitProduceMatch) {
        const farmerCount = Number(submitProduceMatch[1]);
        if (farmerCount <= 4) {
            return getAlternateWorkerCount('ALTERNATE_SUBMIT_WORKERS');
        }
        return farmerCount;
    }

    const testTeaLotMatch = String(functionName).match(/^testTeaLot_a(\d+)(?:_s(\d+))?$/i);
    if (testTeaLotMatch) {
        const aggregatorCount = Number(testTeaLotMatch[1]);
        if (aggregatorCount <= 4) {
            return getAlternateWorkerCount('ALTERNATE_TESTTEALOT_WORKERS');
        }
        return aggregatorCount;
    }

    const makeOfferMatch = String(functionName).match(/^makeoffer_r(\d+)(?:_(\d+))?$/i);
    if (makeOfferMatch) {
        const retailerCount = Number(makeOfferMatch[1]);
        if (retailerCount <= 4) {
            return getAlternateWorkerCount('ALTERNATE_MAKEOFFER_WORKERS');
        }
        return retailerCount;
    }

    const makeOfferAllMatch = String(functionName).match(/^makeofferall(?:_r(\d+)_f(\d+)|_f(\d+)_r(\d+))(?:_s(\d+))?$/i);
    if (makeOfferAllMatch) {
        const retailerCount = Number(makeOfferAllMatch[1] || makeOfferAllMatch[4]);
        if (retailerCount <= 4) {
            return getAlternateWorkerCount('ALTERNATE_MAKEOFFERALL_WORKERS');
        }
        return retailerCount;
    }

    const packMatch = String(functionName).match(/^pack_r(\d+)(?:_s(\d+))?$/i);
    if (packMatch) {
        if (!packMatch[2]) {
            const workers = Number(process.env.ALTERNATE_PACK_WORKERS || process.env.ALTERNATE_LOGICAL_WORKERS || 5);
            return Number.isFinite(workers) && workers > 0 ? workers : Number(packMatch[1]);
        }
        const retailerCount = Number(packMatch[1]);
        if (retailerCount <= 4) {
            return getAlternateWorkerCount('ALTERNATE_PACK_WORKERS');
        }
        return retailerCount;
    }

    const purchaseMatch = String(functionName).match(/^purchase_c(\d+)(?:_r(\d+))?$/i);
    if (purchaseMatch) {
        const workers = Number(process.env.ALTERNATE_PURCHASE_WORKERS || process.env.ALTERNATE_LOGICAL_WORKERS || 5);
        if (Number.isFinite(workers) && workers > 0) {
            return workers;
        }
        return Number(purchaseMatch[1]);
    }

    if (String(functionName).toLowerCase() === 'makeofferall') {
        return Math.max(...strategicCounts);
    }

    const acceptOfferMatch = String(functionName).match(/^acceptoffer(?:_(?:no|n0)_mvcc)?_f(\d+)_r(\d+)(?:_s(\d+))?$/i);
    if (acceptOfferMatch) {
        if (!acceptOfferMatch[3] && !String(functionName).match(/^acceptoffer_(?:no|n0)_mvcc_/i)) {
            const workers = Number(process.env.ALTERNATE_ACCEPT_WORKERS || process.env.ALTERNATE_LOGICAL_WORKERS || 5);
            return Number.isFinite(workers) && workers > 0 ? workers : Number(acceptOfferMatch[1]);
        }
        const farmerCount = Number(acceptOfferMatch[1]);
        if (farmerCount <= 4) {
            return getAlternateWorkerCount('ALTERNATE_ACCEPT_WORKERS');
        }
        return farmerCount;
    }

    if (typeof fixedCaliperWorkers !== 'undefined' && fixedCaliperWorkers) {
        return fixedCaliperWorkers;
    }

    return 5;
}
