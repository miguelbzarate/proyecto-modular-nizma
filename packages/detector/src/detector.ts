/**
 * Contrato de un detector de anomalías (patrón Strategy).
 *
 * La propuesta declara el patrón Strategy para poder intercambiar el algoritmo. Aquí
 * ese patrón no es decorativo: en la Fase D entra un segundo detector —un árbol de
 * decisión— y ambos se evalúan sobre exactamente el mismo flujo de características
 * para poder comparar precisión y recall. Sin una interfaz común, esa comparación
 * exigiría duplicar la tubería de ingesta.
 */

import { randomUUID } from "node:crypto";
import type { Alert, Detector, Reading, Severity } from "@monitoreo/shared";
import type { FeatureVector } from "./features";

/** Veredicto del detector cuando considera anómala una lectura. */
export interface Detection {
  /** Magnitud de la anomalía; su escala depende del detector. */
  score: number;
  severity: Severity;
  lowerLimit: number | null;
  upperLimit: number | null;
  /** Explicación en español, destinada al operador. */
  message: string;
}

export interface AnomalyDetector {
  /** Identifica al detector en la alerta, para poder comparar estrategias. */
  readonly name: Detector;

  /**
   * Evalúa una lectura ya caracterizada.
   *
   * @returns la detección, o `null` si la lectura es normal o si el detector no
   * tiene todavía historial suficiente para pronunciarse.
   */
  evaluate(features: FeatureVector, reading: Reading): Detection | null;
}

/** Arma la alerta que viaja por el protocolo a partir de un veredicto. */
export function buildAlert(
  reading: Reading,
  detection: Detection,
  detector: Detector,
): Alert {
  return {
    alertId: randomUUID(),
    timestamp: reading.timestamp,
    location: reading.location,
    sensorId: reading.sensorId,
    type: reading.type,
    value: reading.value,
    unit: reading.unit,
    detector,
    severity: detection.severity,
    score: detection.score,
    lowerLimit: detection.lowerLimit,
    upperLimit: detection.upperLimit,
    message: detection.message,
  };
}
