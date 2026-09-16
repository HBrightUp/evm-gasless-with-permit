# Gasless mUSDT 合约交互时间线

本文按照用户点击“签名并发送”后的真实时间顺序，说明前端、Relayer 和智能合约之间发生的调用。

## 合约地址

| 合约 | 地址 | 作用 |
| --- | --- | --- |
| MockUSDT | `0x91C6cA0c8925d0E62C5eA932ED63338eaAfa5Ea3` | mUSDT 余额、Permit、转账 |
| ERC2771Forwarder | `0x46F094C285Db58F6CC61D9eE621528A363DD5F2B` | 验证用户签名并代表用户调用业务合约 |
| GaslessUSDTTransfer | `0x580b3212f6Ef9763A48b708113Ca768BAed00163` | 执行 Permit、转账和服务费扣款 |

其他相关地址：

| 角色 | 地址 |
| --- | --- |
| 用户 | `0xC1E3C35dfF48eDcA59c31E73cfC3F155A6534b74` |
| Relayer | `0xd9d727A946E5814793c7c4Ea3fb975747D097E05` |
| 示例接收人 | `0x9B022A8C58170F7F62F71b51e2F9CAAA2620E61F` |
| 服务费 Treasury | `0x0ad826c4d5c96eb5b27b6dde45e1931c93f9a144` |

## 时间顺序总览

```text
用户点击按钮
  ↓
前端检查输入、网络和 Relayer
  ↓
读取 mUSDT 名称和 Permit Nonce
  ↓
用户签署 Permit
  ↓
读取 Forwarder Nonce
  ↓
用户签署 ForwardRequest
  ↓
Relayer 验证并模拟交易
  ↓
Relayer 发送一笔链上交易
  ↓
Forwarder 调用 GaslessUSDTTransfer
  ↓
执行 Permit
  ↓
转账给接收人
  ↓
支付服务费
  ↓
返回交易结果并刷新余额
```

## 1. 检查钱包网络

前端首先调用钱包 RPC：

```text
eth_chainId
```

这不是智能合约函数。

作用：

- 检查钱包当前是不是 Sepolia
- Sepolia Chain ID 是 `0xaa36a7`
- 如果不是，要求 MetaMask 切换网络

这一步不消耗 Gas。

## 2. 获取 Relayer 配置和报价

前端请求：

```http
GET /config
GET /quote?amount=2000000
```

这两次访问的是 Relayer HTTP 服务，不是智能合约。

Relayer 返回：

- 合约地址
- 服务费 `0.1 mUSDT`
- 最大转账金额
- Gas 限额 `300000`
- 签名有效期

## 3. 并行读取 Permit 签名参数

前端同时调用 MockUSDT 合约的两个只读函数。

### 3.1 `name()`

合约地址：

```text
0x91C6cA0c8925d0E62C5eA932ED63338eaAfa5Ea3
```

函数：

```solidity
function name() external view returns (string)
```

作用：

- 获取代币名称
- 当前返回 `Mock USDT`
- 用于构造 EIP-712 Permit 签名域

签名中必须包含正确的代币名称，否则 mUSDT 合约无法验证签名。

### 3.2 `nonces(user)`

同一个 MockUSDT 合约：

```solidity
function nonces(address owner) external view returns (uint256)
```

实际参数：

```text
owner = 0xC1E3C35dfF48eDcA59c31E73cfC3F155A6534b74
```

作用：

- 获取用户当前的 Permit Nonce
- 防止 Permit 签名被重复使用

例如当前 Nonce 是 `3`，这份签名只能用于 Nonce `3`。成功执行后，Nonce 会变成 `4`。

以上两个函数都是只读调用，不消耗用户 Gas。

## 4. 用户签署 Permit

前端请求 MetaMask 签署：

```text
Permit
```

签名主要内容：

```text
owner    = 用户地址
spender  = GaslessUSDTTransfer 地址
value    = 转账金额 + 服务费
nonce    = MockUSDT Permit Nonce
deadline = 过期时间
```

例如发送 `2 mUSDT`：

```text
value = 2 + 0.1 = 2.1 mUSDT
```

`spender` 是：

```text
0x580b3212f6Ef9763A48b708113Ca768BAed00163
```

这一步只是离线签名：

- 没有调用智能合约
- 没有发送交易
- 不消耗 ETH
- 没有立即授权
- 没有立即转走代币

签名最终被拆分为：

```text
v
r
s
```

稍后传给 `permit()`。

## 5. 构造业务合约调用数据

前端准备调用 GaslessUSDTTransfer：

合约地址：

```text
0x580b3212f6Ef9763A48b708113Ca768BAed00163
```

函数：

```solidity
transferWithPermit(
    address recipient,
    uint256 amount,
    uint256 fee,
    uint256 permitDeadline,
    uint8 v,
    bytes32 r,
    bytes32 s
)
```

示例参数：

```text
recipient = 0x9B022A8C58170F7F62F71b51e2F9CAAA2620E61F
amount    = 2,000,000
fee       = 100,000
```

因为 mUSDT 有 6 位小数：

