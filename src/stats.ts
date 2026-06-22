import { dirname } from "node:path";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { Logger } from "pino";

/** 单账号累计统计。requests/errors 取代旧的内存计数器，token 为新增。 */
export interface AccountStats {
  requests: number;
  errors: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  /** 最近一次请求的毫秒 epoch，从未请求过为 null。 */
  lastRequestAt: number | null;
}

/** 一次成功响应解析出的 token 用量。 */
export interface TokenUsage {
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
}

export interface StatsStoreOptions {
  /** 持久化文件路径，如 ./logs/stats.json。 */
  file: string;
  /** 标脏后多久落一次盘（毫秒）。 */
  flushIntervalMs: number;
  logger: Logger;
}

interface StatsFile {
  version: 1;
  accounts: Record<string, AccountStats>;
}

function emptyStats(): AccountStats {
  return {
    requests: 0,
    errors: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    lastRequestAt: null,
  };
}

/**
 * 每账号累计统计的单一数据源，持久化到本地磁盘 JSON。
 *
 * - 内存 Map 为权威值；任何写操作标脏，由定时器周期原子落盘（写 *.tmp 再 rename）。
 * - 启动时 loadSync 读回上次进程的累计值，重启不清零。
 * - 退出时 stopAndFlushSync 同步落盘，避免丢最后一段统计。
 */
export class StatsStore {
  private readonly file: string;
  private readonly flushIntervalMs: number;
  private readonly logger: Logger;
  private readonly accounts = new Map<string, AccountStats>();
  private dirty = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(opts: StatsStoreOptions) {
    this.file = opts.file;
    this.flushIntervalMs = opts.flushIntervalMs;
    this.logger = opts.logger;
  }

  /** 取（或惰性建）某账号的统计条目。 */
  private entry(name: string): AccountStats {
    let s = this.accounts.get(name);
    if (!s) {
      s = emptyStats();
      this.accounts.set(name, s);
    }
    return s;
  }

  /** 启动时读盘。文件缺失→空起步；解析失败→告警后空起步，绝不崩。 */
  loadSync(): void {
    let raw: string;
    try {
      raw = readFileSync(this.file, "utf8");
    } catch {
      // 文件不存在（首次启动）：空起步，正常
      return;
    }
    try {
      const parsed = JSON.parse(raw) as Partial<StatsFile>;
      const accounts = parsed?.accounts;
      if (accounts && typeof accounts === "object") {
        for (const [name, s] of Object.entries(accounts)) {
          this.accounts.set(name, { ...emptyStats(), ...(s as AccountStats) });
        }
      }
      this.logger.info({ file: this.file, accounts: this.accounts.size }, "stats loaded");
    } catch (err) {
      this.logger.warn({ file: this.file, err }, "stats file corrupt, starting empty");
    }
  }

  recordRequest(name: string): void {
    const s = this.entry(name);
    s.requests++;
    s.lastRequestAt = Date.now();
    this.dirty = true;
  }

  recordError(name: string): void {
    this.entry(name).errors++;
    this.dirty = true;
  }

  recordUsage(name: string, u: TokenUsage): void {
    const s = this.entry(name);
    s.inputTokens += u.input;
    s.outputTokens += u.output;
    s.cacheCreationTokens += u.cacheCreation;
    s.cacheReadTokens += u.cacheRead;
    this.dirty = true;
  }

  /** 读取某账号统计；缺失返回全 0 副本（新账号也能在快照里有一行）。 */
  get(name: string): AccountStats {
    const s = this.accounts.get(name);
    return s ? { ...s } : emptyStats();
  }

  /** 启动周期落盘定时器。unref 避免拖住进程退出。 */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.flushIfDirty(), this.flushIntervalMs);
    this.timer.unref?.();
  }

  private flushIfDirty(): void {
    if (!this.dirty) return;
    try {
      this.writeSync();
      this.dirty = false;
    } catch (err) {
      // 落盘失败保留 dirty，下个周期重试
      this.logger.warn({ file: this.file, err }, "stats flush failed");
    }
  }

  /** 原子写：写到 *.tmp 再 rename，避免读到半截文件。 */
  private writeSync(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const data: StatsFile = { version: 1, accounts: Object.fromEntries(this.accounts) };
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2));
    renameSync(tmp, this.file);
  }

  /** 退出时停定时器并同步落盘。 */
  stopAndFlushSync(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.dirty) {
      try {
        this.writeSync();
        this.dirty = false;
      } catch (err) {
        this.logger.warn({ file: this.file, err }, "stats final flush failed");
      }
    }
  }
}
