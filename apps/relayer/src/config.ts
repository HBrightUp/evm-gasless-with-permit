import "dotenv/config";

import { getAddress, isAddress, type Address, type Hex } from "viem";
import { z } from "zod";

const addressSchema = z
  .string()
  .refine(isAddress, "must be an EVM address")
  .transform((value) => getAddress(value));

const privateKeySchema = z
  .string()
  .trim()
  .transform((value) => (value.startsWith("0x") ? value : `0x${value}`))
  .refine(
    (value) => /^0x[0-9a-fA-F]{64}$/.test(value),
    "must be exactly 64 hex characters, optionally prefixed with 0x",
  )
  .transform((value) => value as Hex);

const environmentSchema = z.object({
  SEPOLIA_RPC_URL: z.string().url(),
  RELAYER_PRIVATE_KEY: privateKeySchema,
  TOKEN_ADDRESS: addressSchema,
  FORWARDER_ADDRESS: addressSchema,
  RECIPIENT_ADDRESS: addressSchema,
  RELAYER_PORT: z.coerce.number().int().min(1).max(65_535).default(8787),
  RELAYER_FEE_USDT: z.coerce.bigint().min(0n).default(10_000n),
  RELAYER_MAX_GAS: z.coerce
    .bigint()
    .min(150_000n)
    .max(1_000_000n)
    .default(350_000n),
  RELAYER_MAX_AMOUNT: z.coerce
    .bigint()
    .min(1n)
    .default(100_000_000_000n),
  RELAYER_CORS_ORIGIN: z.string().default("http://localhost:5173"),
});

const parsed = environmentSchema.safeParse(process.env);
if (!parsed.success) {
  const details = parsed.error.issues
    .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
    .join("; ");
  throw new Error(`Invalid relayer environment: ${details}`);
}

export type RelayerConfig = {
  rpcUrl: string;
  privateKey: Hex;
  tokenAddress: Address;
  forwarderAddress: Address;
  recipientAddress: Address;
  port: number;
  fee: bigint;
  requestGas: bigint;
  maxGas: bigint;
  maxAmount: bigint;
  corsOrigins: string[];
};

export const config: RelayerConfig = {
  rpcUrl: parsed.data.SEPOLIA_RPC_URL,
  privateKey: parsed.data.RELAYER_PRIVATE_KEY,
  tokenAddress: parsed.data.TOKEN_ADDRESS,
  forwarderAddress: parsed.data.FORWARDER_ADDRESS,
  recipientAddress: parsed.data.RECIPIENT_ADDRESS,
  port: parsed.data.RELAYER_PORT,
  fee: parsed.data.RELAYER_FEE_USDT,
  requestGas: 300_000n,
  maxGas: parsed.data.RELAYER_MAX_GAS,
  maxAmount: parsed.data.RELAYER_MAX_AMOUNT,
  corsOrigins: parsed.data.RELAYER_CORS_ORIGIN.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
};
