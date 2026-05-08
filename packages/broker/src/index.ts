/**
 * Punto de entrada del broker.
 *
 *   node dist/index.js --port 8080
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { createLogger, dataDir } from "@monitoreo/shared";
import { Broker } from "./broker";

const METRICS_INTERVAL_MS = 10_000;

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      port: { type: "string", short: "p" },
      host: { type: "string" },
      // En segundos. El valor por defecto de 90 s es el operativo; se puede acortar
      // para demostrar la detección de cortes silenciosos sin esperar minuto y medio.
      "idle-timeout": { type: "string" },
      "sweep-interval": { type: "string" },
    },
  });

  const port = Number(values.port ?? process.env.BROKER_PORT ?? 8080);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Puerto inválido: ${values.port}`);
  }

  const log = createLogger("BROKER");
  const broker = new Broker({
    port,
    host: values.host ?? process.env.BROKER_HOST ?? "0.0.0.0",
    logger: log,
    ...(values["idle-timeout"] === undefined
      ? {}
      : { idleTimeoutMs: Number(values["idle-timeout"]) * 1000 }),
    ...(values["sweep-interval"] === undefined
      ? {}
      : { sweepIntervalMs: Number(values["sweep-interval"]) * 1000 }),
  });

  await broker.listen();

  // Las métricas se publican en un archivo porque el dashboard vive en otro proceso y
  // no comparte memoria con el broker. Es el mecanismo más simple que funciona; si
  // hiciera falta algo más serio, el siguiente paso natural sería un endpoint propio.
  const metricsPath = join(dataDir(), "broker-metricas.json");
  const publisher = setInterval(() => {
    const m = broker.snapshot();
    log.info(
      `clientes=${m.connectedClients} suscriptores=${m.subscribers} ` +
        `lecturas=${m.readingsReceived} enrutadas=${m.readingsRouted} ` +
        `alertas=${m.alertsRouted} inválidos=${m.invalidMessages}`,
    );
    try {
      writeFileSync(
        metricsPath,
        JSON.stringify({ ...m, actualizado: new Date().toISOString() }),
      );
    } catch (err) {
      log.warn(`no se pudieron publicar métricas: ${(err as Error).message}`);
    }
  }, METRICS_INTERVAL_MS);
  publisher.unref();

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`recibido ${signal}; cerrando`);
    clearInterval(publisher);
    void broker.close().then(() => process.exit(0));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err: unknown) => {
  console.error("[BROKER] fallo fatal:", err);
  process.exit(1);
});
