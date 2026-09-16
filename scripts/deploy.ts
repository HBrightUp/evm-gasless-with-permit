import "dotenv/config";

import { network } from "hardhat";
import { getAddress, isAddress, parseUnits } from "viem";

const { viem, networkName } = await network.create();
const publicClient = await viem.getPublicClient();
const [deployer] = await viem.getWalletClients();

const treasuryValue = process.env.TREASURY_ADDRESS ?? deployer.account.address;
if (!isAddress(treasuryValue)) {
  throw new Error("TREASURY_ADDRESS is not a valid address");
}
const treasury = getAddress(treasuryValue);

console.log(`Deploying gasless USDT demo to ${networkName}...`);
console.log(`Deployer: ${deployer.account.address}`);
console.log(`Treasury: ${treasury}`);

const token = await viem.deployContract("MockUSDT", [
  deployer.account.address,
]);
const forwarder = await viem.deployContract("GaslessForwarder");
const recipient = await viem.deployContract("GaslessUSDTTransfer", [
  token.address,
  forwarder.address,
  treasury,
]);

const demoUserValue = process.env.DEMO_USER_ADDRESS;
if (demoUserValue) {
  if (!isAddress(demoUserValue)) {
    throw new Error("DEMO_USER_ADDRESS is not a valid address");
  }

  const hash = await token.write.mint([
    getAddress(demoUserValue),
    parseUnits("1000", 6),
  ]);
  await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
  console.log(`Minted 1,000 mUSDT to ${getAddress(demoUserValue)}`);
}

console.log("Deployment complete:");
console.log(`TOKEN_ADDRESS=${token.address}`);
console.log(`FORWARDER_ADDRESS=${forwarder.address}`);
console.log(`RECIPIENT_ADDRESS=${recipient.address}`);
