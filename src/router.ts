import type { Logger } from "pino";
import type { Account, AccountPool } from "./pool.js";
import type { RoutingPolicy } from "./types.js";
import { hashKey } from "./affinity.js";

export interface RouterOptions {
  policy: RoutingPolicy;
  logger: Logger;
}

// 会话粘性绑定的空闲过期时间：会话短，超过即丢弃，重启不持久化。
const STICKY_TTL_MS = 30 * 60 * 1000;
// 粘性表上限：超过后顺带清扫一次过期项，避免内存无界增长。
const STICKY_MAX = 20_000;

export class Router {
  private rrIndex = 0;
  /** 会话亲和的粘性绑定：affinityKey → 上次选中的账号名 + 过期时间。 */
  private readonly sticky = new Map<string, { name: string; expiresAt: number }>();

  constructor(
    private readonly pool: AccountPool,
    private readonly opts: RouterOptions,
  ) {}

  /**
   * 选择一个账号承载请求。
   *
   * 顺序（严格主备 + 会话粘性）：
   *  ① 粘性优先（仅 affinity-first）：会话上次绑定的账号若仍可用，直接复用，
   *     不受优先级分档影响——更高优先级的档恢复了也不抢回（语义 b）。
   *  ② 严格优先级：只保留当前可用账号里最高 priority 的一档；该档被试空后，
   *     exclude 把它们排除、重算 tier，自然降到下一档。
   *  ③ 档内按 policy：affinity-first 一致性哈希 / round-robin / least-used。
   *
   * @param exclude 已经试过的账号名（故障转移时跳过）
   */
  pick(affinityKey: string | null, exclude?: ReadonlySet<string>): Account | null {
    let candidates = this.pool.selectable();
    if (exclude && exclude.size > 0) {
      candidates = candidates.filter((a) => !exclude.has(a.name));
    }
    if (candidates.length === 0) return null;

    const useAffinity = this.opts.policy === "affinity-first" && !!affinityKey;

    // ① 粘性优先：老会话只要原账号还在候选里就继续用它，跨档也不换。
    if (useAffinity) {
      const bound = this.lookupSticky(affinityKey!);
      if (bound) {
        const hit = candidates.find((a) => a.name === bound);
        if (hit) {
          this.touchSticky(affinityKey!, hit.name);
          return hit;
        }
      }
    }

    // ② 严格优先级：只在最高 priority 那一档里选。
    const tier = topTier(candidates);

    // ③ 档内按 policy。
    if (useAffinity) {
      const sorted = [...tier].sort((a, b) => a.name.localeCompare(b.name));
      const picked = sorted[hashKey(affinityKey!) % sorted.length];
      if (picked) {
        this.bindSticky(affinityKey!, picked.name);
        return picked;
      }
    }

    if (this.opts.policy === "round-robin") {
      const sorted = [...tier].sort((a, b) => a.name.localeCompare(b.name));
      const picked = sorted[this.rrIndex % sorted.length];
      this.rrIndex = (this.rrIndex + 1) % Number.MAX_SAFE_INTEGER;
      return picked ?? null;
    }

    // least-used：挑「最高 tier 利用率最低」，并列时挑「inflight 最少」。
    // provider 无关；无 quota 的账号利用率记 0,故 least-used 下会被优先选中
    // (affinity-first 默认策略按哈希撒,不受此影响)。
    return pickLeastUsed(tier);
  }

  /** 读粘性绑定，过期则惰性删除并视为未命中。 */
  private lookupSticky(key: string): string | null {
    const e = this.sticky.get(key);
    if (!e) return null;
    if (Date.now() >= e.expiresAt) {
      this.sticky.delete(key);
      return null;
    }
    return e.name;
  }

  /** 刷新粘性绑定的过期时间（命中复用时调用）。 */
  private touchSticky(key: string, name: string): void {
    this.sticky.set(key, { name, expiresAt: Date.now() + STICKY_TTL_MS });
  }

  /** 写入/重绑粘性绑定，并在表过大时清扫过期项。 */
  private bindSticky(key: string, name: string): void {
    this.touchSticky(key, name);
    if (this.sticky.size > STICKY_MAX) this.pruneSticky();
  }

  private pruneSticky(): void {
    const now = Date.now();
    for (const [k, e] of this.sticky) {
      if (now >= e.expiresAt) this.sticky.delete(k);
    }
  }
}

/** 候选里 priority 最高的一档（数值越大越优先）。 */
function topTier(candidates: Account[]): Account[] {
  let max = -Infinity;
  for (const a of candidates) if (a.priority > max) max = a.priority;
  return candidates.filter((a) => a.priority === max);
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
