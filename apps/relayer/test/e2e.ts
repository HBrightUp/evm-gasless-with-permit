// Runs exclusively against an ephemeral loopback Hardhat chain. No Sepolia
// transaction or project private key is used by this test.
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  createPublicClient, createWalletClient, encodeFunctionData, http,
  parseAbi, parseEther, parseUnits, toHex, type Abi, type Address, type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import {
  FORWARDER_NAME, FORWARDER_VERSION, forwarderAbi, forwardRequestTypes,
  gaslessTransferAbi, permitTypes, splitRpcSignature, tokenAbi,
} from "../../../shared/contracts.ts";

async function unusedPort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

const children: ChildProcess[] = [];
function start(command: string, args: string[], env = process.env) {
  const child = spawn(command, args, { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  // Keep only recent output for diagnostics. Never print the subprocess env.
  let output = "";
  let failure: Error | undefined;
  const collect = (chunk: Buffer) => { output = (output + chunk.toString()).slice(-8000); };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);
  child.on("error", (error) => { failure = error; });
  return { child, check() {
    if (failure) throw failure;
    if (child.exitCode !== null) throw new Error(`Test service exited (${child.exitCode}): ${output}`);
  } };
}

async function waitReady(service: ReturnType<typeof start>, check: () => Promise<unknown>) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    service.check();
    try { await check(); return; } catch { await delay(250); }
  }
  throw new Error("Test service did not become ready within 45 seconds");
}

