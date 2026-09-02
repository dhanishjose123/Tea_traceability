'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
    latencyLevels1,
    tpsLoads1,
    tpsLoads,
    submitProduceBenchmarks,
    acceptOfferBenchmarks,
    purchaseBenchmarks,
    submitProduceBenchmarks1,
    acceptOfferBenchmarks1,
    purchaseBenchmarks1,
    testTeaLotBenchmarks,
    makeOfferBenchmarks,
    packBenchmarks,
    testTeaLotBenchmarks1,
    makeOfferBenchmarks1,
    packBenchmarks1
} = require('./experiment-matrix-alternate');

const desiredHeapMb = Number(process.env.EXTRACT_NODE_MAX_OLD_SPACE_MB || 8192);
const hasHeapArg = process.execArgv.some(arg => arg.startsWith('--max-old-space-size='));

if (!process.env.EXTRACT_HEAP_REEXEC && desiredHeapMb > 0 && !hasHeapArg) {
    const result = spawnSync(
        process.execPath,
        [`--max-old-space-size=${desiredHeapMb}`, __filename, ...process.argv.slice(2)],
        {
            cwd: process.cwd(),
            env: {
                ...process.env,
                EXTRACT_HEAP_REEXEC: '1'
            },
            stdio: 'inherit'
        }
    );

    process.exit(result.status || 0);
}

const XLSX = require('xlsx');

const baseDir = __dirname;
const resultsDir = path.join(baseDir, 'results');
const desktopResultsDir = '/mnt/c/Users/hp/Desktop/dhanish/fabric_2/results';

if (!fs.existsSync(resultsDir)) {
    fs.mkdirSync(resultsDir, { recursive: true });
}

if (!fs.existsSync(desktopResultsDir)) {
    fs.mkdirSync(desktopResultsDir, { recursive: true });
}

const separateOutputFiles = String(process.env.EXTRACT_SEPARATE_FILENAMES || 'true').toLowerCase() !== 'false';
const requestedLogRootsValue = process.env.EXTRACT_LOG_ROOTS || process.env.EXTRACT_LOG_FOLDERS || '';
const requestedLogRoots = String(requestedLogRootsValue)
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
function inferOutputSuffixFromLogRoots(logRoots) {
    if (logRoots.length === 0 || logRoots.includes('logs_9_cache_5')) {
        return '5';
    }

    const singleRootMatch = logRoots.length === 1 && logRoots[0].match(/^logs_(\d+)$/);
    if (singleRootMatch) {
        return singleRootMatch[1];
    }

    return '1';
}

const outputSuffix = process.env.EXTRACT_OUTPUT_SUFFIX || inferOutputSuffixFromLogRoots(requestedLogRoots);
const outputSuffixFolderName = `_${outputSuffix}`;
const suffixResultsDir = path.join(resultsDir, outputSuffixFolderName);
const desktopSuffixResultsDir = path.join(desktopResultsDir, outputSuffixFolderName);
const combinedResultsDir = path.join(resultsDir, 'combining');
const desktopCombinedResultsDir = path.join(desktopResultsDir, 'combining');
const defaultLogRoots = outputSuffix === '5' ? 'logs_9_cache_5' : '';
const extractLogRoots = requestedLogRoots.length > 0
    ? requestedLogRoots
    : String(defaultLogRoots)
        .split(',')
        .map(item => item.trim())
        .filter(Boolean);
const outputName = name => {
    if (!separateOutputFiles) {
        return name;
    }

    const ext = path.extname(name);
    const stem = name.slice(0, -ext.length);
    return `${stem}_${outputSuffix}${ext}`;
};

if (separateOutputFiles) {
    fs.mkdirSync(suffixResultsDir, { recursive: true });
    fs.mkdirSync(desktopSuffixResultsDir, { recursive: true });
    fs.mkdirSync(combinedResultsDir, { recursive: true });
    fs.mkdirSync(desktopCombinedResultsDir, { recursive: true });
}

function safeDesktopOperation(description, operation) {
    try {
        operation();
        return true;
    } catch (error) {
        console.warn(`⚠️ Could not ${description}: ${error.message}`);
        return false;
    }
}

function safeCopyToDesktop(sourcePath, destinationPath) {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
            fs.copyFileSync(sourcePath, destinationPath);
            return true;
        } catch (error) {
            if (attempt === 2) {
                console.warn(`⚠️ Could not copy ${path.basename(sourcePath)} to Desktop results: ${error.message}`);
                return false;
            }
        }
    }

    return false;
}

const masterWorkbookFile = path.join(resultsDir, 'throughput_results_all.xlsx');
const outputMasterWorkbookFile = path.join(resultsDir, outputName('throughput_results_all.xlsx'));
const workbookFile = path.join(resultsDir, outputName('throughput_results_by_function.xlsx'));
const missingCombinationsWorkbookFile = path.join(resultsDir, outputName('throughput_missing_combinations.xlsx'));
const functionPresenceWorkbookFile = path.join(resultsDir, outputName('throughput_function_presence.xlsx'));
const avgLatencyMissingWorkbookFile = path.join(resultsDir, outputName('throughput_avg_latency_missing.xlsx'));
const complexityFile = path.join(resultsDir, 'function_complexity.csv');
const readWriteSummaryFile = path.join(resultsDir, 'reads.txt');
const payloadSizesFile = path.join(resultsDir, 'payload_sizes.csv');
const maxLogReadBytes = Number(process.env.EXTRACT_MAX_LOG_READ_BYTES || 25 * 1024 * 1024);
const extractTxDurationSeconds = Number(process.env.EXTRACT_TX_DURATION_SECONDS || 5);
const stakeholderColumns = [
    'numFarmers',
    'numAggregators',
    'numRetailers',
    'numConsumers',
    'numBankUsers'
];
if (!separateOutputFiles) {
    const generatedOutputFiles = [
        'throughput_results_all.csv',
        'throughput_results_all_unfiltered.csv',
        'throughput_results_all_unfiltered.xlsx',
        'throughput_results_by_latency.xlsx',
    ];

    for (const file of fs.readdirSync(resultsDir)) {
        if (/^throughput_results_latency_.*\.xlsx$/.test(file) || generatedOutputFiles.includes(file)) {
            fs.rmSync(path.join(resultsDir, file), { force: true });
        }
    }

    safeDesktopOperation(`clean generated files in ${desktopResultsDir}`, () => {
        for (const file of fs.readdirSync(desktopResultsDir)) {
            if (/^throughput_results_latency_.*\.xlsx$/.test(file) || generatedOutputFiles.includes(file)) {
                fs.rmSync(path.join(desktopResultsDir, file), { force: true });
            }
        }
    });
}

function countOrgUsers(orgName) {
    const usersDir = path.resolve(
        baseDir,
        '../fabric-test/test-network/organizations/peerOrganizations',
        `${orgName}.example.com`,
        'users'
    );

    if (!fs.existsSync(usersDir)) {
        return 0;
    }

    return fs.readdirSync(usersDir)
        .filter(entry => /^User\d+@/.test(entry))
        .filter(entry => fs.statSync(path.join(usersDir, entry)).isDirectory())
        .length;
}

function getStakeholderCounts() {
    return {
        numFarmers: countOrgUsers('farmers'),
        numAggregators: countOrgUsers('aggregators'),
        numRetailers: countOrgUsers('retailers'),
        numConsumers: countOrgUsers('consumers'),
        numBankUsers: countOrgUsers('bank')
    };
}

function getStakeholderValuesForFunction(functionName) {
    const values = Object.fromEntries(stakeholderColumns.map(column => [column, 0]));
    const matrixMatch = String(functionName || '').match(/submitproduce(?:_(?:no|n0)_mvcc)?_f(\d+)_a(\d+)(?:_s\d+)?$/i);
    const aggregatorMatch = String(functionName || '').match(/submitproduce_agg(\d+)$/i);
    const testTeaLotMatch = String(functionName || '').match(/testTeaLot_a(\d+)(?:_s(\d+))?$/i);
    const makeOfferMatch = String(functionName || '').match(/makeoffer_r(\d+)(?:_(\d+))?(?:_s\d+)?$/i);
    const packMatch = String(functionName || '').match(/^(?:pack|pack\d+kg)_r(\d+)(?:_s\d+)?$/i);
    const purchaseMatch = String(functionName || '').match(/^purchase_c(\d+)_r(\d+)(?:_s\d+)?$/i);
    const acceptOfferMatch = String(functionName || '').match(/acceptoffer(?:_(?:no|n0)_mvcc)?_f(\d+)_r(\d+)(?:_s\d+)?$/i);

    if (matrixMatch) {
        values.numFarmers = matrixMatch[1];
        values.numAggregators = matrixMatch[2];
    } else if (acceptOfferMatch) {
        values.numFarmers = acceptOfferMatch[1];
        values.numRetailers = acceptOfferMatch[2];
    } else if (aggregatorMatch) {
        values.numAggregators = aggregatorMatch[1];
    } else if (testTeaLotMatch) {
        values.numAggregators = testTeaLotMatch[1];
    } else if (makeOfferMatch) {
        values.numRetailers = makeOfferMatch[1];
    } else if (packMatch) {
        values.numRetailers = packMatch[1];
    } else if (purchaseMatch) {
        values.numConsumers = purchaseMatch[1];
        values.numRetailers = purchaseMatch[2];
    }

    return stakeholderColumns.map(column => values[column]);
}

