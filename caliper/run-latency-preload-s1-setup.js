'use strict';

const path = require('path');

const rootDir = __dirname;
const setupSize = Math.max(1, Number(process.env.S1_SETUP_SIZE || 5));
const setupStart = Math.max(1, Number(process.env.S1_SETUP_START || 1));

const benchmarks = [
    `submitproduce_no_mvcc_f${setupSize}_a${setupSize}_s${setupStart}`,
    `testTeaLot_a${setupSize}_s${setupStart}`,
    `makeofferall_r${setupSize}_f${setupSize}_s${setupStart}`,
    `acceptoffer_no_mvcc_f${setupSize}_r${setupSize}_s${setupStart}`
];

if (process.env.INCLUDE_PACK_SETUP === '1') {
    benchmarks.push(`pack_r${setupSize}_s${setupStart}`);
}

process.env.WORKLOAD_DIR = process.env.WORKLOAD_DIR || 'workload_9_cached';
process.env.PRELOAD_CACHE_DIR = process.env.PRELOAD_CACHE_DIR ||
    path.join(rootDir, 'tmp', `preload-cache-s${setupStart}-${setupSize}`);
process.env.LATENCY_BENCHMARKS = benchmarks.join(',');

console.log('Custom normal latency setup pipeline (_s1 only)');
console.log(`Channel       : ${process.env.CHANNEL_NAME || process.argv[2] || 'runner default'}`);
console.log(`Latencies     : ${process.env.LATENCY_LEVELS || 'runner default'}`);
console.log(`Workload      : ${process.env.WORKLOAD_DIR}`);
console.log(`Setup start   : ${setupStart}`);
console.log(`Setup size    : ${setupSize}`);
console.log(`Preload cache : ${process.env.PRELOAD_CACHE_DIR}`);
console.log(`Benchmarks    : ${process.env.LATENCY_BENCHMARKS}`);

require('./run-latency-preload-matrix');
