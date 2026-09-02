'use strict';

const path = require('path');

const rootDir = __dirname;
const benchmarks = [
    'submitproduce_no_mvcc_f5_a5_s1',
    'testTeaLot_a5_s1',
    'makeofferall_r5_f5_s1',
    'acceptoffer_no_mvcc_f5_r5_s1',
    'pack_r5'
];

process.env.WORKLOAD_DIR = 'workload_9_cached_100kg';
process.env.PRELOAD_CACHE_DIR = path.join(rootDir, 'tmp', 'preload-cache-100kg');
process.env.LATENCY_BENCHMARKS = benchmarks.join(',');

console.log('Exclusive 100 kg latency pipeline');
console.log(`Channel    : ${process.env.CHANNEL_NAME || 'runner default'}`);
console.log(`Latencies  : ${process.env.LATENCY_LEVELS || 'runner default'}`);
console.log(`Workload   : ${process.env.WORKLOAD_DIR}`);
console.log(`Benchmarks : ${process.env.LATENCY_BENCHMARKS}`);

require('./run-latency-preload-matrix');
