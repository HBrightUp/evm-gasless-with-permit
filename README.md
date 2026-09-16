# Gasless mUSDT / ERC-2771

一个面向 Sepolia 的完整 Gasless Transfer 示例：

- 用户钱包只需要持有 `mUSDT`，不需要持有 Sepolia ETH。
- 用户签署一次 EIP-2612 Permit 和一次 ERC-2771 ForwardRequest。
- Relayer 校验、模拟并提交交易，支付 Sepolia Gas。
- `GaslessUSDTTransfer` 将 mUSDT 发送给收款人，并把用户签署的服务费发送到固定 Treasury。

> 这是测试网参考实现，尚未经过第三方安全审计，不应用于承载真实资产。

## 架构

```mermaid
sequenceDiagram
    participant U as User wallet
    participant W as Web app
    participant R as Relayer
    participant F as ERC2771Forwarder
    participant G as GaslessUSDTTransfer
    participant T as MockUSDT Permit

    U->>W: Connect wallet (no ETH required)
    W->>U: Sign EIP-2612 Permit
    W->>U: Sign ERC-2771 ForwardRequest
    W->>R: POST /relay
    R->>R: Policy validation + simulation
    R->>F: execute(request), Relayer pays ETH
    F->>G: transferWithPermit(data + signer)
    G->>T: permit(signer, recipient contract)
    G->>T: transferFrom(signer, payee)
    G->>T: transferFrom(signer, treasury fee)
```

### 合约

- `MockUSDT`: 6 位小数、支持 EIP-2612 Permit，仅用于 Sepolia 演示。
- `GaslessForwarder`: 未修改转发逻辑的 OpenZeppelin `ERC2771Forwarder` 子类，固定 EIP-712 名称。
- `GaslessUSDTTransfer`: 固定 Token、Forwarder 和 Treasury；费用上限为转账金额的 5%。

### Relayer 安全策略

Relayer 不接受任意调用，只赞助同时满足以下条件的请求：

- `chainId` 为 Sepolia。
- `to` 必须是已配置的 `GaslessUSDTTransfer`。
- 函数必须是 `transferWithPermit`。
- `value` 必须为 0。
- Gas、金额和有效期必须在服务器限额内。
- 服务费必须等于当前服务器报价。
- Permit 有效期不能早于 ForwardRequest。
- OpenZeppelin Forwarder 的 `verify` 返回 `true`。
- 写链前通过 `eth_call` 完整模拟。

Relayer 使用串行发送队列避免服务器账户的交易 Nonce 冲突，并包含基础 IP 频率限制。生产环境仍应在网关层增加持久化限流、用户配额、监控和告警。

## 为什么不能直接使用任意 USDT

ERC-2771 只能为“信任该 Forwarder 的目标合约”恢复原始调用者，不能修改一个既有 ERC-20 合约的 `msg.sender` 语义。

如果用户持有的 Token：

1. 不支持 EIP-2612 Permit；并且
2. 用户没有事先授权业务合约；

那么业务合约无法从用户 EOA 转出 Token。用户第一次授权仍需要 Gas。

本项目使用支持 Permit 的 `MockUSDT` 解决测试网首次授权问题。迁移到真实资产时，可以选择：

- 使用原生支持 EIP-2612 或 EIP-3009 的 Token；
- 接受一次性的预授权交易；
- 使用已经预授权的 Permit2；
- 改用 ERC-4337 Smart Account + Paymaster。

## 本地安装

要求 Node.js 22.13 或更高版本。

```bash
npm install
cp .env.example .env
npm run compile
npm test
```

测试覆盖以下关键路径：

- 用户不支付 ETH，mUSDT 与服务费正确到账。
- Forwarder Nonce 防止签名重放。
- 攻击者不能从直接调用中盗用他人的 Permit。
- 链上 5% 费用上限。
- 过期请求和非信任目标拒绝。
- Relayer 固定目标、固定函数、零原生 Value、Gas、金额、费用和有效期策略。

## 部署到 Sepolia

### 1. 准备账户

需要两个有少量 Sepolia ETH 的服务器侧账户：

- `SEPOLIA_PRIVATE_KEY`: 部署合约。
- `RELAYER_PRIVATE_KEY`: 持续为用户交易支付 Gas。

建议使用不同账户，并且不要把私钥写入前端或提交到 Git。

### 2. 配置部署参数

在 `.env` 中填写：

```dotenv
SEPOLIA_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com
SEPOLIA_PRIVATE_KEY=0x...
TREASURY_ADDRESS=0x...
DEMO_USER_ADDRESS=0x...
```

### 3. 部署并初始化演示余额

```bash
npm run deploy:sepolia
```

脚本会部署三个合约，并可向 `DEMO_USER_ADDRESS` 铸造 1,000 mUSDT。把输出地址写回 `.env`：

```dotenv
TOKEN_ADDRESS=0x...
FORWARDER_ADDRESS=0x...
RECIPIENT_ADDRESS=0x...
```

后续单独给演示用户补充 mUSDT：

```bash
npm run mint:sepolia
```

## 启动应用

终端一：

```bash
npm run relayer
```

终端二：

```bash
npm run web
```

浏览器打开 `http://localhost:5173`，切换到 Sepolia，连接 `DEMO_USER_ADDRESS` 对应的钱包即可测试。用户可以保持 0 ETH。

Relayer API：

- `GET /health`: 链 ID、Relayer 地址和 ETH 余额。
- `GET /config`: 前端所需合约地址和策略。
- `GET /quote?amount=<token-base-units>`: 费用、Gas 与过期时间。
- `POST /relay`: 校验并提交签署后的 ForwardRequest。

## 配置单位

MockUSDT 使用 6 位小数：

- `RELAYER_FEE_USDT=10000` 表示 0.01 mUSDT。
- `RELAYER_MAX_AMOUNT=100000000000` 表示 100,000 mUSDT。
- 单笔服务费还必须满足链上 `fee <= amount * 5%`。

## 验证

```bash
npm run typecheck
npm test
npm run web:build
npm audit --omit=dev
```

生产依赖的 npm audit 当前为 0 项。完整依赖审计仍会报告 Hardhat 开发工具链间接依赖的公告；Hardhat 不应安装在精简后的生产 Relayer 镜像中。

## 生产化清单

- 对合约进行独立审计与 Sepolia 长时间演练。
- Relayer 私钥放入 KMS/HSM，不使用明文 `.env`。
- 分离合约开发、Relayer 与静态前端的生产镜像。
- 使用 Redis/数据库保存限流、请求状态和幂等键。
- 为 Relayer ETH 余额、失败率、Nonce 卡住和异常 Gas 消耗配置告警。
- 在反向代理配置 TLS、请求体限制、CORS 和 DDoS 防护。
- 固定并验证合约字节码、OpenZeppelin 版本和部署地址。
- 确认目标真实 Token 的 Permit/Authorization 能力，不要仅依据名称或符号判断。
