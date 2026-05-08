/**
 * Ingestor de una zona geográfica. Un proceso del sistema operativo por zona.
 *
 *   node dist/index.js --location NORTE [--host 127.0.0.1] [--port 8080]
 *                      [--window 50] [--k 3] [--min-samples 20]
 *
 * Responsabilidades: persistir cada lectura en su shard, mantener la ventana
 * deslizante de cada sensor, evaluar el detector y publicar las alertas al canal
 * ALERTS del broker.
 *
 * Por qué proceso y no Worker Thread: el criterio 3.3 pide comunicación entre al menos
 * dos dispositivos, y la nota del comité advierte que varias interfaces contra un
 * sistema centralizado no cuentan como distribuido. Procesos independientes que sólo
 * se hablan por TCP satisfacen el criterio incluso corriendo en la misma máquina, y
 * permiten repartirlos entre equipos distintos sin tocar una línea de código.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  BrokerClient,
  LOCATIONS,
  alertToMessage,
  createLogger,
  dataDir,
  messageToReading,
  relativeToRepo,
  type Location,
  type Logger,
} from "@monitoreo/shared";
import {
  DecisionTreeDetector,
  WelfordDetector,
  WindowRegistry,
  buildAlert,
  type AnomalyDetector,
} from "@monitoreo/detector";
import { ShardRepository } from "./shard-repository";

const METRICS_INTERVAL_MS = 10_000;

function parseLocation(value: string | undefined): Location {
  const raw = (value ?? process.env.LOCATION ?? "").toUpperCase();
  const location = LOCATIONS.find((l) => l === raw);
  if (location === undefined) {
    throw new Error(`Zona inválida: '${raw}'. Opciones: ${LOCATIONS.join(", ")}`);
  }
  return location;
}

/**
 * Elige la estrategia de detección.
 *
 * Aquí es donde el patrón Strategy paga: cambiar de la banda de control al árbol de
 * decisión es un argumento de línea de comandos, no una modificación del ingestor.
 * Eso es lo que permite comparar ambos sobre el mismo flujo durante la demostración.
 */
/**
 * Carga el árbol de decisión si hay un modelo entrenado disponible.
 *
 * Devuelve `null` en vez de fallar cuando no lo hay: el sistema debe poder arrancar sin
 * haber entrenado nunca, corriendo sólo con la banda de control.
 */
function loadTree(
  location: Location,
  modelOverride: string | undefined,
  minSamples: number,
  threshold: number,
  log: Logger,
): DecisionTreeDetector | null {
  const path = modelOverride ?? join(dataDir(), `modelo-${location}.json`);
  if (!existsSync(path)) return null;

  const detector = DecisionTreeDetector.fromFile(path, { minSamples, threshold });
  const model = detector.model;
  log.info(
    `modelo cargado de ${relativeToRepo(path)} (entrenado ${model.trainedAt} con ` +
      `${model.trainingSamples} muestras, ${model.positiveSamples} anómalas)`,
  );
  return detector;
}

