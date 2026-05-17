import { request } from "undici";
import type { Logger } from "pino";
import type { Account, AccountPool } from "./pool.js";
import type { QuotaTier, TotalQuota } from "./types.js";

export interface PollerOptions {
  baseUrl: string;
  quotaPath: string;
  intervalMs: number;
  logger: Logger;
}

/**
 * 解析 Kimi For Coding /v1/usages 响应，参考 cc-switch:
 *   limits[].detail.{limit, remaining, resetTime}  → 5 小时窗口
 *   usage.{limit, remaining, resetTime}            → 周/总限额
 */
interface ParsedUsages {
  tiers: QuotaTier[];
  totalQuota: TotalQuota | null;
}

function parseUsages(body: unknown): ParsedUsages {
  const tiers: QuotaTier[] = [];
  let totalQuota: TotalQuota | null = null;
  if (!body || typeof body !== "object") return { tiers, totalQuota };
  const obj = body as Record<string, unknown>;

  const limits = obj.limits;
  if (Array.isArray(limits)) {
    for (const item of limits) {
      if (!item || typeof item !== "object") continue;
      const detail = (item as Record<string, unknown>).detail as
        | Record<string, unknown>
        | undefined;
      if (!detail) continue;
      const limit = toNumber(detail.limit) ?? 1;
      const remaining = toNumber(detail.remaining) ?? 0;
      const used = Math.max(limit - remaining, 0);
      const utilization = limit > 0 ? (used / limit) * 100 : 0;
      tiers.push({
        name: "five_hour",
        limit,
        remaining,
        used,
        utilization,
        resetsAt: toIsoTime(detail.resetTime),
      });
    }
  }

  const usage = obj.usage;
  if (usage && typeof usage === "object") {
    const u = usage as Record<string, unknown>;
    const limit = toNumber(u.limit) ?? 1;
    const remaining = toNumber(u.remaining) ?? 0;
    const used = Math.max(limit - remaining, 0);
    const utilization = limit > 0 ? (used / limit) * 100 : 0;
    tiers.push({
      name: "weekly_limit",
      limit,
      remaining,
      used,
      utilization,
      resetsAt: toIsoTime(u.resetTime),
    });
  }

  const tq = obj.totalQuota;
  if (tq && typeof tq === "object") {
    const t = tq as Record<string, unknown>;
    const limit = toNumber(t.limit);
    const remaining = toNumber(t.remaining);
    if (limit !== null && remaining !== null) {
      totalQuota = { limit, remaining, used: Math.max(limit - remaining, 0) };
    }
  }

  return { tiers, totalQuota };
}

function toNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function toIsoTime(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (typeof v === "number" && Number.isFinite(v)) {
    const ms = v < 1e12 ? v * 1000 : v;
    return new Date(ms).toISOString();
  }
  return null;
}

export class QuotaPoller {
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private readonly url: string;

  constructor(
    private readonly pool: AccountPool,
    private readonly opts: PollerOptions,
  ) {
    this.url = opts.baseUrl.replace(/\/$/, "") + opts.quotaPath;
  }

  /** 立即并发预热一次；后续按间隔串行轮询。 */
  async start(): Promise<void> {
    this.opts.logger.info({ accounts: this.pool.all().length }, "quota poller warming up");
    await Promise.allSettled(this.pool.all().map((a) => this.refreshOne(a)));
    this.scheduleNext();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private scheduleNext(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.tick();
    }, this.opts.intervalMs);
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    for (const acc of this.pool.all()) {
      if (this.stopped) return;
      await this.refreshOne(acc);
    }
    this.scheduleNext();
  }

  async refreshOne(acc: Account): Promise<void> {
    const log = this.opts.logger.child({ account: acc.name });
    acc.lastFetchedAt = Date.now();
    try {
      const res = await request(this.url, {
        method: "GET",
        headers: {
          authorization: `Bearer ${acc.apiKey}`,
          accept: "application/json",
        },
        dispatcher: acc.dispatcher,
        headersTimeout: 10_000,
        bodyTimeout: 10_000,
      });

      if (res.statusCode === 401 || res.statusCode === 403) {
        acc.credentialStatus = "expired";
        acc.healthy = false;
        acc.lastError = `auth failed (${res.statusCode})`;
        await drain(res.body);
        log.warn({ status: res.statusCode }, "credential expired");
        return;
      }

      if (res.statusCode < 200 || res.statusCode >= 300) {
        const text = await res.body.text();
        acc.healthy = false;
        acc.lastError = `HTTP ${res.statusCode}: ${truncate(text, 200)}`;
        log.warn({ status: res.statusCode }, "quota fetch failed");
        return;
      }

      const json = await res.body.json();
      const { tiers, totalQuota } = parseUsages(json);
      acc.tiers = tiers;
      acc.totalQuota = totalQuota;
      acc.healthy = true;
      acc.credentialStatus = "valid";
      acc.lastError = null;
      acc.lastSuccessAt = Date.now();
      log.debug({ tiers, totalQuota }, "quota refreshed");
    } catch (err) {
      acc.healthy = false;
      acc.lastError = (err as Error).message;
      log.warn({ err }, "quota fetch error");
    }
  }
}

async function drain(body: { dump?: () => Promise<void>; text?: () => Promise<string> }): Promise<void> {
  if (typeof body.dump === "function") {
    await body.dump();
  } else if (typeof body.text === "function") {
    await body.text();
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "..." : s;
}
