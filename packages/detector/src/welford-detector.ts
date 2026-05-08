/**
 * Detector por banda de control (Welford).
 *
 * Modelo: una lectura es anómala si cae fuera de `μ ± k·σ`, con μ y σ estimadas sobre
 * la ventana deslizante del propio sensor. Es la carta de control de Shewhart, el
 * método clásico del control estadístico de procesos.
 *
 * Con k = 3 y bajo normalidad, la banda cubre el 99.73 % de las observaciones: se
 * espera aproximadamente una falsa alarma cada 370 lecturas. Ese número es el que
 * gobierna el compromiso entre sensibilidad y ruido, y se puede subir o bajar por
 * configuración.
 *
 * LIMITACIÓN CONOCIDA, y es deliberado dejarla a la vista:
 *
 * Este detector mira una sola característica, el z-score, así que sólo ve anomalías
 * de tipo pico. Es estructuralmente incapaz de detectar:
 *
 *   - Un sensor atorado, que repite el mismo valor. Su σ tiende a cero, la lectura
 *     coincide con la media y el z-score da cero: parece el sensor más sano del
 *     sistema.
 *   - Una deriva lenta. La ventana se va desplazando con ella y adopta el valor
 *     desviado como la nueva normalidad.
 *
 * Ésa es exactamente la razón de ser del árbol de decisión de la Fase D, que combina
 * cinco características en vez de una. La comparación entre ambos sobre los mismos
 * datos es la evidencia que pide el criterio 2.3.
 */

import { VALUE_RESOLUTION, type Reading } from "@monitoreo/shared";
import type { AnomalyDetector, Detection } from "./detector";
import type { FeatureVector } from "./features";

export interface WelfordDetectorOptions {
  /** Anchura de la banda en desviaciones estándar. */
  k?: number;
  /** Muestras mínimas en la ventana antes de emitir un veredicto. */
  minSamples?: number;
  /** Múltiplo de `k` a partir del cual la alerta se considera crítica. */
  criticalFactor?: number;
}

export const DEFAULT_K = 3;
export const DEFAULT_MIN_SAMPLES = 20;
export const DEFAULT_CRITICAL_FACTOR = 1.5;

export class WelfordDetector implements AnomalyDetector {
  readonly name = "WELFORD" as const;

  private readonly k: number;

  private readonly minSamples: number;

  private readonly criticalFactor: number;

  constructor(options: WelfordDetectorOptions = {}) {
    this.k = options.k ?? DEFAULT_K;
    this.minSamples = options.minSamples ?? DEFAULT_MIN_SAMPLES;
    this.criticalFactor = options.criticalFactor ?? DEFAULT_CRITICAL_FACTOR;

    if (this.k <= 0) throw new Error(`k debe ser positivo, se recibió ${this.k}`);
    if (this.minSamples < 2) {
      throw new Error(
        `minSamples debe ser al menos 2, se recibió ${this.minSamples}`,
      );
    }
  }

  evaluate(features: FeatureVector, reading: Reading): Detection | null {
    // Abstención durante el calentamiento. Con cinco muestras, la desviación estándar
    // es tan inestable que casi cualquier lectura cae fuera de la banda; emitir
    // alertas ahí sólo produciría ruido al arrancar el sistema.
    if (features.sampleCount < this.minSamples) return null;

    // Una ventana sin dispersión real da una banda de anchura cero, y contra una banda
    // de anchura cero cualquier lectura queda "infinitamente" fuera.
    //
    // No basta con exigir σ > 0: tras un sensor congelado, Welford no deja σ exactamente
    // en cero sino en un residuo de coma flotante del orden de 1e-15. Ese residuo pasaba
    // la guarda y producía alertas absurdas de decenas de miles de sigmas sobre bandas
    // como [15.68, 15.68].
    //
    // El piso correcto es físico, no numérico: si la dispersión de la ventana es menor
    // que lo que el instrumento puede resolver, no hay información ahí y el detector se
    // abstiene. Detectar un sensor congelado le toca al árbol, que sí mira si el valor
    // cambia entre lecturas.
    if (features.stdDev < VALUE_RESOLUTION[reading.type]) return null;

    const halfWidth = this.k * features.stdDev;
    const lowerLimit = features.mean - halfWidth;
    const upperLimit = features.mean + halfWidth;

    if (reading.value >= lowerLimit && reading.value <= upperLimit) return null;

    const magnitude = Math.abs(features.zScore);
    const severity =
      magnitude >= this.k * this.criticalFactor ? "CRITICAL" : "WARNING";
    const direction = reading.value > upperLimit ? "por encima" : "por debajo";

    return {
      score: magnitude,
      severity,
      lowerLimit,
      upperLimit,
      message:
        `${reading.type} ${direction} de la banda de control: ` +
        `${reading.value}${reading.unit} fuera de [${lowerLimit.toFixed(2)}, ${upperLimit.toFixed(2)}] ` +
        `(${magnitude.toFixed(1)}σ sobre ${features.sampleCount} muestras)`,
    };
  }
}