function getCaliperWorkersForFunction(functionName) {
    const name = String(functionName || '').trim().toLowerCase();

    const submitProduceMatch = name.match(/^submitproduce(?:_(?:no|n0)_mvcc)?_f(\d+)_a(\d+)(?:_s\d+)?$/);
    if (submitProduceMatch) {
        return submitProduceMatch[1];
    }

    const acceptOfferMatch = name.match(/^acceptoffer(?:_(?:no|n0)_mvcc)?_f(\d+)_r(\d+)(?:_s\d+)?$/);
    if (acceptOfferMatch) {
        return acceptOfferMatch[1];
    }

    const purchaseMatch = name.match(/^purchase_c(\d+)_r(\d+)(?:_s\d+)?$/);
    if (purchaseMatch) {
        return purchaseMatch[1];
    }

    const oneDimensionalMatch = name.match(/^(?:testTeaLot_a|makeoffer_r|pack(?:\d+kg)?_r)(\d+)(?:_\d+)?(?:_s\d+)?$/);
    if (oneDimensionalMatch) {
        return oneDimensionalMatch[1];
    }

    if (name === 'makeofferall') {
        return '24';
    }

    return '0';
}

function findLogFolders() {
    const folders = [];

    function walkLogs(currentPath, parts) {
        const stat = fs.statSync(currentPath);
        if (!stat.isDirectory()) {
            return;
        }

        const currentName = parts[parts.length - 1] || '';
        if (currentName.startsWith('logs') && parts.length > 0) {
            const childDirs = fs.readdirSync(currentPath)
                .filter(child => {
                    const childPath = path.join(currentPath, child);
                    return fs.statSync(childPath).isDirectory();
                });

            const hasNestedLogDirs = childDirs.some(child => child.startsWith('logs') || child.startsWith('netem_'));
            if (!hasNestedLogDirs) {
                folders.push({
                    displayName: parts.join('/'),
                    resultName: parts.join('_'),
                    path: currentPath
                });
                return;
            }
        }

        for (const child of fs.readdirSync(currentPath).sort()) {
            const childPath = path.join(currentPath, child);
            if (!fs.statSync(childPath).isDirectory()) {
                continue;
            }

            if (child.startsWith('logs') || child.startsWith('netem_')) {
                walkLogs(childPath, [...parts, child]);
            }
        }
    }

    for (const item of fs.readdirSync(baseDir).sort()) {
        const fullPath = path.join(baseDir, item);

        if (extractLogRoots.length > 0 && !extractLogRoots.includes(item)) {
            continue;
        }

        if (fs.existsSync(fullPath) && fs.statSync(fullPath).isDirectory() && item.startsWith('logs')) {
            walkLogs(fullPath, [item]);
        }
    }

    return folders.sort((left, right) => left.displayName.localeCompare(right.displayName));
}

const logFolders = findLogFolders();

console.log('📂 Found folders:', logFolders.map(folder => folder.displayName));

if (logFolders.length === 0) {
    console.warn(`No log folders matched EXTRACT_LOG_ROOTS=${extractLogRoots.length > 0 ? extractLogRoots.join(',') : 'all logs* folders'}`);
}

const seenRows = new Set();
const workbookRows = [];
const generatedExcelFiles = [];

const masterColumns = [
    'functionName',
    'lotWeightKg',
    'load',
    'numCaliperWorkers',
    'hotKeyWrites',
    'hotParticipants',
    'ledgerWrites',
    'reads',
    'payloadBytes',
    'sendRate',
    'success',
    'failures',
    'totalTransactions',
    'throughput',
    'failureRate',
    'latency',
    'avgLatency'
];

function normalizeOutputFunctionName(functionName) {
    const name = String(functionName || '').trim();
    const bareMakeOfferMatch = name.match(/^makeoffer_r(\d+)$/i);

    if (bareMakeOfferMatch) {
        return `makeoffer_r${bareMakeOfferMatch[1]}_1`;
    }

    const makeOfferOneMatch = name.match(/^makeoffer_r(\d+)_1$/i);
    if (makeOfferOneMatch) {
        return `makeoffer_r${makeOfferOneMatch[1]}_1`;
    }

    return name;
}

function normalizeRowObject(row) {
    const aliases = {
        avgLatency: ['avgLatency', 'avg latency', 'Avg Latency', 'Avg Latency (s)', 'avgLatencySeconds']
    };

    return Object.fromEntries(masterColumns.map(column => [
        column,
        column === 'functionName'
            ? normalizeOutputFunctionName((aliases[column] || [column]).reduce(
                (value, key) => value !== '' && value !== undefined && value !== null
                    ? value
                    : row?.[key],
                ''
            ))
            : column === 'lotWeightKg'
            ? (row?.[column] || 10)
            : (aliases[column] || [column]).reduce(
                (value, key) => value !== '' && value !== undefined && value !== null
                    ? value
                    : row?.[key],
                ''
            )
    ]));
}

function rowIdentity(row) {
    return [
        String(row.functionName || '').trim().toLowerCase(),
        String(row.lotWeightKg || 10).trim(),
        String(row.load || '').trim(),
        String(row.latency || '0').trim()
    ].join('||');
}

function dedupeRows(rows) {
    const byKey = new Map();

    for (const row of rows) {
        const normalized = normalizeRowObject(row);
        const key = rowIdentity(normalized);

        if (!normalized.functionName || !normalized.load) {
            continue;
        }

        byKey.set(key, normalized);
    }

    return [...byKey.values()].sort((left, right) => {
        const functionCompare = String(left.functionName).localeCompare(String(right.functionName));
        if (functionCompare !== 0) {
            return functionCompare;
        }

        const latencyCompare = Number(left.latency || 0) - Number(right.latency || 0);
        if (latencyCompare !== 0) {
            return latencyCompare;
        }

        return Number(left.load || 0) - Number(right.load || 0);
    });
}

function mergeRowsReplacingExisting(existingRows, newRows) {
    const byKey = new Map();
    let replacedExistingRows = 0;
    let duplicateNewRowsRemoved = 0;

    for (const row of existingRows) {
        const normalized = normalizeRowObject(row);
        if (!normalized.functionName || !normalized.load) {
            continue;
        }

        byKey.set(rowIdentity(normalized), normalized);
    }

    for (const row of newRows) {
        const normalized = normalizeRowObject(row);
        if (!normalized.functionName || !normalized.load) {
            continue;
        }

        const key = rowIdentity(normalized);
        const existing = byKey.get(key);
        if (existing && !Object.prototype.hasOwnProperty.call(existing, '__sourceMtimeMs')) {
            replacedExistingRows += 1;
        } else if (existing) {
            const existingMtime = Number(existing.__sourceMtimeMs || 0);
            const newMtime = Number(row.__sourceMtimeMs || 0);
            if (existingMtime > newMtime) {
                duplicateNewRowsRemoved += 1;
                continue;
            }
            duplicateNewRowsRemoved += 1;
        }

        byKey.set(key, {
            ...normalized,
            __sourceMtimeMs: row.__sourceMtimeMs || 0
        });
    }

    const rows = [...byKey.values()]
        .map(({ __sourceMtimeMs, ...row }) => row)
        .sort((left, right) => {
            const functionCompare = String(left.functionName).localeCompare(String(right.functionName));
            if (functionCompare !== 0) {
                return functionCompare;
            }

            const latencyCompare = Number(left.latency || 0) - Number(right.latency || 0);
            if (latencyCompare !== 0) {
                return latencyCompare;
            }

            return Number(left.load || 0) - Number(right.load || 0);
        });

    return { rows, replacedExistingRows, duplicateNewRowsRemoved };
}

