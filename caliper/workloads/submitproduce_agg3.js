'use strict';

const { createSubmitProduceWorkload } = require('./submitproduce_base');

function createWorkloadModule() {
    return createSubmitProduceWorkload(3);
}

module.exports.createWorkloadModule = createWorkloadModule;
