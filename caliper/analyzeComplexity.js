'use strict';

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const baseDir = __dirname;
const chaincodeDir = path.resolve(baseDir, '../fabric-test/test-network/chaincode-javascript/lib');
const resultsDir = path.join(baseDir, 'results');
const desktopResultsDir = '/mnt/c/Users/hp/Desktop/dhanish/fabric_2/results';
const packPacketCountsFile = path.join(baseDir, 'pack_packet_counts.csv');

const targetFunctionOrder = [
    'submitProduce',
    'testTeaLot',
    'makeOffer',
    'acceptOffer',
    'packLotIntoPackets',
    'purchasePacket'
];

const targetFunctions = new Set(targetFunctionOrder);

const workloadFunctionNames = {
    submitProduce: 'submitproduce',
    testTeaLot: 'testTeaLot',
    makeOffer: 'makeoffer',
    acceptOffer: 'acceptoffer',
    packLotIntoPackets: 'pack',
    purchasePacket: 'purchase'
};

const columns = [
    'chaincode',
    'function',
    'chaincodeFunction',
    'totalReads',
    'totalWrites',
    'estimatedWrites',
    'measuredAvgWrites',
    'measuredMaxWrites',
    'measuredAvgPackets',
    'measuredMaxPackets',
    'loops',
    'calledHelpers',
    'writeKeys',
    'notes',
    'complexityScore',
    'complexityLevel'
];

