'use strict';

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
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
} = require('./experiment-matrix');

const baseDir = __dirname;
const resultsDir = path.join(baseDir, 'results');
const desktopResultsDir = '/mnt/c/Users/hp/Desktop/dhanish/fabric_2/results';
const suffix = process.env.THROUGHPUT_SUFFIX || '1';
const inputFile = process.env.THROUGHPUT_INPUT ||
    path.join(resultsDir, `throughput_results_all_${suffix}.xlsx`);
const outputFile = process.env.MISSING_OUTPUT ||
    path.join(resultsDir, `throughput_missing_combinations_${suffix}.xlsx`);
const desktopOutputFile = path.join(desktopResultsDir, path.basename(outputFile));
function normalizeFunctionName(functionName) {
    const name = String(functionName || '').trim();
    const bareMakeOfferMatch = name.match(/^makeoffer_r(\d+)$/i);

    if (bareMakeOfferMatch) {
        return `makeoffer_r${bareMakeOfferMatch[1]}_1`;
    }

    return name;
}

function isWeightedPackVariant(functionName) {
    return /^pack\d+kg_r\d+(?:_s\d+)?$/i.test(String(functionName || ''));
}

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

function getExpectedLatencies() {
    const latencies = new Set(
        String(process.env.EXTRACT_EXPECTED_LATENCIES || latencyLevels1.join(','))
            .split(',')
            .map(value => value.trim())
            .filter(Boolean)
    );

    return [...latencies].sort((left, right) => Number(left) - Number(right));
}

function safeCopyToDesktop(sourcePath, destinationPath) {
    try {
        fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
        fs.copyFileSync(sourcePath, destinationPath);
        return true;
    } catch (error) {
        console.warn(`⚠️ Could not copy to Desktop results: ${error.message}`);
        return false;
    }
}

function main() {
    if (!fs.existsSync(inputFile)) {
        throw new Error(`Input workbook not found: ${inputFile}`);
    }

    const workbook = XLSX.readFile(inputFile);
    const sheetName = workbook.SheetNames[0];
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: '' })
        .map(row => ({
            ...row,
            functionName: normalizeFunctionName(row.functionName),
            load: Number(row.load),
            latency: String(row.latency || '0')
        }))
        .filter(row => row.functionName && Number.isFinite(row.load))
        .filter(row => !isWeightedPackVariant(row.functionName));

    const latencies = getExpectedLatencies();
    const expectedLoads = getExpectedLoads();
    const expectedLoadSet = new Set(expectedLoads);
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
        .map(normalizeFunctionName)
        .map(functionName => functionName.match(/^makeoffer_r(\d+)(?:_\d+)?$/i))
        .filter(Boolean)
        .map(match => Number(match[1]));
    const expectedMakeOfferFunctions = [
        ...makeOfferCounts.map(retailerCount => `makeoffer_r${retailerCount}_5`),
        ...makeOfferVariants.map(variant => `makeoffer_r5_${variant}`)
    ];
    const observedMakeOfferFunctions = rows
        .map(row => normalizeFunctionName(row.functionName))
        .filter(functionName => /^makeoffer_r\d+(?:_\d+)?$/i.test(functionName))
        .filter(functionName => /^makeoffer_r\d+_5$/i.test(functionName) || /^makeoffer_r5_\d+$/i.test(functionName));
    const expectedCountFunctions = [
        ...testTeaLotBenchmarks1(),
        ...expectedMakeOfferFunctions,
        ...observedMakeOfferFunctions,
        ...packBenchmarks1()
    ];
    const expectedFunctions = [...expectedMatrixFunctions, ...expectedCountFunctions];
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
    const observedCombinationKeys = rows
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
            return { functionName, load: Number(load) };
        })
        .sort((left, right) => {
            const functionCompare = left.functionName.localeCompare(
                right.functionName,
                undefined,
                { numeric: true }
            );
            if (functionCompare !== 0) {
                return functionCompare;
            }

            return Number(left.load) - Number(right.load);
        });
    const existing = new Set(rows.map(row =>
        `${row.functionName}||${Number(row.load)}||${String(row.latency || '0')}`
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
        const outputRow = [];
        let missingCount = 0;

        const expectedLatencySet = expectedLatenciesForFunction(combination.functionName);
        for (const latency of latencies) {
            if (!expectedLatencySet.has(String(latency))) {
                outputRow.push('');
                continue;
            }
            const isPresent = existing.has(`${combination.functionName}||${combination.load}||${latency}`);
            outputRow.push(isPresent ? 'OK' : 'MISSING');
            if (!isPresent) {
                missingCount += 1;
            }
        }

        outputRow.push(combination.functionName, combination.load, missingCount);
        if (missingCount === 0) {
            continue;
        }
        table.push(outputRow);
    }

    const outputWorkbook = XLSX.utils.book_new();
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
    XLSX.utils.book_append_sheet(outputWorkbook, sheet, 'Missing');
    XLSX.writeFile(outputWorkbook, outputFile, { cellStyles: true });
    safeCopyToDesktop(outputFile, desktopOutputFile);

    console.log(`Input: ${inputFile}`);
    console.log(`Rows read: ${rows.length}`);
    console.log(`Combinations written: ${combinations.length}`);
    console.log(`Matrix pairs: ${submitProduceBenchmarks1().join(', ')}`);
    console.log(`Output: ${outputFile}`);
}

main();
