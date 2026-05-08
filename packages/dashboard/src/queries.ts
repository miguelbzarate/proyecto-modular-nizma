/**
 * Consultas del tablero contra los shards.
 *
 * REGLA INVIOLABLE: todas las conexiones se abren en SÓLO LECTURA. El tablero observa
 * el sistema; si pudiera escribir dejaría de ser un observador y se volvería otra
 * fuente de verdad, con dos procesos compitiendo por el mismo archivo.
 *
 * Las conexiones se abren y cierran en cada consulta en vez de mantenerse vivas. Con
 * un sondeo cada dos segundos el costo es despreciable, y a cambio se evitan dos
 * problemas: una conexión de larga vida en modo WAL impide que el escritor compacte su
 * bitácora, y obliga a razonar sobre qué instantánea está viendo cada lector.
 */

import { existsSync } from "node:fs";
import {
  SensorWindow,
  WelfordDetector,
  type FeatureVector,
} from "@monitoreo/detector";
import { ShardRepository } from "@monitoreo/ingestor";
import {
  LOCATIONS,
  SENSOR_TYPES,
  shardPath,
  type Alert,
  type Location,
  type SensorType,
} from "@monitoreo/shared";

/** Punto de la gráfica: la lectura más la banda de control vigente en ese instante. */
export interface SeriesPoint {
  timestamp: string;
  value: number;
  mean: number | null;
  lower: number | null;
  upper: number | null;
  /** `true` si la banda de control la marcó. */
  outside: boolean;
  /** Veredicto guardado de cada detector; `null` si ese detector no corría. */
  welford: boolean | null;
  tree: boolean | null;
}

export interface ZoneSummary {
  location: Location;
  readings: number;
  alerts: number;
  sensors: number;
  criticalAlerts: number;
  lastReadingAt: string | null;
  /** `false` si el shard todavía no existe en disco. */
  online: boolean;
}

export interface SeriesResponse {
  location: Location;
  type: SensorType;
  unit: string;
  sensorId: string | null;
  points: SeriesPoint[];
}

/**
 * Ejecuta una operación sobre un shard y cierra la conexión pase lo que pase.
 * Devuelve `fallback` si el shard todavía no existe.
 */
function withShard<T>(
  location: Location,
  fallback: T,
  operation: (repository: ShardRepository) => T,
): T {
  if (!existsSync(shardPath(location))) return fallback;

  let repository: ShardRepository | null = null;
  try {
    repository = new ShardRepository(location, { readOnly: true });
    return operation(repository);
  } catch {
    // Un shard a medio crear o bloqueado no debe tumbar el tablero: se reporta como
    // sin datos y el siguiente sondeo lo intentará otra vez.
    return fallback;
  } finally {
    repository?.close();
  }
}

export function zoneSummary(location: Location): ZoneSummary {
  const empty: ZoneSummary = {
    location,
    readings: 0,
    alerts: 0,
    sensors: 0,
    criticalAlerts: 0,
    lastReadingAt: null,
    online: false,
  };

  return withShard(location, empty, (repository) => {
    const latest = repository.latestReadings({ limit: 1 });
    const recent = repository.latestReadings({ limit: 500 });
    const alerts = repository.latestAlerts(500);

    return {
      location,
      readings: repository.countReadings(),
      alerts: repository.countAlerts(),
      sensors: new Set(recent.map((r) => r.sensorId)).size,
      criticalAlerts: alerts.filter((a) => a.severity === "CRITICAL").length,
      lastReadingAt: latest[0]?.timestamp ?? null,
      online: true,
    };
  });
}

export function allZoneSummaries(): ZoneSummary[] {
  return LOCATIONS.map(zoneSummary);
}

/**
 * Serie de un sensor con su banda de control.
 *
 * Las bandas se recalculan aquí con el MISMO `SensorWindow` y el MISMO detector que
 * usa el ingestor. Reimplementar el cálculo para dibujarlo habría permitido que la
 * gráfica y las alertas se contradijeran: se vería un punto fuera de la banda sin
 * alerta, o al revés, y nadie sabría cuál de los dos miente.
 */
