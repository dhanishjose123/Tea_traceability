'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');

// ===============================
// 📁 SETUP
// ===============================
const baseDir = __dirname;
const resultsDir = path.join(baseDir, 'results');

if (!fs.existsSync(resultsDir)) {
    fs.mkdirSync(resultsDir, { recursive: true });
}

// Master file
const masterFile = path.join(resultsDir, 'resource_results_all.csv');

// Create master header
if (!fs.existsSync(masterFile)) {
    fs.writeFileSync(
        masterFile,
        'folder,function,avgCPU,peakCPU,dockerCPU_avg(%),dockerCPU_peak(%),mem_avg(%),mem_avg(MB),netIO_avg(MB)\n'
    );
}

// ===============================
// 🔧 HELPERS
// ===============================
function avg(arr) {
    if (!arr.length) return 0;

    let sum = 0;
    for (let i = 0; i < arr.length; i++) {
        sum += arr[i];
    }
    return sum / arr.length;
}

function peak(arr) {
    if (!arr.length) return 0;

    let max = arr[0];
    for (let i = 1; i < arr.length; i++) {
        if (arr[i] > max) {
            max = arr[i];
        }
    }
    return max;
}

function toMB(value, unit) {
    const val = parseFloat(value);

    if (Number.isNaN(val)) return 0;

    switch (unit) {
        case 'GB':
        case 'GiB':
            return val * 1024;
        case 'kB':
        case 'KiB':
            return val / 1024;
        case 'MB':
        case 'MiB':
        default:
            return val;
    }
}

// ===============================
// 🔹 CPU (top logs) - STREAMED
// ===============================
async function extractCpuUsage(cpuLogFile) {
    try {
        const fileStream = fs.createReadStream(cpuLogFile);

        const rl = readline.createInterface({
            input: fileStream,
            crlfDelay: Infinity
        });

        const cpuValues = [];

        for await (const line of rl) {
            if (!line.includes('Cpu(s)')) continue;

            // Matches: 86.6 id
            const match = line.match(/(\d+\.?\d*)\s*id/);

            if (match) {
                const idle = parseFloat(match[1]);
                const usage = 100 - idle;
                cpuValues.push(usage);
            }
        }

        return {
            avgCPU: avg(cpuValues).toFixed(2),
            peakCPU: peak(cpuValues).toFixed(2)
        };
    } catch (err) {
        console.error(`❌ Error processing ${cpuLogFile}: ${err.message}`);
        return { avgCPU: '0.00', peakCPU: '0.00' };
    }
}

// ===============================
// 🔹 Docker stats extraction
// ===============================
async function extractDockerUsage(dockerLogFile) {
    try {
        const fileStream = fs.createReadStream(dockerLogFile);

        const rl = readline.createInterface({
            input: fileStream,
            crlfDelay: Infinity
        });

        const cpu = [];
        const memPercent = [];
        const memMB = [];
        const netIO = [];

        for await (const line of rl) {
            if (
                line.includes('CONTAINER') ||
                line.includes('CPU %') ||
                line.trim() === ''
            ) {
                continue;
            }

            // ---------------------------
            // CPU %
            // First percentage in docker stats line
            // ---------------------------
            const cpuMatch = line.match(/(\d+\.?\d*)%/);
            if (cpuMatch) {
                cpu.push(parseFloat(cpuMatch[1]));
            }

            // ---------------------------
            // Memory usage / limit
            // Example: 73.76MiB / 2GiB
            // Capture the first value only = actual memory usage
            // ---------------------------
            const memMatch = line.match(/(\d+\.?\d*)(KiB|MiB|GiB|kB|MB|GB)\s*\/\s*(\d+\.?\d*)(KiB|MiB|GiB|kB|MB|GB)/);
            if (memMatch) {
                memMB.push(toMB(memMatch[1], memMatch[2]));
            }

            // ---------------------------
            // Memory %
            // Docker stats line usually has a standalone MEM % column
            // ---------------------------
            const allPercents = [...line.matchAll(/(\d+\.?\d*)%/g)].map(m => parseFloat(m[1]));
            if (allPercents.length >= 2) {
                // second % is usually MEM %
                memPercent.push(allPercents[1]);
            }

            // ---------------------------
            // Network I/O
            // Example: 23.9MB / 17.1MB
            // We take RX only, consistent with your old script
            // ---------------------------
            const netMatch = line.match(/(\d+\.?\d*)(KiB|MiB|GiB|kB|MB|GB)\s*\/\s*(\d+\.?\d*)(KiB|MiB|GiB|kB|MB|GB)/g);
            if (netMatch && netMatch.length >= 2) {
                // First usage/limit match is memory, second is usually NET I/O
                const netLine = netMatch[1];
                const parsedNet = netLine.match(/(\d+\.?\d*)(KiB|MiB|GiB|kB|MB|GB)\s*\/\s*(\d+\.?\d*)(KiB|MiB|GiB|kB|MB|GB)/);

                if (parsedNet) {
                    netIO.push(toMB(parsedNet[1], parsedNet[2]));
                }
            } else {
                // fallback for logs where only net pattern is available once in parsed text
                const fallbackNet = line.match(/(\d+\.?\d*)(kB|MB|GB|KiB|MiB|GiB)\s*\/\s*(\d+\.?\d*)(kB|MB|GB|KiB|MiB|GiB)/);
                if (fallbackNet && !memMatch) {
                    netIO.push(toMB(fallbackNet[1], fallbackNet[2]));
                }
            }
        }

        return {
            avgDockerCPU: avg(cpu).toFixed(2),
            peakDockerCPU: peak(cpu).toFixed(2),
            avgMemPercent: avg(memPercent).toFixed(2),
            avgMemMB: avg(memMB).toFixed(2),
            avgNetIO: avg(netIO).toFixed(2)
        };
    } catch (err) {
        console.error(`❌ Error processing ${dockerLogFile}: ${err.message}`);

        return {
            avgDockerCPU: '0.00',
            peakDockerCPU: '0.00',
            avgMemPercent: '0.00',
            avgMemMB: '0.00',
            avgNetIO: '0.00'
        };
    }
}

