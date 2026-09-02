'use strict';

const { createSubmitProduceWorkload } = require('./submitproduce_base');

function createWorkloadModule() {
    return createSubmitProduceWorkload(4);
}

module.exports.createWorkloadModule = createWorkloadModule;
