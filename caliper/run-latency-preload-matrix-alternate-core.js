'use strict';

const { spawnSync } = require('child_process');
const path = require('path');
const {
    channelName: experimentChannelName,
    batchSize,
    setupParticipantCount,
    strategicCounts,
    strategicPairs,
    latencyLevels: experimentLatencyLevels,
    tpsLoads,
    submitProduceBenchmarks: getSubmitProduceBenchmarks,
    acceptOfferBenchmarks: getAcceptOfferBenchmarks,
    purchaseBenchmarks: getPurchaseBenchmarks,
    makeOfferBenchmarks: getMakeOfferBenchmarks,
    benchmarkGroups: getBenchmarkGroups
} = require('./experiment-matrix-alternate');

const caliperDir = __dirname;
const rootDir = path.resolve(caliperDir, '..');
const channelStackScript = path.join(rootDir, 'channel-stack.sh');

function isEnabled(value, defaultValue = false) {
    if (value === undefined || value === null || value === '') {
        return defaultValue;
    }

    return !['0', 'false', 'no'].includes(String(value).toLowerCase());
}

function parseList(value, fallback) {
    const parsed = String(value || '')
        .split(',')
        .map(item => item.trim())
        .filter(Boolean);

    return parsed.length > 0 ? parsed : fallback;
}

const missingCombinationsMode = isEnabled(
    process.env.MISSING_COMBINATIONS_MODE || process.env.RUN_MISSING_COMBINATIONS || process.env.MISSING_ONLY,
    false
);
const missingModeChannelName = process.argv[2] || process.env.CHANNEL_NAME || experimentChannelName;

if (missingCombinationsMode) {
    const missingLatencies = parseList(
        process.env.MISSING_LATENCY_LEVELS || process.env.LATENCY_LEVELS,
        ['25']
    );
    const env = {
        ...process.env,
        CHANNEL_NAME: missingModeChannelName,
        MISSING_LATENCY_LEVELS: missingLatencies.join(',')
    };

    console.log('Latency preload matrix runner: missing-combinations mode');
    console.log(`Channel        : ${missingModeChannelName}`);
    console.log(`Latencies      : ${missingLatencies.join(', ')} ms`);
    console.log('Delegating to  : run-latency-missing-all.js');

    const result = spawnSync(
        process.execPath,
        [path.join(caliperDir, 'run-latency-missing-all.js'), missingModeChannelName],
        {
            cwd: caliperDir,
            env,
            stdio: 'inherit',
            shell: false
        }
    );

    process.exit(result.status || 0);
}

function runCommand(command, args, options = {}) {
    console.log(`\n$ ${[command, ...args].join(' ')}`);
    const result = spawnSync(command, args, {
        cwd: options.cwd || rootDir,
        env: options.env || process.env,
        stdio: 'inherit',
        shell: false
    });

    if (result.status !== 0) {
        const error = new Error(`${command} exited with code ${result.status}`);
        if (options.continueOnError) {
            console.error(`⚠️ ${error.message}; continuing to the next benchmark`);
            return false;
        }

        throw error;
    }

    return true;
}

function shouldRunWithoutLatency(benchmarkName) {
    const name = String(benchmarkName || '').toLowerCase();

    return /^submitproduce_(?:no|n0)_mvcc_f\d+_a\d+(?:_s\d+)?$/.test(name) ||
        /^acceptoffer_(?:no|n0)_mvcc_f\d+_r\d+(?:_s\d+)?$/.test(name) ||
        /^makeofferall(?:_r\d+_f\d+|_f\d+_r\d+)(?:_s\d+)?$/.test(name) ||
        /^testTeaLot_a\d+_s\d+$/.test(name) ||
        /^pack_r\d+_s\d+$/.test(name);
}

function splitBenchmarksByLatencyMode(benchmarks) {
    const chunks = [];

    for (const benchmark of benchmarks) {
        const noLatency = shouldRunWithoutLatency(benchmark);
        chunks.push({ noLatency, benchmarks: [benchmark] });
    }

    return chunks;
}

function applyNetem(latencyMs) {
    runCommand(
        channelStackScript,
        [
            channelName,
            'netem',
            chaincodeName,
            String(latencyMs),
            latencyMs === '0' || Number(latencyMs) === 0 ? '0' : jitterMs,
            latencyMs === '0' || Number(latencyMs) === 0 ? '0' : lossPercent,
            caliperWorkers
        ],
        { cwd: rootDir }
    );
}