function ensureDir(dir) {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

function getChaincodeName(filePath) {
    return path.basename(filePath, '.js');
}

function countMatches(source, pattern) {
    return (source.match(pattern) || []).length;
}

function getBraceEnd(source, openBraceIndex) {
    let depth = 0;
    let inString = null;
    let escaped = false;
    let inLineComment = false;
    let inBlockComment = false;

    for (let index = openBraceIndex; index < source.length; index++) {
        const char = source[index];
        const next = source[index + 1];

        if (inLineComment) {
            if (char === '\n') inLineComment = false;
            continue;
        }

        if (inBlockComment) {
            if (char === '*' && next === '/') {
                inBlockComment = false;
                index++;
            }
            continue;
        }

        if (inString) {
            if (escaped) {
                escaped = false;
            } else if (char === '\\') {
                escaped = true;
            } else if (char === inString) {
                inString = null;
            }
            continue;
        }

        if (char === '/' && next === '/') {
            inLineComment = true;
            index++;
            continue;
        }

        if (char === '/' && next === '*') {
            inBlockComment = true;
            index++;
            continue;
        }

        if (char === '\'' || char === '"' || char === '`') {
            inString = char;
            continue;
        }

        if (char === '{') {
            depth++;
        } else if (char === '}') {
            depth--;
            if (depth === 0) {
                return index;
            }
        }
    }

    return -1;
}

function extractFunctions(source) {
    const functions = [];
    const functionPattern = /(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*\{/g;
    let match;

    while ((match = functionPattern.exec(source)) !== null) {
        const name = match[1];
        const params = match[2]
            .split(',')
            .map(param => param.trim())
            .filter(Boolean);

        const openBraceIndex = functionPattern.lastIndex - 1;
        const endIndex = getBraceEnd(source, openBraceIndex);

        if (endIndex === -1) {
            continue;
        }

        functions.push({
            name,
            params,
            body: source.slice(openBraceIndex + 1, endIndex)
        });

        functionPattern.lastIndex = endIndex + 1;
    }

    return functions;
}

function getComplexityLevel(score) {
    if (score >= 35) return 'High';
    if (score >= 16) return 'Medium';
    return 'Low';
}

function getHotspotLevel(score) {
    if (score >= 10) return 'High';
    if (score >= 5) return 'Medium';
    return 'Low';
}

function getCalledHelpers(body, functionsByName) {
    const helpers = new Set();
    const helperPattern = /\bthis\.([A-Za-z_$][\w$]*)\s*\(/g;
    let match;

    while ((match = helperPattern.exec(body)) !== null) {
        const name = match[1];
        if (functionsByName.has(name) && name !== '_logInvocation' && name !== '_requireOrg') {
            helpers.add(name);
        }
    }

    return [...helpers];
}

function splitTopLevelArgs(argumentText) {
    const args = [];
    let current = '';
    let depth = 0;
    let inString = null;
    let escaped = false;

    for (const char of argumentText) {
        if (inString) {
            current += char;
            if (escaped) {
                escaped = false;
            } else if (char === '\\') {
                escaped = true;
            } else if (char === inString) {
                inString = null;
            }
            continue;
        }

        if (char === '\'' || char === '"' || char === '`') {
            inString = char;
            current += char;
            continue;
        }

        if (char === '(' || char === '[' || char === '{') {
            depth++;
        } else if (char === ')' || char === ']' || char === '}') {
            depth--;
        }

        if (char === ',' && depth === 0) {
            args.push(current.trim());
            current = '';
        } else {
            current += char;
        }
    }

    if (current.trim()) {
        args.push(current.trim());
    }

    return args;
}

function getParenEnd(source, openParenIndex) {
    let depth = 0;
    let inString = null;
    let escaped = false;

    for (let index = openParenIndex; index < source.length; index++) {
        const char = source[index];

        if (inString) {
            if (escaped) {
                escaped = false;
            } else if (char === '\\') {
                escaped = true;
            } else if (char === inString) {
                inString = null;
            }
            continue;
        }

        if (char === '\'' || char === '"' || char === '`') {
            inString = char;
            continue;
        }

        if (char === '(') {
            depth++;
        } else if (char === ')') {
            depth--;
            if (depth === 0) {
                return index;
            }
        }
    }

    return -1;
}

function extractWriteKeyExpressions(body) {
    const keys = [];
    const writePattern = /\bctx\.stub\.(?:putState|deleteState)\s*\(/g;
    let match;

    while ((match = writePattern.exec(body)) !== null) {
        const openParenIndex = writePattern.lastIndex - 1;
        const closeParenIndex = getParenEnd(body, openParenIndex);

        if (closeParenIndex === -1) {
            continue;
        }

        const argumentText = body.slice(openParenIndex + 1, closeParenIndex);
        const args = splitTopLevelArgs(argumentText);
        const keyExpression = args[0] ? args[0].replace(/\s+/g, ' ') : 'unknown';

        keys.push(keyExpression);
        writePattern.lastIndex = closeParenIndex + 1;
    }

    return keys;
}

function getFunctionMetrics(fn, functionsByName) {
    const body = fn.body;
    const ledgerReads = countMatches(body, /\bctx\.stub\.getState\s*\(/g);
    const ledgerWrites = countMatches(body, /\bctx\.stub\.(?:putState|deleteState)\s*\(/g);
    const rangeQueries = countMatches(body, /\bctx\.stub\.(?:getStateByRange|getQueryResult|getStateByPartialCompositeKey)\s*\(/g);
    const compositeKeyOps = countMatches(body, /\bctx\.stub\.createCompositeKey\s*\(/g);
    const conditions = countMatches(body, /\bif\s*\(|\belse\s+if\s*\?|\bswitch\s*\(/g);
    const loops = countMatches(body, /\bfor\s*\(|\bwhile\s*\(|\bdo\s*\{|\.forEach\s*\(|\.map\s*\(|\.filter\s*\(|\.reduce\s*\(/g);
    const jsonOps = countMatches(body, /\bJSON\.(?:parse|stringify)\s*\(/g);
    const throws = countMatches(body, /\bthrow\s+new\s+Error\b/g);
    const helperCalls = countMatches(body, /\bthis\.[A-Za-z_$][\w$]*\s*\(/g);
    const walletOps = countMatches(body, /wallet|balance|getWalletBalance|depositMoney|transfermoney|_transfer|transfer/gi);
    const transferOps = countMatches(body, /\b_transfer\s*\(|\btransfer\s*\(|\btransfermoney\s*\(/g);
    const dynamicKeyWrites = countMatches(body, /\bctx\.stub\.(?:putState|deleteState)\s*\(\s*[A-Za-z_$][\w$]*/g);
    const walletWrites = countMatches(body, /\bctx\.stub\.(?:putState|deleteState)\s*\([^)]*(?:wallet|fromKey|toKey)/gi);
    const readBeforeWrite = countMatches(body, /getState[\s\S]{0,400}putState/g);
    const calledHelpers = getCalledHelpers(body, functionsByName);
    const mvccWriteKeys = extractWriteKeyExpressions(body);

    const score =
        (ledgerReads * 1) +
        (ledgerWrites * 2) +
        (rangeQueries * 3) +
        (compositeKeyOps * 1) +
        (conditions * 1) +
        (loops * 2) +
        (jsonOps * 1) +
        (throws * 1) +
        (helperCalls * 1) +
        (walletOps * 1) +
        (transferOps * 3);

    return {
        parameters: fn.params.length,
        ledgerReads,
        ledgerWrites,
        rangeQueries,
        compositeKeyOps,
        conditions,
        loops,
        jsonOps,
        throws,
        helperCalls,
        walletOps,
        transferOps,
        dynamicKeyWrites,
        walletWrites,
        readBeforeWrite,
        calledHelpers,
        mvccWriteKeys,
        complexityScore: score
    };
}

function mergeMetrics(base, addition) {
    for (const field of [
        'ledgerReads',
        'ledgerWrites',
        'rangeQueries',
        'compositeKeyOps',
        'conditions',
        'loops',
        'jsonOps',
        'throws',
        'helperCalls',
        'walletOps',
        'transferOps',
        'dynamicKeyWrites',
        'walletWrites',
        'readBeforeWrite',
        'complexityScore'
    ]) {
        base[field] += addition[field] || 0;
    }

    base.mvccWriteKeys = [
        ...new Set([
            ...(base.mvccWriteKeys || []),
            ...(addition.mvccWriteKeys || [])
        ])
    ];
}

function collectExpandedMetrics(fn, functionsByName, visited = new Set()) {
    const metrics = getFunctionMetrics(fn, functionsByName);
    const expanded = { ...metrics, expandedHelpers: [] };

    if (visited.has(fn.name)) {
        return expanded;
    }

    visited.add(fn.name);

    for (const helperName of metrics.calledHelpers) {
        const helper = functionsByName.get(helperName);
        if (!helper || visited.has(helperName)) {
            continue;
        }

        expanded.expandedHelpers.push(helperName);
        const helperMetrics = collectExpandedMetrics(helper, functionsByName, new Set(visited));
        mergeMetrics(expanded, helperMetrics);
        expanded.expandedHelpers.push(...helperMetrics.expandedHelpers);
    }

    expanded.expandedHelpers = [...new Set(expanded.expandedHelpers)];
    return expanded;
}

function analyzeHotspots(fn, direct, expanded) {
    const reasons = [];
    let score = 0;

    if (expanded.ledgerWrites >= 2) {
        score += expanded.ledgerWrites * 2;
        reasons.push(`${expanded.ledgerWrites} ledger writes in transaction path`);
    }

    if (expanded.mvccWriteKeys.length > 0) {
        score += expanded.mvccWriteKeys.length;
        reasons.push(`${expanded.mvccWriteKeys.length} possible MVCC write keys: ${expanded.mvccWriteKeys.join('|')}`);
    }

    if (expanded.readBeforeWrite > 0) {
        score += expanded.readBeforeWrite * 2;
        reasons.push('read-before-write pattern can create MVCC version conflicts');
    }

    if (expanded.walletWrites > 0 || expanded.transferOps > 0) {
        score += 4;
        reasons.push('wallet transfer updates shared balance keys');
    }

    if (expanded.dynamicKeyWrites > 0) {
        score += expanded.dynamicKeyWrites;
        reasons.push('dynamic ledger keys are rewritten based on transaction arguments');
    }

    if (fn.name === 'makeOffer') {
        score += 4;
        reasons.push('many retailers can update the same lot offer list/highest offer');
    }

    if (fn.name === 'acceptOffer') {
        score += 4;
        reasons.push('accepting an offer rewrites the lot state after competing offer updates');
    }

    if (fn.name === 'submitProduce' && expanded.transferOps > 0) {
        score += 3;
        reasons.push('calls _transfer, so farmer and aggregator wallet keys are updated');
    }

    if (fn.name === 'purchasePacket') {
        score += 4;
        reasons.push('multiple consumers can compete to update the same packet status');
    }

    if (fn.name === 'packLotIntoPackets') {
        score += 3;
        reasons.push('updates lot state and creates packet records from the same source lot');
    }

    return {
        score,
        level: getHotspotLevel(score),
        reasons: [...new Set(reasons)].join('; ')
    };
}

function analyzeTargetFunction(chaincode, fn, functionsByName) {
    const direct = getFunctionMetrics(fn, functionsByName);
    const expanded = collectExpandedMetrics(fn, functionsByName);
    const hotspots = analyzeHotspots(fn, direct, expanded);
    const runtimeWriteEstimate = getRuntimeWriteEstimate(fn.name, direct, expanded);
    const measuredPackStats = fn.name === 'packLotIntoPackets' ? getMeasuredPackStats() : null;
    const scoreWrites = measuredPackStats?.avgWrites || runtimeWriteEstimate;
    const writeKeys = getManualWriteKeys(fn.name, expanded.mvccWriteKeys);

    return {
        chaincode,
        function: workloadFunctionNames[fn.name] || fn.name,
        chaincodeFunction: fn.name,
        totalReads: expanded.ledgerReads + expanded.rangeQueries,
        totalWrites: expanded.ledgerWrites,
        estimatedWrites: runtimeWriteEstimate,
        measuredAvgWrites: measuredPackStats?.avgWrites || '',
        measuredMaxWrites: measuredPackStats?.maxWrites || '',
        measuredAvgPackets: measuredPackStats?.avgPackets || '',
        measuredMaxPackets: measuredPackStats?.maxPackets || '',
        loops: expanded.loops,
        calledHelpers: expanded.expandedHelpers.join('|'),
        writeKeys: writeKeys.join('|'),
        notes: getNotes(fn.name, hotspots.reasons),
        complexityScore: getSimpleComplexityScore(expanded, scoreWrites),
        complexityLevel: getComplexityLevel(getSimpleComplexityScore(expanded, scoreWrites))
    };
}

function getManualWriteKeys(functionName, detectedKeys) {
    const manualKeys = {
        submitProduce: ['fromKey', 'toKey'],
        acceptOffer: ['fromKey', 'toKey'],
        purchasePacket: ['fromKey', 'toKey'],
        makeOffer: ['lotKey'],
        testTeaLot: [],
        packLotIntoPackets: []
    };

    return Object.prototype.hasOwnProperty.call(manualKeys, functionName)
        ? manualKeys[functionName]
        : detectedKeys;
}

function getRuntimeWriteEstimate(functionName, direct, expanded) {
    if (functionName === 'packLotIntoPackets') {
        return 'packetCount + 1 lot write';
    }

    return String(expanded.ledgerWrites);
}

function getSimpleComplexityScore(expanded, estimatedWrites) {
    const writes = Number(estimatedWrites) || expanded.ledgerWrites;
    return (expanded.ledgerReads * 2) + (writes * 4) + (expanded.loops * 2);
}

function getMeasuredPackStats() {
    if (!fs.existsSync(packPacketCountsFile)) {
        return null;
    }

    const lines = fs.readFileSync(packPacketCountsFile, 'utf8')
        .trim()
        .split(/\r?\n/)
        .filter(Boolean);

    if (lines.length <= 1) {
        return null;
    }

    const header = lines[0].split(',');
    const totalPacketsIndex = header.indexOf('totalPackets');
    const estimatedWritesIndex = header.indexOf('estimatedLedgerWrites');

    if (totalPacketsIndex === -1 || estimatedWritesIndex === -1) {
        return null;
    }

    const rows = lines.slice(1)
        .map(line => line.split(','))
        .map(parts => ({
            packets: Number(parts[totalPacketsIndex]),
            writes: Number(parts[estimatedWritesIndex])
        }))
        .filter(row => Number.isFinite(row.packets) && Number.isFinite(row.writes));

    if (rows.length === 0) {
        return null;
    }

    const avgPackets = rows.reduce((sum, row) => sum + row.packets, 0) / rows.length;
    const avgWrites = rows.reduce((sum, row) => sum + row.writes, 0) / rows.length;
    const maxPackets = Math.max(...rows.map(row => row.packets));
    const maxWrites = Math.max(...rows.map(row => row.writes));

    return {
        avgPackets: Number(avgPackets.toFixed(2)),
        avgWrites: Number(avgWrites.toFixed(2)),
        maxPackets,
        maxWrites
    };
}

function getNotes(functionName, hotspotReasons) {
    if (functionName === 'packLotIntoPackets') {
        return 'writes are dynamic: one packet write per generated packet plus one lot update';
    }

    return hotspotReasons;
}

function csvCell(value) {
    const text = String(value ?? '');
    if (/[",\n\r]/.test(text)) {
        return `"${text.replace(/"/g, '""')}"`;
    }
    return text;
}

function writeCsv(filePath, rows) {
    const lines = [
        columns.join(','),
        ...rows.map(row => columns.map(column => csvCell(row[column])).join(','))
    ];

    fs.writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf8');
}

function writeWorkbook(filePath, rows) {
    const workbook = XLSX.utils.book_new();
    const allSheet = XLSX.utils.json_to_sheet(rows, { header: columns });
    XLSX.utils.book_append_sheet(workbook, allSheet, 'All');

    const chaincodes = [...new Set(rows.map(row => row.chaincode))].sort();
    for (const chaincode of chaincodes) {
        const sheetRows = rows.filter(row => row.chaincode === chaincode);
        const sheet = XLSX.utils.json_to_sheet(sheetRows, { header: columns });
        XLSX.utils.book_append_sheet(workbook, sheet, chaincode.slice(0, 31));
    }

    XLSX.writeFile(workbook, filePath);
}

function main() {
    ensureDir(resultsDir);
    ensureDir(desktopResultsDir);

    const requested = process.argv.slice(2);
    const files = requested.length > 0
        ? requested.map(file => path.resolve(process.cwd(), file))
        : fs.readdirSync(chaincodeDir)
            .filter(file => /^tea_\d+.*\.js$/.test(file))
            .map(file => path.join(chaincodeDir, file))
            .sort();

    const rows = [];

    for (const file of files) {
        if (!fs.existsSync(file)) {
            console.warn(`Skipping missing file: ${file}`);
            continue;
        }

        const source = fs.readFileSync(file, 'utf8');
        const chaincode = getChaincodeName(file);
        const allFunctions = extractFunctions(source);
        const functionsByName = new Map(allFunctions.map(fn => [fn.name, fn]));
        const functions = targetFunctionOrder
            .map(name => functionsByName.get(name))
            .filter(Boolean);

        for (const fn of functions) {
            rows.push(analyzeTargetFunction(chaincode, fn, functionsByName));
        }
    }

    const csvFile = path.join(resultsDir, 'function_complexity.csv');
    const workbookFile = path.join(resultsDir, 'function_complexity.xlsx');

    writeCsv(csvFile, rows);
    writeWorkbook(workbookFile, rows);

    fs.copyFileSync(csvFile, path.join(desktopResultsDir, path.basename(csvFile)));
    fs.copyFileSync(workbookFile, path.join(desktopResultsDir, path.basename(workbookFile)));

    console.log(`Analyzed ${rows.length} functions`);
    console.log(`CSV: ${csvFile}`);
    console.log(`Excel: ${workbookFile}`);
    console.log(`Copied to: ${desktopResultsDir}`);
}

main();