```text
2,000,000 = 2 mUSDT
100,000   = 0.1 mUSDT
```

此时只是编码调用数据，还没有访问合约。

## 6. 读取 Forwarder Nonce

前端访问 ERC2771Forwarder：

合约地址：

```text
0x46F094C285Db58F6CC61D9eE621528A363DD5F2B
```

函数：

```solidity
function nonces(address owner) external view returns (uint256)
```

参数：

```text
owner = 用户地址
```

作用：

- 获取用户当前的 ERC-2771 Nonce
- 防止 ForwardRequest 被重复执行

这是只读调用，不消耗 Gas。

需要注意，MockUSDT Permit Nonce 和 Forwarder Nonce 是两个不同的 Nonce：

```text
MockUSDT Nonce
  └─ 防止 Permit 重放

Forwarder Nonce
  └─ 防止 ForwardRequest 重放
```

## 7. 用户签署 ForwardRequest

前端要求 MetaMask 进行第二次签名。

签名内容包括：

```text
from     = 用户地址
to       = GaslessUSDTTransfer 合约
value    = 0 ETH
gas      = 300000
nonce    = Forwarder Nonce
deadline = 过期时间
data     = transferWithPermit 的完整调用数据
```

其中：

```text
to = 0x580b3212f6Ef9763A48b708113Ca768BAed00163
```

这里的 `to` 是业务合约，不是最终的 mUSDT 接收人。

最终接收人被编码在 `data` 的 `recipient` 参数中。

第二次也只是离线签名：

- 不调用智能合约
- 不发送交易
- 不消耗用户 ETH

## 8. Relayer 第一次调用 `verify()`

前端把签名发送到 Relayer：

```http
POST /relay
```

Relayer访问 Forwarder 合约：

```text
0x46F094C285Db58F6CC61D9eE621528A363DD5F2B
```

函数：

```solidity
function verify(ForwardRequest request)
    external
    view
    returns (bool)
```

作用：

- 验证第二次签名
- 检查签名者是不是用户
- 检查 Forwarder Nonce
- 检查 Deadline
- 检查目标合约和调用数据
- 确认这份请求现在有效

这是只读调用，不发送交易。

## 9. Relayer 第二次调用 `verify()`

Relayer 内部使用队列发送交易。

请求进入队列后，Relayer会再次调用：

```solidity
Forwarder.verify(request)
```

作用：

- 防止请求排队期间状态发生变化
- 确认 Nonce 没有被其他交易使用
- 确认签名仍未过期

为什么需要验证两次？

```text
第一次：请求刚到服务器时验证
第二次：正式发送交易前再次验证
```

这次仍然是只读调用。

## 10. 模拟调用 `Forwarder.execute()`

正式花费 ETH 之前，Relayer先通过 RPC 模拟：

合约地址：

```text
0x46F094C285Db58F6CC61D9eE621528A363DD5F2B
```

函数：

```solidity
function execute(ForwardRequest request) external payable
```

模拟过程中会完整执行后面的调用链：

```text
Forwarder.execute()
  ↓
GaslessUSDTTransfer.transferWithPermit()
  ↓
MockUSDT.permit()
  ↓
MockUSDT.allowance()
  ↓
MockUSDT.transferFrom()
  ↓
MockUSDT.transferFrom()
```

但是模拟执行具有以下特点：

- 不产生正式交易
- 不修改区块链状态
- 不真正转账
- 不消耗 Relayer ETH
- 用来提前判断交易是否会失败

## 11. Relayer正式调用 `Forwarder.execute()`

模拟成功后，Relayer发送唯一的一笔链上交易。

发送者：

```text
0xd9d727A946E5814793c7c4Ea3fb975747D097E05
```

目标合约：

```text
0x46F094C285Db58F6CC61D9eE621528A363DD5F2B
```

调用函数：

```solidity
Forwarder.execute(forwardRequest)
```

作用：

- 再次验证用户签名
- 检查 Nonce 和 Deadline
- 消耗 Forwarder Nonce
- 调用 GaslessUSDTTransfer
- 把原始用户地址附加到调用数据末尾

这是整个流程中唯一的一笔正式链上交易。

Gas 由 Relayer 支付。

## 12. Forwarder 调用 `transferWithPermit()`

Forwarder调用业务合约：

```text
0x580b3212f6Ef9763A48b708113Ca768BAed00163
```

函数：

```solidity
transferWithPermit(
    recipient,
    amount,
    fee,
    permitDeadline,
    v,
    r,
    s
)
```

作用：

- 获取真实用户地址
- 检查接收人不能是零地址
- 检查金额必须大于 0
- 检查服务费不能超过金额的 5%
- 执行 Permit
- 执行两笔 mUSDT 划转

因为使用 ERC-2771，业务合约通过：

```solidity
_msgSender()
```

得到的是真实用户：

```text
0xC1E3C35dfF48eDcA59c31E73cfC3F155A6534b74
```

而不是 Relayer 地址。

## 13. 调用 `MockUSDT.permit()`

业务合约访问 MockUSDT：