const channelName = process.argv[2] || process.env.CHANNEL_NAME || experimentChannelName;
const chaincodeName = process.env.CHAINCODE_NAME || 'tea_traceability';
const workloadDir = process.env.WORKLOAD_DIR || 'workload_9_cache_5';
const jitterMs = process.env.LATENCY_JITTER_MS || process.env.NETEM_JITTER || '0';
const lossPercent = process.env.LATENCY_LOSS_PERCENT || process.env.NETEM_LOSS || '0';
const caliperWorkers = process.env.CALIPER_WORKERS || 'auto';
const loadStaggerMs = process.env.LOAD_STAGGER_MS || process.env.INIT_LOAD_STAGGER_MS || '250';
const noProgressTimeoutSeconds = process.env.NO_PROGRESS_TIMEOUT_SECONDS || '300';
const preloadCacheDir = process.env.PRELOAD_CACHE_DIR || path.join(caliperDir, 'tmp', 'preload-cache');
const usePreloadCache = !['0', 'false', 'no'].includes(
    String(process.env.PRELOAD_CACHE || 'true').toLowerCase()
);
const latencyLevels = parseList(
    process.env.LATENCY_LEVELS,
    experimentLatencyLevels.map(String)
);
const submitProduceBenchmarks = getSubmitProduceBenchmarks();
const purchaseMatrix = getPurchaseBenchmarks();
const acceptOfferBenchmarks = getAcceptOfferBenchmarks();
const setupBatchStart = Number(process.env.SETUP_BATCH_START || 1);

function submitNoMvccBatches(
    participantCount = setupParticipantCount,
    startIndex = Number(process.env.SUBMIT_NO_MVCC_BATCH_START || setupBatchStart)
) {
    const batches = [];
    let start = Math.max(1, Number(startIndex) || 1);
    const total = Math.max(1, Number(participantCount) || 1);

    while (start <= total) {
        const currentBatchSize = Math.min(batchSize, total - start + 1);
        batches.push(`submitproduce_no_mvcc_f${currentBatchSize}_a${currentBatchSize}_s${start}`);
        start += currentBatchSize;
    }

    return batches;
}

function submitNoMvccSetup(participantCount = setupParticipantCount) {
    return submitNoMvccBatches(participantCount);
}

function makeOfferAllBatches(
    participantCount = setupParticipantCount,
    startIndex = Number(process.env.MAKEOFFERALL_BATCH_START || setupBatchStart)
) {
    const batches = [];
    let start = Math.max(1, Number(startIndex) || 1);
    const total = Math.max(1, Number(participantCount) || 1);

    while (start <= total) {
        const currentBatchSize = Math.min(batchSize, total - start + 1);
        batches.push(`makeofferall_r${currentBatchSize}_f${currentBatchSize}_s${start}`);
        start += currentBatchSize;
    }

    return batches;
}

function testTeaLotBenchmarks() {
    return strategicCounts.map(count => `testTeaLot_a${count}`);
}

function testTeaLotBatches(
    participantCount = setupParticipantCount,
    startIndex = Number(process.env.TEST_TEA_LOT_BATCH_START || setupBatchStart)
) {
    const batches = [];
    let start = Math.max(1, Number(startIndex) || 1);
    const total = Math.max(1, Number(participantCount) || 1);

    while (start <= total) {
        const currentBatchSize = Math.min(batchSize, total - start + 1);
        batches.push(`testTeaLot_a${currentBatchSize}_s${start}`);
        start += currentBatchSize;
    }

    return batches;
}

function acceptOfferSetup(participantCount = setupParticipantCount) {
    return makeOfferAllBatches(participantCount);
}

function acceptOfferBenchmark(farmerCount, retailerCount) {
    return `acceptoffer_f${farmerCount}_r${retailerCount}`;
}

function acceptOfferNoMvccBatches(
    participantCount = setupParticipantCount,
    startIndex = Number(process.env.ACCEPT_OFFER_NO_MVCC_BATCH_START || setupBatchStart)
) {
    const batches = [];
    let start = Math.max(1, Number(startIndex) || 1);
    const total = Math.max(1, Number(participantCount) || 1);

    while (start <= total) {
        const currentBatchSize = Math.min(batchSize, total - start + 1);
        batches.push(`acceptoffer_no_mvcc_f${currentBatchSize}_r${currentBatchSize}_s${start}`);
        start += currentBatchSize;
    }

    return batches;
}