function main(): void {
  const { values } = parseArgs({
    options: {
      location: { type: "string", short: "l" },
      host: { type: "string" },
      port: { type: "string", short: "p" },
      window: { type: "string", short: "w" },
      k: { type: "string" },
      "min-samples": { type: "string" },
      detector: { type: "string", short: "d" },
      model: { type: "string" },
      threshold: { type: "string" },
      heartbeat: { type: "string" },
    },
  });

  const location = parseLocation(values.location);
  const host = values.host ?? process.env.BROKER_HOST ?? "127.0.0.1";
  const port = Number(values.port ?? process.env.BROKER_PORT ?? 8080);
  const windowSize = Number(values.window ?? 50);
  const k = Number(values.k ?? 3);
  const minSamples = Number(values["min-samples"] ?? 20);
  const threshold = Number(values.threshold ?? 0.3);
  const kind = (values.detector ?? process.env.DETECTOR ?? "welford").toLowerCase();
  // INVARIANTE: el periodo de latido debe ser bastante menor que el tiempo de
  // inactividad del broker, o un cliente sano y callado sería expulsado por silencioso.
  // En operación son 30 s contra 90 s: tres latidos de margen.
  const heartbeatMs = Number(values.heartbeat ?? process.env.HEARTBEAT_MS ?? 30_000);

  const log = createLogger(`INGESTOR-${location}`);
  const repository = new ShardRepository(location);
  const windows = new WindowRegistry(windowSize);
  // AMBOS detectores corren sobre cada lectura, siempre. Es la única forma de
  // compararlos de verdad: mismos datos, mismo instante, mismo estado de la ventana.
  // El elegido con --detector es el que emite la alerta oficial; el otro deja su
  // veredicto registrado para el tablero de comparación.
  const welford = new WelfordDetector({ k, minSamples });
  const tree = loadTree(location, values.model, minSamples, threshold, log);

  if (kind !== "welford" && kind !== "tree") {
    throw new Error(`Detector inválido: '${kind}'. Opciones: welford, tree`);
  }
  if (kind === "tree" && tree === null) {
    throw new Error(
      `No existe el modelo de ${location}. Entrénalo primero con 'pnpm entrenar'.`,
    );
  }

  const primary: AnomalyDetector = kind === "tree" && tree !== null ? tree : welford;

  log.info(`shard abierto con ${repository.countReadings()} lecturas previas`);
  log.info(
    `detector principal ${primary.name}: ventana=${windowSize} min_muestras=${minSamples} ` +
      `k=${k} umbral=${threshold}`,
  );
  log.info(
    tree === null
      ? "sin modelo entrenado: sólo corre la banda de control"
      : "ambos detectores corren en paralelo para comparación",
  );

  let stored = 0;
  let rejected = 0;
  let alertsRaised = 0;
  let flaggedByWelford = 0;
  let flaggedByTree = 0;

  const client = new BrokerClient({
    host,
    port,
    clientId: `ingestor-${location}`,
    topics: [location],
    heartbeatMs,
  });

  client.on("connected", () => log.info(`conectado a ${host}:${port}`));
  client.on("disconnected", (reason) => log.warn(`sin conexión: ${reason}`));
  client.on("invalid-protocol", (error) =>
    log.warn(`mensaje inválido del broker: ${error}`),
  );

  client.on("message", (message) => {
    if (message.kind === "SUBACK") {
      log.info(`suscripción confirmada: [${message.topics.join(", ")}]`);
      return;
    }
    if (message.kind !== "LECTURA") return;

    const reading = messageToReading(message);

    // La ventana se actualiza una sola vez y AMBOS detectores ven exactamente el mismo
    // estado. Si cada uno tuviera su propia ventana, la comparación sería inválida.
    const features = windows.observe(reading);
    const welfordVerdict = welford.evaluate(features, reading);
    const treeVerdict = tree?.evaluate(features, reading) ?? null;

    if (welfordVerdict !== null) flaggedByWelford += 1;
    if (treeVerdict !== null) flaggedByTree += 1;

    try {
      repository.insert(reading, {
        welford: welfordVerdict !== null,
        ...(tree === null ? {} : { tree: treeVerdict !== null }),
      });
      stored += 1;
    } catch (err) {
      // Llega aquí si el broker enruta mal. Se cuenta y se sigue: perder una lectura
      // es preferible a que el ingestor muera y deje la zona sin cobertura.
      rejected += 1;
      log.error(`lectura rechazada: ${(err as Error).message}`);
      return;
    }

    // Sólo el detector principal emite la alerta oficial. El otro ya dejó su veredicto
    // registrado en la lectura, que es lo que alimenta la vista de comparación.
    const detection = primary === welford ? welfordVerdict : treeVerdict;
    if (detection === null) {
      log.debug(
        `${reading.sensorId.slice(0, 8)} ${reading.type}=${reading.value}${reading.unit} z=${features.zScore.toFixed(2)}`,
      );
      return;
    }

    const alert = buildAlert(reading, detection, primary.name);
    alertsRaised += 1;
    repository.recordAlert(alert);

    // La alerta viaja al canal ALERTS. Si el broker está caído se pierde el aviso en
    // vivo, pero queda registrada en el shard: el tablero la seguirá mostrando.
    const delivered = client.send(alertToMessage(alert));
    log.warn(
      `[${alert.severity}] ${alert.message}${delivered ? "" : " (no se pudo publicar; queda en el shard)"}`,
    );
  });

  client.connect();

  const metrics = setInterval(() => {
    log.info(
      `almacenadas=${stored} rechazadas=${rejected} alertas=${alertsRaised} ` +
        `welford_marcó=${flaggedByWelford} árbol_marcó=${flaggedByTree} ` +
        `sensores_vigilados=${windows.size}`,
    );
  }, METRICS_INTERVAL_MS);
  metrics.unref();

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(
      `recibido ${signal}; ${stored} lecturas almacenadas y ${alertsRaised} alertas emitidas`,
    );
    clearInterval(metrics);
    client.close();
    repository.close();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

try {
  main();
} catch (err) {
  console.error("[INGESTOR] fallo fatal:", (err as Error).message);
  process.exit(1);
}
