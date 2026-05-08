/**
 * Generación de conjuntos de datos etiquetados.
 *
 * Se produce fuera de línea, en memoria, sin levantar procesos ni sockets: el mismo
 * `SimulatedSensor` de producción alimenta el mismo `SensorWindow` de producción, y
 * lo que sale es exactamente el vector de características que verá el ingestor. Si el
 * conjunto viniera de un generador paralelo, el modelo se entrenaría sobre una
 * distribución que nunca va a encontrar en operación.
 *
 * Dos precauciones metodológicas que sostienen la validez de la evaluación:
 *
 * 1. La simulación abarca varios días de reloj. Si todas las muestras cayeran en la
 *    misma franja horaria, el árbol podría partir por `hourOfDay` y aparentar acierto
 *    memorizando cuándo se generaron los datos en lugar de qué es una anomalía.
 *
 * 2. Se descartan las muestras de calentamiento. El detector se abstiene mientras la
 *    ventana no esté suficientemente llena, así que entrenarlo con ese tramo sería
 *    enseñarle sobre casos que en operación nunca va a juzgar.
 */

import {
  DEFAULT_ANOMALY,
  SimulatedSensor,
  type AnomalyLabel,
  type AnomalyMode,
} from "@monitoreo/simulator";
import {
  SensorWindow,
  toFeatureArray,
  type ClassLabel,
  type FeatureVector,
} from "@monitoreo/detector";
import { SENSOR_TYPES, type Location, type SensorType } from "@monitoreo/shared";

export interface LabeledSample {
  features: FeatureVector;
  /** 1 si el simulador corrompió esta lectura. */
  label: ClassLabel;
  /** Tipo concreto de falla, para desglosar la exhaustividad por modo. */
  anomalyType: AnomalyLabel;
  sensorType: SensorType;
}

export interface Dataset {
  samples: LabeledSample[];
  rows: number[][];
  labels: ClassLabel[];
}

export interface DatasetOptions {
  location: Location;
  /** Modos de falla a inyectar. Un modo por sensor, repartidos cíclicamente. */
  modes: readonly AnomalyMode[];
  /** Lecturas a generar por sensor, ya descontado el calentamiento. */
  samplesPerSensor: number;
  /** Sensores por cada tipo de medida. */
  sensorsPerType?: number;
  types?: readonly SensorType[];
  /** Separación entre lecturas, en milisegundos de reloj simulado. */
  intervalMs?: number;
  windowSize?: number;
  /** Muestras de calentamiento que se generan y se descartan. */
  warmupSamples?: number;
  anomalyRate?: number;
  seed?: number;
}

export const DEFAULT_DATASET: Required<
  Omit<DatasetOptions, "location" | "modes" | "samplesPerSensor">
> = {
  /**
   * Cuatro sensores por tipo de medida y cuatro modos de falla repartidos
   * cíclicamente: cada modo queda asignado a exactamente un sensor de cada tipo. Con
   * dos por tipo, dos de los modos aparecían el doble de veces que los otros y las
   * exhaustividades por tipo no eran comparables entre sí.
   */
  sensorsPerType: 4,
  types: SENSOR_TYPES,
  intervalMs: 30_000,
  windowSize: 50,
  warmupSamples: 60,
  /**
   * Probabilidad de que ARRANQUE un episodio en una lectura dada, no proporción de
   * lecturas anómalas. Como un episodio de deriva o de sensor atorado dura veinte
   * lecturas, la fracción resultante es aproximadamente `duración / (1/tasa + duración)`:
   * con 0.002 sale cerca del 4 %, que es un orden de magnitud plausible para fallas de
   * instrumentación. Un valor de 0.03 saturaría la serie por encima del 25 % y volvería
   * las métricas irreconocibles frente a un despliegue real.
   */
  anomalyRate: 0.002,
  seed: 42,
};

/**
 * Generador congruencial lineal.
 *
 * Se usa en vez de `Math.random` para que el conjunto de datos sea reproducible: los
 * resultados reportados en el documento tienen que poder regenerarse con la misma
 * semilla, o no son verificables.
 */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

export function generateDataset(options: DatasetOptions): Dataset {
  const config = { ...DEFAULT_DATASET, ...options };
  const random = seededRandom(config.seed);
  const samples: LabeledSample[] = [];

  // El reloj arranca a medianoche y avanza `intervalMs` por muestra, de modo que la
  // serie recorra el ciclo diario completo varias veces.
  const startTime = new Date();
  startTime.setHours(0, 0, 0, 0);

  let sensorIndex = 0;
  for (const type of config.types) {
    for (let i = 0; i < config.sensorsPerType; i += 1) {
      const mode = config.modes[sensorIndex % config.modes.length] as AnomalyMode;
      sensorIndex += 1;

      // Un pico dura una sola lectura mientras que una deriva, un atorón o un exceso
      // de ruido duran veinte. Con la misma tasa de arranque, los picos aportarían
      // veinte veces menos muestras anómalas y el árbol apenas los vería. Escalar su
      // tasa por la duración iguala la contribución de los cuatro modos, que es lo
      // que permite comparar la exhaustividad entre ellos de forma honesta.
      const rate =
        mode === "SPIKE"
          ? Math.min(1, config.anomalyRate * DEFAULT_ANOMALY.durationSamples)
          : config.anomalyRate;

      const sensor = new SimulatedSensor(config.location, type, random, {
        ...DEFAULT_ANOMALY,
        mode,
        rate,
      });
      const window = new SensorWindow(config.windowSize);

      const total = config.warmupSamples + config.samplesPerSensor;
      for (let step = 0; step < total; step += 1) {
        const at = new Date(startTime.getTime() + step * config.intervalMs);
        const { reading, label } = sensor.measure(at);
        const features = window.observe(reading);

        if (step < config.warmupSamples) continue;

        samples.push({
          features,
          label: label === "NORMAL" ? 0 : 1,
          anomalyType: label,
          sensorType: type,
        });
      }
    }
  }

  return {
    samples,
    rows: samples.map((s) => toFeatureArray(s.features)),
    labels: samples.map((s) => s.label),
  };
}

/** Reparto de etiquetas, para reportar el desbalance del conjunto. */
export function summarize(dataset: Dataset): {
  total: number;
  positives: number;
  positiveRate: number;
  byType: Record<string, number>;
} {
  const byType: Record<string, number> = {};
  let positives = 0;

  for (const sample of dataset.samples) {
    if (sample.label === 1) {
      positives += 1;
      byType[sample.anomalyType] = (byType[sample.anomalyType] ?? 0) + 1;
    }
  }

  return {
    total: dataset.samples.length,
    positives,
    positiveRate: dataset.samples.length === 0 ? 0 : positives / dataset.samples.length,
    byType,
  };
}
