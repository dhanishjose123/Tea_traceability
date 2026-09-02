'use strict';

const { createSubmitProduceWorkload } = require('./submitproduce_base');

function createWorkloadModule() {
    return createSubmitProduceWorkload(1);
}

module.exports.createWorkloadModule = createWorkloadModule;
