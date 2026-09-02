'use strict';

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const baseDir = __dirname;
const sourceDir = path.join(baseDir, 'results', 'new');
const outFile = path.join(baseDir, 'results', 'throughput_results_all_2.xlsx');
const desktopOut = '/mnt/c/Users/hp/Desktop/dhanish/fabric_2/results/throughput_results_all_2.xlsx';

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

function numberValue(value, fallback = 0) {
    const number = Number(String(value ?? '').replace(/,/g, ''));
    return Number.isFinite(number) ? number : fallback;
}

function normalizeFunctionName(functionName) {
    const name = String(functionName || '').trim();
    const bareMakeOffer = name.match(/^makeoffer_r(\d+)$/i);

    if (bareMakeOffer) {
        return `makeoffer_r${bareMakeOffer[1]}_1`;
    }

    return name;
}

function isMakeOffer(functionName) {
    return /^makeoffer_r\d+(?:_\d+)?$/i.test(String(functionName || ''));
}

function deriveCounts(row) {
    const total = numberValue(row.totalTransactions);
    const failureRate = numberValue(row.failureRate);

    if (total <= 0) {
        return { success: 0, failures: 0, failureRate: 0 };
    }

    if (isMakeOffer(row.functionName)) {
        // Separate makeoffer formula discussed earlier:
        // failureRate = 1 - (effectiveSuccess / totalTransactions)
        const success = Math.max(0, Math.round(total * (1 - failureRate)));
        const failures = Math.max(0, total - success);
        return {
            success,
            failures,
            failureRate: 1 - (success / total)
        };
    }

    const failures = Math.max(0, Math.round(total * failureRate));
    const success = Math.max(0, total - failures);
    return {
        success,
        failures,
        failureRate: failures / total
    };
}

function normalizeRow(row) {
    const normalized = {
        ...row,
        functionName: normalizeFunctionName(row.functionName)
    };
    const counts = deriveCounts(normalized);

    normalized.success = counts.success;
    normalized.failures = counts.failures;
    normalized.failureRate = counts.failureRate;
    normalized.lotWeightKg = normalized.lotWeightKg || 10;
    normalized.load = numberValue(normalized.load);
    normalized.latency = String(normalized.latency ?? '0').trim() || '0';
    normalized.totalTransactions = numberValue(normalized.totalTransactions);
    normalized.numCaliperWorkers = numberValue(normalized.numCaliperWorkers);
    normalized.hotKeyWrites = numberValue(normalized.hotKeyWrites);
    normalized.hotParticipants = numberValue(normalized.hotParticipants);
    normalized.ledgerWrites = numberValue(normalized.ledgerWrites);
    normalized.reads = numberValue(normalized.reads);
    normalized.payloadBytes = numberValue(normalized.payloadBytes);
    normalized.sendRate = numberValue(normalized.sendRate);
    normalized.throughput = numberValue(normalized.throughput);
    normalized.avgLatency = normalized.avgLatency === '' || normalized.avgLatency === '-'
        ? ''
        : numberValue(normalized.avgLatency);

    return Object.fromEntries(masterColumns.map(column => [column, normalized[column] ?? '']));
}

function rowKey(row) {
    return [
        String(row.functionName || '').toLowerCase(),
        String(row.lotWeightKg || 10),
        String(row.load || ''),
        String(row.latency || '0')
    ].join('||');
}

function main() {
    if (!fs.existsSync(sourceDir)) {
        throw new Error(`Source folder not found: ${sourceDir}`);
    }

    const files = fs.readdirSync(sourceDir)
        .filter(file => file.endsWith('.xlsx') && !file.includes(':Zone.Identifier'))
        .map(file => path.join(sourceDir, file))
        .sort((left, right) => fs.statSync(left).mtimeMs - fs.statSync(right).mtimeMs);

    const byKey = new Map();

    for (const file of files) {
        const workbook = XLSX.readFile(file);

        for (const sheetName of workbook.SheetNames) {
            const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: '' });

            for (const row of rows) {
                if (!row.functionName || !row.load) {
                    continue;
                }

                const normalized = normalizeRow(row);
                byKey.set(rowKey(normalized), normalized);
            }
        }
    }

    const rows = [...byKey.values()].sort((left, right) => {
        const functionCompare = String(left.functionName)
            .localeCompare(String(right.functionName), undefined, { numeric: true });
        if (functionCompare !== 0) {
            return functionCompare;
        }

        const latencyCompare = numberValue(left.latency) - numberValue(right.latency);
        if (latencyCompare !== 0) {
            return latencyCompare;
        }

        return numberValue(left.load) - numberValue(right.load);
    });

    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    const outputWorkbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
        outputWorkbook,
        XLSX.utils.json_to_sheet(rows, { header: masterColumns }),
        'All'
    );
    XLSX.writeFile(outputWorkbook, outFile);

    try {
        fs.mkdirSync(path.dirname(desktopOut), { recursive: true });
        fs.copyFileSync(outFile, desktopOut);
    } catch (error) {
        console.warn(`Desktop copy failed: ${error.message}`);
    }

    const invalidFailureRates = rows.filter(row => numberValue(row.failureRate) > 1).length;
    console.log(`Input files: ${files.map(file => path.relative(baseDir, file)).join(', ')}`);
    console.log(`Rows written: ${rows.length}`);
    console.log(`failureRate > 1: ${invalidFailureRates}`);
    console.log(`Output: ${outFile}`);
}

main();
