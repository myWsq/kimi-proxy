import { Agent, ProxyAgent, type Dispatcher } from "undici";
import type { AccountConfig } from "./config.js";
import type { AccountSnapshot, CredentialStatus, QuotaTier, TotalQuota } from "./types.js";

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

  healthy = true;
  credentialStatus: CredentialStatus = "unknown";
  tiers: QuotaTier[] = [];
  lastError: string | null = null;
  lastFetchedAt: number | null = null;
  lastSuccessAt: number | null = null;
  inflight = 0;
  totalRequests = 0;
  totalErrors = 0;
  /** 冷却到期时间（毫秒 epoch），0 表示无冷却 */
  cooldownUntil = 0;
  /** 终身配额（从 /v1/usages 的 totalQuota 字段解析），null 表示上游未返回 */
  totalQuota: TotalQuota | null = null;

  constructor(cfg: AccountConfig) {
    this.name = cfg.name;
    this.apiKey = cfg.apiKey;
    this.proxyUrl = cfg.proxy;
    this.dispatcher = cfg.proxy
      ? new ProxyAgent({
          uri: cfg.proxy,
          connectTimeout: 10_000,
          headersTimeout: 60_000,
          bodyTimeout: 0,
        })
      : new Agent({
          connectTimeout: 10_000,
          headersTimeout: 60_000,
          bodyTimeout: 0,
        });
  }

  /** 5 小时窗口已用比例。无数据时返回 null。 */
  fiveHourUtilization(): number | null {
    const t = this.tiers.find((x) => x.name === "five_hour");
    return t ? t.utilization : null;
  }

  /** 周/总额已用比例。无数据时返回 null。 */
  weeklyUtilization(): number | null {
    const t = this.tiers.find((x) => x.name === "weekly_limit");
    return t ? t.utilization : null;
  }

  /** 综合可用判定：未爆 5 小时窗口、未爆周限、凭证有效、不在冷却。 */
  isSelectable(): boolean {
    if (!this.healthy) return false;
    if (this.credentialStatus === "expired") return false;
    if (Date.now() < this.cooldownUntil) return false;
    const five = this.fiveHourUtilization();
    const weekly = this.weeklyUtilization();
    if (five !== null && five >= 100) return false;
    if (weekly !== null && weekly >= 100) return false;
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

  snapshot(): AccountSnapshot {
    const remaining = Math.max(0, this.cooldownUntil - Date.now());
    return {
      name: this.name,
      hasProxy: this.proxyUrl !== undefined,
      healthy: this.healthy,
      credentialStatus: this.credentialStatus,
      tiers: this.tiers.map((t) => ({ ...t })),
      lastError: this.lastError,
      lastFetchedAt: this.lastFetchedAt ? new Date(this.lastFetchedAt).toISOString() : null,
      lastSuccessAt: this.lastSuccessAt ? new Date(this.lastSuccessAt).toISOString() : null,
      inflight: this.inflight,
      totalRequests: this.totalRequests,
      totalErrors: this.totalErrors,
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

  constructor(configs: AccountConfig[]) {
    this.accounts = configs.map((c) => new Account(c));
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

  snapshot(): AccountSnapshot[] {
    return this.accounts.map((a) => a.snapshot());
  }

  async close(): Promise<void> {
    await Promise.allSettled(this.accounts.map((a) => a.close()));
  }
}
