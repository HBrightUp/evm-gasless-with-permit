import {
  createPublicClient,
  createWalletClient,
  custom,
  encodeFunctionData,
  formatEther,
  formatUnits,
  getAddress,
  http,
  isAddress,
  parseUnits,
  type Address,
  type EIP1193Provider,
  type Hex,
} from "viem";
import { sepolia } from "viem/chains";

import {
  FORWARDER_VERSION,
  forwardRequestTypes,
  forwarderAbi,
  gaslessTransferAbi,
  permitTypes,
  splitRpcSignature,
  tokenAbi,
} from "../../../shared/contracts.ts";
import "./style.css";

type WalletProvider = EIP1193Provider & {
  isMetaMask?: boolean;
  isPhantom?: boolean;
  isTronLink?: boolean;
  providers?: WalletProvider[];
  on?: (event: string, listener: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, listener: (...args: unknown[]) => void) => void;
};

type Eip6963ProviderDetail = {
  info: {
    uuid: string;
    name: string;
    icon: string;
    rdns: string;
  };
  provider: WalletProvider;
};

declare global {
  interface Window {
    ethereum?: WalletProvider;
  }
}

type AppConfig = {
  chainId: number;
  tokenAddress: Address;
  forwarderAddress: Address;
  recipientAddress: Address;
  tokenDecimals: number;
  tokenSymbol: string;
  forwarderName: string;
  forwarderVersion: string;
  fee: string;
  requestGas: string;
  maxAmount: string;
};

type Quote = {
  fee: string;
  requestGas: string;
  expiresAt: number;
};

const SEPOLIA_RPC_URL =
  (import.meta.env.VITE_SEPOLIA_RPC_URL as string | undefined) ??
  "https://ethereum-sepolia-rpc.publicnode.com";
const RELAYER_TIMEOUT_MS = 10_000;
const RELAY_CONFIRMATION_TIMEOUT_MS = 120_000;
const WALLET_TIMEOUT_MS = 20_000;
const RPC_TIMEOUT_MS = 15_000;

const relayerUrl =
  (import.meta.env.VITE_RELAYER_URL as string | undefined)?.replace(/\/$/, "") ??
  "/api";
const publicClient = createPublicClient({
  chain: sepolia,
  transport: http(SEPOLIA_RPC_URL, { timeout: RPC_TIMEOUT_MS }),
});

const connectButton = element<HTMLButtonElement>("connectButton");
const sendButton = element<HTMLButtonElement>("sendButton");
const transferForm = element<HTMLFormElement>("transferForm");
const accountPanel = element<HTMLElement>("accountPanel");
const walletAddress = element<HTMLElement>("walletAddress");
const tokenBalance = element<HTMLElement>("tokenBalance");
const ethBalance = element<HTMLElement>("ethBalance");
const recipientInput = element<HTMLInputElement>("recipientInput");
const amountInput = element<HTMLInputElement>("amountInput");
const feeValue = element<HTMLElement>("feeValue");
const statusPanel = element<HTMLElement>("statusPanel");
const statusIcon = element<HTMLElement>("statusIcon");
const statusTitle = element<HTMLElement>("statusTitle");
const statusMessage = element<HTMLElement>("statusMessage");
const transactionLink = element<HTMLAnchorElement>("transactionLink");

let appConfig: AppConfig | undefined;
let appConfigPromise: Promise<AppConfig> | undefined;
let account: Address | undefined;
let transferPending = false;
let boundWalletProvider: WalletProvider | undefined;
const announcedWalletProviders: Eip6963ProviderDetail[] = [];

function element<T extends HTMLElement>(id: string): T {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing element #${id}`);
  return value as T;
}

function shortAddress(address: Address): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function selectWalletProvider(): WalletProvider | undefined {
  const announcedMetaMask =
    announcedWalletProviders.find(
      (detail) => detail.info.rdns === "io.metamask",
    ) ??
    announcedWalletProviders.find(
      (detail) => detail.info.name.toLowerCase() === "metamask",
    );
  if (announcedMetaMask) return announcedMetaMask.provider;

  const injected = window.ethereum;
  const injectedProviders = injected?.providers;
  if (Array.isArray(injectedProviders)) {
    return (
      injectedProviders.find(
        (provider) =>
          provider.isMetaMask === true &&
          provider.isPhantom !== true &&
          provider.isTronLink !== true,
      ) ??
      injectedProviders[0]
    );
  }
  return injected;
}

