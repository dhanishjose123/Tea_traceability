const fs = require("fs");
const path = require("path");
const { Gateway, Wallets } = require("fabric-network");

async function getGatewayAndIdentity(org, userId) {
  const ccpPath = path.resolve(__dirname, `./connections/connection-${org}.json`);
  const ccp = JSON.parse(fs.readFileSync(ccpPath, "utf8"));

  const walletPath = path.join(__dirname, "wallet", org);
  const wallet = await Wallets.newFileSystemWallet(walletPath);
  const identity = await wallet.get(userId);
  if (!identity) throw new Error(`Identity '${userId}' not found in wallet for org '${org}'`);

  const gateway = new Gateway();
  await gateway.connect(ccp, {
    wallet,
    identity: userId,
    discovery: { enabled: true, asLocalhost: true }
  });

  return { gateway, identity, ccp };
}

module.exports = { getGatewayAndIdentity };