```text
0x91C6cA0c8925d0E62C5eA932ED63338eaAfa5Ea3
```

函数：

```solidity
permit(
    address owner,
    address spender,
    uint256 value,
    uint256 deadline,
    uint8 v,
    bytes32 r,
    bytes32 s
)
```

参数大致为：

```text
owner   = 用户地址
spender = GaslessUSDTTransfer
value   = 2.1 mUSDT
```

作用：

- 验证第一次 Permit 签名
- 检查 Permit Nonce
- 检查 Deadline
- 给 GaslessUSDTTransfer 设置 `2.1 mUSDT` 的 allowance
- Permit Nonce 加 1

这一步开始真正修改链上状态。

## 14. 调用 `MockUSDT.allowance()`

业务合约继续访问 MockUSDT：

```solidity
allowance(
    address owner,
    address spender
)
```

作用：

- 检查 Permit 是否成功
- 检查 GaslessUSDTTransfer 是否拥有足够的额度

需要满足：

```text
allowance >= amount + fee
```

当前示例需要：

```text
allowance >= 2.1 mUSDT
```

虽然它是只读函数，但它是在正式交易内部执行的。

## 15. 第一次调用 `MockUSDT.transferFrom()`

业务合约调用：

```solidity
transferFrom(
    address from,
    address to,
    uint256 amount
)
```

参数：

```text
from   = 0xC1E3C35dfF48eDcA59c31E73cfC3F155A6534b74
to     = 0x9B022A8C58170F7F62F71b51e2F9CAAA2620E61F
amount = 2 mUSDT
```

作用：

```text
用户 → 接收人：2 mUSDT
```

这是用户真正要完成的转账。

## 16. 第二次调用 `MockUSDT.transferFrom()`

因为服务费不为 0，业务合约再次调用：

```solidity
transferFrom(
    address from,
    address to,
    uint256 fee
)
```

参数：

```text
from = 用户地址
to   = Treasury 地址
fee  = 0.1 mUSDT
```

作用：

```text
用户 → Treasury：0.1 mUSDT
```

Treasury 地址：

```text
0x0ad826c4d5c96eb5b27b6dde45e1931c93f9a144
```

如果服务费是 0，这次 `transferFrom()` 就不会执行。

## 17. 等待交易确认

Relayer通过 RPC 等待交易收据：

```text
eth_getTransactionReceipt
```

这不是合约函数。

作用：

- 等待交易进入区块
- 检查状态是成功还是失败
- 获取区块号和交易哈希

当前成功交易：

- 交易哈希：`0xf1836cf3b58865276aef577fd9306beb81d4af6396a435a0e506feb4eac841a1`
- 区块：`11382729`
- 状态：`Success`
- Etherscan：<https://sepolia.etherscan.io/tx/0xf1836cf3b58865276aef577fd9306beb81d4af6396a435a0e506feb4eac841a1>

## 18. 刷新用户余额

交易成功后，前端最后访问 MockUSDT：

```text
0x91C6cA0c8925d0E62C5eA932ED63338eaAfa5Ea3
```

函数：

```solidity
balanceOf(address account)
```

参数：

```text
account = 用户地址
```

作用：

- 获取用户最新 mUSDT 余额
- 更新网页中的余额显示

同时还会通过 RPC 查询用户的 Sepolia ETH 余额，但 ETH 余额查询不是合约调用。

## 合约调用汇总

| 顺序 | 合约 | 函数 | 类型 | 作用 |
| ---: | --- | --- | --- | --- |
| 1 | MockUSDT | `name()` | 只读 | 构造 Permit 签名 |
| 2 | MockUSDT | `nonces(user)` | 只读 | 获取 Permit Nonce |
| 3 | Forwarder | `nonces(user)` | 只读 | 获取转发 Nonce |
| 4 | Forwarder | `verify(request)` | 只读 | 第一次验证转发签名 |
| 5 | Forwarder | `verify(request)` | 只读 | 发送前再次验证 |
| 6 | Forwarder | `execute(request)` | 模拟 | 模拟完整交易 |
| 7 | Forwarder | `execute(request)` | 正式交易 | 验证并执行请求 |
| 8 | GaslessUSDTTransfer | `transferWithPermit(...)` | 正式交易内部 | 执行业务逻辑 |
| 9 | MockUSDT | `permit(...)` | 正式交易内部 | 设置代币额度 |
| 10 | MockUSDT | `allowance(...)` | 正式交易内部 | 检查额度 |
| 11 | MockUSDT | `transferFrom(...)` | 正式交易内部 | 给接收人转账 |
| 12 | MockUSDT | `transferFrom(...)` | 正式交易内部 | 支付服务费 |
| 13 | MockUSDT | `balanceOf(user)` | 只读 | 刷新余额 |

其中真正产生链上状态变化的仍然只有 `1 笔交易`，就是 Relayer 调用：

```text
0x46F094C285Db58F6CC61D9eE621528A363DD5F2B
    .execute(forwardRequest)
```

后面的 Permit、转账和服务费支付全部包含在这同一笔交易中。

