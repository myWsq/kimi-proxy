import { Agent, ProxyAgent, type Dispatcher } from "undici";
import { socksDispatcher } from "fetch-socks";
import type { AccountConfig, ProviderConfig } from "./config.js";
import { DEFAULT_PROVIDER_ID, getProvider, type ProviderDef } from "./providers/index.js";
import type { AccountStats, StatsStore } from "./stats.js";
import type { AccountSnapshot, CredentialStatus, QuotaTier, TotalQuota } from "./types.js";

// 所有 dispatcher 共用的超时基线
const BASE_AGENT_OPTS = { connectTimeout: 10_000, headersTimeout: 60_000, bodyTimeout: 0 } as const;

/**
 * 按 proxy URL 的 scheme 选连接器：
 *  - socks5/socks5h/socks4(a)：走 fetch-socks 的 SOCKS 连接器(支持用户名/密码认证)
 *  - http/https：undici 原生 ProxyAgent(CONNECT 隧道)
 *  - 无 proxy：直连 Agent
 * undici 的 ProxyAgent 不支持 SOCKS，所以 SOCKS 必须单独走 socksDispatcher。
 */
function createDispatcher(proxyUrl: string | undefined): Dispatcher {
  if (!proxyUrl) return new Agent(BASE_AGENT_OPTS);
  const u = new URL(proxyUrl);
  const scheme = u.protocol.replace(/:$/, "");
  if (scheme === "socks" || scheme === "socks5" || scheme === "socks5h" || scheme === "socks4" || scheme === "socks4a") {
    const type: 4 | 5 = scheme.startsWith("socks4") ? 4 : 5;
    return socksDispatcher(
      {
        type,
        host: u.hostname,
        port: Number(u.port) || 1080,
        // URL 里的认证段;为空则不带认证
        userId: u.username ? decodeURIComponent(u.username) : undefined,
        password: u.password ? decodeURIComponent(u.password) : undefined,
      },
      { ...BASE_AGENT_OPTS },
    );
  }
  return new ProxyAgent({ uri: proxyUrl, ...BASE_AGENT_OPTS });
}

export interface CooldownConfig {
  cooldownAfter5xxMs: number;
  cooldownAfterNetworkErrorMs: number;
  cooldownAfter429MinMs: number;
  cooldownAfter429MaxMs: number;
  cooldownTierExhaustionThreshold: number;
}

export class Account {
  readonly name: string;
  readonly apiKey: string;
  readonly proxyUrl: string | undefined;
  readonly dispatcher: Dispatcher;
  /** 管理类 OpenAPI 的账号级凭证(如方舟用量查询的 V4 签名),与 apiKey 不同。 */
  readonly accessKey: string | undefined;
  readonly secretKey: string | undefined;
  /** 此账号所属 provider 定义(解析策略、默认地址)。 */
  readonly provider: ProviderDef;
  /** 生效上游地址:provider 默认 baseUrl,被 config providers 覆盖后的结果。 */
  readonly baseUrl: string;
  /** 生效 model:转发时强制写入请求体,覆盖客户端指定的 model。 */
  readonly model: string;
  /** provider 的严格主备优先级,数值越大越优先(不配为 0)。 */
  readonly priority: number;

  healthy = true;
  credentialStatus: CredentialStatus = "unknown";
  tiers: QuotaTier[] = [];
  lastError: string | null = null;
  lastFetchedAt: number | null = null;
  lastSuccessAt: number | null = null;
  inflight = 0;
  /** 冷却到期时间（毫秒 epoch），0 表示无冷却 */
  cooldownUntil = 0;
  /** 终身配额（从 /v1/usages 的 totalQuota 字段解析），null 表示上游未返回 */
  totalQuota: TotalQuota | null = null;

  constructor(cfg: AccountConfig, provider: ProviderDef, baseUrl: string, model: string, priority: number) {
    this.name = cfg.name;
    this.apiKey = cfg.apiKey;
    this.proxyUrl = cfg.proxy;
    this.provider = provider;
    this.baseUrl = baseUrl;
    this.model = model;
    this.priority = priority;
    this.accessKey = cfg.accessKey;
    this.secretKey = cfg.secretKey;
    this.dispatcher = createDispatcher(cfg.proxy);
  }

  /** 所有 tier 中最高的已用比例。无 tier(如无 quota 的 provider)时返回 null。 */
  maxTierUtilization(): number | null {
    if (this.tiers.length === 0) return null;
    let max = 0;
    for (const t of this.tiers) if (t.utilization > max) max = t.utilization;
    return max;
  }

  /**
   * 综合可用判定(provider 无关):凭证有效、不在冷却、且没有任何 tier 爆掉。
   * 无 quota 的 provider 没有 tier,只要 healthy + 不在冷却即可选。
   */
  isSelectable(): boolean {
    if (!this.healthy) return false;
    if (this.credentialStatus === "expired") return false;
    if (Date.now() < this.cooldownUntil) return false;
    for (const t of this.tiers) {
      if (t.utilization >= 100) return false;
    }
    return true;
  }

