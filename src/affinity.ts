import { createHash } from "node:crypto";

/**
 * 从 Anthropic Messages 请求体中抽取会话亲和 key。
 *
 * 优先级：
 *  1. metadata.user_id —— Anthropic 标准会话标识，Claude Code 等客户端会带
 *  2. system + 首条 user 消息内容 —— 同一 agent 配置自然落到同一账号，保 prompt cache
 *
 * 找不到任何稳定特征时返回 null，路由层应降级到负载策略。
 */
export function extractAffinityFromBody(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const obj = body as Record<string, unknown>;

  const metadata = obj.metadata;
  if (metadata && typeof metadata === "object") {
    const userId = (metadata as Record<string, unknown>).user_id;
    if (typeof userId === "string" && userId.length > 0) return `uid:${userId}`;
  }

  const fingerprint = fingerprintMessages(obj);
  return fingerprint ? `fp:${fingerprint}` : null;
}

function fingerprintMessages(body: Record<string, unknown>): string | null {
  const parts: string[] = [];

  const system = body.system;
  if (typeof system === "string") {
    parts.push(system.slice(0, 2048));
  } else if (Array.isArray(system)) {
    for (const block of system) {
      if (block && typeof block === "object") {
        const text = (block as Record<string, unknown>).text;
        if (typeof text === "string") parts.push(text.slice(0, 2048));
      }
      if (parts.join("").length > 4096) break;
    }
  }

  const messages = body.messages;
  if (Array.isArray(messages)) {
    for (const msg of messages) {
      if (!msg || typeof msg !== "object") continue;
      if ((msg as Record<string, unknown>).role !== "user") continue;
      const content = (msg as Record<string, unknown>).content;
      if (typeof content === "string") {
        parts.push(content.slice(0, 1024));
        break;
      }
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block && typeof block === "object") {
            const text = (block as Record<string, unknown>).text;
            if (typeof text === "string") {
              parts.push(text.slice(0, 1024));
              break;
            }
          }
        }
        break;
      }
    }
  }

  if (parts.length === 0) return null;
  return createHash("sha256").update(parts.join("")).digest("hex").slice(0, 16);
}

/** FNV-1a 64-bit 截 32 位，足够做一致性选桶。 */
export function hashKey(key: string): number {
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < key.length; i++) {
    h ^= BigInt(key.charCodeAt(i));
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return Number(h & 0xffffffffn);
}
