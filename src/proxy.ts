import type { FastifyReply, FastifyRequest } from "fastify";
import type { Logger } from "pino";
import { request as undiciRequest } from "undici";
import type { Account, CooldownConfig } from "./pool.js";
import type { Router } from "./router.js";
import type { StatsStore } from "./stats.js";
import { UsageTap } from "./usage.js";

export interface ForwardContext {
  requestTimeoutMs: number;
  cooldown: CooldownConfig;
  stats: StatsStore;
  logger: Logger;
}

// 不该转发到上游的 hop-by-hop 头（RFC 7230 + 客户端鉴权）
const STRIP_REQUEST_HEADERS = new Set([
  "host",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-length",
  "authorization",
  "x-forwarded-for",
  "x-forwarded-proto",
  "x-forwarded-host",
]);

// 不该回写到客户端的响应头（hop-by-hop）。content-encoding 是 end-to-end，
// 我们对上游强制 identity 编码所以不会出现这个 header，不需要剥
const STRIP_RESPONSE_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-length",
]);

type AttemptOutcome =
  | { kind: "streamed" } // 已经 hijack 并开始/完成流式回写
  | { kind: "retry"; reason: string; status: number }; // 应当切换账号重试

export async function forwardWithFailover(
  req: FastifyRequest,
  reply: FastifyReply,
  router: Router,
  body: Buffer | null,
  parsedBody: Record<string, unknown> | null,
  upstreamPath: string,
  affinityKey: string | null,
  providerPin: string | null,
  ctx: ForwardContext,
): Promise<void> {
  const tried = new Set<string>();
  const failures: string[] = [];

  while (true) {
    const account = router.pick(affinityKey, tried, providerPin);
    if (!account) {
      if (!reply.sent && !reply.raw.headersSent) {
        const exhausted =
          failures.length === 0
            ? providerPin
              ? `no selectable account for provider "${providerPin}"`
              : "all accounts unhealthy or quota exhausted"
            : `all candidates failed: ${failures.join("; ")}`;
        reply.code(503).type("application/json").send({
          error: { type: "no_account_available", message: exhausted },
        });
      }
      return;
    }
    tried.add(account.name);

    const outcome = await attemptOnce(req, reply, account, body, parsedBody, upstreamPath, affinityKey, ctx);
    if (outcome.kind === "streamed") return;

    failures.push(`${account.name}: ${outcome.status} ${outcome.reason}`);
    ctx.logger.warn(
      { account: account.name, status: outcome.status, reason: outcome.reason, tried: [...tried] },
      "retry on next account",
    );
  }
}

