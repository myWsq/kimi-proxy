import type { FastifyInstance } from "fastify";
import type { AccountPool } from "../pool.js";

export function registerAccountsRoute(app: FastifyInstance, pool: AccountPool): void {
  app.get("/accounts", async () => {
    return { accounts: pool.snapshot() };
  });
}
