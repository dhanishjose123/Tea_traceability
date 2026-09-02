const fs = require('fs');
const path = require('path');

const cacheFile = path.join(__dirname, 'tmp', 'preload-cache', 'makeoffer_matrix__agrochannel0107__tea_traceability__r5__lots5.json');
const latestLog = path.join(__dirname, 'logs_9_cached', 'logs_multi', 'makeoffer_r5_5-multi-1782891000500.log');

console.log('cacheFile:', cacheFile);
if (fs.existsSync(cacheFile)) {
    const data = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    console.log('cacheRecords:', Array.isArray(data) ? data.length : 0);
    console.log('firstLot:', Array.isArray(data) && data[0] ? data[0].lotId : 'none');
}

console.log('latestLog:', latestLog);
if (fs.existsSync(latestLog)) {
    const lines = fs.readFileSync(latestLog, 'utf8').split(/\r?\n/).filter(line =>
        /PRELOAD_CACHE|LOADED FROM CACHE|loadedLots|MakeOfferMatrix|makeoffer_r5_5_Load|Submitted:/i.test(line)
    );
    console.log(lines.slice(-120).join('\n'));
}
