/**
 * Detector basado en el árbol de decisión entrenado.
 *
 * Es la segunda estrategia del patrón Strategy, intercambiable con la banda de
 * control sin tocar el ingestor. A diferencia de aquélla, combina las seis
 * características en vez de mirar sólo el z-score, y por eso puede reconocer fallas
 * que la banda es estructuralmente incapaz de ver: un sensor atorado (delta
 * exactamente cero, sostenido) o una deriva lenta (tendencia direccional entre las dos
 * mitades de la ventana).
 *
 * El entrenamiento ocurre fuera de línea, en el paquete `trainer`. Aquí sólo se carga
 * el modelo y se infiere: recorrer un árbol ya construido es una decena de
 * comparaciones, del orden de microsegundos, así que no necesita hilo aparte.
 */

import { readFileSync } from "node:fs";
import type { Reading } from "@monitoreo/shared";
import { DecisionTree, type TreeModel } from "./cart";
import type { AnomalyDetector, Detection } from "./detector";
import { toFeatureArray, type FeatureVector } from "./features";

export interface DecisionTreeDetectorOptions {
  /**
   * Probabilidad mínima de la hoja para emitir una alerta.
   *
   * Subirlo reduce falsas alarmas a costa de exhaustividad. Es la perilla equivalente
   * a la `k` de la banda de control, y permite mover el punto de operación sin
   * reentrenar.
   */
  threshold?: number;
  /** Muestras mínimas en la ventana antes de pronunciarse. */
  minSamples?: number;
  /** Probabilidad a partir de la cual la alerta se marca como crítica. */
  criticalProbability?: number;
}

export const DEFAULT_TREE_THRESHOLD = 0.3;
export const DEFAULT_TREE_MIN_SAMPLES = 20;
export const DEFAULT_CRITICAL_PROBABILITY = 0.85;

export class DecisionTreeDetector implements AnomalyDetector {
  readonly name = "DECISION_TREE" as const;

  private readonly threshold: number;

  private readonly minSamples: number;

  private readonly criticalProbability: number;

  constructor(
    private readonly tree: DecisionTree,
    options: DecisionTreeDetectorOptions = {},
  ) {
    this.threshold = options.threshold ?? DEFAULT_TREE_THRESHOLD;
    this.minSamples = options.minSamples ?? DEFAULT_TREE_MIN_SAMPLES;
    this.criticalProbability =
      options.criticalProbability ?? DEFAULT_CRITICAL_PROBABILITY;

    if (this.threshold <= 0 || this.threshold > 1) {
      throw new Error(
        `El umbral debe estar en (0, 1], se recibió ${this.threshold}`,
      );
    }
  }

  /** Carga un modelo serializado desde disco. */
  static fromFile(
    path: string,
    options: DecisionTreeDetectorOptions = {},
  ): DecisionTreeDetector {
    let model: TreeModel;
    try {
      model = JSON.parse(readFileSync(path, "utf8")) as TreeModel;
    } catch (err) {
      throw new Error(
        `No se pudo leer el modelo en ${path}: ${(err as Error).message}`,
      );
    }
    return new DecisionTreeDetector(DecisionTree.fromModel(model), options);
  }

  get model(): TreeModel {
    return this.tree.model;
  }

  evaluate(features: FeatureVector, reading: Reading): Detection | null {
    // Misma abstención que la banda de control, y por la misma razón: con la ventana
    // casi vacía las características no describen nada. Además mantiene comparables
    // las métricas de ambos detectores, que se miden sobre el mismo subconjunto.
    if (features.sampleCount < this.minSamples) return null;

    const { probability } = this.tree.predict(toFeatureArray(features));
    if (probability < this.threshold) return null;

    const severity =
      probability >= this.criticalProbability ? "CRITICAL" : "WARNING";

    return {
      score: probability,
      severity,
      // El árbol no razona con una banda de control, así que no hay límites que
      // reportar; el tablero los omite cuando vienen nulos.
      lowerLimit: null,
      upperLimit: null,
      message:
        `${reading.type} clasificada como anómala por el árbol de decisión: ` +
        `${reading.value}${reading.unit} (confianza ${(probability * 100).toFixed(0)} %, ` +
        `${describeEvidence(features)})`,
    };
  }
}

/**
 * Resume qué característica delata la anomalía.
 *
 * Un número de confianza a secas no le dice nada a un operador. Nombrar la evidencia
 * dominante convierte la alerta en algo accionable, y de paso hace visible durante la
 * defensa que el modelo es interpretable, que es la razón de haber elegido un árbol.
 */
function describeEvidence(features: FeatureVector): string {
  const candidates: { label: string; magnitude: number }[] = [
    { label: `z=${features.zScore.toFixed(1)}σ`, magnitude: Math.abs(features.zScore) },
    {
      label: `tendencia=${features.trend.toFixed(1)}σ`,
      magnitude: Math.abs(features.trend),
    },
    {
      label: `desv. mediana=${features.medianDeviation.toFixed(1)}σ`,
      magnitude: Math.abs(features.medianDeviation),
    },
  ];

  if (features.delta === 0) return "sensor sin variación";

  const dominant = candidates.reduce((a, b) => (b.magnitude > a.magnitude ? b : a));
  return dominant.label;
}
