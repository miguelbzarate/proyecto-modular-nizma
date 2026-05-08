/**
 * Vector de características de una lectura.
 *
 * Éste es el puente entre los dos detectores del proyecto. La banda de control de
 * Welford sólo mira `zScore`; el árbol de decisión de la siguiente fase consume el
 * vector completo. Que ambos partan de la misma extracción es lo que hace justa la
 * comparación entre estrategias: la diferencia de resultados viene del modelo, no de
 * que uno reciba mejores datos.
 *
 * Todos los campos son numéricos porque un árbol CART parte por umbrales sobre
 * valores ordenables. Nada de categorías ni texto.
 */

export interface FeatureVector {
  /** Valor crudo de la lectura. */
  value: number;

  /**
   * Desviaciones estándar respecto de la media de la ventana.
   * Es la característica que usa la banda de control.
   */
  zScore: number;

  /** Diferencia contra la lectura inmediatamente anterior del mismo sensor. */
  delta: number;

  /**
   * Tasa de cambio en unidades por segundo.
   *
   * `delta` por sí solo engaña: un salto de 3 °C es normal en diez minutos y
   * absurdo en un segundo. Normalizar por el tiempo transcurrido separa ambos casos,
   * y es lo que permite distinguir un pico de una deriva lenta.
   */
  rateOfChange: number;

  /**
   * Distancia a la mediana de la ventana, en desviaciones estándar.
   *
   * La mediana no se deja arrastrar por los valores extremos como la media. Cuando ya
   * entraron varias anomalías a la ventana, la media se corre y el `zScore` se vuelve
   * ciego; la desviación contra la mediana aguanta mucho más.
   */
  medianDeviation: number;

  /**
   * Desplazamiento entre la mitad reciente y la mitad antigua de la ventana, medido
   * en desviaciones estándar.
   *
   * Ninguna de las características anteriores ve una deriva lenta: cada punto
   * individual es casi normal y la ventana se corre junto con la desviación, así que
   * el z-score nunca crece. Lo que sí distingue a una deriva es que el movimiento es
   * *sostenido y direccional*, y eso sólo se aprecia comparando dos tramos de la
   * ventana entre sí.
   *
   * Bajo ruido normal las dos mitades tienen la misma media y esta característica
   * oscila alrededor de cero; bajo deriva se separa de forma consistente.
   */
  trend: number;

  /**
   * Hora del día, 0–23 con fracción.
   *
   * Le da al árbol la posibilidad de aprender el ciclo diario: 28 °C a las tres de la
   * tarde es normal y a las cuatro de la mañana no lo es.
   */
  hourOfDay: number;

  /**
   * Muestras que había en la ventana ANTES de esta lectura.
   *
   * Sirve de guardia: con la ventana casi vacía los estadísticos no significan nada y
   * el detector debe abstenerse en lugar de inventar alertas.
   */
  sampleCount: number;

  /** Media de la ventana previa. Se expone para construir los límites de la alerta. */
  mean: number;

  /** Desviación estándar de la ventana previa. */
  stdDev: number;

  /** Mediana de la ventana previa. */
  median: number;
}

/** Orden canónico de las características. El árbol lo usa para nombrar sus cortes. */
export const FEATURE_NAMES = [
  "zScore",
  "delta",
  "rateOfChange",
  "medianDeviation",
  "trend",
  "hourOfDay",
] as const;

export type FeatureName = (typeof FEATURE_NAMES)[number];

/** Proyecta el vector a los campos que el modelo puede partir, en orden fijo. */
export function toFeatureArray(features: FeatureVector): number[] {
  return FEATURE_NAMES.map((name) => features[name]);
}
