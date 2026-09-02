'use strict';

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const baseDir = __dirname;
const resultsDir = path.join(baseDir, 'results');
const desktopResultsDir = '/mnt/c/Users/hp/Desktop/dhanish/fabric_2/results';
const suffix = process.env.THROUGHPUT_SUFFIX || '1';
const inputFile = process.env.THROUGHPUT_INPUT ||
    path.join(resultsDir, `throughput_results_all_${suffix}.xlsx`);
const outputFile = process.env.THROUGHPUT_OUTPUT || inputFile;
const desktopOutputFile = path.join(desktopResultsDir, path.basename(outputFile));
const allowedPairCounts = new Set(
    String(process.env.ALLOWED_PAIR_COUNTS || '1,2,4,10,15,20,24')
        .split(',')
        .map(value => Number(value.trim()))
        .filter(value => Number.isFinite(value) && value > 0)
);

function shouldKeepFunction(functionName) {
    const name = String(functionName || '').trim();
    const submitMatch = name.match(/^submitproduce_f(\d+)_a(\d+)$/i);
    if (submitMatch) {
        return submitMatch[1] === submitMatch[2] && allowedPairCounts.has(Number(submitMatch[1]));
    }

    const acceptMatch = name.match(/^acceptoffer_f(\d+)_r(\d+)$/i);
    if (acceptMatch) {
        return acceptMatch[1] === acceptMatch[2] && allowedPairCounts.has(Number(acceptMatch[1]));
    }

    const purchaseMatch = name.match(/^purchase_c(\d+)_r(\d+)$/i);
    if (purchaseMatch) {
        return purchaseMatch[1] === purchaseMatch[2] && allowedPairCounts.has(Number(purchaseMatch[1]));
    }

    return true;
}

function main() {
    if (!fs.existsSync(inputFile)) {
        throw new Error(`Input workbook not found: ${inputFile}`);
    }

    const workbook = XLSX.readFile(inputFile);
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
    const headers = rows[0] ? Object.keys(rows[0]) : [];
    const filteredRows = rows.filter(row => shouldKeepFunction(row.functionName));
    const removedRows = rows.length - filteredRows.length;

    const outputWorkbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
        outputWorkbook,
        XLSX.utils.json_to_sheet(filteredRows, { header: headers }),
        sheetName || 'All'
    );
    XLSX.writeFile(outputWorkbook, outputFile);

    try {
        fs.mkdirSync(path.dirname(desktopOutputFile), { recursive: true });
        fs.copyFileSync(outputFile, desktopOutputFile);
    } catch (error) {
        console.warn(`⚠️ Could not copy to Desktop results: ${error.message}`);
    }

    console.log(`Input: ${inputFile}`);
    console.log(`Rows before: ${rows.length}`);
    console.log(`Rows removed: ${removedRows}`);
    console.log(`Rows after: ${filteredRows.length}`);
    console.log(`Allowed pair counts: ${[...allowedPairCounts].sort((a, b) => a - b).join(', ')}`);
    console.log(`Output: ${outputFile}`);
}

main();
