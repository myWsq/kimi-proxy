import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { pino, type Logger, multistream, type StreamEntry } from "pino";
// @ts-expect-error pino-roll 自带类型但 NodeNext 解析有时找不到
import pinoRoll from "pino-roll";

export interface LoggerOptions {
  level: string;
  logFile?: string | undefined;
  logFileMaxSize: string;
  logFileMaxFiles: number;
}

export async function createLogger(opts: LoggerOptions): Promise<Logger> {
  const isTTY = process.stdout.isTTY;

  const streams: StreamEntry[] = [];

  // 标准输出：TTY 走 pino-pretty，否则原始 JSON
  if (isTTY) {
    const prettyMod = await import("pino-pretty");
    const pretty = prettyMod.default({
      colorize: true,
      translateTime: "SYS:HH:MM:ss.l",
      ignore: "pid,hostname",
    });
    streams.push({ stream: pretty });
  } else {
    streams.push({ stream: process.stdout });
  }

  // 文件日志：按大小滚动，超出 maxFiles 自动删除最旧
  if (opts.logFile) {
    mkdirSync(dirname(opts.logFile), { recursive: true });
    const fileStream = await pinoRoll({
      file: opts.logFile,
      size: opts.logFileMaxSize,
      limit: { count: opts.logFileMaxFiles },
      mkdir: true,
      // 同步写：日志量不大，省得退出时还要 flush；SIGTERM 不丢日志
      sync: true,
    });
    streams.push({ stream: fileStream });
  }

  return pino({ level: opts.level }, multistream(streams));
}

export type { Logger };
