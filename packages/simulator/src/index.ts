/**
 * Proceso simulador de sensores.
 *
 *   node dist/index.js --location NORTE --sensors 2 --interval 1000
 *
 * Publica lecturas al broker por TCP. Un proceso puede alojar varios sensores de
 * varios tipos; para repartirlos entre máquinas basta lanzar procesos distintos
 * apuntando al mismo `--host`.
 */

import { parseArgs } from "node:util";
import {
  BrokerClient,
  LOCATIONS,
  SENSOR_TYPES,
  createLogger,
  readingToMessage,
  type Location,
  type SensorType,
} from "@monitoreo/shared";
import {
  ANOMALY_MODES,
  DEFAULT_ANOMALY,
  type AnomalyConfig,
  type AnomalyMode,
} from "./anomaly";
import { createSensors } from "./sensor";

const METRICS_INTERVAL_MS = 10_000;

function parseAnomaly(
  mode: string | undefined,
  rate: string | undefined,
  duration: string | undefined,
): AnomalyConfig | null {
  if (mode === undefined) return null;
  const requested = mode.toUpperCase();
  const found = ANOMALY_MODES.find((m) => m === requested) as
    | AnomalyMode
    | undefined;
  if (found === undefined) {
    throw new Error(
      `Modo de anomalía inválido: '${mode}'. Opciones: ${ANOMALY_MODES.join(", ")}`,
    );
  }
  const parsedRate = rate === undefined ? DEFAULT_ANOMALY.rate : Number(rate);
  if (!Number.isFinite(parsedRate) || parsedRate < 0 || parsedRate > 1) {
    throw new Error(`--anomaly-rate debe estar entre 0 y 1, se recibió ${rate}`);
  }
  // Cuántas lecturas dura el episodio. SPIKE dura una por definición; para los demás,
  // alargarlo hace la falla mucho más visible en la gráfica durante una demostración.
  const parsedDuration =
    duration === undefined ? DEFAULT_ANOMALY.durationSamples : Number(duration);
  if (!Number.isInteger(parsedDuration) || parsedDuration < 1) {
    throw new Error(
      `--anomaly-duration debe ser un entero positivo, se recibió ${duration}`,
    );
  }

  return {
    ...DEFAULT_ANOMALY,
    mode: found,
    rate: parsedRate,
    durationSamples: parsedDuration,
  };
}

function parseLocation(value: string | undefined): Location {
  const raw = (value ?? process.env.LOCATION ?? "NORTE").toUpperCase();
  const location = LOCATIONS.find((l) => l === raw);
  if (location === undefined) {
    throw new Error(`Zona inválida: '${raw}'. Opciones: ${LOCATIONS.join(", ")}`);
  }
  return location;
}

function parseTypes(value: string | undefined): SensorType[] {
  if (value === undefined) return [...SENSOR_TYPES];
  return value
    .split(",")
    .map((t) => t.trim().toUpperCase())
    .map((requested) => {
      const type = SENSOR_TYPES.find((t) => t === requested);
      if (type === undefined) {
        throw new Error(
          `Tipo inválido: '${requested}'. Opciones: ${SENSOR_TYPES.join(", ")}`,
        );
      }
      return type;
    });
}

function main(): void {
  const { values } = parseArgs({
    options: {
      location: { type: "string", short: "l" },
      sensors: { type: "string", short: "n" },
      types: { type: "string", short: "t" },
      interval: { type: "string", short: "i" },
      host: { type: "string" },
      port: { type: "string", short: "p" },
      anomaly: { type: "string", short: "a" },
      "anomaly-rate": { type: "string" },
      "anomaly-duration": { type: "string" },
      heartbeat: { type: "string" },
    },
  });

  const location = parseLocation(values.location);
  const types = parseTypes(values.types);
  const perType = Number(values.sensors ?? 1);
  const intervalMs = Number(values.interval ?? process.env.INTERVAL_MS ?? 1000);
  const host = values.host ?? process.env.BROKER_HOST ?? "127.0.0.1";
  const port = Number(values.port ?? process.env.BROKER_PORT ?? 8080);

  if (!Number.isInteger(perType) || perType < 1) {
    throw new Error(
      `--sensors debe ser un entero positivo, se recibió ${values.sensors}`,
    );
  }
  if (!Number.isFinite(intervalMs) || intervalMs < 10) {
    throw new Error(
      `--interval debe ser al menos 10 ms, se recibió ${values.interval}`,
    );
  }

  const anomaly = parseAnomaly(
    values.anomaly,
    values["anomaly-rate"],
    values["anomaly-duration"],
  );

  const log = createLogger(`SIMULADOR-${location}`);
  const sensors = createSensors(location, types, perType, Math.random, anomaly);

  log.info(
    `${sensors.length} sensores (${perType} por tipo × ${types.length} tipos) ` +
      `cada ${intervalMs} ms hacia ${host}:${port}`,
  );
  if (anomaly !== null) {
    log.info(
      `inyectando anomalías ${anomaly.mode} con probabilidad ${anomaly.rate} ` +
        `por lectura (${anomaly.magnitude}σ, ${anomaly.durationSamples} muestras)`,
    );
  }
  for (const sensor of sensors) {
    log.info(`  ${sensor.type.padEnd(13)} ${sensor.sensorId}`);
  }

  const client = new BrokerClient({
    host,
    port,
    clientId: `simulador-${location}-${process.pid}`,
    // El simulador sólo publica; no se suscribe a nada. Sin temas, el broker no le
    // reenvía tráfico y no se recibe el eco de sus propias lecturas.
    heartbeatMs: Number(values.heartbeat ?? process.env.HEARTBEAT_MS ?? 30_000),
  });

  let sent = 0;
  let dropped = 0;
  let injected = 0;

  client.on("connected", () => log.info(`conectado a ${host}:${port}`));
  client.on("disconnected", (reason) => log.warn(`sin conexión: ${reason}`));
  client.on("message", (message) => {
    if (message.kind === "ERROR") log.warn(`el broker rechazó: ${message.message}`);
  });

  client.connect();

  const clock = setInterval(() => {
    if (!client.connected) return;
    const now = new Date();
    for (const sensor of sensors) {
      const { reading, label } = sensor.measure(now);
      if (label !== "NORMAL") {
        injected += 1;
        // La etiqueta se registra sólo aquí, en el proceso que la generó. No viaja
        // por el cable: el detector tiene que descubrir la anomalía por su cuenta.
        log.debug(
          `inyectada ${label} en ${sensor.type} -> ${reading.value}${reading.unit}`,
        );
      }
      // `send` devuelve false si el búfer de salida está lleno: el broker está
      // aplicando contrapresión. Un sensor real tampoco puede acumular indefinidamente,
      // así que la muestra se descarta y se cuenta.
      if (client.send(readingToMessage(reading))) sent += 1;
      else dropped += 1;
    }
  }, intervalMs);

  const metrics = setInterval(() => {
    log.info(
      `enviadas=${sent} descartadas_por_contrapresion=${dropped}` +
        (anomaly === null ? "" : ` anomalias_inyectadas=${injected}`),
    );
  }, METRICS_INTERVAL_MS);
  metrics.unref();

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`recibido ${signal}; enviadas ${sent} lecturas en total`);
    clearInterval(clock);
    clearInterval(metrics);
    client.close();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

try {
  main();
} catch (err) {
  console.error("[SIMULADOR] fallo fatal:", (err as Error).message);
  process.exit(1);
}