function packSetup(participantCount = setupParticipantCount) {
    return acceptOfferNoMvccBatches(participantCount);
}

function packBenchmarks() {
    return strategicCounts.map(count => `pack_r${count}`);
}

function purchaseSetupBatches(
    participantCount = setupParticipantCount,
    startIndex = Number(process.env.PURCHASE_SETUP_BATCH_START || setupBatchStart)
) {
    const batches = [];
    let start = Math.max(1, Number(startIndex) || 1);
    const total = Math.max(1, Number(participantCount) || 1);

    while (start <= total) {
        const currentBatchSize = Math.min(batchSize, total - start + 1);
        batches.push(`pack_r${currentBatchSize}_s${start}`);
        start += currentBatchSize;
    }

    return batches;
}

function makeOfferBenchmarks(lotCount) {
    return getMakeOfferBenchmarks([lotCount]);
}

function makeOfferAllBenchmarks() {
    return strategicCounts.map(count => `makeofferall_r${count}_f${count}`);
}

const defaultBenchmarkGroups = getBenchmarkGroups();

const defaultBenchmarks = defaultBenchmarkGroups.flatMap(group => group.benchmarks);
const selectedBenchmarks = parseList(
    process.env.LATENCY_BENCHMARKS,
    defaultBenchmarks
);
const setupBatchPatterns = [
    {
        label: 'Submit no-MVCC',
        generated: submitNoMvccSetup(setupParticipantCount),
        pattern: /^submitproduce_(?:no|n0)_mvcc_f\d+_a\d+_s\d+$/i
    },
    {
        label: 'TestTeaLot setup',
        generated: testTeaLotBatches(setupParticipantCount),
        pattern: /^testTeaLot_a\d+_s\d+$/i
    },
    {
        label: 'MakeOfferAll setup',
        generated: makeOfferAllBatches(setupParticipantCount),
        pattern: /^makeofferall_r\d+_f\d+_s\d+$/i
    },
    {
        label: 'AcceptOffer no-MVCC',
        generated: acceptOfferNoMvccBatches(setupParticipantCount),
        pattern: /^acceptoffer_(?:no|n0)_mvcc_f\d+_r\d+_s\d+$/i
    },
    {
        label: 'Purchase pack setup',
        generated: purchaseSetupBatches(setupParticipantCount),
        pattern: /^pack_r\d+_s\d+$/i
    }
].map(item => ({
    ...item,
    selected: selectedBenchmarks.filter(benchmark => item.pattern.test(benchmark))
}));
const selectedBenchmarkSet = new Set(selectedBenchmarks);
const selectedBenchmarkGroups = defaultBenchmarkGroups
    .map(group => ({
        name: group.name,
        benchmarks: group.benchmarks.filter(benchmark => selectedBenchmarkSet.has(benchmark))
    }))
    .filter(group => group.benchmarks.length > 0);

const knownDefaultBenchmarks = new Set(defaultBenchmarks);
const customBenchmarks = selectedBenchmarks.filter(benchmark => !knownDefaultBenchmarks.has(benchmark));
if (customBenchmarks.length > 0) {
    selectedBenchmarkGroups.push({
        name: 'custom',
        benchmarks: customBenchmarks
    });
}

const latencyTpsLevels = parseList(
    process.env.LATENCY_TPS || process.env.TRANSACTION_LOADS || '',
    tpsLoads.map(String)
);
const latencyTpsLevels1 = parseList(
    process.env.LATENCY_TPS || process.env.TRANSACTION_LOADS || '',
    [ '200']
);
const selectedTps = latencyTpsLevels.join(',');
const setupTpsLevels1 = parseList(
    process.env.LATENCY_SETUP_TPS || process.env.SETUP_TRANSACTION_LOADS || process.env.SETUP_TPS_FILTER || '',
    ['500']);
const setupTpsLevels = parseList(
    process.env.LATENCY_SETUP_TPS || process.env.SETUP_TRANSACTION_LOADS || process.env.SETUP_TPS_FILTER || '',
    ['500', '500', '500', '500',]
);
const selectedSetupTps = setupTpsLevels.join(',');
const setupRoundCount = Math.max(1, setupTpsLevels.length);