function readExistingWorkbookRows(filePath) {
    if (!fs.existsSync(filePath)) {
        return [];
    }

    try {
        const workbook = XLSX.readFile(filePath);
        const sheetName = workbook.SheetNames[0];

        if (!sheetName) {
            return [];
        }

        return XLSX.utils
            .sheet_to_json(workbook.Sheets[sheetName], { defval: '' })
            .map(normalizeRowObject)
            .filter(row => row.functionName && row.load);
    } catch (error) {
        console.warn(`⚠️ Could not read existing workbook for append: ${filePath}`);
        console.warn(`   ${error.message}`);
        return [];
    }
}

const existingMasterWorkbookFile = fs.existsSync(outputMasterWorkbookFile)
    ? outputMasterWorkbookFile
    : masterWorkbookFile;
const existingWorkbookRows = readExistingWorkbookRows(existingMasterWorkbookFile);
if (existingWorkbookRows.length > 0) {
    console.log(`📌 Existing throughput rows loaded for append: ${existingWorkbookRows.length}`);
    console.log(`📌 Existing throughput source: ${existingMasterWorkbookFile}`);
}

function getExpectedLatencies() {
    const envLatencies = String(process.env.EXTRACT_EXPECTED_LATENCIES || latencyLevels1.join(','))
        .split(',')
        .map(value => value.trim())
        .filter(Boolean);
    const latencies = new Set(envLatencies);

    return [...latencies].sort((left, right) => Number(left) - Number(right));
}

const expectedLatencies = getExpectedLatencies();

function getExpectedLoads() {
    return String(
        process.env.EXTRACT_EXPECTED_LOADS ||
        process.env.LATENCY_TPS ||
        process.env.TRANSACTION_LOADS ||
        tpsLoads1.join(',')
    )
        .split(',')
        .map(value => Number(value.trim()))
        .filter(value => Number.isFinite(value) && value > 0);
}

function getZeroThroughputPlaceholderTargets() {
    const configured = String(
        process.env.EXTRACT_ZERO_THROUGHPUT_PLACEHOLDERS ||
        'pack_r10@100,pack_r15@100,pack_r20@50,pack_r20@100,pack_r24@50,pack_r24@100'
    )
        .split(',')
        .map(item => item.trim())
        .filter(Boolean);

    return configured
        .map(item => {
            const [functionName, latency] = item.split('@').map(part => part.trim());
            if (!functionName || latency === undefined || latency === '') {
                return null;
            }
            return {
                functionName: normalizeOutputFunctionName(functionName),
                latency: String(latency)
            };
        })
        .filter(Boolean);
}

function createZeroThroughputPlaceholderRow(functionName, latency, load) {
    const lotWeightKg = 10;
    const refreshedComplexity = getComplexityMetrics(
        process.env.CHAINCODE_NAME || 'tea_traceability',
        functionName
    );
    const readWriteOverride = readWriteOverrides.get(
        normalizeFunctionForComplexity(functionName)
    );
    const normalizedFunction = normalizeFunctionForComplexity(functionName);

    return {
        functionName,
        lotWeightKg,
        load,
        numCaliperWorkers: getCaliperWorkersForFunction(functionName),
        hotKeyWrites: Number(refreshedComplexity.hotKeyWrites || 0),
        hotParticipants: 0,
        ledgerWrites: normalizedFunction === 'pack'
            ? calculatePackLedgerWrites(lotWeightKg)
            : (readWriteOverride ? readWriteOverride.totalWrites : refreshedComplexity.totalWrites || 0),
        reads: readWriteOverride ? readWriteOverride.totalReads : refreshedComplexity.totalReads || 0,
        payloadBytes: payloadMetrics.get(normalizePayloadFunction(functionName)) || 0,
        sendRate: 0,
        success: 0,
        failures: 0,
        totalTransactions: 0,
        throughput: 0,
        failureRate: 0,
        latency: String(latency),
        avgLatency: 0
    };
}

function addZeroThroughputPlaceholders(rows) {
    const byKey = new Map(rows.map(row => [rowIdentity(normalizeRowObject(row)), row]));
    const expectedLoads = getExpectedLoads();

    for (const target of getZeroThroughputPlaceholderTargets()) {
        for (const load of expectedLoads) {
            const placeholder = createZeroThroughputPlaceholderRow(target.functionName, target.latency, load);
            const key = rowIdentity(placeholder);

            if (!byKey.has(key)) {
                byKey.set(key, placeholder);
            }
        }
    }

    return dedupeRows([...byKey.values()]);
}

function parseCsvLine(line) {
    const cells = [];
    let current = '';
    let inQuotes = false;

    for (let index = 0; index < line.length; index++) {
        const char = line[index];
        const next = line[index + 1];

        if (char === '"' && inQuotes && next === '"') {
            current += '"';
            index++;
        } else if (char === '"') {
            inQuotes = !inQuotes;
        } else if (char === ',' && !inQuotes) {
            cells.push(current);
            current = '';
        } else {
            current += char;
        }
    }

    cells.push(current);
    return cells;
}

function normalizeFunctionForComplexity(functionName) {
    const name = normalizeOutputFunctionName(functionName).toLowerCase();

    if (/^submitproduce(?:_(?:no|n0)_mvcc)?_f\d+_a\d+(?:_s\d+)?$/.test(name) || /^submitproduce_agg\d+$/.test(name)) {
        return 'submitproduce';
    }

    if (/^acceptoffer(?:_(?:no|n0)_mvcc)?_f\d+_r\d+$/.test(name)) {
        return 'acceptoffer';
    }

    if (/^testTeaLot_a\d+(?:_s\d+)?$/.test(name)) {
        return 'testTeaLot';
    }

    if (/^makeoffer_r\d+(?:_1)?$/.test(name)) {
        return 'makeoffer';
    }

    if (/^pack(?:\d+kg)?_r\d+$/.test(name)) {
        return 'pack';
    }

    if (/^purchase_c\d+(?:_r\d+)?$/.test(name)) {
        return 'purchase';
    }

    if (/^makeofferall(?:_r\d+_f\d+|_f\d+_r\d+)?$/.test(name)) {
        return 'makeoffer';
    }

    return name;
}

function normalizePayloadFunction(functionName) {
    const name = normalizeOutputFunctionName(functionName).trim().toLowerCase();
    const aliases = {
        submitproduce: 'submitproduce',
        testTeaLot: 'testTeaLot',
        makeoffer: 'makeoffer',
        acceptoffer: 'acceptoffer',
        packlotintopackets: 'pack',
        purchasepacket: 'purchase'
    };

    return aliases[name] || normalizeFunctionForComplexity(name);
}

function loadPayloadMetrics() {
    const totals = new Map();

    if (!fs.existsSync(payloadSizesFile)) {
        console.warn(`Payload file not found: ${payloadSizesFile}`);
        return new Map();
    }

    const lines = fs.readFileSync(payloadSizesFile, 'utf8')
        .split(/\r?\n/)
        .filter(Boolean);

    if (lines.length <= 1) {
        return new Map();
    }

    const header = parseCsvLine(lines[0]).map(column => column.replace(/^\uFEFF/, ''));
    const functionIndex = header.indexOf('function');
    const payloadBytesIndex = header.indexOf('payload_bytes');

    for (const line of lines.slice(1)) {
        const cells = parseCsvLine(line);
        const functionName = normalizePayloadFunction(cells[functionIndex]);
        const payloadBytes = Number(cells[payloadBytesIndex]);

        if (!functionName || !Number.isFinite(payloadBytes)) {
            continue;
        }

        const current = totals.get(functionName) || { sum: 0, count: 0 };
        current.sum += payloadBytes;
        current.count += 1;
        totals.set(functionName, current);
    }

    return new Map([...totals.entries()].map(([functionName, values]) => [
        functionName,
        Math.round((values.sum / values.count) * 100) / 100
    ]));
}

function normalizeFunctionForSheet(functionName) {
    return normalizeFunctionForComplexity(normalizeOutputFunctionName(functionName));
}

function shouldExcludeFunction(functionName) {
    const name = String(functionName || '').toLowerCase();
    return /_s\d+(?:_|$)/.test(name) ||
        /^makeofferall(?:_r\d+_f\d+|_f\d+_r\d+)?(?:_s\d+)?$/.test(name) ||
        /^submitproduce_(?:no|n0)_mv+cc_f\d+_a\d+(?:_s\d+)?$/.test(name) ||
        /^submitprice_(?:no|n0)_mv+cc_f\d+_a\d+$/.test(name) ||
        /^makeoffer_(?:no|n0)_mv+cc(?:_r\d+)?$/.test(name) ||
        /^acceptoffer_(?:no|n0)_mv+cc_f\d+_r\d+(?:_s\d+)?$/.test(name) ||
        /^purchase(?:_c\d+)?$/.test(name) ||
        /^purchase_(?:r)?\d+$/.test(name) ||
        /^purchase_c\d+$/.test(name);
}

