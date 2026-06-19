import type { QuotaTier, TotalQuota } from "../types.js";
import type { ParsedUsages, ProviderDef } from "./types.js";

/**
 * 解析 Kimi For Coding /v1/usages 响应,参考 cc-switch:
 *   limits[].detail.{limit, remaining, resetTime}  → 5 小时窗口
 *   usage.{limit, remaining, resetTime}            → 周/总限额
 *   totalQuota.{limit, remaining}                  → 终身配额
 */
export function parseKimiUsages(body: unknown): ParsedUsages {
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

export const kimi: ProviderDef = {
  id: "kimi",
  baseUrl: "https://api.kimi.com/coding",
  quota: { path: "/v1/usages", parse: parseKimiUsages },
};
