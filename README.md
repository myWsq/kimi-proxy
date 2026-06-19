# kimi-proxy

多账号 / 多 Provider 反向代理。它把多个上游账号（Kimi For Coding、GLM 等 Anthropic 兼容上游）聚合到一个 Anthropic 兼容端点后面，自动做：

- 实时查询每个账号余量（如 Kimi 的 5 小时窗口 + 周限额；无 usage 接口的 provider 靠运行时冷却）
- 会话亲和 + 负载均衡（保 prompt cache、避免单账号被打爆）
- 上游 429 / 5xx / 网络错误时自动故障转移到其他账号
- 失败账号按"错误类型 + 当前余量"动态冷却，不会被 poll 立刻拉回来又被打爆
- 每个账号独立的 HTTP/HTTPS 出站代理

上游均原生兼容 Anthropic Messages 协议，把 `ANTHROPIC_BASE_URL` 指到本服务的 `/anthropic` 前缀、`ANTHROPIC_API_KEY` 设成 `proxyToken` 即可让 Claude Code 用上多账号。

## 快速开始

```bash
cp config.example.yaml config.yaml
# 填入真实的 apiKey 和 proxyToken
pnpm install
pnpm dev
```

Claude Code 端：

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:8787/anthropic
export ANTHROPIC_API_KEY=sk-local-change-me   # 等于 config.yaml 里的 server.proxyToken
claude
```

## 配置

仅 `server.proxyToken` + 至少一个 `accounts[]` 必填，其余字段都有默认值，详见 [`config.example.yaml`](./config.example.yaml) 和 `src/config.ts`。

| 字段 | 说明 |
|---|---|
| `server.proxyToken` | 客户端必须用此 token 做 Bearer 鉴权（服务内部替换为对应账号真实 key） |
| `server.affinityHeader` | 额外的会话亲和 header（默认 `x-session-id`）。Claude Code 的 `x-claude-code-session-id` 已内置为最高优先级，无需配置 |
| `server.policy` | `affinity-first`（默认） / `least-used` / `round-robin` |
| `server.logFile` | 可选，开启文件日志；按大小滚动到 `<file>.N.log`，超出 `logFileMaxFiles` 自动删最旧 |
| `accounts[].name` | 账号名称（响应头 `x-kimi-proxy-account` 用） |
| `accounts[].apiKey` | 该 provider 的真实 API Key |
| `accounts[].provider` | 可选，所属 provider id（见下「Provider」），省略默认 `kimi` |
| `accounts[].proxy` | 可选，该账号独立出站 HTTP/HTTPS 代理 URL |
| `providers.<id>.model` | **必填**（被账号引用的每个 provider），本服务固定下发的 model（见「固定 model」） |
| `providers.<id>.baseUrl` | 可选，覆盖该 provider 的默认上游地址（走自建网关 / 换域名时用） |
| `upstream.pollIntervalMs` | 余量轮询间隔，默认 30s |
| `upstream.cooldownAfter429MinMs` | 429 但余量充足时的最短冷却，默认 60s |
| `upstream.cooldownAfter429MaxMs` | 429 且 tier 接近爆掉时冷却到 `resetsAt`，但封顶到这个值（默认 1h） |
| `upstream.cooldownTierExhaustionThreshold` | utilization 超此阈值视为 tier 接近爆掉，默认 95（%） |
| `upstream.cooldownAfter5xxMs` | 5xx 故障冷却，默认 10s |
| `upstream.cooldownAfterNetworkErrorMs` | 网络错误冷却，默认 5s |

配置路径解析顺序：`KIMI_PROXY_CONFIG` 环境变量 > `./config.yaml`。

## Provider

所有账号汇入**一个扁平号池**做负载均衡；每个账号通过 `provider` 字段声明所属上游类型。Provider 的上游地址与配额解析逻辑写在代码里（`src/providers/`），model 在配置的 `providers` 块里指定：

| provider | 说明 |
|---|---|
| `kimi` | Kimi For Coding，含 `/v1/usages` 余量解析（5 小时窗口 + 周限额 + 终身配额） |
| `glm` | 智谱 GLM（Anthropic 兼容），暂无 usage 接口：账号默认可用，仅靠运行时 429/5xx 冷却 |
| `ark` | 火山引擎方舟 Coding Plan（Anthropic 兼容，`/api/coding`）。配账号级 AK/SK 后可查实时用量（session/weekly/monthly），否则仅靠运行时冷却 |

每个 provider 在配置里固定一个 **model**（见下「固定 model」）。

**新增 provider**：在 `src/providers/` 写一个模块（`id` + `baseUrl` + 可选 `quota.parse`），在 `src/providers/index.ts` 注册，再在配置的 `providers` 块里给它配 `model` 即可，无需改配置 schema 或路由逻辑。要求该上游原生兼容 Anthropic Messages 协议（透明转发）。

### 固定 model

聚合入口**不再支持客户端指定 model**。每个被账号引用的 provider 必须在配置里配一次 `providers.<id>.model`（无代码默认值；同一 provider 的多个账号共用，不必逐账号配）。转发时请求体里的 `model` 字段会被强制覆盖成所选账号 provider 的 model；客户端发什么 `model` 都会被忽略。由于覆盖按账号在每次重试时进行，故障转移跨 provider 时 model 会随之切换到目标 provider 的 model。

同一会话经亲和哈希稳定落到同一账号（因而同一 provider，保 prompt cache）；该账号不可用时故障转移可能切到其它 provider 的账号。

> 迁移提示：旧版用 `upstream.baseUrl` 覆盖地址的，请改用 `providers.kimi.baseUrl`。`upstream.baseUrl` / `quotaPath` 已不再生效（保留仅为兼容旧配置，不报错）。

## 接口

### `ANY /anthropic/*` — Anthropic 兼容转发

剥掉 `/anthropic` 前缀后转发到所选账号 provider 的 `baseUrl` + 原 path。鉴权头会被替换为选中账号的真实 key；请求体里的 `model` 会被强制覆盖成该 provider 的固定 model（见「固定 model」），其余字段原样保留。

响应头额外回写：

- `x-kimi-proxy-account: <选中账号名>`
- `x-kimi-proxy-affinity: <亲和 key>`（用于调试，能看到这次走的是 header / metadata.user_id / 还是 fingerprint）

### `GET /accounts` — 实时余量快照

```json
{
  "accounts": [
    {
      "name": "kimi-A",
      "provider": "kimi",
      "model": "kimi-k2.6",
      "hasProxy": true,
      "healthy": true,
      "credentialStatus": "valid",
      "tiers": [
        { "name": "five_hour",    "limit": 100, "remaining": 98, "used": 2,  "utilization": 2.0,  "resetsAt": "2026-05-17T06:31:39Z" },
        { "name": "weekly_limit", "limit": 100, "remaining": 83, "used": 17, "utilization": 17.0, "resetsAt": "2026-05-21T18:31:39Z" }
      ],
      "lastError": null,
      "lastFetchedAt": "2026-05-17T04:00:00.000Z",
      "lastSuccessAt": "2026-05-17T04:00:00.000Z",
      "inflight": 0,
      "totalRequests": 12,
      "totalErrors": 0,
      "cooldownUntil": null,
      "cooldownRemainingMs": 0
    }
  ]
}
```

数据由后台 poller 定时刷新（间隔 `upstream.pollIntervalMs`），接口本身只读内存，**零延迟**。

### `GET /healthz`

`200` 表示有至少一个账号可调度；`503` 表示所有账号都不可用（不健康 / 凭证失效 / 余量耗尽 / 全部冷却中）。

## 路由策略

- **affinity-first**（默认）：有亲和 key → 一致性哈希到健康账号集合；无亲和 key 时降级到 least-used
- **least-used**：选「最高 tier 利用率最低」的健康账号，并列时挑 inflight 少（无 quota 接口的账号利用率记 0，会被优先选中）
- **round-robin**：按账号名字典序轮询

亲和 key 提取顺序（任一命中即采用）：

1. `x-claude-code-session-id` 头（Claude Code 每个请求都带的 per-session UUID，内置最高优先级）→ `ccs:<uuid>`
2. 配置的 `affinityHeader`（默认 `x-session-id`）→ `h:<值>`
3. 请求体 `metadata.user_id` → `uid:<值>`
4. 请求体 `system` + 首条 user 消息内容的 SHA-256 前 16 字节 → `fp:<hash>`

均无 → 降级到负载策略。

> Claude Code 默认不发 `x-session-id`、也不填充 `metadata.user_id`，但会带 `x-claude-code-session-id`，因此走第 1 档拿到真正的 per-session 亲和。可在 debug 日志的 `forward_start` 行看到实际命中的 `affinityKey`。

## 故障转移与冷却

请求转发失败时自动切换到下一个可用账号重试，直到全部账号都试过：

| 上游响应 | 行为 |
|---|---|
| 2xx | 流式回写客户端，**清空**该账号冷却（确认可用） |
| 4xx（非 401/403/429） | 透传给客户端（用户请求本身的问题，重试也是这个结果） |
| 401 / 403 | 标记 `credentialStatus=expired`，透传给客户端（凭证问题需人工处理） |
| 429 | 冷却该账号 + 切换下一个账号重试 |
| 5xx | 短冷却 + 切换下一个账号重试 |
| 网络错误 | 极短冷却 + 切换下一个账号重试 |

冷却时长由"错误类型 + 当前余量"共同决定：

- **5xx / 网络错误**：固定短冷却（默认 10s / 5s），视为瞬时故障
- **429 + 余量充足**（所有 tier utilization < 95%）：默认 60s 冷却，视为瞬时突发（并发尖峰之类）
- **429 + 某 tier 接近爆掉**（utilization ≥ 95%）：冷却到该 tier 的 `resetsAt`，但封顶 1h，避免周限耗尽时锁死几天

冷却中的账号在 `isSelectable()` 里直接被滤掉，新请求绕开它；poller 仍会继续 poll 它（不消耗调用配额），冷却到期后正常恢复。

## 运行

```bash
# 开发：tsx watch
pnpm dev

# 生产：直接 tsx 跑（tsx 内部用 esbuild 编译，启动一次性多几百 ms，长跑可忽略）
pnpm start
```

配置文件路径解析顺序：`KIMI_PROXY_CONFIG` 环境变量 > 工作目录下的 `./config.yaml`。

## 实现说明

- HTTP 框架：Fastify 5
- 上游/出站：undici `ProxyAgent`（每账号一个 dispatcher 实例，账号配置变更需重启）
- 转发模式：流式 pipe，SSE 完全兼容（不缓存响应体）
- 余量解析：参考 cc-switch 的 `src-tauri/src/services/coding_plan.rs`
- 日志：pino + 可选 pino-roll 文件轮转（sync 写入，退出不丢日志）
