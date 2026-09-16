import "dotenv/config";

import { network } from "hardhat";
import { getAddress, isAddress, parseUnits } from "viem";

const tokenValue = process.env.TOKEN_ADDRESS;
const userValue = process.env.DEMO_USER_ADDRESS;
if (!tokenValue || !isAddress(tokenValue)) {
  throw new Error("TOKEN_ADDRESS must be set to the deployed MockUSDT address");
}
if (!userValue || !isAddress(userValue)) {
  throw new Error("DEMO_USER_ADDRESS must be set to the recipient wallet");
}

const { viem, networkName } = await network.create();
const publicClient = await viem.getPublicClient();
const token = await viem.getContractAt("MockUSDT", getAddress(tokenValue));

const hash = await token.write.mint([
  getAddress(userValue),
  parseUnits("1000", 6),
]);
await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });

console.log(`Minted 1,000 mUSDT to ${getAddress(userValue)} on ${networkName}`);
