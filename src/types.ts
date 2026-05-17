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
}