try {
  await mkdir("cache", { recursive: true });
  const binary = resolve("cache", `relayer-e2e-${process.pid}${process.platform === "win32" ? ".exe" : ""}`);
  const emptyEnv = resolve("cache", `relayer-e2e-${process.pid}.env`);
  await writeFile(emptyEnv, "# E2E uses only generated local accounts.\n");
  execFileSync("go", ["build", "-o", binary, "./apps/relayer"], { stdio: "inherit", windowsHide: true });

  const rpcPort = await unusedPort();
  const rpcURL = `http://127.0.0.1:${rpcPort}`;
  const node = start(process.execPath, [
    "node_modules/hardhat/dist/src/cli.js", "node", "--hostname", "127.0.0.1",
    "--port", String(rpcPort), "--chain-id", String(sepolia.id),
  ], { ...process.env, DOTENV_CONFIG_PATH: emptyEnv });
  const publicClient = createPublicClient({ chain: sepolia, transport: http(rpcURL, { timeout: 2000, retryCount: 0 }) });
  const wallet = createWalletClient({ chain: sepolia, transport: http(rpcURL) });
  await waitReady(node, () => publicClient.getChainId());
  assert.equal(await publicClient.getChainId(), sepolia.id);
  const [deployer, payee, treasury] = await wallet.getAddresses();
  assert(deployer && payee && treasury);

  async function deploy(contractPath: string, args: readonly unknown[] = []): Promise<Address> {
    const artifact = JSON.parse(await readFile(`artifacts/contracts/${contractPath}`, "utf8")) as { abi: Abi; bytecode: Hex };
    const hash = await wallet.deployContract({ account: deployer!, abi: artifact.abi, bytecode: artifact.bytecode, args });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    assert.equal(receipt.status, "success");
    assert(receipt.contractAddress);
    return receipt.contractAddress;
  }
  const token = await deploy("mocks/MockUSDT.sol/MockUSDT.json", [deployer]);
  const forwarder = await deploy("GaslessForwarder.sol/GaslessForwarder.json");
  const recipient = await deploy("GaslessUSDTTransfer.sol/GaslessUSDTTransfer.json", [token, forwarder, treasury]);
  const relayerKey = generatePrivateKey();
  const relayerAccount = privateKeyToAccount(relayerKey);
  async function localRPC(method: string, params: unknown[]) {
    const response = await fetch(rpcURL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    const result = await response.json() as { error?: unknown };
    assert(!result.error, JSON.stringify(result.error));
  }
  await localRPC("hardhat_setBalance", [relayerAccount.address, toHex(parseEther("5"))]);
  const relayPort = await unusedPort();
  const baseURL = `http://127.0.0.1:${relayPort}`;
  const goService = start(binary, [], {
    ...process.env, RELAYER_ENV_FILE: emptyEnv, SEPOLIA_RPC_URL: rpcURL,
    RELAYER_PRIVATE_KEY: relayerKey, TOKEN_ADDRESS: token, FORWARDER_ADDRESS: forwarder,
    RECIPIENT_ADDRESS: recipient, RELAYER_PORT: String(relayPort), RELAYER_FEE_USDT: "10000",
    RELAYER_MAX_GAS: "350000", RELAYER_MAX_AMOUNT: "100000000000",
    RELAYER_CORS_ORIGIN: "http://localhost:5173", RELAYER_TRUSTED_PROXIES: "",
  });
  await waitReady(goService, async () => {
    const response = await fetch(`${baseURL}/health`, { signal: AbortSignal.timeout(2000) });
    assert(response.ok);
    const health = await response.json() as { ok: boolean; relayer: string };
    assert(health.ok);
    assert.equal(health.relayer.toLowerCase(), relayerAccount.address.toLowerCase());
  });
  const config = await (await fetch(`${baseURL}/config`)).json() as { recipientAddress: string; fee: string };
  assert.equal(config.recipientAddress.toLowerCase(), recipient.toLowerCase());
  assert.equal(config.fee, "10000");

  const amount = parseUnits("25", 6);
  const fee = parseUnits("0.01", 6);
  const mintABI = parseAbi(["function mint(address to,uint256 amount)"]);
  async function newUser() {
    const user = privateKeyToAccount(generatePrivateKey());
    const hash = await wallet.writeContract({ account: deployer!, address: token, abi: mintABI, functionName: "mint", args: [user.address, parseUnits("1000", 6)] });
    await publicClient.waitForTransactionReceipt({ hash });
    assert.equal(await publicClient.getBalance({ address: user.address }), 0n);
    return user;
  }
  async function signedRequest(user: ReturnType<typeof privateKeyToAccount>, transferAmount = amount) {
    const quoteResponse = await fetch(`${baseURL}/quote?amount=${transferAmount}`);
    assert(quoteResponse.ok);
    const quote = await quoteResponse.json() as { fee: string; requestGas: string; expiresAt: number };
    const permitNonce = await publicClient.readContract({ address: token, abi: tokenAbi, functionName: "nonces", args: [user.address] });
    const signature = await user.signTypedData({
      domain: { name: "Mock USDT", version: "1", chainId: sepolia.id, verifyingContract: token }, types: permitTypes, primaryType: "Permit",
      message: { owner: user.address, spender: recipient, value: transferAmount + BigInt(quote.fee), nonce: permitNonce, deadline: BigInt(quote.expiresAt) },
    });
    const { v, r, s } = splitRpcSignature(signature);
    const data = encodeFunctionData({ abi: gaslessTransferAbi, functionName: "transferWithPermit", args: [payee!, transferAmount, BigInt(quote.fee), BigInt(quote.expiresAt), v, r, s] });
    const nonce = await publicClient.readContract({ address: forwarder, abi: forwarderAbi, functionName: "nonces", args: [user.address] });
    const forwardSignature = await user.signTypedData({
      domain: { name: FORWARDER_NAME, version: FORWARDER_VERSION, chainId: sepolia.id, verifyingContract: forwarder }, types: forwardRequestTypes, primaryType: "ForwardRequest",
      message: { from: user.address, to: recipient, value: 0n, gas: BigInt(quote.requestGas), nonce, deadline: quote.expiresAt, data },
    });
    return { request: { from: user.address, to: recipient, value: "0", gas: quote.requestGas, deadline: quote.expiresAt, data, signature: forwardSignature } };
  }
  async function post(body: unknown) {
    const response = await fetch(`${baseURL}/relay`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(110_000) });
    const payload = await response.json() as { transactionHash?: Hex; status?: string; error?: string };
    return { response, payload };
  }
  const balanceOf = (address: Address) => publicClient.readContract({ address: token, abi: tokenAbi, functionName: "balanceOf", args: [address] });

  const user = await newUser();
  const request = await signedRequest(user);
  const relayerETHBefore = await publicClient.getBalance({ address: relayerAccount.address });
  const result = await post(request);
  assert.equal(result.response.status, 200, JSON.stringify(result.payload));
  assert.equal(result.payload.status, "success");
  assert(result.payload.transactionHash);
  const transaction = await publicClient.getTransaction({ hash: result.payload.transactionHash });
  assert.equal(transaction.type, "eip1559");
  assert.equal(transaction.from.toLowerCase(), relayerAccount.address.toLowerCase());
  assert.equal(transaction.to?.toLowerCase(), forwarder.toLowerCase());
  assert.equal(await balanceOf(user.address), parseUnits("1000", 6) - amount - fee);
  assert.equal(await balanceOf(payee), amount);
  assert.equal(await balanceOf(treasury), fee);
  assert.equal(await publicClient.getBalance({ address: user.address }), 0n);
  assert((await publicClient.getBalance({ address: relayerAccount.address })) < relayerETHBefore);
  assert.equal(await publicClient.readContract({ address: token, abi: tokenAbi, functionName: "nonces", args: [user.address] }), 1n);
  assert.equal(await publicClient.readContract({ address: forwarder, abi: forwarderAbi, functionName: "nonces", args: [user.address] }), 1n);
  console.log("PASS: viem signatures -> Gin -> EIP-1559 -> real contracts; user pays zero ETH");

  const replay = await post(request);
  assert.equal(replay.response.status, 400);
  console.log("PASS: consumed Forwarder nonce rejects replay");

  const nonceBefore = await publicClient.getTransactionCount({ address: relayerAccount.address });
  const impossible = await signedRequest(user, parseUnits("2000", 6));
  const rejected = await post(impossible);
  assert.equal(rejected.response.status, 500);
  assert.equal(await publicClient.getTransactionCount({ address: relayerAccount.address }), nonceBefore);
  assert.equal(await publicClient.readContract({ address: forwarder, abi: forwarderAbi, functionName: "nonces", args: [user.address] }), 1n);
  console.log("PASS: insufficient balance fails simulation before spending gas or consuming nonce");

  const users = await Promise.all([newUser(), newUser()]);
  const requests = await Promise.all(users.map((user) => signedRequest(user)));
  const results = await Promise.all(requests.map(post));
  for (let index = 0; index < results.length; index++) {
    const item = results[index]!;
    assert.equal(item.response.status, 200, JSON.stringify(item.payload));
    assert.equal(await balanceOf(users[index]!.address), parseUnits("1000", 6) - amount - fee);
  }
  const transactions = await Promise.all(results.map((item) => publicClient.getTransaction({ hash: item.payload.transactionHash! })));
  assert.equal(new Set(transactions.map((tx) => tx.nonce)).size, 2);
  assert.equal(await balanceOf(payee), 3n * amount);
  assert.equal(await balanceOf(treasury), 3n * fee);
  console.log("PASS: concurrent requests use distinct relayer transaction nonces");
} finally {
  for (const child of children.reverse()) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit").catch(() => undefined);
      child.kill();
      await exited;
    }
  }
}
