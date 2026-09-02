'use strict';

const { createSubmitProduceWorkload } = require('./submitproduce_base');

function createWorkloadModule() {
    return createSubmitProduceWorkload(5, 5);
}

module.exports.createWorkloadModule = createWorkloadModule;
