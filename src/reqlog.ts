import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { pino, type Logger } from "pino";
// @ts-expect-error pino-roll 自带类型但 NodeNext 解析有时找不到
import pinoRoll from "pino-roll";

export interface RequestLogOptions {
  // 请求日志文件基名，如 ./logs/requests.log
  file: string;
  // 按小时轮换，保留多少个历史文件。默认 24 ≈ 近 1 天。
  retentionHours: number;
  // 单文件大小上限；某一小时内暴量时提前切，避免单文件过大。与按时轮换叠加生效。
  maxSize: string;
}

// 专用「请求快照」日志：把每个进来的请求(method/url/headers/body)整条落盘一份。
// 与应用日志(logger.ts，按大小滚动)分开：这个按小时轮换 + 数量上限，磁盘占用恒定有界。
export async function createRequestLogger(opts: RequestLogOptions): Promise<Logger> {
  mkdirSync(dirname(opts.file), { recursive: true });
  const stream = await pinoRoll({
    file: opts.file,
    frequency: "hourly",
    size: opts.maxSize,
    // 文件名带到小时，方便按时间翻查：requests.log.2026-06-19-14
    dateFormat: "yyyy-MM-dd-HH",
    mkdir: true,
    // 数量上限即「近 N 小时」；removeOtherLogFiles 连同上次进程留下的旧文件一起清，
    // PM2 频繁重启也不会越攒越多。
    limit: { count: opts.retentionHours, removeOtherLogFiles: true },
  });
  // base:undefined 去掉 pid/hostname，请求快照只关心请求本身
  return pino({ base: undefined }, stream);
}

export type { Logger };
