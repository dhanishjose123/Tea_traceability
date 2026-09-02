'use strict';

const path = require('path');
const matrix = require('./experiment-matrix-alternate');

const caliperDir = __dirname;

function parseList(value, fallback = []) {
    const parsed = String(value || '')
        .split(',')
        .map(item => item.trim())
        .filter(Boolean);

    return parsed.length > 0 ? parsed : fallback;
}

function uniqueList(items) {
    return [...new Set(items.filter(Boolean))];
}

function isEnabled(value, defaultValue = false) {
    if (value === undefined || value === null || value === '') {
        return defaultValue;
    }

    return !['0', 'false', 'no'].includes(String(value).toLowerCase());
}

function getGroupBenchmarks(groupName) {
    const key = String(groupName || '').toLowerCase();

    if (key === 'submitproduce' || key === 'submit') {
        return matrix.submitProduceBenchmarks();
    }

    if (key === 'submitproduce-setup' || key === 'submit-setup' || key === 'submit-no-mvcc') {
        return matrix.submitProduceNoMvccSetup(matrix.setupParticipantCount);
    }

    if (key === 'testTeaLot' || key === 'test') {
        return matrix.testTeaLotBenchmarks();
    }

    if (key === 'testTeaLot-setup' || key === 'test-setup') {
        return matrix.testTeaLotSetup(matrix.setupParticipantCount);
    }

    if (key === 'makeofferall' || key === 'makeoffer-setup') {
        return matrix.makeOfferAllSetup(matrix.setupParticipantCount);
    }

    if (key === 'acceptoffer' || key === 'accept') {
        return matrix.acceptOfferBenchmarks();
    }

    if (key === 'acceptoffer-setup' || key === 'accept-setup' || key === 'accept-no-mvcc') {
        return matrix.acceptOfferNoMvccSetup(matrix.setupParticipantCount);
    }

    if (key === 'pack') {
        return matrix.packBenchmarks();
    }

    if (key === 'pack-setup') {
        return matrix.packSetup(matrix.setupParticipantCount);
    }

    if (key === 'purchase') {
        return matrix.purchaseBenchmarks();
    }

    if (key === 'all') {
        return matrix.allBenchmarks();
    }

    console.warn(`Unknown alternate function group ignored: ${groupName}`);
    return [];
}

function resolveBenchmarks() {
    const allowEnvSelection = isEnabled(process.env.ALTERNATE_ALLOW_ENV_BENCHMARKS, false);

    if (!allowEnvSelection) {
        return uniqueList(matrix.benchmarkGroups().flatMap(group => group.benchmarks));
    }

    const exactBenchmarks = parseList(
        process.env.LATENCY_BENCHMARKS ||
        process.env.BENCHMARK_FILTER ||
        process.env.ALTERNATE_BENCHMARKS ||
        ''
    );

    if (exactBenchmarks.length > 0) {
        return exactBenchmarks;
    }

    const groups = parseList(
        process.env.ALTERNATE_FUNCTIONS ||
        process.env.LATENCY_FUNCTIONS ||
        process.env.FUNCTIONS ||
        'all'
    );

    return uniqueList(groups.flatMap(getGroupBenchmarks));
}

const selectedBenchmarks = resolveBenchmarks();
const envBenchmarkSelectionEnabled = isEnabled(process.env.ALTERNATE_ALLOW_ENV_BENCHMARKS, false);
const channelName = process.argv[2] || process.env.CHANNEL_NAME || matrix.channelName;
const workloadDir = process.env.WORKLOAD_DIR || 'workload_9_cache_5';
const preloadCacheDir = process.env.PRELOAD_CACHE_DIR ||
    path.join(caliperDir, 'tmp', 'preload-cache-alternate');

process.env.CHANNEL_NAME = channelName;
process.env.WORKLOAD_DIR = workloadDir;
process.env.PRELOAD_CACHE_DIR = preloadCacheDir;
process.env.LATENCY_BENCHMARKS = selectedBenchmarks.join(',');
process.env.LATENCY_LEVELS = process.env.LATENCY_LEVELS || matrix.latencyLevels.join(',');
process.env.TRANSACTION_LOADS = process.env.TRANSACTION_LOADS || process.env.LATENCY_TPS || matrix.tpsLoads.join(',');
process.env.CALIPER_WORKERS = process.env.CALIPER_WORKERS || 'auto';
process.env.ALTERNATE_LOGICAL_WORKERS = process.env.ALTERNATE_LOGICAL_WORKERS || '5';
process.env.ALTERNATE_SUBMIT_WORKERS = process.env.ALTERNATE_SUBMIT_WORKERS || process.env.ALTERNATE_LOGICAL_WORKERS;
process.env.SUBMITPRODUCE_FARMER_SELECTION_MODE = process.env.SUBMITPRODUCE_FARMER_SELECTION_MODE || 'random';
process.env.SUBMITPRODUCE_AGGREGATOR_SELECTION_MODE = process.env.SUBMITPRODUCE_AGGREGATOR_SELECTION_MODE || 'paired';
process.env.ACCEPT_OFFER_RETAILER_SELECTION_MODE = process.env.ACCEPT_OFFER_RETAILER_SELECTION_MODE || 'paired';

console.log('Alternate latency preload matrix runner');
console.log(`Channel        : ${process.env.CHANNEL_NAME}`);
console.log(`Workload dir   : ${process.env.WORKLOAD_DIR}`);
console.log(`Preload cache  : ${process.env.PRELOAD_CACHE_DIR}`);
console.log(`Batch size     : ${matrix.batchSize}`);
console.log(`Logical workers: ${process.env.ALTERNATE_LOGICAL_WORKERS}`);
console.log(`Submit workers : ${process.env.ALTERNATE_SUBMIT_WORKERS}`);
console.log(`Submit farmers : ${process.env.SUBMITPRODUCE_FARMER_SELECTION_MODE}`);
console.log(`Submit aggregators: ${process.env.SUBMITPRODUCE_AGGREGATOR_SELECTION_MODE}`);
console.log(`Accept retailers: ${process.env.ACCEPT_OFFER_RETAILER_SELECTION_MODE}`);
console.log(`Env benchmark overrides: ${envBenchmarkSelectionEnabled ? 'enabled' : 'disabled'}`);
console.log(`Latencies      : ${process.env.LATENCY_LEVELS}`);
console.log(`TPS levels     : ${process.env.TRANSACTION_LOADS}`);
console.log(`Benchmarks     : ${process.env.LATENCY_BENCHMARKS}`);
console.log('Delegating to  : run-latency-preload-matrix-alternate-core.js');

require('./run-latency-preload-matrix-alternate-core');
