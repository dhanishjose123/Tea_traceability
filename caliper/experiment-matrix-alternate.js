'use strict';

// Alternate matrix for 5-role batches.
// This file is intentionally separate from experiment-matrix.js.

const channelName = 'agrochannel0307';

// Edit these values for the alternate runner.
// The *1 arrays keep the full candidate set; the non-*1 arrays are what runs now.
const latencyLevels1 = [0, 25, 50, 100];
const latencyLevels = [0, 25, 50, 100];

const tpsLoads1 = [1, 4, 10, 20, 50, 100, 200, 400, 500];
const tpsLoads = [ 1, 4, 10, 20, 50, 100, 200, 400, 500];

const strategicCounts1 = [1, 2, 5, 10, 15, 20, 24];
const strategicCounts = [1, 2, 5, 10, 15, 20, 24];

const strategicPairs1 = [
    [1, 1],
    [2, 2],
    [4, 4],
    [10, 10],
    [15, 15],
    [20, 20],
    [24, 24],
];

const strategicPairs = [
    [1, 1],
    [2, 2],
    [4, 4],
    [10, 10],
    [15, 15],
    [20, 20],
    [24, 24],
];

const makeOfferLotCounts1 = [1, 2, 5, 10, 20, 30, 40, 50];
const makeOfferLotCounts = [ 2, 20, 30, 40, 50];

// Group order used when LATENCY_BENCHMARKS / ALTERNATE_FUNCTIONS is not set.
// Uncomment/comment entries here to control the default alternate run.
const activeBenchmarkGroups = [
    'submitproduce',
    // 'testTeaLot-setup',
    // 'testTeaLot',
    // 'makeoffer',
    // 'makeofferall-setup',
    // 'acceptoffer',
    // 'pack-setup',
    // 'pack',
    // 'purchase-setup',
    // 'purchase',
];

const batchSize = 5;
const setupParticipantCount = 24;

function chunkParticipantCount(total, startIndex = 1) {
    const chunks = [];
    let start = Math.max(1, Number(startIndex) || 1);
    const end = Math.max(1, Number(total) || 1);

    while (start <= end) {
        const count = Math.min(batchSize, end - start + 1);
        chunks.push({ count, start });
        start += count;
    }

    return chunks;
}

function uniqueList(items) {
    return [...new Set(items.filter(Boolean))];
}

function pairedChunks(leftTotal, rightTotal, startIndex = 1) {
    const chunks = [];
    let start = Math.max(1, Number(startIndex) || 1);
    const leftEnd = Math.max(1, Number(leftTotal) || 1);
    const rightEnd = Math.max(1, Number(rightTotal) || 1);
    const sharedEnd = Math.min(leftEnd, rightEnd);

    while (start <= sharedEnd) {
        const count = Math.min(batchSize, sharedEnd - start + 1);
        chunks.push({ leftCount: count, rightCount: count, start });
        start += count;
    }

    return chunks;
}

function submitProduceBenchmarks() {
    return strategicPairs.map(([farmers, aggregators]) =>
        `submitproduce_f${farmers}_a${aggregators}`
    );
}

function submitProduceBenchmarks1() {
    return strategicPairs1.map(([farmers, aggregators]) =>
        `submitproduce_f${farmers}_a${aggregators}`
    );
}

function submitProduceNoMvccSetup(participantCount = 24) {
    const total = Number(participantCount) || setupParticipantCount;
    return pairedChunks(total, total).map(({ leftCount, rightCount, start }) =>
        `submitproduce_no_mvcc_f${leftCount}_a${rightCount}_s${start}`
    );
}

function testTeaLotBenchmarks() {
    return strategicCounts.map(count => `testTeaLot_a${count}`);
}

function testTeaLotBenchmarks1() {
    return strategicCounts1.map(count => `testTeaLot_a${count}`);
}

function testTeaLotSetup(participantCount = 24) {
    const total = Number(participantCount) || setupParticipantCount;
    return chunkParticipantCount(total).map(({ count, start }) =>
        `testTeaLot_a${count}_s${start}`
    );
}

function makeOfferAllSetup(participantCount = 24) {
    const total = Number(participantCount) || setupParticipantCount;
    return pairedChunks(total, total).map(({ leftCount, rightCount, start }) =>
        `makeofferall_r${leftCount}_f${rightCount}_s${start}`
    );
}

