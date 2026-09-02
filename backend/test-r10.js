const fs = require('fs');
const sum = JSON.parse(fs.readFileSync('/home/dhanish/fabric_2/backend/stats.json', 'utf8'));
const r10 = sum.retailers.find(r => r.retailerId === 'User10');
console.log('User10:', r10);
const r1 = sum.retailers.find(r => r.retailerId === 'User1');
console.log('User1:', r1);
