/**
 * Proceso gestor de alertas.
 *
 *   node dist/index.js [--host 127.0.0.1] [--port 8080] [--quiet-period 60]
 *
 * Se suscribe al canal ALERTS del broker, agrupa las alertas en incidentes y las
 * persiste en `data/alertas.log`.
 *
 * Sobre la notificación por correo: la propuesta original contemplaba `nodemailer` con
 * respaldo a un archivo si el servidor de correo fallaba. Se implementa directamente el
 * respaldo, que es el camino que de todos modos se recorre en una demostración sin
 * servidor SMTP configurado, y se deja el envío real como trabajo futuro. Escribir a
 * disco antes de notificar es además el orden correcto: una alerta que no se pudo
 * enviar pero quedó registrada es recuperable; una que se envió pero no se registró, no.
 */

import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  BrokerClient,
  createLogger,
  dataDir,
  relativeToRepo,
  messageToAlert,
  type Alert,
} from "@monitoreo/shared";
import { AlertManager, describeEvent } from "./alert-manager";

const SUMMARY_INTERVAL_MS = 15_000;
const SWEEP_INTERVAL_MS = 5_000;

function main(): void {
  const { values } = parseArgs({
    options: {
      host: { type: "string" },
      port: { type: "string", short: "p" },
      "quiet-period": { type: "string" },
      "log-file": { type: "string" },
      heartbeat: { type: "string" },
    },
  });

  const host = values.host ?? process.env.BROKER_HOST ?? "127.0.0.1";
  const port = Number(values.port ?? process.env.BROKER_PORT ?? 8080);
  const quietPeriodMs = Number(values["quiet-period"] ?? 60) * 1000;
  // Este proceso puede pasar horas sin recibir una sola alerta, que es justamente la
  // señal de que todo va bien. Sin latidos, el broker lo tomaría por caído.
  const heartbeatMs = Number(values.heartbeat ?? process.env.HEARTBEAT_MS ?? 30_000);
  const logPath = values["log-file"] ?? join(dataDir(), "alertas.log");

  const log = createLogger("ALERTAS");
  const manager = new AlertManager({ quietPeriodMs });

  log.info(`bitácora en ${relativeToRepo(logPath)}`);
  log.info(`un incidente se cierra tras ${quietPeriodMs / 1000} s sin novedades`);

  let writeFailures = 0;

  /**
   * Cada alerta se escribe cruda, una por línea en JSON. El resumen por incidentes es
   * para la persona; este archivo es para la auditoría posterior y para el tablero.
   */
  const persist = (alert: Alert): void => {
    try {
      appendFileSync(logPath, `${JSON.stringify(alert)}\n`);
    } catch (err) {
      writeFailures += 1;
      log.error(`no se pudo escribir la bitácora: ${(err as Error).message}`);
    }
  };

  const client = new BrokerClient({
    host,
    port,
    clientId: "alert-manager",
    topics: ["ALERTS"],
    heartbeatMs,
  });

  client.on("connected", () => log.info(`conectado a ${host}:${port}`));
  client.on("disconnected", (reason) => log.warn(`sin conexión: ${reason}`));
  client.on("invalid-protocol", (error) => log.warn(`mensaje inválido: ${error}`));

  client.on("message", (message) => {
    if (message.kind === "SUBACK") {
      log.info(`suscripción confirmada: [${message.topics.join(", ")}]`);
      return;
    }
    if (message.kind !== "ALERTA") return;

    const alert = messageToAlert(message);
    persist(alert);

    const event = manager.receive(alert);
    // `null` significa que la alerta engrosó un incidente ya conocido sin agravarlo.
    // Queda en la bitácora, pero no se repite en pantalla.
    if (event === null) return;

    const line = describeEvent(event);
    if (event.incident.maxSeverity === "CRITICAL") log.error(line);
    else log.warn(line);
  });

  client.connect();

  // Un incidente no puede enterarse solo de que el sensor se recuperó: la recuperación
  // es la ausencia de mensajes, así que hay que ir a buscarla.
  const sweeper = setInterval(() => {
    for (const event of manager.sweep()) log.info(describeEvent(event));
  }, SWEEP_INTERVAL_MS);
  sweeper.unref();

  const summary = setInterval(() => {
    const s = manager.snapshot();
    const zones = Object.entries(s.alertsByZone)
      .map(([zone, count]) => `${zone}=${count}`)
      .join(" ");
    log.info(
      `incidentes_abiertos=${s.openIncidents} totales=${s.totalIncidents} ` +
        `alertas=${s.totalAlerts} agrupadas=${s.suppressedAlerts} ` +
        `críticos=${s.incidentsBySeverity.CRITICAL}` +
        (zones === "" ? "" : ` | ${zones}`),
    );
  }, SUMMARY_INTERVAL_MS);
  summary.unref();

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    const s = manager.snapshot();
    log.info(
      `recibido ${signal}; ${s.totalAlerts} alertas en ${s.totalIncidents} incidentes` +
        (writeFailures > 0 ? ` (${writeFailures} fallos de escritura)` : ""),
    );
    for (const incident of manager.activeIncidents()) {
      log.warn(
        `incidente sin cerrar: ${incident.location}/${incident.type} ` +
          `con ${incident.alertCount} alertas`,
      );
    }
    clearInterval(sweeper);
    clearInterval(summary);
    client.close();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

// Este archivo es el ejecutable: importarlo arranca el proceso. La lógica reutilizable
// vive en `alert-manager.ts`, que es lo que importan las pruebas.
try {
  main();
} catch (err) {
  console.error("[ALERTAS] fallo fatal:", (err as Error).message);
  process.exit(1);
}
