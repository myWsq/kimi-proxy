import type { FastifyInstance } from "fastify";
import type { AccountPool } from "../pool.js";
import type { StatsStore } from "../stats.js";

export function registerAccountsRoute(
  app: FastifyInstance,
  pool: AccountPool,
  stats: StatsStore,
): void {
  app.get("/accounts", async () => {
    return { accounts: pool.snapshot(stats) };
  });
}
