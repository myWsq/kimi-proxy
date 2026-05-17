import type { FastifyInstance } from "fastify";
import type { AccountPool } from "../pool.js";

export function registerHealthRoute(app: FastifyInstance, pool: AccountPool): void {
  app.get("/healthz", async (_req, reply) => {
    const accounts = pool.all();
    const selectable = pool.selectable().length;
    const status = selectable > 0 ? "ok" : "degraded";
    reply.code(selectable > 0 ? 200 : 503);
    return {
      status,
      accounts: accounts.length,
      selectable,
    };
  });
}
