/**
 * Sensor simulado (patrón Factory Method).
 *
 * El generador anterior producía `Math.random() * 10 + 15`: ruido blanco uniforme sin
 * estructura temporal. Sobre eso ningún detector de anomalías tiene nada que aprender,
 * porque no hay patrón normal del cual desviarse.
 *
 * Éste produce una serie con la forma que tiene una variable ambiental real:
 *
 *   valor(t) = base_zona + ciclo_diario(t) + deriva_lenta(t) + ruido_gaussiano
 *
 * - `ciclo_diario` es la estacionalidad que la propuesta menciona como razón para
 *   elegir el algoritmo: una senoide con máximo por la tarde.
 * - `deriva_lenta` es un paseo aleatorio con reversión a la media, que simula el clima
 *   cambiando durante horas sin volverse inestable.
 * - `ruido_gaussiano` es el error de medición del sensor.
 */

import { randomUUID } from "node:crypto";
import {
  UNIT_BY_SENSOR_TYPE,
  VALUE_BOUNDS,
  type Location,
  type Reading,
  type SensorType,
} from "@monitoreo/shared";
import {
  AnomalyInjector,
  type AnomalyConfig,
  type AnomalyLabel,
} from "./anomaly";

/**
 * Lectura más su verdad de terreno.
 *
 * La etiqueta se devuelve por separado y jamás entra en el objeto `Reading`, que es lo
 * único que viaja por el cable. El detector no puede verla ni por accidente.
 */
export interface SensorSample {
  reading: Reading;
  label: AnomalyLabel;
}

interface SensorProfile {
  /** Valor típico alrededor del cual oscila la medida. */
  base: number;
  /** Amplitud del ciclo de 24 horas. */
  dailyAmplitude: number;
  /** Desviación estándar del ruido de medición. */
  noise: number;
  /** Magnitud del paso de la deriva lenta. */
  driftStep: number;
  /** Cuántos decimales reporta el sensor. */
  decimals: number;
}

const PROFILES: Readonly<Record<SensorType, SensorProfile>> = {
  TEMPERATURA: {
    base: 22,
    dailyAmplitude: 5,
    noise: 0.25,
    driftStep: 0.05,
    decimals: 2,
  },
  HUMEDAD: {
    base: 55,
    dailyAmplitude: 10,
    noise: 1.2,
    driftStep: 0.2,
    decimals: 1,
  },
  CALIDAD_AIRE: {
    base: 450,
    dailyAmplitude: 90,
    noise: 12,
    driftStep: 2.5,
    decimals: 0,
  },
};

/**
 * Desplazamiento por zona, como fracción de la amplitud diaria. Le da a cada shard una
 * distribución propia, que es lo que hace observable el particionamiento: si todas las
 * zonas fueran idénticas, no habría forma de notar un error de enrutamiento.
 */
const ZONE_BIAS: Readonly<Record<Location, number>> = {
  NORTE: -0.6,
  SUR: 0.7,
  ESTE: 0.15,
  OESTE: -0.2,
};

/** Normal estándar por el método de Box-Muller. */
function standardNormal(random: () => number): number {
  let u = 0;
  while (u === 0) u = random(); // log(0) es -Infinity
  const v = random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

export class SimulatedSensor {
  /**
   * Generado UNA sola vez, en el constructor.
   *
   * La versión anterior llamaba a `randomUUID()` dentro de la función que generaba
   * cada lectura, así que cada muestra parecía venir de un sensor distinto. Sin un
   * identificador estable no existe serie temporal por sensor, y sin serie temporal no
   * hay ventana deslizante ni detección de anomalías posible. Este renglón es la
   * precondición de todo el Módulo 2.
   */
  readonly sensorId: string = randomUUID();

  private readonly profile: SensorProfile;

  private readonly injector: AnomalyInjector | null;

  private drift = 0;

  constructor(
    readonly location: Location,
    readonly type: SensorType,
    private readonly random: () => number = Math.random,
    anomaly: AnomalyConfig | null = null,
  ) {
    this.profile = PROFILES[type];
    this.injector =
      anomaly === null
        ? null
        : new AnomalyInjector(anomaly, this.profile.noise, random);
  }

  /** Genera la lectura correspondiente al instante dado, con su verdad de terreno. */
  measure(now: Date = new Date()): SensorSample {
    const { base, dailyAmplitude, noise, driftStep, decimals } = this.profile;

    // Fracción del día transcurrida, desfasada para que el máximo caiga hacia las 15 h.
    const dayFraction =
      (now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds()) / 86_400;
    const cycle = dailyAmplitude * Math.sin(2 * Math.PI * (dayFraction - 0.25));

    // Reversión a la media: sin el factor 0.98 la deriva se alejaría sin límite.
    this.drift = this.drift * 0.98 + standardNormal(this.random) * driftStep;

    const bias = ZONE_BIAS[this.location] * dailyAmplitude;
    const clean =
      base + bias + cycle + this.drift + standardNormal(this.random) * noise;

    // La falla del instrumento se aplica sobre el valor físico ya calculado.
    const corrupted = this.injector?.apply(clean) ?? {
      value: clean,
      label: "NORMAL" as const,
    };

    // El acotado va al final: un pico jamás debe salirse del rango que el protocolo
    // acepta, o el broker lo rechazaría como basura antes de que el detector lo vea.
    const { min, max } = VALUE_BOUNDS[this.type];
    const clamped = Math.min(max, Math.max(min, corrupted.value));

    return {
      reading: {
        timestamp: now.toISOString(),
        sensorId: this.sensorId,
        location: this.location,
        type: this.type,
        value: round(clamped, decimals),
        unit: UNIT_BY_SENSOR_TYPE[this.type],
      },
      label: corrupted.label,
    };
  }
}

/**
 * Crea el conjunto de sensores de una zona.
 *
 * `count` es el número de sensores *por tipo de medida*, de modo que una zona con
 * `count = 2` tiene dos de temperatura, dos de humedad y dos de calidad del aire.
 */
export function createSensors(
  location: Location,
  types: readonly SensorType[],
  count: number,
  random: () => number = Math.random,
  anomaly: AnomalyConfig | null = null,
): SimulatedSensor[] {
  const sensors: SimulatedSensor[] = [];
  for (const type of types) {
    for (let i = 0; i < count; i += 1) {
      sensors.push(new SimulatedSensor(location, type, random, anomaly));
    }
  }
  return sensors;
}
