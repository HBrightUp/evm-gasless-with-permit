import {
  parseAbi,
  toFunctionSelector,
  type Address,
  type Hex,
} from "viem";

export const SEPOLIA_CHAIN_ID = 11_155_111;
export const TOKEN_DECIMALS = 6;
export const FORWARDER_NAME = "GaslessUSDTForwarder";
export const FORWARDER_VERSION = "1";

export const forwarderAbi = parseAbi([
  "function execute((address from,address to,uint256 value,uint256 gas,uint48 deadline,bytes data,bytes signature) request) payable",
  "function verify((address from,address to,uint256 value,uint256 gas,uint48 deadline,bytes data,bytes signature) request) view returns (bool)",
  "function nonces(address owner) view returns (uint256)",
  "event ExecutedForwardRequest(address indexed signer,uint256 nonce,bool success)",
]);

export const tokenAbi = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address account) view returns (uint256)",
  "function allowance(address owner,address spender) view returns (uint256)",
  "function nonces(address owner) view returns (uint256)",
]);

export const gaslessTransferAbi = parseAbi([
  "function transferWithPermit(address recipient,uint256 amount,uint256 fee,uint256 permitDeadline,uint8 v,bytes32 r,bytes32 s)",
  "function token() view returns (address)",
  "function treasury() view returns (address)",
  "function trustedForwarder() view returns (address)",
  "function MAX_FEE_BPS() view returns (uint256)",
  "event GaslessTransfer(address indexed sender,address indexed recipient,uint256 amount,uint256 fee,address indexed relayer)",
]);

export const transferWithPermitSelector = toFunctionSelector(
  "transferWithPermit(address,uint256,uint256,uint256,uint8,bytes32,bytes32)",
);

export const permitTypes = {
  Permit: [
    { name: "owner", type: "address" },
    { name: "spender", type: "address" },
    { name: "value", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

export const forwardRequestTypes = {
  ForwardRequest: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "gas", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint48" },
    { name: "data", type: "bytes" },
  ],
} as const;

export type ForwardRequest = {
  from: Address;
  to: Address;
  value: bigint;
  gas: bigint;
  deadline: number;
  data: Hex;
  signature: Hex;
};

export type UnsignedForwardRequest = Omit<ForwardRequest, "signature"> & {
  nonce: bigint;
};

export function splitRpcSignature(signature: Hex): {
  v: number;
  r: Hex;
  s: Hex;
} {
  if (signature.length !== 132) {
    throw new Error("Expected a 65-byte RPC signature");
  }

  const r = `0x${signature.slice(2, 66)}` as Hex;
  const s = `0x${signature.slice(66, 130)}` as Hex;
  let v = Number.parseInt(signature.slice(130, 132), 16);
  if (v < 27) v += 27;

  return { v, r, s };
}
