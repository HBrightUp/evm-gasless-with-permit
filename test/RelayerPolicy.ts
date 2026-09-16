import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  encodeFunctionData,
  getAddress,
  pad,
  zeroAddress,
  type Hex,
} from "viem";

import {
  gaslessTransferAbi,
  type ForwardRequest,
} from "../shared/contracts.ts";
import {
  PolicyError,
  validateRelayPolicy,
} from "../apps/relayer/src/policy.ts";

const user = getAddress("0x1000000000000000000000000000000000000001");
const target = getAddress("0x2000000000000000000000000000000000000002");
const payee = getAddress("0x3000000000000000000000000000000000000003");
const signature = `0x${"11".repeat(65)}` as Hex;

function makeRequest(overrides: Partial<ForwardRequest> = {}): ForwardRequest {
  const now = 2_000_000_000;
  return {
    from: user,
    to: target,
    value: 0n,
    gas: 300_000n,
    deadline: now + 600,
    data: encodeFunctionData({
      abi: gaslessTransferAbi,
      functionName: "transferWithPermit",
      args: [
        payee,
        10_000_000n,
        10_000n,
        BigInt(now + 600),
        27,
        pad("0x01", { size: 32 }),
        pad("0x02", { size: 32 }),
      ],
    }),
    signature,
    ...overrides,
  };
}

const policy = {
  recipientAddress: target,
  expectedFee: 10_000n,
  maxGas: 350_000n,
  maxAmount: 100_000_000_000n,
  nowSeconds: 2_000_000_000,
};

describe("relayer policy", function () {
  it("accepts only the intended fixed-fee permit transfer", function () {
    const intent = validateRelayPolicy(makeRequest(), policy);
    assert.equal(intent.recipient, payee);
    assert.equal(intent.amount, 10_000_000n);
    assert.equal(intent.fee, 10_000n);
  });

  it("rejects arbitrary target contracts and native value", function () {
    assert.throws(
      () => validateRelayPolicy(makeRequest({ to: zeroAddress }), policy),
      PolicyError,
    );
    assert.throws(
      () => validateRelayPolicy(makeRequest({ value: 1n }), policy),
      PolicyError,
    );
  });

  it("rejects fee changes, excessive gas, and long-lived requests", function () {
    const wrongFeeData = encodeFunctionData({
      abi: gaslessTransferAbi,
      functionName: "transferWithPermit",
      args: [
        payee,
        10_000_000n,
        20_000n,
        2_000_000_600n,
        27,
        pad("0x01", { size: 32 }),
        pad("0x02", { size: 32 }),
      ],
    });

    assert.throws(
      () => validateRelayPolicy(makeRequest({ data: wrongFeeData }), policy),
      PolicyError,
    );
    assert.throws(
      () => validateRelayPolicy(makeRequest({ gas: 900_000n }), policy),
      PolicyError,
    );
    assert.throws(
      () =>
        validateRelayPolicy(
          makeRequest({ deadline: 2_000_000_000 + 3_600 }),
          policy,
        ),
      PolicyError,
    );
  });
});
