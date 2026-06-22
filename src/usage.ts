import { StringDecoder } from "node:string_decoder";
import type { TokenUsage } from "./stats.js";

// 非流式 JSON 响应累加上限：超过则放弃解析 usage（极少见，正常响应远小于此）。
const MAX_JSON_BYTES = 8 * 1024 * 1024;

/**
 * 从上游（Anthropic 协议）响应里旁路提取 token usage，不缓冲整条响应、零阻塞透传。
 *
 * - SSE（text/event-stream）：增量按行解析，从 message_start 取 input/cache，
 *   从最后一个 message_delta 取 output（累计值）。只保留一行残尾，内存有界。
 * - 非流式 JSON（application/json）：累加 chunk（有上限）后整体 parse 顶层 usage。
 *
 * 所有解析包在 try/catch 内：解析失败只是丢统计，绝不影响响应透传。
 */
export class UsageTap {
  private readonly sse: boolean;
  private readonly decoder = new StringDecoder("utf8");
  // SSE 模式：未消费完的残行
  private lineBuf = "";
  private input = 0;
  private cacheCreation = 0;
  private cacheRead = 0;
  private output = 0;
  private sawUsage = false;
  // JSON 模式：累加的 chunk
  private jsonChunks: Buffer[] = [];
  private jsonBytes = 0;
  private jsonOverflow = false;

  /** mode 由上游 content-type 决定；非 SSE 一律按非流式 JSON 处理。 */
  constructor(contentType: string | undefined) {
    this.sse = (contentType ?? "").toLowerCase().includes("text/event-stream");
  }

  push(chunk: Buffer): void {
    try {
      if (this.sse) this.pushSse(chunk);
      else this.pushJson(chunk);
    } catch {
      // 解析异常不影响透传
    }
  }

  private pushSse(chunk: Buffer): void {
    this.lineBuf += this.decoder.write(chunk);
    let nl: number;
    while ((nl = this.lineBuf.indexOf("\n")) >= 0) {
      const line = this.lineBuf.slice(0, nl);
      this.lineBuf = this.lineBuf.slice(nl + 1);
      this.consumeSseLine(line);
    }
  }

  private consumeSseLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") return;
    let evt: unknown;
    try {
      evt = JSON.parse(payload);
    } catch {
      return;
    }
    if (!evt || typeof evt !== "object") return;
    const o = evt as Record<string, unknown>;
    if (o.type === "message_start") {
      const msg = o.message as Record<string, unknown> | undefined;
      this.applyInputUsage(msg?.usage);
    } else if (o.type === "message_delta") {
      // message_delta.usage.output_tokens 为累计值，保留最后一个即最终值。
      // 部分上游(如小米 MiMo)把真实 input_tokens / cache_read_input_tokens 放在
      // 最终 message_delta 里，而 message_start 的对应字段全是 0，故这里也并入 input/cache。
      const usage = o.usage as Record<string, unknown> | undefined;
      const out = toNumber(usage?.output_tokens);
      if (out !== null) {
        this.output = out;
        this.sawUsage = true;
      }
      this.mergeInputUsage(usage);
    }
  }

  /** 从一个 usage 对象取 input/cache（用于 message_start 与非流式顶层）。 */
  private applyInputUsage(usage: unknown): void {
    if (!usage || typeof usage !== "object") return;
    const u = usage as Record<string, unknown>;
    const inp = toNumber(u.input_tokens);
    const cc = toNumber(u.cache_creation_input_tokens);
    const cr = toNumber(u.cache_read_input_tokens);
    if (inp !== null) this.input = inp;
    if (cc !== null) this.cacheCreation = cc;
    if (cr !== null) this.cacheRead = cr;
    if (inp !== null || cc !== null || cr !== null) this.sawUsage = true;
  }

  /**
   * message_delta 里若带 input/cache(MiMo 把真实值放这儿、message_start 全为 0),
   * 按 max 并入：只升不降，绝不让已取到的真实值被后来的占位 0 覆盖。
   */
  private mergeInputUsage(usage: unknown): void {
    if (!usage || typeof usage !== "object") return;
    const u = usage as Record<string, unknown>;
    const inp = toNumber(u.input_tokens);
    const cc = toNumber(u.cache_creation_input_tokens);
    const cr = toNumber(u.cache_read_input_tokens);
    if (inp !== null && inp > this.input) { this.input = inp; this.sawUsage = true; }
    if (cc !== null && cc > this.cacheCreation) { this.cacheCreation = cc; this.sawUsage = true; }
    if (cr !== null && cr > this.cacheRead) { this.cacheRead = cr; this.sawUsage = true; }
  }

  private pushJson(chunk: Buffer): void {
    if (this.jsonOverflow) return;
    this.jsonBytes += chunk.length;
    if (this.jsonBytes > MAX_JSON_BYTES) {
      this.jsonOverflow = true;
      this.jsonChunks = [];
      return;
    }
    this.jsonChunks.push(chunk);
  }

  /** 流结束后调用，返回累计 usage；没解析到任何 usage 返回 null。 */
  finish(): TokenUsage | null {
    try {
      if (this.sse) {
        // flush 残行（最后一行可能没有结尾换行）
        const tail = this.lineBuf + this.decoder.end();
        if (tail) this.consumeSseLine(tail);
      } else if (!this.jsonOverflow && this.jsonChunks.length > 0) {
        const obj = JSON.parse(Buffer.concat(this.jsonChunks).toString("utf8")) as Record<string, unknown>;
        this.applyInputUsage(obj?.usage);
        const usage = obj?.usage as Record<string, unknown> | undefined;
        const out = toNumber(usage?.output_tokens);
        if (out !== null) {
          this.output = out;
          this.sawUsage = true;
        }
      }
    } catch {
      // 忽略解析失败
    }
    if (!this.sawUsage) return null;
    return {
      input: this.input,
      output: this.output,
      cacheCreation: this.cacheCreation,
      cacheRead: this.cacheRead,
    };
  }
}

function toNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}
