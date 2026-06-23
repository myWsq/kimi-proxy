import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { DEFAULT_PROVIDER_ID, isProviderId } from "./providers/index.js";

const accountSchema = z.object({
  name: z.string().min(1),
  apiKey: z.string().min(1),
  proxy: z.string().url().optional(),
  // 引用代码注册表里的 provider id;省略则默认归 DEFAULT_PROVIDER_ID(向后兼容)
  provider: z.string().min(1).optional(),
  // 管理类 OpenAPI 的账号级 AK/SK(如方舟用量查询的 V4 签名),与 apiKey 不同。
  // 仅需要查 usage 的 provider(如 ark)才配;不配则该账号按无 quota 处理。
  accessKey: z.string().min(1).optional(),
  secretKey: z.string().min(1).optional(),
});

// provider 的部署配置。model 必填(本服务固定下发的 model,无代码默认值);
// baseUrl 可选,省略则用代码注册表里的默认地址。parse 逻辑始终在代码。
const providerConfigSchema = z.object({
  model: z.string().min(1),
  baseUrl: z.string().url().optional(),
  // 严格主备优先级:数值越大越优先。路由只从「当前可用账号里最高优先级的一档」出,
  // 该档全部不可用才降到下一档。不配=0,所有 provider 同档时退化为原有行为。
  priority: z.number().int().default(0),
});

const configSchema = z.object({
  server: z.object({
    host: z.string().default("0.0.0.0"),
    port: z.number().int().min(1).max(65535).default(8787),
    proxyToken: z.string().min(8),
    affinityHeader: z.string().default("x-session-id"),
    // 客户端可在此 header 里指定 provider id,强制本次请求只从该 provider 的账号里选。
    // 省略/留空则按默认严格主备 + 优先级路由。值必须是已配置账号引用的 provider。
    providerHeader: z.string().default("x-set-provider"),
    policy: z.enum(["affinity-first", "least-used", "round-robin"]).default("affinity-first"),
    logLevel: z.enum(["trace", "debug", "info", "warn", "error"]).default("info"),
    // 文件日志：留空则只输出 stdout
    logFile: z.string().optional(),
    // 单文件最大大小，到达后按 N.log → N.1.log 滚动
    logFileMaxSize: z.string().default("50M"),
    // 保留多少个滚动文件（含当前）
    logFileMaxFiles: z.number().int().min(1).default(10),
    // 请求快照日志：把每个进来的请求(method/url/headers/body)整条落盘一份。
    // 留空则关闭。按小时轮换 + 数量上限，磁盘占用恒定有界。
    requestLogFile: z.string().optional(),
    // 保留多少小时的请求快照（按小时一个文件），默认 24 ≈ 近 1 天
    requestLogRetentionHours: z.number().int().min(1).default(24),
    // 单个小时文件大小上限，暴量时提前切，避免单文件过大
    requestLogMaxSize: z.string().default("100M"),
    // 每账号累计统计(请求/错误/token)的持久化文件，跨重启累加
    statsFile: z.string().default("./logs/stats.json"),
    // 统计标脏后多久落一次盘（毫秒）
    statsFlushIntervalMs: z.number().int().min(1000).default(10_000),
  }),
  upstream: z
    .object({
      baseUrl: z.string().url().default("https://api.kimi.com/coding"),
      quotaPath: z.string().default("/v1/usages"),
      pollIntervalMs: z.number().int().min(1000).default(30_000),
      requestTimeoutMs: z.number().int().min(1000).default(600_000),
      // 失败后冷却时长：避免 poller 30s 把它判回 healthy 后立即又被命中
      cooldownAfter5xxMs: z.number().int().min(0).default(10_000),
      cooldownAfterNetworkErrorMs: z.number().int().min(0).default(5_000),
      // 429 时：余量充足走 min（瞬时突发），某 tier 接近爆掉则等到 resetsAt（受 max 封顶）
      cooldownAfter429MinMs: z.number().int().min(0).default(60_000),
      cooldownAfter429MaxMs: z.number().int().min(0).default(3_600_000), // 1h
      // 当某 tier utilization 超过此阈值视为「接近爆掉」，冷却到 resetsAt
      cooldownTierExhaustionThreshold: z.number().min(0).max(100).default(95),
    })
    .default({}),
  // provider 部署配置表,键为 provider id。被账号引用的每个 provider 都必须在此配置 model。
  providers: z.record(providerConfigSchema).optional(),
  accounts: z.array(accountSchema).min(1),
});

export type AppConfig = z.infer<typeof configSchema>;
export type AccountConfig = z.infer<typeof accountSchema>;
export type ProviderConfig = z.infer<typeof providerConfigSchema>;

export function loadConfig(path?: string): AppConfig {
  const configPath = resolve(path ?? process.env.KIMI_PROXY_CONFIG ?? "config.yaml");
  let raw: string;
  try {
    raw = readFileSync(configPath, "utf8");
  } catch (err) {
    throw new Error(`Failed to read config at ${configPath}: ${(err as Error).message}`);
  }
  const parsed = parseYaml(raw);
  const result = configSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".") || "<root>"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid config at ${configPath}:\n${issues}`);
  }
  const cfg = result.data;
  const names = new Set<string>();
  const usedProviders = new Set<string>();
  for (const acc of cfg.accounts) {
    if (names.has(acc.name)) throw new Error(`Duplicate account name: ${acc.name}`);
    names.add(acc.name);
    // 补默认 provider,并校验其为已注册 id
    acc.provider ??= DEFAULT_PROVIDER_ID;
    if (!isProviderId(acc.provider)) {
      throw new Error(
        `Account "${acc.name}" references unknown provider "${acc.provider}". ` +
          `Register it in src/providers/index.ts first.`,
      );
    }
    usedProviders.add(acc.provider);
  }
  // providers 配置表的键必须是已注册 id,避免拼错后静默无效
  for (const id of Object.keys(cfg.providers ?? {})) {
    if (!isProviderId(id)) {
      throw new Error(`providers config for unknown provider "${id}"`);
    }
  }
  // 被账号引用的每个 provider 都必须配置 model(无代码默认值)
  for (const id of usedProviders) {
    if (!cfg.providers?.[id]?.model) {
      throw new Error(
        `Provider "${id}" is used by accounts but has no model configured. ` +
          `Add providers.${id}.model to the config.`,
      );
    }
  }
  return cfg;
}
