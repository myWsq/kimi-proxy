import { Service } from "@volcengine/openapi";
import type { QuotaTier } from "../types.js";
import type { ParsedUsages, ProviderDef, QuotaContext } from "./types.js";

/**
 * 火山引擎方舟 Coding Plan(Anthropic 兼容端点)。
 * - 转发地址用 /api/coding(Anthropic 协议),不能用 /api/v3(不走套餐且额外计费)。
 * - 用量查询走管理类 OpenAPI GetCodingPlanUsage,鉴权用账号级 AK/SK + 签名 V4
 *   (与推理 key 不同),由官方 SDK @volcengine/openapi 自动签名。
 *   账号未配 accessKey/secretKey 时返回 null,按"无 quota"处理(仅靠运行时冷却)。
 */

const ARK_OPENAPI_HOST = "open.volcengineapi.com";
const ARK_USAGE_ACTION = "GetCodingPlanUsage";
const ARK_USAGE_VERSION = "2024-01-01";
const ARK_DEFAULT_REGION = "cn-beijing";

/**
 * 解析 GetCodingPlanUsage 响应:Result.QuotaUsage[] 每档给 Percent(已是百分比)
 * 与 ResetTimestamp(unix 秒)。方舟只给百分比、不给绝对额度,故 limit 归一到 100。
 */
export function parseArkUsage(body: unknown): ParsedUsages {
  const tiers: QuotaTier[] = [];
  const result = (body as { Result?: { QuotaUsage?: unknown } })?.Result;
  const list = result?.QuotaUsage;
  if (Array.isArray(list)) {
    for (const item of list) {
      if (!item || typeof item !== "object") continue;
      const o = item as Record<string, unknown>;
      const level = typeof o.Level === "string" ? o.Level : null;
      const percent = typeof o.Percent === "number" && Number.isFinite(o.Percent) ? o.Percent : null;
      if (!level || percent === null) continue;
      const utilization = percent; // 0-100
      tiers.push({
        name: level, // session / weekly / monthly
        limit: 100,
        remaining: Math.max(0, 100 - utilization),
        used: utilization,
        utilization,
        resetsAt:
          typeof o.ResetTimestamp === "number" && Number.isFinite(o.ResetTimestamp)
            ? new Date(o.ResetTimestamp * 1000).toISOString()
            : null,
      });
    }
  }
  return { tiers, totalQuota: null };
}

async function fetchArkUsage(ctx: QuotaContext): Promise<ParsedUsages | null> {
  if (!ctx.accessKey || !ctx.secretKey) return null; // 未配 AK/SK：按无 quota 处理
  const svc = new Service({
    serviceName: "ark",
    host: ARK_OPENAPI_HOST,
    region: ctx.region ?? ARK_DEFAULT_REGION,
    defaultVersion: ARK_USAGE_VERSION,
    accessKeyId: ctx.accessKey,
    secretKey: ctx.secretKey,
  });
  const getUsage = svc.createAPI(ARK_USAGE_ACTION, { method: "GET" });
  const resp = await getUsage({});
  return parseArkUsage(resp);
}

export const ark: ProviderDef = {
  id: "ark",
  baseUrl: "https://ark.cn-beijing.volces.com/api/coding",
  quota: { fetch: fetchArkUsage },
};
