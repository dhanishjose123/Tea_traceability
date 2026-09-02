'use strict';

const channelName = 'agrochannel0307';

const strategicCounts1 = [1, 2, 5, 10, 15, 20, 24];
const strategicCounts = [5];
const latencyLevels1 = [0, 25, 50, 100];
const latencyLevels = [ 25];
const tpsLoads1 = [1, 4, 10, 20, 50, 100, 200, 400, 500];
const tpsLoads = [1, 4, 10, 20, 50, 100, 200, 400, 500];

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
    //  [1, 1],
    // [2, 2],
    // [4, 4],
    // [10, 10],
    // [15, 15],
    [20, 20],
    [24, 24],
];

function submitProduceBenchmarks() {
    return strategicPairs.map(([farmers, aggregators]) => `submitproduce_f${farmers}_a${aggregators}`);
}

function acceptOfferBenchmarks() {
    return strategicPairs.map(([farmers, retailers]) => `acceptoffer_f${farmers}_r${retailers}`);
}

function purchaseBenchmarks() {
    return strategicPairs.map(([consumers, retailers]) => `purchase_c${consumers}_r${retailers}`);
}

function submitProduceBenchmarks1() {
    return strategicPairs1.map(([farmers, aggregators]) => `submitproduce_f${farmers}_a${aggregators}`);
}

function acceptOfferBenchmarks1() {
    return strategicPairs1.map(([farmers, retailers]) => `acceptoffer_f${farmers}_r${retailers}`);
}

function purchaseBenchmarks1() {
    return strategicPairs1.map(([consumers, retailers]) => `purchase_c${consumers}_r${retailers}`);
}

function testTeaLotBenchmarks() {
    return strategicCounts.map(count => `testTeaLot_a${count}`);
}

function makeOfferBenchmarks() {
    return strategicCounts.map(count => `makeoffer_r${count}`);
}

function packBenchmarks() {
    return strategicCounts.map(count => `pack_r${count}`);
}

function testTeaLotBenchmarks1() {
    return strategicCounts1.map(count => `testTeaLot_a${count}`);
}

function makeOfferBenchmarks1() {
    return strategicCounts1.map(count => `makeoffer_r${count}`);
}

function packBenchmarks1() {
    return strategicCounts1.map(count => `pack_r${count}`);
}

module.exports = {
    channelName,
    strategicCounts1,
    strategicCounts,
    strategicPairs1,
    strategicPairs,
    latencyLevels1,
    latencyLevels,
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
};
