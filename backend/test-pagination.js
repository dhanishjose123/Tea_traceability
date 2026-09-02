const { getContract, CHANNEL_NAME, CHAINCODE_NAME } = require('./fabric-utils');
async function main() {
  const { contract } = await getContract('retailers', 'User1');
  const result = await contract.evaluateTransaction('getAllOffers');
  const offersData = JSON.parse(result.toString());
  const offers = Array.isArray(offersData) ? offersData : (offersData.data || []);
  console.log('total length:', offers.length);
  process.exit(0);
}
main().catch(console.error);
