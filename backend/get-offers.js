const path = require('path');
const { Gateway, Wallets } = require('fabric-network');
const fs = require('fs');

async function main() {
    const org = "farmers";
    const userId = "Admin";
    const CHANNEL_NAME = "agrochannel1106";
    const CHAINCODE_NAME = "tea_traceability";

    const ccpPath = path.resolve(__dirname, `./connections/connection-${org}.json`);
    const walletPath = path.join(__dirname, "wallet", org);
    const ccp = JSON.parse(fs.readFileSync(ccpPath, "utf8"));
    const wallet = await Wallets.newFileSystemWallet(walletPath);
    const gateway = new Gateway();

    await gateway.connect(ccp, {
        wallet,
        identity: userId,
        discovery: { enabled: true, asLocalhost: true }
    });

    const network = await gateway.getNetwork(CHANNEL_NAME);
    const contract = network.getContract(CHAINCODE_NAME);

    const result = await contract.evaluateTransaction("getAllOffers");
    const parsed = JSON.parse(result.toString());
    const offers = Array.isArray(parsed) ? parsed : (parsed.data || []);

    let count10 = 0;
    for (const offer of offers) {
        if (offer.retailerId === 'User10') {
            count10++;
        }
    }
    console.log(`Total offers: ${offers.length}`);
    console.log(`Offers by Retailer User10: ${count10}`);

    gateway.disconnect();
}
main();