function loadComplexityMetrics() {
    const metrics = new Map();

    if (!fs.existsSync(complexityFile)) {
        console.warn(`⚠️ Complexity file not found: ${complexityFile}`);
        return metrics;
    }

    const lines = fs.readFileSync(complexityFile, 'utf8')
        .split(/\r?\n/)
        .filter(Boolean);

    if (lines.length <= 1) {
        return metrics;
    }

    const header = parseCsvLine(lines[0]);
    const columnIndex = Object.fromEntries(header.map((column, index) => [column, index]));

    for (const line of lines.slice(1)) {
        const cells = parseCsvLine(line);
        const chaincode = cells[columnIndex.chaincode] || '';
        const functionName = normalizeFunctionForComplexity(cells[columnIndex.function] || '');
        const totalReads = cells[columnIndex.totalReads] || '0';
        const totalWrites = cells[columnIndex.totalWrites] || '0';
        const writeKeys = cells[columnIndex.writeKeys] || '';
        const hotKeyWrites = writeKeys
            ? writeKeys.split('|').filter(Boolean).length
            : '0';

        metrics.set(`${chaincode}:${functionName}`, {
            hotKeyWrites,
            totalWrites,
            totalReads
        });
    }

    return metrics;
}

function loadReadWriteOverrides() {
    const overrides = new Map();

    if (!fs.existsSync(readWriteSummaryFile)) {
        return overrides;
    }

    const functionNames = {
        submitproduce: 'submitproduce',
        testTeaLot: 'testTeaLot',
        makeoffer: 'makeoffer',
        acceptoffer: 'acceptoffer',
        purchasepacket: 'purchase',
        packlotintopackets: 'pack'
    };
    const lines = fs.readFileSync(readWriteSummaryFile, 'utf8')
        .split(/\r?\n/)
        .filter(Boolean);

    for (const line of lines.slice(1)) {
        const cells = line.split(/\t+/).map(cell => cell.trim());
        const normalized = functionNames[String(cells[0] || '').toLowerCase()];
        if (!normalized) {
            continue;
        }

        const totalReads = Number.parseInt(cells[4], 10);
        const parsedWrites = Number.parseInt(cells[5], 10);
        overrides.set(normalized, {
            totalReads: Number.isFinite(totalReads) ? totalReads : 0,
            totalWrites: normalized === 'pack'
                ? Number(process.env.PACK_LEDGER_WRITES || 58)
                : (Number.isFinite(parsedWrites) ? parsedWrites : 0)
        });
    }

    return overrides;
}

const complexityMetrics = loadComplexityMetrics();
const readWriteOverrides = loadReadWriteOverrides();
const payloadMetrics = loadPayloadMetrics();

function getComplexityMetrics(chaincodeName, functionName) {
    const normalizedFunction = normalizeFunctionForComplexity(functionName);
    const base = complexityMetrics.get(`${chaincodeName}:${normalizedFunction}`) || {
        hotKeyWrites: '0',
        totalWrites: '0',
        totalReads: '0'
    };
    const override = readWriteOverrides.get(normalizedFunction);

    return override ? {
        ...base,
        totalWrites: override.totalWrites,
        totalReads: override.totalReads
    } : base;
}

function getChaincodeNameFromFolder(folder) {
    const nestedMatch = folder.match(/^logs_(\d+)(?:_[^/]*)?(?:\/netem_[^/]+)?\/logs_(?:\d+|multi)$/);
    if (nestedMatch) {
        return `tea_${nestedMatch[1]}`;
    }

    const flatMatch = folder.match(/^logs_\d+_(\d+)$/);

    if (flatMatch) {
        return `tea_${flatMatch[1]}`;
    }

    const rootMatch = folder.match(/^logs_(\d+)(?:_[^/]*)?$/);
    if (rootMatch) {
        return `tea_${rootMatch[1]}`;
    }

    return process.env.CHAINCODE_NAME || '';
}

function getLotWeightFromFolder(folder) {
    const match = String(folder || '').match(/(?:^|[_/])(\d+)kg(?:[_/]|$)/i);
    return match ? Number(match[1]) : 10;
}

function getOutputFunctionName(functionName, lotWeightKg) {
    const name = String(functionName || '');
    const packMatch = name.match(/^pack_r(\d+)(?:_s(\d+))?$/i);

    if (packMatch && Number(lotWeightKg) !== 10) {
        return normalizeOutputFunctionName(`pack${lotWeightKg}kg_r${packMatch[1]}${packMatch[2] ? `_s${packMatch[2]}` : ''}`);
    }

    return normalizeOutputFunctionName(name);
}

function calculatePackLedgerWrites(weightKg) {
    const totalWeightGrams = Number(weightKg || 10) * 1000;
    const packetCount =
        Math.floor(totalWeightGrams * 0.10 / 1000) +
        Math.floor(totalWeightGrams * 0.20 / 500) +
        Math.floor(totalWeightGrams * 0.30 / 250) +
        Math.floor(totalWeightGrams * 0.40 / 100);

    return packetCount + 1;
}

function getNetworkInfoFromFolder(folder) {
    const match = folder.match(/\/netem_([^/]+)ms_([^/]+)ms_([^/]+)pct\//);
    if (!match) {
        return {
            latencyMs: '0',
            jitterMs: '0',
            lossPercent: '0'
        };
    }

    return {
        latencyMs: match[1].replace('p', '.'),
        jitterMs: match[2].replace('p', '.'),
        lossPercent: match[3].replace('p', '.')
    };
}

function parseMetricRow(line) {
    const trimmed = line.trim();

    if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) {
        return null;
    }

    if (trimmed.includes('Name') || trimmed.includes('Throughput (TPS)')) {
        return null;
    }

    if (/^\|[-+\s|]+\|?$/.test(trimmed)) {
        return null;
    }

    const parts = trimmed.split('|').map(x => x.trim()).filter(Boolean);
    if (parts.length < 8) {
        return null;
    }

    const [name, success, fail, sendRate, maxLatency, minLatency, avgLatency, throughput] = parts;
    const successCount = Number(String(success).replace(/,/g, '')) || 0;
    const failureCount = Number(String(fail).replace(/,/g, '')) || 0;
    let totalTransactions = successCount + failureCount;

    const loadMatch = name.match(/(?:Load@|round\d+@)(\d+)/i);
    const roundMatch = name.match(/_round(\d+)@/i);
    const functionMatch = name.match(/^(.*?)(?:_Load@|_round\d+@)/i);
    const funcName = functionMatch ? functionMatch[1] : name;

    return {
        name,
        func: funcName,
        round: roundMatch ? roundMatch[1] : '',
        load: loadMatch ? loadMatch[1] : '',
        totalTransactions,
        rawTotalTransactions: successCount + failureCount,
        success,
        failures: fail,
        sendRate,
        maxLatency,
        minLatency,
        avgLatency,
        throughput
    };
}

function calculateFailureRate(failures, totalTransactions) {
    const failureCount = Number(String(failures || '').replace(/,/g, '')) || 0;
    const total = Number(totalTransactions) || 0;

    if (total <= 0) {
        return 0;
    }

    return failureCount / total;
}

function calculateParsedFailureRate(parsed) {
    const rawTotal = Number(parsed.rawTotalTransactions || parsed.totalTransactions || 0);
    const rawFailureCount = Number(String(parsed.failures || '').replace(/,/g, '')) || 0;
    const rawSuccessCount = rawTotal - rawFailureCount;

    if (rawTotal <= 0) {
        return 0;
    }

    if (String(parsed.func || '').toLowerCase().startsWith('makeoffer')) {
        const halfTotal = rawTotal / 2;
        if (rawFailureCount <= 0 || halfTotal <= 0) {
            return 0;
        }

        const makeOfferFailureRate = rawFailureCount / halfTotal;
        return makeOfferFailureRate > 1
            ? calculateFailureRate(rawFailureCount, rawTotal)
            : makeOfferFailureRate;
    }

    return calculateFailureRate(rawFailureCount, rawTotal);
}