function selectedWalletName(provider: WalletProvider): string {
  const announced = announcedWalletProviders.find(
    (detail) => detail.provider === provider,
  );
  if (announced) return announced.info.name;
  return provider.isMetaMask ? "MetaMask" : "浏览器钱包";
}

function bindWalletEvents(): void {
  const provider = selectWalletProvider();
  if (!provider || provider === boundWalletProvider) return;

  boundWalletProvider?.removeListener?.(
    "accountsChanged",
    restoreAccountWithFeedback,
  );
  boundWalletProvider?.removeListener?.("chainChanged", restoreAccountWithFeedback);
  provider.on?.("accountsChanged", restoreAccountWithFeedback);
  provider.on?.("chainChanged", restoreAccountWithFeedback);
  boundWalletProvider = provider;
}

function handleProviderAnnouncement(event: Event): void {
  const detail = (event as CustomEvent<Eip6963ProviderDetail>).detail;
  if (!detail?.provider || !detail.info) return;
  if (
    !announcedWalletProviders.some(
      (known) => known.info.uuid === detail.info.uuid,
    )
  ) {
    announcedWalletProviders.push(detail);
  }
  bindWalletEvents();
  if (!account) renderAccount(undefined);
}

function renderAccount(nextAccount: Address | undefined): void {
  account = nextAccount;

  if (!nextAccount) {
    const provider = selectWalletProvider();
    const connectLabel = provider
      ? `连接 ${selectedWalletName(provider)}`
      : "连接钱包";
    connectButton.textContent = connectLabel;
    connectButton.classList.remove("is-connected");
    connectButton.removeAttribute("title");
    connectButton.setAttribute("aria-label", connectLabel);
    connectButton.setAttribute("aria-pressed", "false");
    walletAddress.textContent = "—";
    walletAddress.removeAttribute("title");
    tokenBalance.textContent = "—";
    ethBalance.textContent = "—";
    feeValue.textContent = appConfig
      ? `${formatUnits(BigInt(appConfig.fee), appConfig.tokenDecimals)} ${appConfig.tokenSymbol}`
      : "正在连接 Relayer";
    accountPanel.classList.add("is-hidden");
    sendButton.disabled = transferPending;
    return;
  }

  const shortened = shortAddress(nextAccount);
  connectButton.textContent = `已连接 · ${shortened}`;
  connectButton.classList.add("is-connected");
  connectButton.title = nextAccount;
  connectButton.setAttribute("aria-label", `已连接钱包 ${nextAccount}`);
  connectButton.setAttribute("aria-pressed", "true");
  walletAddress.textContent = shortened;
  walletAddress.title = nextAccount;
  accountPanel.classList.remove("is-hidden");
}

function showStatus(
  step: string,
  title: string,
  message: string,
  state: "working" | "success" | "error" = "working",
): void {
  statusPanel.classList.remove("is-hidden", "is-working", "is-success", "is-error");
  statusPanel.classList.add(`is-${state}`);
  statusIcon.textContent = state === "success" ? "✓" : state === "error" ? "!" : step;
  statusTitle.textContent = title;
  statusMessage.textContent = message;
  if (state !== "success") transactionLink.classList.add("is-hidden");
  statusPanel.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function humanError(error: unknown): string {
  if (error instanceof Error) {
    if (error.message.includes("User rejected")) return "你取消了钱包签名。";
    if (
      error.message.includes("Already processing") ||
      error.message.includes("already pending")
    ) {
      return "钱包中已有待处理请求，请打开钱包扩展并处理或取消后重试。";
    }
    if (error.message.includes("insufficient funds")) return "Relayer 的 Sepolia ETH 不足。";
    if (error.message.includes("timeout") || error.message.includes("超时")) {
      return error.message;
    }
    if (error.message.includes("Failed to fetch")) {
      return "无法连接 Relayer，请确认服务已启动并刷新页面。";
    }
    return error.message.split("\n")[0] ?? "请求失败";
  }
  return "请求失败，请稍后再试。";
}

async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: number | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = window.setTimeout(() => reject(new Error(message)), timeoutMs);
  });

  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer !== undefined) window.clearTimeout(timer);
  }
}

