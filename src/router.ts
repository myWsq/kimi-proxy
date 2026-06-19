import type { Logger } from "pino";
import type { Account, AccountPool } from "./pool.js";
import type { RoutingPolicy } from "./types.js";
import { hashKey } from "./affinity.js";

export interface RouterOptions {
  policy: RoutingPolicy;
  logger: Logger;
}

export class Router {
  private rrIndex = 0;

  constructor(
    private readonly pool: AccountPool,
    private readonly opts: RouterOptions,
  ) {}

  /**
   * 选择一个账号承载请求。
   * - 有 affinityKey + policy=affinity-first：一致性哈希到健康候选；候选为空则降级
   * - 否则按 policy 走 least-used / round-robin
   * @param exclude 已经试过的账号名（故障转移时跳过）
   */
  pick(affinityKey: string | null, exclude?: ReadonlySet<string>): Account | null {
    let candidates = this.pool.selectable();
    if (exclude && exclude.size > 0) {
      candidates = candidates.filter((a) => !exclude.has(a.name));
    }
    if (candidates.length === 0) return null;

    if (this.opts.policy === "affinity-first" && affinityKey) {
      const sorted = [...candidates].sort((a, b) => a.name.localeCompare(b.name));
      const picked = sorted[hashKey(affinityKey) % sorted.length];
      if (picked) return picked;
    }

    if (this.opts.policy === "round-robin") {
      const sorted = [...candidates].sort((a, b) => a.name.localeCompare(b.name));
      const picked = sorted[this.rrIndex % sorted.length];
      this.rrIndex = (this.rrIndex + 1) % Number.MAX_SAFE_INTEGER;
      return picked ?? null;
    }

    // least-used：挑「最高 tier 利用率最低」，并列时挑「inflight 最少」。
    // provider 无关；无 quota 的账号利用率记 0,故 least-used 下会被优先选中
    // (affinity-first 默认策略按哈希撒,不受此影响)。
    return pickLeastUsed(candidates);
  }
}

function pickLeastUsed(candidates: Account[]): Account {
  let best = candidates[0]!;
  let bestScore = scoreOf(best);
  for (let i = 1; i < candidates.length; i++) {
    const acc = candidates[i]!;
    const s = scoreOf(acc);
    if (compare(s, bestScore) < 0) {
      best = acc;
      bestScore = s;
    }
  }
  return best;
}

function scoreOf(a: Account): [number, number] {
  // 主键：最高 tier 利用率,越低越优；次：inflight
  return [a.maxTierUtilization() ?? 0, a.inflight];
}

function compare(a: [number, number], b: [number, number]): number {
  for (let i = 0; i < a.length; i++) {
    const av = a[i]!;
    const bv = b[i]!;
    if (av !== bv) return av - bv;
  }
  return 0;
}
