const fs = require('fs');
const sum = JSON.parse(fs.readFileSync('/home/dhanish/fabric_2/backend/stats.json', 'utf8'));
console.log('User1 bidsByRetailer:', sum.farmers.find(f => f.farmerId === 'User1').bidsByRetailer);
console.log('User10 bidsByRetailer:', sum.farmers.find(f => f.farmerId === 'User10').bidsByRetailer);