async function fetchJson<T>(
  path: string,
  init?: RequestInit,
  timeoutMs = RELAYER_TIMEOUT_MS,
): Promise<T> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${relayerUrl}${path}`, {
      ...init,
      signal: controller.signal,
    });
    const payload = await response.json() as { error?: string };
    if (!response.ok) {
      throw new Error(payload.error ?? `HTTP ${response.status}`);
    }
    return payload as T;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      if (path === "/relay") {
        throw new Error(
          "等待链上确认超时，交易可能已经提交。请先在 Etherscan 检查 Relayer 地址，避免重复发送。",
        );
      }
      throw new Error("Relayer 响应超时，请确认 npm run relayer 正在运行。");
    }
    throw error;
  } finally {
    window.clearTimeout(timer);
  }
}

async function loadAppConfig(): Promise<AppConfig> {
  if (appConfig) {
    feeValue.textContent = `${formatUnits(
      BigInt(appConfig.fee),
      appConfig.tokenDecimals,
    )} ${appConfig.tokenSymbol}`;
    return appConfig;
  }
  appConfigPromise ??= fetchJson<AppConfig>("/config")
    .then((config) => {
      appConfig = config;
      feeValue.textContent = `${formatUnits(
        BigInt(config.fee),
        config.tokenDecimals,
      )} ${config.tokenSymbol}`;
      return config;
    })
    .catch((error) => {
      appConfigPromise = undefined;
      throw error;
    });
  return appConfigPromise;
}

async function ensureSepolia(provider: EIP1193Provider): Promise<void> {
  const currentChain = await withTimeout(
    provider.request({ method: "eth_chainId" }),
    WALLET_TIMEOUT_MS,
    "钱包网络检查超时，请打开钱包扩展后重试。",
  );
  if (currentChain === "0xaa36a7") return;

  showStatus("…", "等待切换网络", "请在钱包中确认切换到 Sepolia。");
  try {
    await withTimeout(
      provider.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: "0xaa36a7" }],
      }),
      60_000,
      "等待钱包切换网络超时，请打开钱包扩展后重试。",
    );
  } catch (error) {
    const code = (error as { code?: number }).code;
    if (code !== 4902) throw error;

    await withTimeout(
      provider.request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId: "0xaa36a7",
            chainName: "Sepolia",
            nativeCurrency: { name: "Sepolia ETH", symbol: "ETH", decimals: 18 },
            rpcUrls: [SEPOLIA_RPC_URL],
            blockExplorerUrls: ["https://sepolia.etherscan.io"],
          },
        ],
      }),
      60_000,
      "等待钱包添加 Sepolia 超时，请打开钱包扩展后重试。",
    );
  }
}

async function refreshBalances(): Promise<void> {
  if (!account || !appConfig) return;
  const [tokenAmount, nativeAmount] = await withTimeout(
    Promise.all([
      publicClient.readContract({
        address: appConfig.tokenAddress,
        abi: tokenAbi,
        functionName: "balanceOf",
        args: [account],
      }),
      publicClient.getBalance({ address: account }),
    ]),
    RPC_TIMEOUT_MS,
    "Sepolia 余额读取超时。",
  );

  tokenBalance.textContent = formatUnits(tokenAmount, appConfig.tokenDecimals);
  ethBalance.textContent = Number(formatEther(nativeAmount)).toFixed(5);
}

async function initializeAccount(selected: string): Promise<void> {
  if (!isAddress(selected)) {
    renderAccount(undefined);
    throw new Error("钱包返回了无效账户");
  }

  renderAccount(getAddress(selected));
  await loadAppConfig();
  sendButton.disabled = transferPending;
  void refreshBalances().catch(() => {
    tokenBalance.textContent = "读取失败";
    ethBalance.textContent = "读取失败";
  });
}

async function connect(): Promise<void> {
  const provider = selectWalletProvider();
  if (!provider) {
    throw new Error("未检测到浏览器钱包，请先安装 MetaMask 或兼容钱包。");
  }

  bindWalletEvents();
  const walletName = selectedWalletName(provider);
  connectButton.disabled = true;
  try {
    showStatus(
      "…",
      `正在检查 ${walletName} 网络`,
      "正在确认当前网络是否为 Sepolia。",
    );
    await ensureSepolia(provider);
    showStatus(
      "…",
      `等待 ${walletName} 授权`,
      "如果钱包窗口没有自动弹出，请打开钱包扩展。",
    );
    const walletClient = createWalletClient({
      chain: sepolia,
      transport: custom(provider),
    });
    const [selected] = await withTimeout(
      walletClient.requestAddresses(),
      60_000,
      "等待钱包授权超时，请打开钱包扩展后重试。",
    );
    if (!selected) throw new Error("钱包没有返回账户");
    await initializeAccount(selected);
    showStatus(
      "✓",
      "钱包已连接",
      `当前账户 ${shortAddress(getAddress(selected))}，网络为 Sepolia。`,
      "success",
    );
  } finally {
    connectButton.disabled = false;
  }
}

connectButton.addEventListener("click", () => {
  connect().catch((error) => {
    showStatus("!", "连接失败", humanError(error), "error");
  });
});

transferForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (transferPending) return;

  transferPending = true;
  sendButton.disabled = true;
  transactionLink.classList.add("is-hidden");
  showStatus("…", "正在准备交易", "正在检查钱包、网络和输入内容。");

  submitTransfer()
    .catch((error) => {
      showStatus("!", "发送失败", humanError(error), "error");
    })
    .finally(() => {
      transferPending = false;
      sendButton.disabled = false;
    });
});

async function submitTransfer(): Promise<void> {
  const provider = selectWalletProvider();
  if (!provider) {
    throw new Error("未检测到浏览器钱包，请先安装 MetaMask 或兼容钱包。");
  }
  if (!account) {
    await connect();
  }
  if (!account) throw new Error("钱包没有返回账户。");

  const activeProvider = selectWalletProvider() ?? provider;
  const walletName = selectedWalletName(activeProvider);
  showStatus(
    "…",
    `正在检查 ${walletName} 网络`,
    "正在确认钱包已连接到 Sepolia。",
  );
  await ensureSepolia(activeProvider);
  showStatus("…", "正在连接 Relayer", "正在读取手续费和合约配置。");
  const config = await loadAppConfig();

  const recipientValue = recipientInput.value.trim();
  if (!recipientValue) {
    throw new Error("请输入接收地址。");
  }
  if (!isAddress(recipientValue)) {
    throw new Error("接收地址格式不正确。");
  }
  const recipient = getAddress(recipientValue);
  const amountValue = amountInput.value.trim();
  if (!amountValue) {
    throw new Error("请输入发送数量。");
  }
  let amount: bigint;
  try {
    amount = parseUnits(amountValue, config.tokenDecimals);
  } catch {
    throw new Error(`发送数量最多支持 ${config.tokenDecimals} 位小数。`);
  }
  if (amount <= 0n) throw new Error("发送数量必须大于 0。");
  if (amount > BigInt(config.maxAmount)) {
    throw new Error("发送数量超过 Relayer 单笔限额。");
  }

  showStatus("…", "正在获取报价", "正在检查手续费、金额和 Relayer 状态。");
  const quote = await fetchJson<Quote>(`/quote?amount=${amount.toString()}`);
  const fee = BigInt(quote.fee);
  const permitDeadline = BigInt(quote.expiresAt);
  const walletClient = createWalletClient({
    chain: sepolia,
    transport: custom(activeProvider),
  });

  showStatus("…", "正在读取签名参数", "正在读取代币名称和 Permit Nonce。");
  const [tokenName, permitNonce] = await withTimeout(
    Promise.all([
      publicClient.readContract({
        address: config.tokenAddress,
        abi: tokenAbi,
        functionName: "name",
      }),
      publicClient.readContract({
        address: config.tokenAddress,
        abi: tokenAbi,
        functionName: "nonces",
        args: [account],
      }),
    ]),
    RPC_TIMEOUT_MS,
    "Sepolia 签名参数读取超时，请稍后重试。",
  );

  showStatus("1", "签署 Permit", "本次签名只授权转账金额与服务费，不消耗 ETH。");
  const permitSignature = await walletClient.signTypedData({
    account,
    domain: {
      name: tokenName,
      version: "1",
      chainId: sepolia.id,
      verifyingContract: config.tokenAddress,
    },
    types: permitTypes,
    primaryType: "Permit",
    message: {
      owner: account,
      spender: config.recipientAddress,
      value: amount + fee,
      nonce: permitNonce,
      deadline: permitDeadline,
    },
  });
  const { v, r, s } = splitRpcSignature(permitSignature);

  const data = encodeFunctionData({
    abi: gaslessTransferAbi,
    functionName: "transferWithPermit",
    args: [recipient, amount, fee, permitDeadline, v, r, s],
  });
  showStatus("…", "正在读取转发 Nonce", "正在准备第二次签名。");
  const forwardNonce = await withTimeout(
    publicClient.readContract({
      address: config.forwarderAddress,
      abi: forwarderAbi,
      functionName: "nonces",
      args: [account],
    }),
    RPC_TIMEOUT_MS,
    "Sepolia 转发 Nonce 读取超时，请稍后重试。",
  );
  const requestGas = BigInt(quote.requestGas);

  showStatus("2", "签署转发请求", "请核对接收人、数量、Nonce 与有效期。");
  const forwardSignature = await walletClient.signTypedData({
    account,
    domain: {
      name: config.forwarderName,
      version: config.forwarderVersion ?? FORWARDER_VERSION,
      chainId: sepolia.id,
      verifyingContract: config.forwarderAddress,
    },
    types: forwardRequestTypes,
    primaryType: "ForwardRequest",
    message: {
      from: account,
      to: config.recipientAddress,
      value: 0n,
      gas: requestGas,
      nonce: forwardNonce,
      deadline: quote.expiresAt,
      data,
    },
  });

  showStatus("3", "Relayer 正在提交", "服务器正在校验、模拟并支付 Sepolia Gas。");
  const result = await fetchJson<{
    transactionHash: Hex;
    status: string;
    blockNumber: string;
  }>(
    "/relay",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request: {
          from: account,
          to: config.recipientAddress,
          value: "0",
          gas: requestGas.toString(),
          deadline: quote.expiresAt,
          data,
          signature: forwardSignature,
        },
      }),
    },
    RELAY_CONFIRMATION_TIMEOUT_MS,
  );

  showStatus("✓", "转账已确认", `已在区块 ${result.blockNumber} 完成，无需用户支付 ETH。`, "success");
  transactionLink.href = `https://sepolia.etherscan.io/tx/${result.transactionHash}`;
  transactionLink.classList.remove("is-hidden");
  void refreshBalances().catch(() => undefined);
}