export function series(
  location: Location,
  type: SensorType,
  limit = 120,
  sensorId?: string,
): SeriesResponse {
  const empty: SeriesResponse = {
    location,
    type,
    unit: "",
    sensorId: sensorId ?? null,
    points: [],
  };

  return withShard(location, empty, (repository) => {
    // Sin sensor explícito se toma el más reciente de ese tipo, que es lo que un
    // operador espera ver al abrir la página.
    const chosen =
      sensorId ?? repository.latestReadings({ type, limit: 1 })[0]?.sensorId;
    if (chosen === undefined) return empty;

    const readings = repository.latestReadings({
      type,
      sensorId: chosen,
      limit,
    });
    if (readings.length === 0) return empty;

    const window = new SensorWindow(50);
    const detector = new WelfordDetector();
    const points: SeriesPoint[] = readings.map((reading) => {
      const features: FeatureVector = window.observe(reading);
      const verdict = detector.evaluate(features, reading);
      const ready = features.sampleCount >= 20 && features.stdDev > 0;

      return {
        timestamp: reading.timestamp,
        value: reading.value,
        mean: ready ? features.mean : null,
        lower: ready ? features.mean - 3 * features.stdDev : null,
        upper: ready ? features.mean + 3 * features.stdDev : null,
        outside: verdict !== null,
        // Los veredictos vienen de la base, no se recalculan: son los que el ingestor
        // emitió en vivo, con el estado de la ventana de ese instante.
        welford: reading.flaggedWelford === null ? null : reading.flaggedWelford === 1,
        tree: reading.flaggedTree === null ? null : reading.flaggedTree === 1,
      };
    });

    return {
      location,
      type,
      unit: readings[0]?.unit ?? "",
      sensorId: chosen,
      points,
    };
  });
}

/** Sensores disponibles en una zona, para poblar el selector de la interfaz. */
export function sensorsInZone(
  location: Location,
): { sensorId: string; type: SensorType }[] {
  return withShard(location, [], (repository) => {
    const seen = new Map<string, SensorType>();
    for (const reading of repository.latestReadings({ limit: 500 })) {
      seen.set(reading.sensorId, reading.type);
    }
    return [...seen.entries()].map(([sensorId, type]) => ({ sensorId, type }));
  });
}

/** Alertas más recientes de todas las zonas, mezcladas y ordenadas por tiempo. */
export function recentAlerts(limit = 40): Alert[] {
  const all: Alert[] = [];
  for (const location of LOCATIONS) {
    all.push(...withShard(location, [], (r) => r.latestAlerts(limit)));
  }
  return all
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    .slice(0, limit);
}

export const AVAILABLE_TYPES = SENSOR_TYPES;


/**
 * Marcador comparativo entre detectores.
 *
 * Se cuenta sobre las MISMAS lecturas: cada fila de `readings` guarda lo que dijo cada
 * detector en ese instante, así que la comparación no depende de reejecutar nada.
 *
 * El sistema en vivo no conoce la verdad de terreno —la etiqueta del simulador nunca
 * viaja por la red—, así que no se puede decir "acertó" o "falló". Lo que sí es
 * observable en los propios datos es si el sensor dejó de variar: dos lecturas
 * consecutivas idénticas del mismo sensor. Ese es el criterio que se usa para separar
 * los tramos congelados de los normales.
 */
export interface DetectorComparison {
  totalReadings: number;
  frozenReadings: number;
  welford: { onFrozen: number; onNormal: number; total: number };
  tree: { onFrozen: number; onNormal: number; total: number } | null;
}

export function detectorComparison(): DetectorComparison {
  const result: DetectorComparison = {
    totalReadings: 0,
    frozenReadings: 0,
    welford: { onFrozen: 0, onNormal: 0, total: 0 },
    tree: { onFrozen: 0, onNormal: 0, total: 0 },
  };

  let treeSeen = false;

  for (const location of LOCATIONS) {
    withShard(location, null, (repository) => {
      const rows = repository.latestReadings({ limit: 20000 });

      // Una lectura se considera "congelada" si repite exactamente el valor anterior
      // del mismo sensor. Es observable sin conocer la verdad de terreno.
      const previous = new Map<string, number>();

      for (const row of rows) {
        const key = `${row.sensorId}|${row.type}`;
        const frozen = previous.get(key) === row.value;
        previous.set(key, row.value);

        result.totalReadings += 1;
        if (frozen) result.frozenReadings += 1;

        if (row.flaggedWelford === 1) {
          result.welford.total += 1;
          if (frozen) result.welford.onFrozen += 1;
          else result.welford.onNormal += 1;
        }
        if (row.flaggedTree !== null) {
          treeSeen = true;
          if (row.flaggedTree === 1 && result.tree !== null) {
            result.tree.total += 1;
            if (frozen) result.tree.onFrozen += 1;
            else result.tree.onNormal += 1;
          }
        }
      }
      return null;
    });
  }

  if (!treeSeen) result.tree = null;
  return result;
}