async function attemptOnce(
  req: FastifyRequest,
  reply: FastifyReply,
  account: Account,
  body: Buffer | null,
  parsedBody: Record<string, unknown> | null,
  upstreamPath: string,
  affinityKey: string | null,
  ctx: ForwardContext,
): Promise<AttemptOutcome> {
  const url = joinUrl(account.baseUrl, upstreamPath);
  const headers = buildUpstreamHeaders(req.headers, account.apiKey);
  // 强制把请求体里的 model 覆盖成该账号 provider 固定的 model。
  // 按账号在每次 attempt 重写:故障转移跨 provider 时 model 随之切换。
  // injectKeyInBody 的 provider(经 LiteLLM 转协议):同时把账号 apiKey 注入 body.api_key,
  // 由 LiteLLM 的 clientside-auth 透传给真正上游——每个 key 即一个独立账号。
  const outgoingBody = parsedBody
    ? Buffer.from(
        JSON.stringify(
          account.provider.injectKeyInBody
            ? { ...parsedBody, model: account.model, api_key: account.apiKey }
            : { ...parsedBody, model: account.model },
        ),
      )
    : body;

  account.inflight++;
  ctx.stats.recordRequest(account.name);

  try {
    const upstream = await undiciRequest(url, {
      method: req.method as never,
      headers,
      body: outgoingBody ?? undefined,
      dispatcher: account.dispatcher,
      headersTimeout: ctx.requestTimeoutMs,
      bodyTimeout: 0,
    });

    const status = upstream.statusCode;

    // 可重试：429 限流 + 5xx 上游故障
    if (status === 429 || (status >= 500 && status < 600)) {
      const text = await upstream.body.text().catch(() => "");
      account.lastError = `HTTP ${status}: ${truncate(text, 200)}`;
      ctx.stats.recordError(account.name);
      const reason = status === 429 ? "rate_limit_429" : "upstream_5xx";
      const cdMs = account.computeCooldownFor(reason, ctx.cooldown);
      account.cooldown(cdMs);
      ctx.logger.info(
        { account: account.name, status, cooldownMs: cdMs, until: new Date(Date.now() + cdMs).toISOString() },
        "account cooled down",
      );
      return { kind: "retry", status, reason: truncate(text, 120) || "upstream error" };
    }

    // 401/403：凭证失效，不会因换账号好转，但应该把这个账号摘掉以免下一次还选它
    if (status === 401 || status === 403) {
      account.credentialStatus = "expired";
      account.healthy = false;
      account.lastError = `HTTP ${status}`;
      ctx.stats.recordError(account.name);
      // 直接把上游错误透传给客户端：用户得知凭证问题
    }

    // 透传上游响应（2xx 流式，或 4xx 错误）
    reply.hijack();
    const raw = reply.raw;
    raw.statusCode = status;
    for (const [k, v] of Object.entries(upstream.headers)) {
      if (v === undefined) continue;
      if (STRIP_RESPONSE_HEADERS.has(k.toLowerCase())) continue;
      raw.setHeader(k, v as string | string[]);
    }
    raw.setHeader("x-kimi-proxy-account", account.name);
    raw.setHeader("x-kimi-proxy-provider", account.provider.id);
    if (affinityKey) raw.setHeader("x-kimi-proxy-affinity", affinityKey);

    // 2xx 视为成功调用：清掉历史冷却（账号确认可用）
    const ok2xx = status >= 200 && status < 300;
    if (ok2xx) account.clearCooldown();

    // 仅成功响应才解析 token usage：旁路喂给 tap，不阻塞透传
    const tap = ok2xx ? new UsageTap(headerValue(upstream.headers["content-type"])) : null;
    await pipeStream(upstream.body, raw, tap ? (chunk) => tap.push(chunk) : undefined);
    if (tap) {
      const usage = tap.finish();
      if (usage) ctx.stats.recordUsage(account.name, usage);
    }
    return { kind: "streamed" };
  } catch (err) {
    // 网络层错误：socket reset、DNS、代理拒绝等，可以切账号重试
    ctx.stats.recordError(account.name);
    account.lastError = (err as Error).message;
    const cdMs = account.computeCooldownFor("network_error", ctx.cooldown);
    account.cooldown(cdMs);
    return {
      kind: "retry",
      status: 0,
      reason: (err as Error).message || "network error",
    };
  } finally {
    account.inflight--;
  }
}

function joinUrl(base: string, path: string): string {
  return base.replace(/\/$/, "") + (path.startsWith("/") ? path : `/${path}`);
}

function buildUpstreamHeaders(
  incoming: FastifyRequest["headers"],
  apiKey: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(incoming)) {
    if (v === undefined) continue;
    if (STRIP_REQUEST_HEADERS.has(k.toLowerCase())) continue;
    out[k] = Array.isArray(v) ? v.join(", ") : String(v);
  }
  out["authorization"] = `Bearer ${apiKey}`;
  // 同时下发 x-api-key=apiKey：① LiteLLM 的 /v1/messages 认这个头而非 Bearer；
  // ② 客户端带来的 x-api-key（往往是本代理的 proxyToken）若不覆盖会泄漏给上游导致 401。
  // 对原生 Anthropic 上游(kimi/glm/mimo…)多带一个同值头无害，它们走 Bearer。
  out["x-api-key"] = apiKey;
  // 强制 identity：我们需要扫 SSE/JSON 文本里的 usage 字段，
  // 拿到压缩字节就没法解析了；undici request() 默认不自动解压
  out["accept-encoding"] = "identity";
  return out;
}

async function pipeStream(
  src: NodeJS.ReadableStream,
  dst: NodeJS.WritableStream,
  onData?: (chunk: Buffer) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    src.on("error", reject);
    dst.on("error", reject);
    // 旁路监听 data 喂统计 tap：与下面的 pipe 共存，不改变透传字节
    if (onData) {
      src.on("data", (chunk: Buffer) => {
        if (Buffer.isBuffer(chunk)) onData(chunk);
      });
    }
    src.on("end", () => {
      if (!(dst as { writableEnded?: boolean }).writableEnded) dst.end();
      resolve();
    });
    src.pipe(dst as never, { end: false });
  });
}

/** 取响应头值的第一个字符串（undici 头可能是 string | string[]）。 */
function headerValue(v: string | string[] | undefined): string | undefined {
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v[0] : v;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "..." : s;
}
