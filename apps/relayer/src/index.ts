import cors from "cors";
import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import {
  createPublicClient,
  createWalletClient,
  formatEther,
  http,
  isAddressEqual,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { ZodError } from "zod";

import {
  FORWARDER_NAME,
  FORWARDER_VERSION,
  SEPOLIA_CHAIN_ID,
  TOKEN_DECIMALS,
  forwarderAbi,
  gaslessTransferAbi,
} from "../../../shared/contracts.ts";
import { config } from "./config.ts";
import { PolicyError, validateRelayPolicy } from "./policy.ts";
import { rateLimit } from "./rate-limit.ts";
import { quoteQuerySchema, relayBodySchema } from "./schema.ts";

const account = privateKeyToAccount(config.privateKey);
const transport = http(config.rpcUrl);
const publicClient = createPublicClient({ chain: sepolia, transport });
const walletClient = createWalletClient({
  account,
  chain: sepolia,
  transport,
});

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(
  cors({
    origin: config.corsOrigins,
    methods: ["GET", "POST"],
  }),
);
app.use(express.json({ limit: "16kb" }));
app.use(rateLimit);

app.get("/health", async (_request, response) => {
  const [chainId, balance] = await Promise.all([
    publicClient.getChainId(),
    publicClient.getBalance({ address: account.address }),
  ]);

  response.json({
    ok: chainId === SEPOLIA_CHAIN_ID,
    chainId,
    relayer: account.address,
    relayerEth: formatEther(balance),
  });
});

app.get("/config", (_request, response) => {
  response.json({
    chainId: SEPOLIA_CHAIN_ID,
    tokenAddress: config.tokenAddress,
    forwarderAddress: config.forwarderAddress,
    recipientAddress: config.recipientAddress,
    tokenDecimals: TOKEN_DECIMALS,
    tokenSymbol: "mUSDT",
    forwarderName: FORWARDER_NAME,
    forwarderVersion: FORWARDER_VERSION,
    fee: config.fee.toString(),
    requestGas: config.requestGas.toString(),
    maxAmount: config.maxAmount.toString(),
  });
});

app.get("/quote", (request, response) => {
  const query = quoteQuerySchema.parse(request.query);
  const maximumFee = (query.amount * 500n) / 10_000n;
  if (query.amount === 0n || config.fee > maximumFee) {
    response.status(400).json({
      error: "amount is too small for the configured fee",
      minimumAmount: (
        config.fee === 0n ? 1n : (config.fee * 10_000n + 499n) / 500n
      ).toString(),
    });
    return;
  }
  if (query.amount > config.maxAmount) {
    response.status(400).json({ error: "amount exceeds relayer policy" });
    return;
  }

  response.json({
    fee: config.fee.toString(),
    requestGas: config.requestGas.toString(),
    expiresAt: Math.floor(Date.now() / 1000) + 10 * 60,
  });
});

let relayQueue: Promise<unknown> = Promise.resolve();
function enqueue<T>(operation: () => Promise<T>): Promise<T> {
  const result = relayQueue.then(operation, operation);
  relayQueue = result.catch(() => undefined);
  return result;
}

app.post("/relay", async (request, response) => {
  const body = relayBodySchema.parse(request.body);
  const forwardRequest = body.request;

  validateRelayPolicy(forwardRequest, {
    recipientAddress: config.recipientAddress,
    expectedFee: config.fee,
    maxGas: config.maxGas,
    maxAmount: config.maxAmount,
  });

  const valid = await publicClient.readContract({
    address: config.forwarderAddress,
    abi: forwarderAbi,
    functionName: "verify",
    args: [forwardRequest],
  });
  if (!valid) {
    response.status(400).json({ error: "invalid ERC-2771 request" });
    return;
  }

  const transactionHash = await enqueue(async () => {
    // Recheck after waiting in the queue because the signer nonce may have changed.
    const stillValid = await publicClient.readContract({
      address: config.forwarderAddress,
      abi: forwarderAbi,
      functionName: "verify",
      args: [forwardRequest],
    });
    if (!stillValid) {
      throw new PolicyError("request became invalid before submission");
    }

    const simulation = await publicClient.simulateContract({
      account,
      address: config.forwarderAddress,
      abi: forwarderAbi,
      functionName: "execute",
      args: [forwardRequest],
      value: 0n,
    });
    return walletClient.writeContract(simulation.request);
  });

  const receipt = await publicClient.waitForTransactionReceipt({
    hash: transactionHash,
    confirmations: 1,
    timeout: 90_000,
  });

  response.json({
    transactionHash,
    status: receipt.status,
    blockNumber: receipt.blockNumber.toString(),
  });
});

app.use(
  (
    error: unknown,
    _request: Request,
    response: Response,
    _next: NextFunction,
  ) => {
    if (error instanceof ZodError) {
      response.status(400).json({
        error: "invalid request",
        details: error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      });
      return;
    }
    if (error instanceof PolicyError) {
      response.status(400).json({ error: error.message });
      return;
    }

    console.error(error);
    response.status(500).json({ error: "relay execution failed" });
  },
);

async function start(): Promise<void> {
  const [chainId, tokenCode, forwarderCode, recipientCode] = await Promise.all([
    publicClient.getChainId(),
    publicClient.getCode({ address: config.tokenAddress }),
    publicClient.getCode({ address: config.forwarderAddress }),
    publicClient.getCode({ address: config.recipientAddress }),
  ]);
  if (chainId !== SEPOLIA_CHAIN_ID) {
    throw new Error(`RPC chain ${chainId} is not Sepolia`);
  }
  if (!tokenCode || !forwarderCode || !recipientCode) {
    throw new Error("one or more configured contracts are not deployed");
  }

  const [configuredToken, configuredForwarder] = await Promise.all([
    publicClient.readContract({
      address: config.recipientAddress,
      abi: gaslessTransferAbi,
      functionName: "token",
    }),
    publicClient.readContract({
      address: config.recipientAddress,
      abi: gaslessTransferAbi,
      functionName: "trustedForwarder",
    }),
  ]);
  if (
    !isAddressEqual(configuredToken, config.tokenAddress) ||
    !isAddressEqual(configuredForwarder, config.forwarderAddress)
  ) {
    throw new Error("recipient contract does not match relayer configuration");
  }

  app.listen(config.port, () => {
    console.log(`Relayer listening on http://localhost:${config.port}`);
    console.log(`Relayer account: ${account.address}`);
  });
}

start().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