  /** 失败后进入冷却；durationMs<=0 视为不冷却。 */
  cooldown(durationMs: number): void {
    if (durationMs <= 0) return;
    const until = Date.now() + durationMs;
    // 取较晚者：避免短冷却覆盖长冷却
    if (until > this.cooldownUntil) this.cooldownUntil = until;
  }

  /** 成功调用后清零冷却。 */
  clearCooldown(): void {
    this.cooldownUntil = 0;
  }

  /**
   * 根据失败原因 + 当前余量状态计算冷却毫秒数。
   *
   * - 5xx：固定短冷却（瞬时上游故障）
   * - 网络错误：固定更短冷却
   * - 429：
   *   * 任一 tier 已超过 exhaustionThreshold → 冷却到该 tier 的 resetsAt（受 max 封顶）
   *   * 否则视为瞬时突发，用 min 冷却
   */
  computeCooldownFor(
    reason: "rate_limit_429" | "upstream_5xx" | "network_error",
    cfg: CooldownConfig,
  ): number {
    switch (reason) {
      case "upstream_5xx":
        return cfg.cooldownAfter5xxMs;
      case "network_error":
        return cfg.cooldownAfterNetworkErrorMs;
      case "rate_limit_429": {
        const now = Date.now();
        let bestMs = cfg.cooldownAfter429MinMs;
        for (const t of this.tiers) {
          if (t.utilization < cfg.cooldownTierExhaustionThreshold) continue;
          if (!t.resetsAt) continue;
          const resetMs = Date.parse(t.resetsAt);
          if (!Number.isFinite(resetMs)) continue;
          const waitMs = resetMs - now;
          if (waitMs > bestMs) bestMs = waitMs;
        }
        return Math.min(bestMs, cfg.cooldownAfter429MaxMs);
      }
    }
  }

  /** 合并实时状态（本对象）与持久化累计统计（stats 参数）成对外快照。 */
  snapshot(stats: AccountStats): AccountSnapshot {
    const remaining = Math.max(0, this.cooldownUntil - Date.now());
    const totalTokens =
      stats.inputTokens + stats.outputTokens + stats.cacheCreationTokens + stats.cacheReadTokens;
    return {
      name: this.name,
      provider: this.provider.id,
      priority: this.priority,
      model: this.model,
      hasProxy: this.proxyUrl !== undefined,
      healthy: this.healthy,
      credentialStatus: this.credentialStatus,
      tiers: this.tiers.map((t) => ({ ...t })),
      lastError: this.lastError,
      lastFetchedAt: this.lastFetchedAt ? new Date(this.lastFetchedAt).toISOString() : null,
      lastSuccessAt: this.lastSuccessAt ? new Date(this.lastSuccessAt).toISOString() : null,
      inflight: this.inflight,
      totalRequests: stats.requests,
      totalErrors: stats.errors,
      inputTokens: stats.inputTokens,
      outputTokens: stats.outputTokens,
      cacheCreationTokens: stats.cacheCreationTokens,
      cacheReadTokens: stats.cacheReadTokens,
      totalTokens,
      lastRequestAt: stats.lastRequestAt ? new Date(stats.lastRequestAt).toISOString() : null,
      cooldownUntil: this.cooldownUntil > 0 ? new Date(this.cooldownUntil).toISOString() : null,
      cooldownRemainingMs: remaining,
      totalQuota: this.totalQuota,
    };
  }

  async close(): Promise<void> {
    await this.dispatcher.close();
  }
}

export class AccountPool {
  private readonly accounts: Account[];
  private readonly byName: Map<string, Account>;

  constructor(configs: AccountConfig[], providerConfigs?: Record<string, ProviderConfig>) {
    this.accounts = configs.map((c) => {
      const id = c.provider ?? DEFAULT_PROVIDER_ID;
      const provider = getProvider(id);
      // config.ts 已校验过 id 合法,这里兜底以满足类型收窄
      if (!provider) throw new Error(`Unknown provider "${id}" for account "${c.name}"`);
      const pc = providerConfigs?.[id];
      // config.ts 已校验被引用 provider 必有 model,这里兜底
      if (!pc?.model) throw new Error(`Provider "${id}" has no model configured (account "${c.name}")`);
      const baseUrl = pc.baseUrl ?? provider.baseUrl;
      return new Account(c, provider, baseUrl, pc.model, pc.priority ?? 0);
    });
    this.byName = new Map(this.accounts.map((a) => [a.name, a]));
  }

  all(): readonly Account[] {
    return this.accounts;
  }

  get(name: string): Account | undefined {
    return this.byName.get(name);
  }

  selectable(): Account[] {
    return this.accounts.filter((a) => a.isSelectable());
  }

  /** 至少配了一个账号的 provider id 集合（header 显式指定 provider 时用于校验）。 */
  providerIds(): Set<string> {
    return new Set(this.accounts.map((a) => a.provider.id));
  }

  snapshot(stats: StatsStore): AccountSnapshot[] {
    return this.accounts.map((a) => a.snapshot(stats.get(a.name)));
  }

  async close(): Promise<void> {
    await Promise.allSettled(this.accounts.map((a) => a.close()));
  }
}
