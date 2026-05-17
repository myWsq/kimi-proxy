import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

const accountSchema = z.object({
  name: z.string().min(1),
  apiKey: z.string().min(1),
  proxy: z.string().url().optional(),
});

const configSchema = z.object({
  server: z.object({
    host: z.string().default("0.0.0.0"),
    port: z.number().int().min(1).max(65535).default(8787),
    proxyToken: z.string().min(8),
    affinityHeader: z.string().default("x-session-id"),
    policy: z.enum(["affinity-first", "least-used", "round-robin"]).default("affinity-first"),
    logLevel: z.enum(["trace", "debug", "info", "warn", "error"]).default("info"),
    // 文件日志：留空则只输出 stdout
    logFile: z.string().optional(),
    // 单文件最大大小，到达后按 N.log → N.1.log 滚动
    logFileMaxSize: z.string().default("50M"),
    // 保留多少个滚动文件（含当前）
    logFileMaxFiles: z.number().int().min(1).default(10),
  }),
  upstream: z.object({
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
  }),
  accounts: z.array(accountSchema).min(1),
});

export type AppConfig = z.infer<typeof configSchema>;
export type AccountConfig = z.infer<typeof accountSchema>;

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
  for (const acc of cfg.accounts) {
    if (names.has(acc.name)) throw new Error(`Duplicate account name: ${acc.name}`);
    names.add(acc.name);
  }
  return cfg;
}
