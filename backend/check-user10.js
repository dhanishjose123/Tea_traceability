const { getContract, CHANNEL_NAME, CHAINCODE_NAME } = require('./common');
async function main() {
  const { contract } = await getContract('retailers', 'User10');
  const result = await contract.evaluateTransaction('getAllOffers');
  const offersData = JSON.parse(result.toString());
  const offers = Array.isArray(offersData) ? offersData : (offersData.data || []);
  const user10Offers = offers.filter(o => o.retailerId === 'User10');
  console.log('Total offers:', offers.length);
  console.log('User10 offers:', user10Offers.length);
  if(user10Offers.length > 0) {
    console.log('First User10 offer:', user10Offers[0]);
  }
}
main().catch(console.error);
