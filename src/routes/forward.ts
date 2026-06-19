import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Logger } from "pino";
import type { AccountPool } from "../pool.js";
import type { Router } from "../router.js";
import { checkProxyToken } from "../auth.js";
import { extractAffinityFromBody } from "../affinity.js";
import { forwardWithFailover, type ForwardContext } from "../proxy.js";

export interface ForwardRouteOptions {
  pool: AccountPool;
  router: Router;
  proxyToken: string;
  affinityHeader: string;
  forwardCtx: ForwardContext;
  logger: Logger;
}

export function registerForwardRoute(
  app: FastifyInstance,
  opts: ForwardRouteOptions,
): void {
  // 把整个请求体读成 Buffer；JSON 解析放到 handler 里做，
  // 这样既能从 body 提亲和 key，又能原样转发（避免重新序列化的字段顺序差异）。
  // 必须先移除默认的 JSON parser，否则不会被覆盖。
  app.removeAllContentTypeParsers();
  app.addContentTypeParser("*", { parseAs: "buffer" }, (_req, body, done) => done(null, body));

  app.route({
    method: ["POST", "GET", "PUT", "DELETE", "PATCH"],
    url: "/anthropic/*",
    handler: async (req, reply) => {
      if (!checkProxyToken(req, opts.proxyToken)) {
        reply.code(401).send({ error: { type: "unauthorized", message: "invalid proxy token" } });
        return;
      }

      const body = readBody(req);
      // 解析一次:既用于抽亲和 key,也用于转发时覆盖 model。非 JSON 对象则为 null。
      const parsedBody = parseJsonObject(body);

      // body 含用户对话原文，只在 debug 级别打印（调试时手动 logLevel=debug 即可看到）
      opts.logger.debug(
        {
          method: req.method,
          url: req.url,
          headers: req.headers,
          body: body ? body.toString("utf8") : null,
        },
        "incoming_request",
      );

      const affinityKey = resolveAffinityKey(req, parsedBody, opts.affinityHeader);
      // 剥掉 /anthropic 前缀后透明转发，Kimi For Coding 原生兼容 Anthropic 协议
      const upstreamPath = req.url.replace(/^\/anthropic/, "") || "/";

      opts.logger.debug(
        { affinityKey, upstreamPath, method: req.method },
        "forward_start",
      );

      await forwardWithFailover(
        req,
        reply,
        opts.router,
        body,
        parsedBody,
        upstreamPath,
        affinityKey,
        opts.forwardCtx,
      );
    },
  });
}

function readBody(req: FastifyRequest): Buffer | null {
  if (req.body === undefined || req.body === null) return null;
  if (Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === "string") return Buffer.from(req.body);
  return null;
}

// Claude Code 在每个请求上带此头(per-session UUID,会话内稳定),是最可靠的
// 会话亲和来源。显式置于最高优先级,无需用户配置 affinityHeader 即可生效。
const CLAUDE_CODE_SESSION_HEADER = "x-claude-code-session-id";

function resolveAffinityKey(
  req: FastifyRequest,
  parsedBody: Record<string, unknown> | null,
  headerName: string,
): string | null {
  const ccSession = readHeader(req, CLAUDE_CODE_SESSION_HEADER);
  if (ccSession) return `ccs:${ccSession}`;

  const headerVal = readHeader(req, headerName.toLowerCase());
  if (headerVal) return `h:${headerVal}`;

  if (!parsedBody) return null;
  return extractAffinityFromBody(parsedBody);
}

function readHeader(req: FastifyRequest, name: string): string | null {
  const v = req.headers[name];
  if (typeof v === "string" && v.length > 0) return v;
  if (Array.isArray(v) && v[0]) return v[0];
  return null;
}

/** 把请求体解析成 JSON 对象;非 JSON 或非对象(数组/标量)返回 null。 */
function parseJsonObject(body: Buffer | null): Record<string, unknown> | null {
  if (!body || body.length === 0) return null;
  try {
    const parsed = JSON.parse(body.toString("utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}