function calculateRowFailureRate(row) {
    const functionName = String(row.functionName || '').toLowerCase();
    const successCount = Number(String(row.success || '').replace(/,/g, '')) || 0;
    const failureCount = Number(String(row.failures || '').replace(/,/g, '')) || 0;
    const total = Number(String(row.totalTransactions || '').replace(/,/g, '')) || (successCount + failureCount);

    if (total <= 0) {
        return 0;
    }

    if (functionName.startsWith('makeoffer')) {
        const halfTotal = total / 2;
        if (failureCount <= 0 || halfTotal <= 0) {
            return 0;
        }

        const makeOfferFailureRate = failureCount / halfTotal;
        return makeOfferFailureRate > 1
            ? calculateFailureRate(failureCount, total)
            : makeOfferFailureRate;
    }

    return calculateFailureRate(failureCount, total);
}

function csvCell(value) {
    const text = String(value ?? '');
    if (/[",\n\r]/.test(text)) {
        return `"${text.replace(/"/g, '""')}"`;
    }
    return text;
}

function getDummyTransactionInfo(logText) {
    function sumMatches(pattern) {
        let total = 0;
        let found = false;
        let match;
        while ((match = pattern.exec(logText)) !== null) {
            total += Number(match[1] || 0);
            found = true;
        }
        return found ? total : null;
    }

    const standardTotal = sumMatches(/Dummy TX\s*:\s*(\d+)/gi);
    const legacyTotal = sumMatches(/Dummy Transactions\s*:\s*(\d+)/gi);

    if (standardTotal !== null || legacyTotal !== null) {
        const count = standardTotal !== null ? standardTotal : legacyTotal;
        return {
            count,
            summary: `total dummy tx in round: ${count}`
        };
    }

    const dummySuccessMatches = logText.match(/\[DUMMY TX\]/g);
    const fallbackCount = dummySuccessMatches ? dummySuccessMatches.length : 0;

    return {
        count: fallbackCount,
        summary: fallbackCount > 0 ? `total dummy tx in round: ${fallbackCount}` : ''
    };
}

function sumLogMetric(logText, patterns) {
    for (const pattern of patterns) {
        let total = 0;
        let found = false;
        let match;

        while ((match = pattern.exec(logText)) !== null) {
            total += Number(match[1] || 0);
            found = true;
        }

        if (found) {
            return total;
        }
    }

    return '';
}

function getPacketLoadInfo(logText) {
    return sumLogMetric(logText, [
        /Packets Loaded\s*:\s*(\d+)/gi,
        /Cached\s+(\d+)\s+AVAILABLE packets/gi
    ]);
}

function getPacketCreatedInfo(logText) {
    return sumLogMetric(logText, [
        /Packets Created In Invocation\s*:\s*(\d+)/gi,
        /Packets Created\s*:\s*(\d+)/gi
    ]);
}

function readLogText(filePath) {
    const stat = fs.statSync(filePath);
    if (stat.size <= maxLogReadBytes) {
        return fs.readFileSync(filePath, 'utf8');
    }

    const fd = fs.openSync(filePath, 'r');
    try {
        const start = Math.max(0, stat.size - maxLogReadBytes);
        const length = stat.size - start;
        const buffer = Buffer.alloc(length);
        fs.readSync(fd, buffer, 0, length, start);
        console.warn(`⚠️ Large log detected, reading last ${Math.round(length / 1024 / 1024)} MB only: ${filePath}`);
        return buffer.toString('utf8');
    } finally {
        fs.closeSync(fd);
    }
}

for (const folder of logFolders) {
    const logDir = folder.path;
    const chaincodeName = getChaincodeNameFromFolder(folder.displayName);
    const lotWeightKg = getLotWeightFromFolder(folder.displayName);

    const files = fs.readdirSync(logDir)
        .filter(file => file.endsWith('.log') && !file.includes('cpu') && !file.includes('docker'))
        .sort();

    for (const file of files) {
        const filePath = path.join(logDir, file);
        const sourceMtimeMs = fs.statSync(filePath).mtimeMs;
        const logText = readLogText(filePath);
        const networkInfo = getNetworkInfoFromFolder(folder.displayName);
        const lines = logText.split(/\r?\n/);

        for (const line of lines) {
            const parsed = parseMetricRow(line);
            if (!parsed) {
                continue;
            }

            if (shouldExcludeFunction(parsed.func)) {
                continue;
            }

            const outputFunctionName = getOutputFunctionName(parsed.func, lotWeightKg);

            const uniqueKey = `${folder.displayName}-${file}-${parsed.name}`;
            if (seenRows.has(uniqueKey)) {
                continue;
            }

            seenRows.add(uniqueKey);
            const complexity = getComplexityMetrics(chaincodeName, parsed.func);
            const stakeholderValues = getStakeholderValuesForFunction(parsed.func);
            const totalParticipants = stakeholderValues.reduce((sum, value) => sum + Number(value || 0), 0);
            const numCaliperWorkers = getCaliperWorkersForFunction(parsed.func);
            let hotParticipants = Number(complexity.hotKeyWrites || 0) > 0
                ? totalParticipants
                : 0;
            const makeOfferMatch2 = String(parsed.func || '').match(/makeoffer_r(\d+)(?:_(\d+))?(?:_s\d+)?$/i);
            if (makeOfferMatch2 && makeOfferMatch2[2]) {
                hotParticipants = Number(makeOfferMatch2[2]);
            }
            const failureRate = calculateParsedFailureRate(parsed);

            const masterRow = [
                outputFunctionName,
                lotWeightKg,
                parsed.load,
                numCaliperWorkers,
                complexity.hotKeyWrites,
                hotParticipants,
                complexity.totalWrites,
                complexity.totalReads,
                payloadMetrics.get(normalizePayloadFunction(parsed.func)) || 0,
                parsed.sendRate,
                parsed.success,
                parsed.failures,
                parsed.totalTransactions,
                parsed.throughput,
                failureRate,
                networkInfo.latencyMs,
                parsed.avgLatency
            ];

            const rowObject = Object.fromEntries(masterColumns.map((column, index) => [column, masterRow[index]]));
            rowObject.__sourceMtimeMs = sourceMtimeMs;

		    const sendRateValue = Number(String(parsed.sendRate || '').replace(/,/g, ''));
	            const throughputValue = Number(String(parsed.throughput || '').replace(/,/g, ''));
	            if (!Number.isFinite(throughputValue) || throughputValue <= 0) {
	                console.log(`⏭️ Skipping ${parsed.name}: throughput=${parsed.throughput}`);
	                continue;
	            }

	            const minimumExpectedTransactions = 0.6 * extractTxDurationSeconds * sendRateValue;
	            if (sendRateValue > 0 && parsed.totalTransactions < minimumExpectedTransactions) {
                console.log(
                    `⏭️ Skipping ${parsed.name}: totalTransactions=${parsed.totalTransactions} < 0.6*${extractTxDurationSeconds}*${sendRateValue}=${minimumExpectedTransactions}`
                );
                continue;
            }

            workbookRows.push(rowObject);
        }
    }

    console.log(`✅ Processed folder: ${folder.displayName}`);
}

function safeSheetName(name, usedNames) {
    const cleaned = String(name || 'Unknown')
        .replace(/[\[\]\*\/\\?:]/g, '_')
        .slice(0, 31) || 'Unknown';

    let candidate = cleaned;
    let counter = 1;
    while (usedNames.has(candidate)) {
        const suffix = `_${counter}`;
        candidate = `${cleaned.slice(0, 31 - suffix.length)}${suffix}`;
        counter += 1;
    }

    usedNames.add(candidate);
    return candidate;
}

function writeWorkbookByFunction(rows, outputFile = workbookFile, collector = generatedExcelFiles) {
    const workbook = XLSX.utils.book_new();
    const usedSheetNames = new Set();

    const functionNames = [...new Set(rows.map(row => normalizeFunctionForSheet(row.functionName || 'Unknown')))].sort();
    if (functionNames.length === 0) {
        const sheet = XLSX.utils.json_to_sheet([], { header: masterColumns });
        XLSX.utils.book_append_sheet(workbook, sheet, safeSheetName('No Data', usedSheetNames));
    }

    for (const functionName of functionNames) {
        const functionRows = rows.filter(row => normalizeFunctionForSheet(row.functionName || 'Unknown') === functionName);
        const sheet = XLSX.utils.json_to_sheet(functionRows, { header: masterColumns });
        XLSX.utils.book_append_sheet(workbook, sheet, safeSheetName(functionName, usedSheetNames));
    }

    XLSX.writeFile(workbook, outputFile);
    collector.push(outputFile);
}

function writeMasterWorkbook(rows, outputFile = masterWorkbookFile, collector = generatedExcelFiles) {
    const workbook = XLSX.utils.book_new();
    const usedSheetNames = new Set();
    const sheet = XLSX.utils.json_to_sheet(rows, { header: masterColumns });
    XLSX.utils.book_append_sheet(workbook, sheet, safeSheetName('All', usedSheetNames));

    XLSX.writeFile(workbook, outputFile);
    collector.push(outputFile);
}

function writeWorkbooksByLatency(rows, targetDir = resultsDir, nameFactory = outputName, collector = generatedExcelFiles) {
    const latencies = [...new Set(rows.map(row => String(row.latency || '0')))]
        .sort((left, right) => Number(left) - Number(right));

    for (const latency of latencies) {
        const workbook = XLSX.utils.book_new();
        const usedSheetNames = new Set();
        const latencyRows = rows.filter(row => String(row.latency || '0') === latency);
        const sheet = XLSX.utils.json_to_sheet(latencyRows, { header: masterColumns });
        XLSX.utils.book_append_sheet(workbook, sheet, safeSheetName('All', usedSheetNames));
        const outputFile = path.join(
            targetDir,
            nameFactory(`throughput_results_latency_${String(latency).replace(/\./g, 'p')}ms.xlsx`)
        );
        XLSX.writeFile(workbook, outputFile);
        collector.push(outputFile);
    }
}

function writeMissingCombinationsWorkbook(rows, outputFile = missingCombinationsWorkbookFile, collector = generatedExcelFiles) {
    const latencies = [...new Set([
        ...expectedLatencies,
        ...rows.map(row => String(row.latency || '0'))
    ])]
        .sort((left, right) => Number(left) - Number(right));
    const expectedLoads = getExpectedLoads();
    const expectedMatrixFunctions = [
        ...submitProduceBenchmarks1(),
        ...acceptOfferBenchmarks1(),
        ...purchaseBenchmarks1()
    ];
    const makeOfferVariants = String(process.env.MAKEOFFER_VARIANTS || '1,2,5,10,20,30,40,50')
        .split(',')
        .map(value => Number(value.trim()))
        .filter(value => Number.isFinite(value) && value > 0);
    const makeOfferCounts = makeOfferBenchmarks1()
        .map(normalizeOutputFunctionName)
        .map(functionName => functionName.match(/^makeoffer_r(\d+)(?:_\d+)?$/i))
        .filter(Boolean)
        .map(match => Number(match[1]));
    const expectedMakeOfferFunctions = [
        ...makeOfferCounts.map(retailerCount => `makeoffer_r${retailerCount}_5`),
        ...makeOfferVariants.map(variant => `makeoffer_r5_${variant}`)
    ];
    const observedMakeOfferFunctions = rows
        .map(row => normalizeOutputFunctionName(row.functionName))
        .filter(functionName => /^makeoffer_r\d+(?:_\d+)?$/i.test(functionName))
        .filter(functionName => /^makeoffer_r\d+_5$/i.test(functionName) || /^makeoffer_r5_\d+$/i.test(functionName));
    const expectedCountFunctions = [
        ...testTeaLotBenchmarks1(),
        ...expectedMakeOfferFunctions,
        ...observedMakeOfferFunctions,
        ...packBenchmarks1()
    ].map(normalizeOutputFunctionName);
    const expectedFunctions = [...expectedMatrixFunctions, ...expectedCountFunctions];
    const expectedLoadSet = new Set(expectedLoads);
    const expectedMatrixFunctionSet = new Set(expectedMatrixFunctions);
    const expectedCountFunctionSet = new Set(expectedCountFunctions);
    const isMatrixFunction = functionName =>
        /^submitproduce_f\d+_a\d+$/.test(functionName) ||
        /^acceptoffer_f\d+_r\d+$/.test(functionName) ||
        /^purchase_c\d+_r\d+$/.test(functionName);
    const isCountFunction = functionName =>
        /^testTeaLot_a\d+$/.test(functionName) ||
        /^makeoffer_r\d+(?:_\d+)?$/.test(functionName) ||
        /^pack_r\d+$/.test(functionName);
    const isWeightedPackVariant = functionName =>
        /^pack\d+kg_r\d+(?:_s\d+)?$/i.test(functionName);
    const observedCombinationKeys = rows
        .map(row => ({ ...row, functionName: normalizeOutputFunctionName(row.functionName) }))
        .filter(row => !isWeightedPackVariant(row.functionName))
        .filter(row => expectedLoadSet.has(Number(row.load)))
        .filter(row => !isMatrixFunction(row.functionName) || expectedMatrixFunctionSet.has(row.functionName))
        .filter(row => !isCountFunction(row.functionName) || expectedCountFunctionSet.has(row.functionName))
        .map(row => `${row.functionName}||${row.load}`);
    const expectedCombinationKeys = expectedFunctions.flatMap(functionName =>
        expectedLoads.map(load => `${functionName}||${load}`)
    );
    const combinations = [...new Set([...observedCombinationKeys, ...expectedCombinationKeys])]
        .map(key => {
            const [functionName, load] = key.split('||');
            return { functionName, load };
        })
        .sort((left, right) => {
            const functionCompare = left.functionName.localeCompare(right.functionName);
            if (functionCompare !== 0) {
                return functionCompare;
            }

            return Number(left.load) - Number(right.load);
        });
    const existing = new Set(rows.map(row =>
        `${normalizeOutputFunctionName(row.functionName)}||${row.load}||${row.latency}`
    ));
    const expectedLatenciesForFunction = functionName => {
        if (/^makeoffer_r\d+_5$/i.test(functionName)) {
            return new Set(latencies);
        }

        return new Set(latencies);
    };
    const latencyColumns = latencies.map(latency => `${latency}ms`);
    const headers = [...latencyColumns, 'functionName', 'load', 'missingCount'];
    const table = [headers];

    for (const combination of combinations) {
        const row = [];
        let missingCount = 0;

        const expectedLatencySet = expectedLatenciesForFunction(combination.functionName);
        for (const latency of latencies) {
            if (!expectedLatencySet.has(String(latency))) {
                row.push('');
                continue;
            }
            const isPresent = existing.has(`${combination.functionName}||${combination.load}||${latency}`);
            row.push(isPresent ? 'OK' : 'MISSING');
            if (!isPresent) {
                missingCount += 1;
            }
        }

        row.push(combination.functionName, combination.load);
        row.push(missingCount);
        if (missingCount === 0) {
            continue;
        }
        table.push(row);
    }

    const workbook = XLSX.utils.book_new();
    const sheet = XLSX.utils.aoa_to_sheet(table);
    const range = XLSX.utils.decode_range(sheet['!ref']);
    const missingFill = { patternType: 'solid', fgColor: { rgb: 'FFFF0000' } };
    const presentFill = { patternType: 'solid', fgColor: { rgb: 'FFC6EFCE' } };
    const headerFill = { patternType: 'solid', fgColor: { rgb: 'FFD9EAF7' } };

    for (let column = range.s.c; column <= range.e.c; column += 1) {
        const address = XLSX.utils.encode_cell({ r: 0, c: column });
        sheet[address].s = { fill: headerFill, font: { bold: true } };
    }

    for (let row = 1; row <= range.e.r; row += 1) {
        for (let column = 0; column < latencyColumns.length; column += 1) {
            const address = XLSX.utils.encode_cell({ r: row, c: column });
            if (!sheet[address]) {
                continue;
            }

            if (sheet[address].v === '') {
                continue;
            }

            sheet[address].s = {
                fill: sheet[address].v === 'MISSING' ? missingFill : presentFill,
                font: { bold: true }
            };
        }
    }

    sheet['!autofilter'] = { ref: sheet['!ref'] };
    sheet['!cols'] = headers.map(header => ({ wch: Math.max(12, String(header).length + 2) }));
    XLSX.utils.book_append_sheet(workbook, sheet, 'Missing');
    XLSX.writeFile(workbook, outputFile, { cellStyles: true });
    collector.push(outputFile);
}

function writeFunctionPresenceWorkbook(rows, outputFile = functionPresenceWorkbookFile, collector = generatedExcelFiles) {
    const latencies = [...new Set([
        ...expectedLatencies,
        ...rows.map(row => String(row.latency || '0'))
    ])].sort((left, right) => Number(left) - Number(right));
    const expectedLoads = getExpectedLoads();
    const experimentMatrixFunctions = new Set([
        ...submitProduceBenchmarks1(),
        ...acceptOfferBenchmarks1(),
        ...purchaseBenchmarks1()
    ]);
    const strategicCountFunctions = new Set([
        ...testTeaLotBenchmarks1(),
        ...makeOfferBenchmarks1(),
        ...packBenchmarks1()
    ].map(normalizeOutputFunctionName));
    const isMatrixFunction = functionName =>
        /^submitproduce_f\d+_a\d+$/.test(functionName) ||
        /^acceptoffer_f\d+_r\d+$/.test(functionName) ||
        /^purchase_c\d+_r\d+$/.test(functionName);
    const isCountFunction = functionName =>
        /^testTeaLot_a\d+$/.test(functionName) ||
        /^makeoffer_r\d+$/.test(functionName) ||
        /^pack_r\d+$/.test(functionName);
    const isWeightedPackVariant = functionName =>
        /^pack\d+kg_r\d+(?:_s\d+)?$/i.test(functionName);
    const observedFunctions = rows
        .map(row => normalizeOutputFunctionName(row.functionName))
        .filter(Boolean)
        .filter(functionName => !isWeightedPackVariant(functionName))
        .filter(functionName =>
            !isMatrixFunction(functionName) || experimentMatrixFunctions.has(functionName)
        )
        .filter(functionName =>
            !isCountFunction(functionName) || strategicCountFunctions.has(functionName)
        );
    const functions = [...new Set(observedFunctions)]
        .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
    const existing = new Set(rows.map(row =>
        `${normalizeOutputFunctionName(row.functionName)}||${Number(row.load)}||${String(row.latency || '0')}`
    ));
    const latencyColumns = latencies.map(latency => `${latency}ms`);
    const headers = [...latencyColumns, 'functionName', 'load', 'missingCount'];

    const table = [headers];
    for (const functionName of functions) {
        for (const load of expectedLoads) {
            const outputRow = [];
            let missingCount = 0;

            for (const latency of latencies) {
                const isPresent = existing.has(`${functionName}||${load}||${latency}`);
                outputRow.push(isPresent ? 'OK' : 'MISSING');
                if (!isPresent) {
                    missingCount += 1;
                }
            }

            outputRow.push(functionName, load, missingCount);
            table.push(outputRow);
        }
    }

    const workbook = XLSX.utils.book_new();
    const sheet = XLSX.utils.aoa_to_sheet(table);
    const range = XLSX.utils.decode_range(sheet['!ref']);
    const missingFill = { patternType: 'solid', fgColor: { rgb: 'FFFF0000' } };
    const presentFill = { patternType: 'solid', fgColor: { rgb: 'FFC6EFCE' } };
    const headerFill = { patternType: 'solid', fgColor: { rgb: 'FFD9EAF7' } };

    for (let column = range.s.c; column <= range.e.c; column += 1) {
        const address = XLSX.utils.encode_cell({ r: 0, c: column });
        sheet[address].s = { fill: headerFill, font: { bold: true } };
    }

    for (let row = 1; row <= range.e.r; row += 1) {
        for (let column = 0; column < latencyColumns.length; column += 1) {
            const address = XLSX.utils.encode_cell({ r: row, c: column });
            sheet[address].s = {
                fill: sheet[address].v === 'OK' ? presentFill : missingFill,
                font: { bold: true }
            };
        }
    }

    sheet['!autofilter'] = { ref: sheet['!ref'] };
    sheet['!cols'] = headers.map(header => ({
        wch: header === 'functionName' ? 38 : Math.max(12, String(header).length + 2)
    }));
    XLSX.utils.book_append_sheet(workbook, sheet, 'Function Presence');
    XLSX.writeFile(workbook, outputFile, { cellStyles: true });
    collector.push(outputFile);
}

function hasAverageLatencyValue(value) {
    const text = String(value ?? '').trim();
    if (!text || text === '-') {
        return false;
    }

    return Number.isFinite(Number(text.replace(/,/g, '')));
}

function writeAvgLatencyMissingWorkbook(rows, outputFile = avgLatencyMissingWorkbookFile, collector = generatedExcelFiles) {
    const latencies = [...new Set([
        ...expectedLatencies,
        ...rows.map(row => String(row.latency || '0'))
    ])].sort((left, right) => Number(left) - Number(right));
    const expectedLoads = getExpectedLoads();
    const experimentMatrixFunctions = new Set([
        ...submitProduceBenchmarks1(),
        ...acceptOfferBenchmarks1(),
        ...purchaseBenchmarks1()
    ]);
    const strategicCountFunctions = new Set([
        ...testTeaLotBenchmarks1(),
        ...makeOfferBenchmarks1(),
        ...packBenchmarks1()
    ].map(normalizeOutputFunctionName));
    const isMatrixFunction = functionName =>
        /^submitproduce_f\d+_a\d+$/.test(functionName) ||
        /^acceptoffer_f\d+_r\d+$/.test(functionName) ||
        /^purchase_c\d+_r\d+$/.test(functionName);
    const isCountFunction = functionName =>
        /^testTeaLot_a\d+$/.test(functionName) ||
        /^makeoffer_r\d+$/.test(functionName) ||
        /^pack(?:\d+kg)?_r\d+$/.test(functionName);
    const isWeightedPackVariant = functionName =>
        /^pack\d+kg_r\d+(?:_s\d+)?$/i.test(functionName);
    const observedFunctions = rows
        .map(row => normalizeOutputFunctionName(row.functionName))
        .filter(Boolean)
        .filter(functionName => !isWeightedPackVariant(functionName))
        .filter(functionName =>
            !isMatrixFunction(functionName) || experimentMatrixFunctions.has(functionName)
        )
        .filter(functionName =>
            !isCountFunction(functionName) || strategicCountFunctions.has(functionName)
        );
    const functions = [...new Set(observedFunctions)]
        .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
    const rowByKey = new Map(rows.map(row => [
        `${normalizeOutputFunctionName(row.functionName)}||${Number(row.load)}||${String(row.latency || '0')}`,
        row
    ]));
    const latencyColumns = latencies.map(latency => `${latency}ms`);
    const headers = [...latencyColumns, 'functionName', 'load', 'missingCount'];
    const table = [headers];

    for (const functionName of functions) {
        for (const load of expectedLoads) {
            const outputRow = [];
            let missingCount = 0;
            let hasAnyThroughputRow = false;

            for (const latency of latencies) {
                const row = rowByKey.get(`${functionName}||${load}||${latency}`);
                if (row) {
                    hasAnyThroughputRow = true;
                }
                const isPresent = row && hasAverageLatencyValue(row.avgLatency);
                outputRow.push(!row ? '' : (isPresent ? 'OK' : 'MISSING'));
                if (row && !isPresent) {
                    missingCount += 1;
                }
            }

            if (!hasAnyThroughputRow || missingCount === 0) {
                continue;
            }

            outputRow.push(functionName, load, missingCount);
            table.push(outputRow);
        }
    }

    const workbook = XLSX.utils.book_new();
    const sheet = XLSX.utils.aoa_to_sheet(table);
    const range = XLSX.utils.decode_range(sheet['!ref']);
    const missingFill = { patternType: 'solid', fgColor: { rgb: 'FFFF0000' } };
    const presentFill = { patternType: 'solid', fgColor: { rgb: 'FFC6EFCE' } };
    const headerFill = { patternType: 'solid', fgColor: { rgb: 'FFD9EAF7' } };

    for (let column = range.s.c; column <= range.e.c; column += 1) {
        const address = XLSX.utils.encode_cell({ r: 0, c: column });
        sheet[address].s = { fill: headerFill, font: { bold: true } };
    }

    for (let row = 1; row <= range.e.r; row += 1) {
        for (let column = 0; column < latencyColumns.length; column += 1) {
            const address = XLSX.utils.encode_cell({ r: row, c: column });
            sheet[address].s = {
                fill: sheet[address].v === 'OK' ? presentFill : missingFill,
                font: { bold: true }
            };
        }
    }

    sheet['!autofilter'] = { ref: sheet['!ref'] };
    sheet['!cols'] = headers.map(header => ({
        wch: header === 'functionName' ? 38 : Math.max(12, String(header).length + 2)
    }));
    XLSX.utils.book_append_sheet(workbook, sheet, 'Avg Latency Missing');
    XLSX.writeFile(workbook, outputFile, { cellStyles: true });
    collector.push(outputFile);
}

const mergedRows = mergeRowsReplacingExisting(existingWorkbookRows, workbookRows);
const combinedRows = addZeroThroughputPlaceholders(mergedRows.rows
    .filter(row => !shouldExcludeFunction(row.functionName))
    .map(row => {
        const participantCount = getStakeholderValuesForFunction(row.functionName)
            .reduce((sum, value) => sum + Number(value || 0), 0);
        const refreshedComplexity = getComplexityMetrics(
            process.env.CHAINCODE_NAME || 'tea_traceability',
            row.functionName
        );
        const readWriteOverride = readWriteOverrides.get(
            normalizeFunctionForComplexity(row.functionName)
        );
        const hotKeyWrites = Number(refreshedComplexity.hotKeyWrites || 0);
        const payloadBytes = payloadMetrics.get(normalizePayloadFunction(row.functionName)) || 0;
        const normalizedFunction = normalizeFunctionForComplexity(row.functionName);
        const ledgerWrites = normalizedFunction === 'pack'
            ? calculatePackLedgerWrites(row.lotWeightKg)
            : (readWriteOverride ? readWriteOverride.totalWrites : row.ledgerWrites);

        return {
            ...row,
            functionName: normalizeOutputFunctionName(row.functionName),
            numCaliperWorkers: getCaliperWorkersForFunction(row.functionName),
            hotKeyWrites,
            hotParticipants: (() => {
                const makeOfferMatch3 = String(row.functionName || '').match(/makeoffer_r(\d+)(?:_(\d+))?(?:_s\d+)?$/i);
                if (makeOfferMatch3 && makeOfferMatch3[2]) {
                    return Number(makeOfferMatch3[2]);
                }
                return hotKeyWrites > 0 ? participantCount : 0;
            })(),
            ledgerWrites,
            reads: readWriteOverride ? readWriteOverride.totalReads : row.reads,
            payloadBytes,
            failureRate: calculateRowFailureRate(row)
        };
	    }));
const duplicateRowsRemoved = existingWorkbookRows.length + workbookRows.length - combinedRows.length;

console.log(`📊 Newly extracted rows: ${workbookRows.length}`);
console.log(`📊 Combined throughput rows: ${combinedRows.length}`);
console.log(`🧹 Duplicate rows removed: ${duplicateRowsRemoved}`);
console.log(`🔁 Existing rows replaced by new extracted rows: ${mergedRows.replacedExistingRows}`);
console.log(`🧹 Duplicate new rows resolved by newest log: ${mergedRows.duplicateNewRowsRemoved}`);

writeMasterWorkbook(combinedRows, outputMasterWorkbookFile);
writeWorkbookByFunction(combinedRows);
writeWorkbooksByLatency(combinedRows);
writeMissingCombinationsWorkbook(combinedRows);
writeFunctionPresenceWorkbook(combinedRows);
writeAvgLatencyMissingWorkbook(combinedRows);

for (const sourcePath of generatedExcelFiles) {
    const destinationPath = path.join(desktopResultsDir, path.basename(sourcePath));

    safeCopyToDesktop(sourcePath, destinationPath);

    if (separateOutputFiles) {
        fs.copyFileSync(sourcePath, path.join(suffixResultsDir, path.basename(sourcePath)));
        safeCopyToDesktop(sourcePath, path.join(desktopSuffixResultsDir, path.basename(sourcePath)));
    }
}

function combinedOutputName(name) {
    const ext = path.extname(name);
    const stem = name.slice(0, -ext.length);
    return `${stem}_combined${ext}`;
}

function writeCombinedResultsFromSuffixFolders() {
    const primaryFile = path.join(resultsDir, '_1', 'throughput_results_all_1.xlsx');
    const fallbackFile = path.join(resultsDir, '_5', 'throughput_results_all_5.xlsx');
    const primaryMtimeMs = fs.existsSync(primaryFile) ? fs.statSync(primaryFile).mtimeMs : 0;
    const fallbackMtimeMs = fs.existsSync(fallbackFile) ? fs.statSync(fallbackFile).mtimeMs : 0;
    const primaryRows = readExistingWorkbookRows(primaryFile).map(row => ({
        ...row,
        __sourceMtimeMs: primaryMtimeMs
    }));
    const fallbackRows = readExistingWorkbookRows(fallbackFile).map(row => ({
        ...row,
        __sourceMtimeMs: fallbackMtimeMs
    }));

    if (primaryRows.length === 0 && fallbackRows.length === 0) {
        console.log('📁 Combined _1/_5 output skipped: no source rows found');
        return;
    }

    const merged = mergeRowsReplacingExisting(primaryRows, fallbackRows);
    const combinedRows = addZeroThroughputPlaceholders(merged.rows
        .filter(row => !shouldExcludeFunction(row.functionName))
        .map(row => {
            const participantCount = getStakeholderValuesForFunction(row.functionName)
                .reduce((sum, value) => sum + Number(value || 0), 0);
            const refreshedComplexity = getComplexityMetrics(
                process.env.CHAINCODE_NAME || 'tea_traceability',
                row.functionName
            );
            const readWriteOverride = readWriteOverrides.get(
                normalizeFunctionForComplexity(row.functionName)
            );
            const hotKeyWrites = Number(refreshedComplexity.hotKeyWrites || 0);
            const payloadBytes = payloadMetrics.get(normalizePayloadFunction(row.functionName)) || Number(row.payloadBytes || 0) || 0;
            const normalizedFunction = normalizeFunctionForComplexity(row.functionName);
            const ledgerWrites = normalizedFunction === 'pack'
                ? calculatePackLedgerWrites(row.lotWeightKg)
                : (readWriteOverride ? readWriteOverride.totalWrites : row.ledgerWrites);

            return {
                ...row,
                functionName: normalizeOutputFunctionName(row.functionName),
                numCaliperWorkers: getCaliperWorkersForFunction(row.functionName),
                hotKeyWrites,
                hotParticipants: (() => {
                    const makeOfferMatch3 = String(row.functionName || '').match(/makeoffer_r(\d+)(?:_(\d+))?(?:_s\d+)?$/i);
                    if (makeOfferMatch3 && makeOfferMatch3[2]) {
                        return Number(makeOfferMatch3[2]);
                    }
                    return hotKeyWrites > 0 ? participantCount : 0;
                })(),
                ledgerWrites,
                reads: readWriteOverride ? readWriteOverride.totalReads : row.reads,
                payloadBytes,
                failureRate: calculateRowFailureRate(row)
            };
        }));
    const combinedGeneratedFiles = [];

    writeMasterWorkbook(
        combinedRows,
        path.join(combinedResultsDir, combinedOutputName('throughput_results_all.xlsx')),
        combinedGeneratedFiles
    );
    writeWorkbookByFunction(
        combinedRows,
        path.join(combinedResultsDir, combinedOutputName('throughput_results_by_function.xlsx')),
        combinedGeneratedFiles
    );
    writeWorkbooksByLatency(
        combinedRows,
        combinedResultsDir,
        combinedOutputName,
        combinedGeneratedFiles
    );
    writeMissingCombinationsWorkbook(
        combinedRows,
        path.join(combinedResultsDir, combinedOutputName('throughput_missing_combinations.xlsx')),
        combinedGeneratedFiles
    );
    writeFunctionPresenceWorkbook(
        combinedRows,
        path.join(combinedResultsDir, combinedOutputName('throughput_function_presence.xlsx')),
        combinedGeneratedFiles
    );
    writeAvgLatencyMissingWorkbook(
        combinedRows,
        path.join(combinedResultsDir, combinedOutputName('throughput_avg_latency_missing.xlsx')),
        combinedGeneratedFiles
    );

    for (const sourcePath of combinedGeneratedFiles) {
        safeCopyToDesktop(sourcePath, path.join(desktopCombinedResultsDir, path.basename(sourcePath)));
    }

    console.log(`📁 Combined _1/_5 rows: ${combinedRows.length} (_1 primary=${primaryRows.length}, _5 fallback=${fallbackRows.length})`);
    console.log('📁 Combined _1/_5 folder:', combinedResultsDir);
}

writeCombinedResultsFromSuffixFolders();

console.log('\n🎯 Throughput extraction completed');
console.log('📄 Existing master workbook read from:', existingMasterWorkbookFile);
console.log('📄 New filtered master workbook:', outputMasterWorkbookFile);
console.log('📄 Filtered function workbook:', workbookFile);
console.log('📄 Filtered latency workbooks:', generatedExcelFiles.filter(file => path.basename(file).startsWith('throughput_results_latency_')));
console.log('📄 Missing combinations workbook:', missingCombinationsWorkbookFile);
console.log('📄 Function presence workbook:', functionPresenceWorkbookFile);
console.log('📄 Avg latency missing workbook:', avgLatencyMissingWorkbookFile);
console.log('📁 Copied results to:', desktopResultsDir);
