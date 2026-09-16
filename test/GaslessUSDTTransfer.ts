import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { network } from "hardhat";
import {
  encodeFunctionData,
  getAddress,
  parseUnits,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";

import {
  FORWARDER_NAME,
  FORWARDER_VERSION,
  forwardRequestTypes,
  gaslessTransferAbi,
  permitTypes,
  splitRpcSignature,
  type ForwardRequest,
} from "../shared/contracts.ts";

describe("GaslessUSDTTransfer", async function () {
  const { viem } = await network.create();
  const publicClient = await viem.getPublicClient();
  const [deployer, user, payee, treasury, relayer, attacker] =
    await viem.getWalletClients();

  let token: Awaited<ReturnType<typeof viem.deployContract>>;
  let forwarder: Awaited<ReturnType<typeof viem.deployContract>>;
  let recipient: Awaited<ReturnType<typeof viem.deployContract>>;

  beforeEach(async function () {
    token = await viem.deployContract("MockUSDT", [
      deployer.account.address,
    ]);
    forwarder = await viem.deployContract("GaslessForwarder");
    recipient = await viem.deployContract("GaslessUSDTTransfer", [
      token.address,
      forwarder.address,
      treasury.account.address,
    ]);

    await token.write.mint([
      user.account.address,
      parseUnits("1000", 6),
    ]);
  });

  async function buildRequest(options?: {
    amount?: bigint;
    fee?: bigint;
    forwardDeadline?: number;
    permitDeadline?: bigint;
    signer?: typeof user;
    target?: Address;
  }): Promise<ForwardRequest> {
    const signer = options?.signer ?? user;
    const amount = options?.amount ?? parseUnits("25", 6);
    const fee = options?.fee ?? parseUnits("0.01", 6);
    const latestBlock = await publicClient.getBlock();
    const now = Number(latestBlock.timestamp);
    const forwardDeadline = options?.forwardDeadline ?? now + 900;
    const permitDeadline = options?.permitDeadline ?? BigInt(now + 900);
    const chainId = await publicClient.getChainId();

    const permitNonce = await token.read.nonces([
      signer.account.address,
    ]) as bigint;
    const permitSignature = await signer.signTypedData({
      domain: {
        name: "Mock USDT",
        version: "1",
        chainId,
        verifyingContract: token.address,
      },
      types: permitTypes,
      primaryType: "Permit",
      message: {
        owner: signer.account.address,
        spender: recipient.address,
        value: amount + fee,
        nonce: permitNonce,
        deadline: permitDeadline,
      },
    });
    const { v, r, s } = splitRpcSignature(permitSignature);

    const data = encodeFunctionData({
      abi: gaslessTransferAbi,
      functionName: "transferWithPermit",
      args: [
        payee.account.address,
        amount,
        fee,
        permitDeadline,
        v,
        r,
        s,
      ],
    });

    const forwardNonce = await forwarder.read.nonces([
      signer.account.address,
    ]) as bigint;
    const to = options?.target ?? recipient.address;
    const gas = 300_000n;
    const value = 0n;
    const signature = await signer.signTypedData({
      domain: {
        name: FORWARDER_NAME,
        version: FORWARDER_VERSION,
        chainId,
        verifyingContract: forwarder.address,
      },
      types: forwardRequestTypes,
      primaryType: "ForwardRequest",
      message: {
        from: signer.account.address,
        to,
        value,
        gas,
        nonce: forwardNonce,
        deadline: forwardDeadline,
        data,
      },
    });

    return {
      from: getAddress(signer.account.address),
      to: getAddress(to),
      value,
      gas,
      deadline: forwardDeadline,
      data,
      signature,
    };
  }

  it("moves mUSDT and charges the signed fee while the user pays no ETH", async function () {
    const amount = parseUnits("25", 6);
    const fee = parseUnits("0.01", 6);
    const request = await buildRequest({ amount, fee });
    const userEthBefore = await publicClient.getBalance({
      address: user.account.address,
    });

    assert.equal(await forwarder.read.verify([request]), true);

    const hash = await forwarder.write.execute([request], {
      account: relayer.account,
    });
    await publicClient.waitForTransactionReceipt({ hash });

    assert.equal(
      await token.read.balanceOf([payee.account.address]),
      amount,
    );
    assert.equal(
      await token.read.balanceOf([treasury.account.address]),
      fee,
    );
    assert.equal(
      await token.read.balanceOf([user.account.address]),
      parseUnits("1000", 6) - amount - fee,
    );
    assert.equal(
      await publicClient.getBalance({ address: user.account.address }),
      userEthBefore,
    );
  });

  it("rejects replay after consuming the forwarder nonce", async function () {
    const request = await buildRequest();
    const hash = await forwarder.write.execute([request], {
      account: relayer.account,
    });
    await publicClient.waitForTransactionReceipt({ hash });

    assert.equal(await forwarder.read.verify([request]), false);
    await assert.rejects(
      forwarder.write.execute([request], { account: relayer.account }),
    );
  });

  it("cannot use another user's permit from a direct attacker call", async function () {
    const request = await buildRequest();
    const decoded = await import("viem").then(({ decodeFunctionData }) =>
      decodeFunctionData({
        abi: gaslessTransferAbi,
        data: request.data,
      }),
    );

    await assert.rejects(
      recipient.write.transferWithPermit(
        decoded.args as [
          Address,
          bigint,
          bigint,
          bigint,
          number,
          Hex,
          Hex,
        ],
        { account: attacker.account },
      ),
    );
    assert.equal(
      await token.read.balanceOf([payee.account.address]),
      0n,
    );
  });

  it("rejects a fee above the on-chain five percent cap", async function () {
    const amount = parseUnits("1", 6);
    const request = await buildRequest({
      amount,
      fee: parseUnits("0.06", 6),
    });

    await assert.rejects(
      forwarder.write.execute([request], { account: relayer.account }),
    );
    assert.equal(
      await forwarder.read.nonces([user.account.address]),
      0n,
    );
  });

  it("rejects expired and untrusted-target requests before execution", async function () {
    const latestBlock = await publicClient.getBlock();
    const expired = await buildRequest({
      forwardDeadline: Number(latestBlock.timestamp) - 1,
    });
    assert.equal(await forwarder.read.verify([expired]), false);

    const wrongTarget = await buildRequest({ target: zeroAddress });
    assert.equal(await forwarder.read.verify([wrongTarget]), false);
  });
});
