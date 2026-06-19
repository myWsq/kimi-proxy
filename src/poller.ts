import { request } from "undici";
import type { Logger } from "pino";
import type { Account, AccountPool } from "./pool.js";

export interface PollerOptions {
  intervalMs: number;
  logger: Logger;
}

export class QuotaPoller {
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(
    private readonly pool: AccountPool,
    private readonly opts: PollerOptions,
  ) {}

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
    const log = this.opts.logger.child({ account: acc.name, provider: acc.provider.id });
    const quota = acc.provider.quota;

    // 无 usage 接口的 provider：不轮询，默认可用，仅靠运行时 429/5xx 冷却。
    if (!quota) {
      acc.healthy = true;
      acc.lastFetchedAt = Date.now();
      return;
    }

    // 自定义抓取(如方舟 V4 签名)：provider 自己请求+鉴权+解析。
    // 注意:用量查询与转发用的是不同凭证(AK/SK vs 推理 key),所以查询失败
    // 不应把账号摘掉——保持可选,只记录错误、不更新 tiers。
    if (quota.fetch) {
      acc.lastFetchedAt = Date.now();
      try {
        const parsed = await quota.fetch(acc);
        if (!parsed) {
          // 未配置凭证：按无 quota 处理
          acc.healthy = true;
          return;
        }
        acc.tiers = parsed.tiers;
        acc.totalQuota = parsed.totalQuota;
        acc.healthy = true;
        acc.lastSuccessAt = Date.now();
        log.debug({ tiers: parsed.tiers }, "quota refreshed (custom)");
      } catch (err) {
        acc.healthy = true; // 用量查询失败不影响转发可用性
        acc.lastError = `usage query: ${(err as Error).message}`;
        log.warn({ err }, "custom quota fetch error");
      }
      return;
    }

    // 简单模式缺字段(理论不会发生):按无 quota 处理
    if (!quota.path || !quota.parse) {
      acc.healthy = true;
      acc.lastFetchedAt = Date.now();
      return;
    }
    const parseUsage = quota.parse;

    const url = acc.baseUrl.replace(/\/$/, "") + quota.path;
    acc.lastFetchedAt = Date.now();
    try {
      const res = await request(url, {
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
      const { tiers, totalQuota } = parseUsage(json);
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