function makeOfferBenchmarks(lotCounts = makeOfferLotCounts) {
    return uniqueList(lotCounts.flatMap(lotCount =>
        strategicCounts.map(count => `makeoffer_r${count}_${lotCount}`)
    ));
}

function makeOfferBenchmarks1() {
    return strategicCounts1.map(count => `makeoffer_r${count}`);
}

function acceptOfferBenchmarks() {
    return strategicPairs.map(([farmers, retailers]) =>
        `acceptoffer_f${farmers}_r${retailers}`
    );
}

function acceptOfferBenchmarks1() {
    return strategicPairs1.map(([farmers, retailers]) =>
        `acceptoffer_f${farmers}_r${retailers}`
    );
}

function acceptOfferNoMvccSetup(participantCount = 24) {
    const total = Number(participantCount) || setupParticipantCount;
    return pairedChunks(total, total).map(({ leftCount, rightCount, start }) =>
        `acceptoffer_no_mvcc_f${leftCount}_r${rightCount}_s${start}`
    );
}

function packBenchmarks() {
    return strategicCounts.map(count => `pack_r${count}`);
}

function packBenchmarks1() {
    return strategicCounts1.map(count => `pack_r${count}`);
}

function packSetup(participantCount = 24) {
    const total = Number(participantCount) || setupParticipantCount;
    return chunkParticipantCount(total).map(({ count, start }) =>
        `pack_r${count}_s${start}`
    );
}

function purchaseBenchmarks() {
    return strategicPairs.map(([consumers, retailers]) =>
        `purchase_c${consumers}_r${retailers}`
    );
}

function purchaseBenchmarks1() {
    return strategicPairs1.map(([consumers, retailers]) =>
        `purchase_c${consumers}_r${retailers}`
    );
}

function allBenchmarks() {
    return uniqueList([
        ...submitProduceBenchmarks(),
        ...submitProduceNoMvccSetup(setupParticipantCount),
        ...testTeaLotBenchmarks(),
        ...testTeaLotSetup(setupParticipantCount),
        ...makeOfferBenchmarks(),
        ...makeOfferAllSetup(setupParticipantCount),
        ...acceptOfferBenchmarks(),
        ...acceptOfferNoMvccSetup(setupParticipantCount),
        ...packBenchmarks(),
        ...packSetup(setupParticipantCount),
        ...purchaseBenchmarks(),
    ]);
}

function benchmarkGroups() {
    const groups = {
        submitproduce: submitProduceBenchmarks(),
        'testTeaLot-setup': submitProduceNoMvccSetup(setupParticipantCount),
        testTeaLot: testTeaLotBenchmarks(),
        'testTeaLot-alternate': testTeaLotSetup(setupParticipantCount),
        makeoffer: makeOfferBenchmarks(),
        'makeofferall-setup': makeOfferAllSetup(setupParticipantCount),
        acceptoffer: acceptOfferBenchmarks(),
        'pack-setup': acceptOfferNoMvccSetup(setupParticipantCount),
        pack: packBenchmarks(),
        'purchase-setup': packSetup(setupParticipantCount),
        purchase: purchaseBenchmarks(),
    };

    return activeBenchmarkGroups
        .filter(name => groups[name])
        .map(name => ({ name, benchmarks: groups[name] }));
}

module.exports = {
    channelName,
    batchSize,
    setupParticipantCount,
    strategicCounts1,
    strategicCounts,
    strategicPairs1,
    strategicPairs,
    latencyLevels1,
    latencyLevels,
    tpsLoads1,
    tpsLoads,
    makeOfferLotCounts1,
    makeOfferLotCounts,
    activeBenchmarkGroups,
    chunkParticipantCount,
    uniqueList,
    pairedChunks,
    submitProduceBenchmarks,
    submitProduceBenchmarks1,
    submitProduceNoMvccSetup,
    testTeaLotBenchmarks,
    testTeaLotBenchmarks1,
    testTeaLotSetup,
    makeOfferBenchmarks,
    makeOfferBenchmarks1,
    makeOfferAllSetup,
    acceptOfferBenchmarks,
    acceptOfferBenchmarks1,
    acceptOfferNoMvccSetup,
    packBenchmarks,
    packBenchmarks1,
    packSetup,
    purchaseBenchmarks,
    purchaseBenchmarks1,
    allBenchmarks,
    benchmarkGroups
};
