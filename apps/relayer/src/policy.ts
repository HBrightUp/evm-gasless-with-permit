import {
  decodeFunctionData,
  getAddress,
  isAddressEqual,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";

import {
  gaslessTransferAbi,
  transferWithPermitSelector,
  type ForwardRequest,
} from "../../../shared/contracts.ts";

const MIN_REQUEST_GAS = 150_000n;
const MAX_DEADLINE_SECONDS = 15 * 60;

export class PolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyError";
  }
}

export type Policy = {
  recipientAddress: Address;
  expectedFee: bigint;
  maxGas: bigint;
  maxAmount: bigint;
  nowSeconds?: number;
};

export type TransferIntent = {
  recipient: Address;
  amount: bigint;
  fee: bigint;
  permitDeadline: bigint;
};

export function validateRelayPolicy(
  request: ForwardRequest,
  policy: Policy,
): TransferIntent {
  const now = policy.nowSeconds ?? Math.floor(Date.now() / 1000);

  if (!isAddressEqual(request.to, policy.recipientAddress)) {
    throw new PolicyError("target contract is not sponsored");
  }
  if (request.value !== 0n) {
    throw new PolicyError("native token value is not sponsored");
  }
  if (request.gas < MIN_REQUEST_GAS || request.gas > policy.maxGas) {
    throw new PolicyError("requested gas is outside the sponsored range");
  }
  if (request.deadline <= now) {
    throw new PolicyError("forward request has expired");
  }
  if (request.deadline > now + MAX_DEADLINE_SECONDS) {
    throw new PolicyError("forward request deadline is too far in the future");
  }
  if (!request.data.startsWith(transferWithPermitSelector)) {
    throw new PolicyError("function is not sponsored");
  }

  let decoded: ReturnType<typeof decodeFunctionData>;
  try {
    decoded = decodeFunctionData({
      abi: gaslessTransferAbi,
      data: request.data,
    });
  } catch {
    throw new PolicyError("malformed recipient calldata");
  }

  if (decoded.functionName !== "transferWithPermit") {
    throw new PolicyError("function is not sponsored");
  }

  const [recipient, amount, fee, permitDeadline] = decoded.args as readonly [
    Address,
    bigint,
    bigint,
    bigint,
    number,
    Hex,
    Hex,
  ];
  const normalizedRecipient = getAddress(recipient);

  if (normalizedRecipient === zeroAddress) {
    throw new PolicyError("token recipient cannot be zero");
  }
  if (amount <= 0n || amount > policy.maxAmount) {
    throw new PolicyError("token amount is outside the sponsored range");
  }
  if (fee !== policy.expectedFee) {
    throw new PolicyError("relayer fee does not match the current quote");
  }
  if (permitDeadline < BigInt(request.deadline)) {
    throw new PolicyError("permit expires before the forward request");
  }

  return {
    recipient: normalizedRecipient,
    amount,
    fee,
    permitDeadline,
  };
}
