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
  hasProxy: boolean;
  healthy: boolean;
  credentialStatus: CredentialStatus;
  tiers: QuotaTier[];
  lastError: string | null;
  lastFetchedAt: string | null;
  lastSuccessAt: string | null;
  inflight: number;
  totalRequests: number;
  totalErrors: number;
  /** 冷却到期时间；null 或过去时间表示不冷却 */
  cooldownUntil: string | null;
  /** 冷却剩余毫秒（便于客户端直接显示） */
  cooldownRemainingMs: number;
  /** 终身配额；上游未返回时为 null */
  totalQuota: TotalQuota | null;
}