function repeatSetupTps(value, fallback) {
    const parsed = parseList(value, []);
    if (parsed.length > 1) {
        return parsed.join(',');
    }

    const tps = parsed[0] || fallback;
    return Array.from({ length: setupRoundCount }, () => tps).join(',');
}

function getSetupTpsForBenchmark(benchmarkName) {
    const name = String(benchmarkName || '').toLowerCase();

    if (/^submitproduce_(?:no|n0)_mvcc_/.test(name)) {
        return repeatSetupTps(process.env.LATENCY_SUBMIT_NO_MVCC_TPS, '500');
    }

    if (/^testTeaLot_a\d+_s\d+$/.test(name)) {
        return repeatSetupTps(process.env.LATENCY_TESTTEALOT_SETUP_TPS, '450');
    }

    if (/^makeofferall.*_s\d+$/.test(name)) {
        return repeatSetupTps(process.env.LATENCY_MAKEOFFERALL_SETUP_TPS, '400');
    }

    if (/^acceptoffer_(?:no|n0)_mvcc_/.test(name)) {
        return repeatSetupTps(process.env.LATENCY_ACCEPT_NO_MVCC_TPS, '350');
    }

    if (/^pack_r\d+_s\d+$/.test(name)) {
        return repeatSetupTps(process.env.LATENCY_PACK_SETUP_TPS, '300');
    }

    return selectedSetupTps;
}
const cleanupNetem = !['0', 'false', 'no'].includes(
    String(process.env.LATENCY_CLEANUP || 'true').toLowerCase()
);
const continueOnBenchmarkError = !['0', 'false', 'no'].includes(
    String(process.env.LATENCY_CONTINUE_ON_ERROR || 'true').toLowerCase()
);

function supportsPreloadCache(benchmarkName) {
    const name = String(benchmarkName || '').toLowerCase();

    return /^testTeaLot_a\d+(?:_s\d+)?$/.test(name) ||
        /^acceptoffer_f\d+_r\d+(?:_s\d+)?$/.test(name) ||
        /^makeoffer_r\d+(?:_\d+)?(?:_s\d+)?$/.test(name) ||
        /^makeofferall(?:_r\d+_f\d+|_f\d+_r\d+)?(?:_s\d+)?$/.test(name) ||
        /^pack_r\d+(?:_s\d+)?$/.test(name) ||
        /^purchase_c\d+(?:_r\d+)?$/.test(name);
}

function shouldPreloadChunk(chunk, activeLatency) {
    if (!usePreloadCache || chunk.noLatency || Number(activeLatency) === 0) {
        return false;
    }

    return chunk.benchmarks.every(supportsPreloadCache);
}

function isPurchaseChunk(chunk) {
    return chunk.benchmarks.every(benchmark => /^purchase_c\d+(?:_r\d+)?$/i.test(benchmark));
}

function runBenchmarks(chunk, activeLatency, activeJitter, activeLoss, extraEnv = {}) {
    const env = {
        ...process.env,
        CHANNEL_NAME: channelName,
        CHAINCODE_NAME: chaincodeName,
        WORKLOAD_DIR: workloadDir,
        NETEM_LATENCY: activeLatency,
        NETEM_JITTER: activeJitter,
        NETEM_LOSS: activeLoss,
        CALIPER_WORKERS: caliperWorkers,
        LOAD_STAGGER_MS: loadStaggerMs,
        NO_PROGRESS_TIMEOUT_SECONDS: noProgressTimeoutSeconds,
        BENCHMARK_FILTER: chunk.benchmarks.join(','),
        PRELOAD_CACHE_DIR: preloadCacheDir,
        ...extraEnv
    };

    if (selectedTps && !extraEnv.TRANSACTION_LOADS) {
        env.TRANSACTION_LOADS = selectedTps;
    }

    const benchmarkSetupTps = getSetupTpsForBenchmark(chunk.benchmarks[0]);
    if (benchmarkSetupTps) {
        env.SETUP_TRANSACTION_LOADS = benchmarkSetupTps;
        console.log(`Setup TPS for ${chunk.benchmarks.join(', ')}: ${benchmarkSetupTps}`);
    }

    return runCommand(
        process.execPath,
        ['run-alternate.js', activeLatency, activeJitter, activeLoss, caliperWorkers],
        { cwd: caliperDir, env, continueOnError: continueOnBenchmarkError }
    );
}

