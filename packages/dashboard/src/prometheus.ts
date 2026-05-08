/**
 * Exposición de métricas en formato de texto de Prometheus.
 *
 * Es el formato que la propuesta prometía y el que entiende cualquier recolector
 * estándar, de modo que el sistema se pueda integrar con Grafana sin escribir un
 * adaptador. El formato es deliberadamente simple: una línea por métrica, con
 * etiquetas entre llaves.
 *
 *     # HELP nombre descripción
 *     # TYPE nombre counter|gauge
 *     nombre{etiqueta="valor"} 123
 *
 * Las que terminan en `_total` son contadores, que sólo suben; las demás son
 * indicadores, que suben y bajan. Confundirlos rompe las gráficas de tasa del
 * recolector, así que el tipo declarado importa.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "@monitoreo/shared";
import type { ZoneSummary } from "./queries";

export interface ProcessMetrics {
  /** Retraso del bucle de eventos en milisegundos, percentil 99. */
  eventLoopLagP99Ms: number;
  memoryBytes: number;
  uptimeSeconds: number;
}

interface BrokerMetricsFile {
  connectedClients?: number;
  subscribers?: number;
  readingsReceived?: number;
  readingsRouted?: number;
  alertsRouted?: number;
  invalidMessages?: number;
  idleDisconnects?: number;
  backpressurePauses?: number;
}

/**
 * Lee las métricas que el broker publica en disco.
 *
 * El broker vive en otro proceso y no comparte memoria con el tablero, así que
 * publica su estado en un archivo. Si no existe —el broker no está corriendo— se
 * devuelve vacío en lugar de fallar: un tablero que se cae porque falta una métrica
 * es peor que uno que muestra un hueco.
 */
export function readBrokerMetrics(): BrokerMetricsFile {
  try {
    const path = join(dataDir(), "broker-metricas.json");
    return JSON.parse(readFileSync(path, "utf8")) as BrokerMetricsFile;
  } catch {
    return {};
  }
}

function metric(
  name: string,
  help: string,
  type: "counter" | "gauge",
  samples: { labels?: Record<string, string>; value: number }[],
): string {
  const lines = [`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`];
  for (const sample of samples) {
    const labels = sample.labels
      ? `{${Object.entries(sample.labels)
          .map(([key, value]) => `${key}="${value}"`)
          .join(",")}}`
      : "";
    lines.push(`${name}${labels} ${sample.value}`);
  }
  return lines.join("\n");
}

export function renderMetrics(
  zones: readonly ZoneSummary[],
  process: ProcessMetrics,
  broker: BrokerMetricsFile = readBrokerMetrics(),
): string {
  const blocks: string[] = [];

  blocks.push(
    metric(
      "monitoreo_lecturas_total",
      "Lecturas almacenadas en el shard de cada zona",
      "counter",
      zones.map((z) => ({ labels: { zona: z.location }, value: z.readings })),
    ),
  );

  blocks.push(
    metric(
      "monitoreo_alertas_total",
      "Alertas registradas en el shard de cada zona",
      "counter",
      zones.map((z) => ({ labels: { zona: z.location }, value: z.alerts })),
    ),
  );

  blocks.push(
    metric(
      "monitoreo_alertas_criticas",
      "Alertas de severidad crítica entre las mas recientes",
      "gauge",
      zones.map((z) => ({
        labels: { zona: z.location },
        value: z.criticalAlerts,
      })),
    ),
  );

  blocks.push(
    metric(
      "monitoreo_sensores_activos",
      "Sensores distintos vistos recientemente en cada zona",
      "gauge",
      zones.map((z) => ({ labels: { zona: z.location }, value: z.sensors })),
    ),
  );

  blocks.push(
    metric(
      "monitoreo_shard_disponible",
      "1 si el shard de la zona pudo leerse, 0 si no",
      "gauge",
      zones.map((z) => ({
        labels: { zona: z.location },
        value: z.online ? 1 : 0,
      })),
    ),
  );

  const brokerSamples: { name: string; help: string; value: number | undefined }[] =
    [
      {
        name: "monitoreo_broker_clientes",
        help: "Clientes conectados al broker",
        value: broker.connectedClients,
      },
      {
        name: "monitoreo_broker_lecturas_recibidas_total",
        help: "Lecturas recibidas por el broker",
        value: broker.readingsReceived,
      },
      {
        name: "monitoreo_broker_lecturas_enrutadas_total",
        help: "Entregas de lectura a suscriptores",
        value: broker.readingsRouted,
      },
      {
        name: "monitoreo_broker_mensajes_invalidos_total",
        help: "Mensajes descartados por no cumplir el esquema",
        value: broker.invalidMessages,
      },
      {
        name: "monitoreo_broker_desconexiones_inactividad_total",
        help: "Clientes desconectados por dejar de dar señales de vida",
        value: broker.idleDisconnects,
      },
      {
        name: "monitoreo_broker_contrapresion_total",
        help: "Veces que el broker pausó la entrada por un suscriptor saturado",
        value: broker.backpressurePauses,
      },
    ];

  for (const sample of brokerSamples) {
    if (sample.value === undefined) continue;
    blocks.push(
      metric(
        sample.name,
        sample.help,
        sample.name.endsWith("_total") ? "counter" : "gauge",
        [{ value: sample.value }],
      ),
    );
  }

  blocks.push(
    metric(
      "monitoreo_event_loop_lag_ms",
      "Retraso del bucle de eventos del tablero, percentil 99",
      "gauge",
      [{ value: Number(process.eventLoopLagP99Ms.toFixed(3)) }],
    ),
  );

  blocks.push(
    metric(
      "monitoreo_memoria_bytes",
      "Memoria residente del proceso del tablero",
      "gauge",
      [{ value: process.memoryBytes }],
    ),
  );

  blocks.push(
    metric(
      "monitoreo_tiempo_activo_segundos",
      "Segundos que lleva corriendo el tablero",
      "gauge",
      [{ value: Number(process.uptimeSeconds.toFixed(1)) }],
    ),
  );

  return `${blocks.join("\n\n")}\n`;
}
