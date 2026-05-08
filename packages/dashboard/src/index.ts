/**
 * Punto de entrada del tablero.
 *
 *   node dist/index.js [--port 3000]
 */

import { parseArgs } from "node:util";
import { createLogger } from "@monitoreo/shared";
import { Dashboard } from "./server";

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      port: { type: "string", short: "p" },
      host: { type: "string" },
    },
  });

  const port = Number(values.port ?? process.env.DASHBOARD_PORT ?? 3000);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Puerto inválido: ${values.port}`);
  }

  const log = createLogger("TABLERO");
  const dashboard = new Dashboard({
    port,
    host: values.host ?? process.env.DASHBOARD_HOST ?? "0.0.0.0",
    logger: log,
  });

  await dashboard.listen();
  log.info("el tablero lee los shards en sólo lectura; nunca escribe");

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`recibido ${signal}; cerrando`);
    void dashboard.close().then(() => process.exit(0));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err: unknown) => {
  console.error("[TABLERO] fallo fatal:", (err as Error).message);
  process.exit(1);
});