console.log('Latency preload matrix runner');
console.log(`Channel        : ${channelName}`);
console.log(`Chaincode      : ${chaincodeName}`);
console.log(`Workload dir   : ${workloadDir}`);
console.log(`Preload cache  : ${usePreloadCache ? preloadCacheDir : 'disabled'}`);
console.log(`Latencies      : ${latencyLevels.join(', ')} ms`);
console.log(`Jitter         : ${jitterMs} ms`);
console.log(`Packet loss    : ${lossPercent}%`);
console.log(`Caliper workers: ${caliperWorkers}`);
console.log(`Load stagger   : ${loadStaggerMs} ms per worker`);
console.log(`Benchmarks     : ${selectedBenchmarks.join(', ')}`);
console.log(`Group order    : ${selectedBenchmarkGroups.map(group => group.name).join(' -> ')}`);
console.log(`TPS filter     : ${selectedTps || 'run.js default'}`);
console.log(`Setup TPS      : ${selectedSetupTps || 'run.js default'}`);
console.log(`Continue errors: ${continueOnBenchmarkError}`);
console.log(`Setup batch start: ${setupBatchStart || 1}`);
for (const setupBatch of setupBatchPatterns) {
    console.log(`${setupBatch.label} batches generated: ${setupBatch.generated.join(', ')}`);
    console.log(`${setupBatch.label} batches selected : ${setupBatch.selected.length > 0 ? setupBatch.selected.join(', ') : 'none'}`);
    if (
        process.env.LATENCY_BENCHMARKS &&
        setupBatch.selected.length > 0 &&
        setupBatch.selected.length < setupBatch.generated.length
    ) {
        console.warn(`⚠️ LATENCY_BENCHMARKS is filtering ${setupBatch.label} batches; unset it to run the full generated setup list.`);
    }
}

try {
    for (const latencyMs of latencyLevels) {
        console.log(`\n################ Latency level: ${latencyMs} ms ################`);

        for (const group of selectedBenchmarkGroups) {
            console.log(`\n################ Benchmark group: ${group.name} ################`);
            console.log(`Group benchmarks: ${group.benchmarks.join(', ')}`);
            console.log(`\n================ ${group.name} @ Latency ${latencyMs} ms ================`);

            for (const chunk of splitBenchmarksByLatencyMode(group.benchmarks)) {
                const activeLatency = chunk.noLatency ? '0' : latencyMs;
                const activeJitter = chunk.noLatency ? '0' : jitterMs;
                const activeLoss = chunk.noLatency ? '0' : lossPercent;
                const modeLabel = chunk.noLatency ? 'no latency setup' : `${latencyMs} ms latency`;

                console.log(`\n---- Running ${modeLabel}: ${chunk.benchmarks.join(', ')} ----`);

                if (shouldPreloadChunk(chunk, activeLatency)) {
                    console.log(`\n---- Preloading with netem off: ${chunk.benchmarks.join(', ')} ----`);
                    applyNetem('0');
                    const preloadSucceeded = runBenchmarks(chunk, '0', '0', '0', {
                        PRELOAD_CACHE_MODE: 'write',
                        PRELOAD_ONLY: '1',
                        ...(isPurchaseChunk(chunk) ? {
                            TRANSACTION_LOADS: '1',
                            PURCHASE_TX_DURATION_SECONDS: '1'
                        } : {})
                    });

                    if (!preloadSucceeded) {
                        console.warn(`⚠️ Preload failed; skipping benchmark: ${chunk.benchmarks.join(', ')}`);
                        continue;
                    }

                    console.log(`\n---- Running from preload cache under ${modeLabel}: ${chunk.benchmarks.join(', ')} ----`);
                    applyNetem(activeLatency);
                    runBenchmarks(chunk, activeLatency, activeJitter, activeLoss, {
                        PRELOAD_CACHE_MODE: 'read',
                        PRELOAD_ONLY: '0'
                    });
                } else {
                    applyNetem(activeLatency);
                    runBenchmarks(chunk, activeLatency, activeJitter, activeLoss, {
                        PRELOAD_CACHE_MODE: '',
                        PRELOAD_ONLY: '0'
                    });
                }
            }
        }
    }
} finally {
    if (cleanupNetem) {
        console.log('\n================ Removing network latency ================');
        runCommand(
            channelStackScript,
            [channelName, 'netem', chaincodeName, '0', '0', '0', caliperWorkers],
            { cwd: rootDir }
        );
    }
}
