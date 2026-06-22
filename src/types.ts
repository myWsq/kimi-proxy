export type RoutingPolicy = "affinity-first" | "least-used" | "round-robin";

export type CredentialStatus = "valid" | "expired" | "unknown";

export interface QuotaTier {
  name: "five_hour" | "weekly_limit" | string;
  limit: number;
  remaining: number;
  used: number;
  utilization: number;
  resetsAt: string | null;
}

/** 终身配额（账号注册以来的累计），对应 /v1/usages 的 totalQuota 字段。 */
export interface TotalQuota {
  limit: number;
  remaining: number;
  used: number;
}

export interface AccountSnapshot {
  name: string;
  /** 所属 provider id（如 kimi、glm）。 */
  provider: string;
  /** provider 的严格主备优先级；数值越大越优先（不配为 0）。 */
  priority: number;
  /** 该账号固定使用的 model（转发时强制覆盖请求体）。 */
  model: string;
  hasProxy: boolean;
  healthy: boolean;
  credentialStatus: CredentialStatus;
  tiers: QuotaTier[];
  lastError: string | null;
  lastFetchedAt: string | null;
  lastSuccessAt: string | null;
  inflight: number;
  /** 累计请求数（持久化到磁盘，跨重启累加）。 */
  totalRequests: number;
  /** 累计错误数（持久化到磁盘，跨重启累加）。 */
  totalErrors: number;
  /** 累计输入 token。 */
  inputTokens: number;
  /** 累计输出 token。 */
  outputTokens: number;
  /** 累计缓存写入 token。 */
  cacheCreationTokens: number;
  /** 累计缓存读取 token。 */
  cacheReadTokens: number;
  /** 上述四类 token 之和，便于直接展示。 */
  totalTokens: number;
  /** 最近一次请求时间；从未请求过为 null。 */
  lastRequestAt: string | null;
  /** 冷却到期时间；null 或过去时间表示不冷却 */
  cooldownUntil: string | null;
  /** 冷却剩余毫秒（便于客户端直接显示） */
  cooldownRemainingMs: number;
  /** 终身配额；上游未返回时为 null */
  totalQuota: TotalQuota | null;
}
