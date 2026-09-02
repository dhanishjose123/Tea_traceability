const fs = require('fs');

const strategicCounts = [1, 2, 5, 10, 15, 20, 24];
const submitProduceBenchmarks = [
    'submitproduce_f1_a1',
    'submitproduce_f1_a5',
    'submitproduce_f2_a10',
    'submitproduce_f5_a5',
    'submitproduce_f5_a20',
    'submitproduce_f10_a10',
    'submitproduce_f10_a20',
    'submitproduce_f20_a20',
    'submitproduce_f24_a24',
];
const purchaseMatrix = submitProduceBenchmarks.map(benchmark =>
    benchmark.replace(/^submitproduce_f/i, 'purchase_c').replace('_a', '_r')
);

function acceptOfferPipeline(farmerCount, retailerCount) {
    return [
        `makeofferall_r${retailerCount}_f${farmerCount}`,
        `acceptoffer_f${farmerCount}_r${retailerCount}`
    ];
}

const defaultBenchmarkGroups = [
    {
        name: 'submitproduce',
        benchmarks: submitProduceBenchmarks
    },
    {
        name: 'testTeaLot',
        benchmarks: [
            'submitproduce_no_mvcc_f24_a24',
            'testTeaLot_a24',
            'submitproduce_no_mvcc_f20_a20',
            'testTeaLot_a20',
            'submitproduce_no_mvcc_f18_a18',
            'testTeaLot_a18',
            'submitproduce_no_mvcc_f15_a15',
            'testTeaLot_a15',
            'submitproduce_no_mvcc_f10_a10',
            'testTeaLot_a10',
            'submitproduce_no_mvcc_f5_a5',
            'testTeaLot_a5',
            'submitproduce_no_mvcc_f1_a1',
            'testTeaLot_a1'
        ]
    },
    {
        name: 'makeoffer',
        benchmarks: [
            'makeoffer_r24',
            'makeoffer_r20',
            'makeoffer_r10',
            'makeoffer_r5',
            'makeoffer_r1',
            'makeofferall'
        ]
    },
    {
        name: 'acceptoffer',
        benchmarks: [
            ...acceptOfferPipeline(24, 24),
            ...acceptOfferPipeline(20, 20),
            ...acceptOfferPipeline(10, 24),
            ...acceptOfferPipeline(10, 20),
            ...acceptOfferPipeline(10, 10),
            ...acceptOfferPipeline(5, 24),
            ...acceptOfferPipeline(5, 20),
        ]
    },
    {
        name: 'pack',
        benchmarks: [
            'acceptoffer_no_mvcc_f24_r24',
            'pack_r24',
            'acceptoffer_no_mvcc_f20_r20',
            'pack_r20',
            'acceptoffer_no_mvcc_f10_r10',
            'pack_r10',
            'acceptoffer_no_mvcc_f5_r5',
            'pack_r5',
            'acceptoffer_no_mvcc_f1_r1',
            'pack_r1'
        ]
    },
    {
        name: 'purchase',
        benchmarks: purchaseMatrix
    }
];

let csvContent = "Group,Benchmark Name\n";

defaultBenchmarkGroups.forEach(group => {
    group.benchmarks.forEach(benchmark => {
        csvContent += `${group.name},${benchmark}\n`;
    });
});

fs.writeFileSync('experiment_combinations.csv', csvContent);
console.log("CSV created: experiment_combinations.csv");