// ===============================
// 🔍 Find log folders
// ===============================
const allItems = fs.readdirSync(baseDir);

const logFolders = allItems.filter(item => {
    const fullPath = path.join(baseDir, item);
    return fs.statSync(fullPath).isDirectory() && item.startsWith('logs');
});

console.log('📂 Found folders:', logFolders);

// ===============================
// 🚀 MAIN PROCESS
// ===============================
(async () => {
    for (const folder of logFolders) {
        const logDir = path.join(baseDir, folder);
        const folderFile = path.join(resultsDir, `resource_${folder}.csv`);

        // Write header
        fs.writeFileSync(
            folderFile,
            'function,avgCPU,peakCPU,dockerCPU_avg(%),dockerCPU_peak(%),mem_avg(%),mem_avg(MB),netIO_avg(MB)\n'
        );

        const files = fs.readdirSync(logDir);
        const functions = new Set();

        // detect functions from cpu logs
        for (const file of files) {
            if (file.endsWith('-cpu.log')) {
                const func = file.replace('-cpu.log', '');
                functions.add(func);
            }
        }

        console.log(`\n📁 Processing folder: ${folder}`);
        console.log('🔧 Functions detected:', [...functions]);

        // process each function
        for (const func of functions) {
            const cpuFile = path.join(logDir, `${func}-cpu.log`);
            const dockerFile = path.join(logDir, `${func}-docker.log`);

            if (!fs.existsSync(cpuFile) || !fs.existsSync(dockerFile)) {
                console.warn(`⚠️ Missing logs for ${folder} → ${func}`);
                continue;
            }

            const cpuStats = await extractCpuUsage(cpuFile);
            const dockerStats = await extractDockerUsage(dockerFile);

            const row =
                `${func},${cpuStats.avgCPU},${cpuStats.peakCPU},` +
                `${dockerStats.avgDockerCPU},${dockerStats.peakDockerCPU},` +
                `${dockerStats.avgMemPercent},${dockerStats.avgMemMB},${dockerStats.avgNetIO}\n`;

            // write folder file
            fs.appendFileSync(folderFile, row);

            // write master file
            fs.appendFileSync(masterFile, `${folder},${row}`);

            console.log(
                `✅ ${folder} → ${func} | CPU(avg/peak): ${cpuStats.avgCPU}/${cpuStats.peakCPU} | ` +
                `DockerCPU(avg/peak): ${dockerStats.avgDockerCPU}/${dockerStats.peakDockerCPU} | ` +
                `Mem: ${dockerStats.avgMemMB}MB | Net: ${dockerStats.avgNetIO}MB`
            );
        }
    }

    console.log('\n🎯 Resource extraction complete.');
    console.log('📄 Master file:', masterFile);
})();