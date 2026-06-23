import Fastify, { type FastifyBaseLogger } from "fastify";
import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { createRequestLogger, type Logger } from "./reqlog.js";
import { AccountPool } from "./pool.js";
import { QuotaPoller } from "./poller.js";
import { Router } from "./router.js";
import { StatsStore } from "./stats.js";
import { registerAccountsRoute } from "./routes/accounts.js";
import { registerHealthRoute } from "./routes/health.js";
import { registerForwardRoute } from "./routes/forward.js";

async function main(): Promise<void> {
  const cfg = loadConfig();
  const logger = await createLogger({
    level: cfg.server.logLevel,
    logFile: cfg.server.logFile,
    logFileMaxSize: cfg.server.logFileMaxSize,
    logFileMaxFiles: cfg.server.logFileMaxFiles,
  });

  // 请求快照日志（可选）：每个请求整条落盘，按小时轮换，只留近 N 小时
  let requestLogger: Logger | undefined;
  if (cfg.server.requestLogFile) {
    requestLogger = await createRequestLogger({
      file: cfg.server.requestLogFile,
      retentionHours: cfg.server.requestLogRetentionHours,
      maxSize: cfg.server.requestLogMaxSize,
    });
  }

  logger.info(
    {
      port: cfg.server.port,
      accounts: cfg.accounts.length,
      policy: cfg.server.policy,
      affinityHeader: cfg.server.affinityHeader,
      requestLog: cfg.server.requestLogFile ?? false,
    },
    "starting kimi-proxy",
  );

  const pool = new AccountPool(cfg.accounts, cfg.providers);
  const router = new Router(pool, { policy: cfg.server.policy, logger });
  // 每账号累计统计(请求/错误/token)：启动读盘恢复，周期+退出落盘
  const stats = new StatsStore({
    file: cfg.server.statsFile,
    flushIntervalMs: cfg.server.statsFlushIntervalMs,
    logger,
  });
  stats.loadSync();
  stats.start();
  const poller = new QuotaPoller(pool, {
    intervalMs: cfg.upstream.pollIntervalMs,
    logger,
  });

  await poller.start();

  const app = Fastify({
    // pino.Logger 与 FastifyBaseLogger 的 msgPrefix 字段定义差异需要 cast
    loggerInstance: logger as unknown as FastifyBaseLogger,
    disableRequestLogging: true,
    bodyLimit: 32 * 1024 * 1024, // 32MB，Anthropic 大上下文请求可能很大
  });

  app.addHook("onRequest", (req, _reply, done) => {
    req.log.debug({ method: req.method, url: req.url }, "incoming");
    done();
  });

  registerAccountsRoute(app, pool, stats);
  registerHealthRoute(app, pool);
  registerForwardRoute(app, {
    pool,
    router,
    proxyToken: cfg.server.proxyToken,
    affinityHeader: cfg.server.affinityHeader,
    providerHeader: cfg.server.providerHeader,
    logger,
    requestLogger,
    forwardCtx: {
      requestTimeoutMs: cfg.upstream.requestTimeoutMs,
      stats,
      cooldown: {
        cooldownAfter5xxMs: cfg.upstream.cooldownAfter5xxMs,
        cooldownAfterNetworkErrorMs: cfg.upstream.cooldownAfterNetworkErrorMs,
        cooldownAfter429MinMs: cfg.upstream.cooldownAfter429MinMs,
        cooldownAfter429MaxMs: cfg.upstream.cooldownAfter429MaxMs,
        cooldownTierExhaustionThreshold: cfg.upstream.cooldownTierExhaustionThreshold,
      },
      logger,
    },
  });

  app.get("/", async () => ({
    name: "kimi-proxy",
    endpoints: ["/v1/* (proxied)", "/accounts", "/healthz"],
  }));

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "shutting down");
    poller.stop();
    stats.stopAndFlushSync();
    try {
      await app.close();
    } catch (err) {
      logger.warn({ err }, "fastify close error");
    }
    await pool.close();
    // 同步日志流（sync: true）已经全部落盘，可以直接退出
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await app.listen({ host: cfg.server.host, port: cfg.server.port });
  logger.info({ host: cfg.server.host, port: cfg.server.port }, "listening");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