async function restoreAuthorizedAccount(): Promise<void> {
  const provider = selectWalletProvider();
  if (!provider) return;

  const addresses = await withTimeout(
    provider.request({ method: "eth_accounts" }),
    WALLET_TIMEOUT_MS,
    "钱包账户读取超时，请打开钱包扩展后刷新页面。",
  );
  const selected =
    Array.isArray(addresses) && typeof addresses[0] === "string"
      ? addresses[0]
      : undefined;

  if (!selected) {
    renderAccount(undefined);
    return;
  }

  renderAccount(isAddress(selected) ? getAddress(selected) : undefined);
  const chainId = await withTimeout(
    provider.request({ method: "eth_chainId" }),
    WALLET_TIMEOUT_MS,
    "钱包网络读取超时，请打开钱包扩展后刷新页面。",
  );
  if (chainId !== "0xaa36a7") {
    sendButton.disabled = transferPending;
    feeValue.textContent = "点击发送后切换到 Sepolia";
    return;
  }

  await initializeAccount(selected);
}

function restoreAccountWithFeedback(): void {
  restoreAuthorizedAccount().catch((error) => {
    sendButton.disabled = transferPending;
    showStatus("!", "钱包状态同步失败", humanError(error), "error");
  });
}

window.addEventListener(
  "eip6963:announceProvider",
  handleProviderAnnouncement as EventListener,
);
window.dispatchEvent(new Event("eip6963:requestProvider"));
bindWalletEvents();
void loadAppConfig().catch(() => {
  feeValue.textContent = "Relayer 暂不可用";
});
restoreAccountWithFeedback();
window.setTimeout(() => {
  bindWalletEvents();
  restoreAccountWithFeedback();
}, 250);
