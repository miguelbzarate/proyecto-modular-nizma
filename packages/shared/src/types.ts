/**
 * Tipos del dominio. Fuente única de verdad para todos los paquetes.
 *
 * Nota de diseño sobre el protocolo de cable: los documentos originales proponían
 * uniones discriminadas anidadas (`value: { __type: 'TEMPERATURA', value: Celsius }`)
 * pero la demo escrita mostraba JSON plano. Se resolvió a favor del JSON plano en el
 * cable — es lo que un operador ve con `nc` y lo que se puede depurar a ojo — y la
 * garantía de "estados imposibles" (temperatura medida en %) se impone en tiempo de
 * ejecución con Zod, en `schemas.ts`.
 *
 * Los nombres de zonas y tipos de medida se conservan en español porque son datos del
 * dominio: aparecen en el tablero, en las alertas y en la propuesta entregada al
 * comité. El código que los manipula sí está en inglés.
 */

export const LOCATIONS = ["NORTE", "SUR", "ESTE", "OESTE"] as const;
export type Location = (typeof LOCATIONS)[number];

export const SENSOR_TYPES = [
  "TEMPERATURA",
  "HUMEDAD",
  "CALIDAD_AIRE",
] as const;
export type SensorType = (typeof SENSOR_TYPES)[number];

export const UNITS = ["C", "%", "PPM"] as const;
export type Unit = (typeof UNITS)[number];

/** Unidad obligatoria para cada tipo de medida. Impide `TEMPERATURA` en `%`. */
export const UNIT_BY_SENSOR_TYPE: Readonly<Record<SensorType, Unit>> = {
  TEMPERATURA: "C",
  HUMEDAD: "%",
  CALIDAD_AIRE: "PPM",
};

/**
 * Rangos de cordura del protocolo — NO son umbrales de anomalía.
 * Sirven para descartar basura de red (un `value` de 1e9, un NaN serializado).
 * La detección de anomalías trabaja *dentro* de estos rangos.
 */
export const VALUE_BOUNDS: Readonly<
  Record<SensorType, { min: number; max: number }>
> = {
  TEMPERATURA: { min: -50, max: 80 },
  HUMEDAD: { min: 0, max: 100 },
  CALIDAD_AIRE: { min: 0, max: 10000 },
};

/**
 * Resolución del instrumento: el escalón más pequeño que cada sensor puede reportar.
 *
 * Una desviación estándar por debajo de este valor no tiene significado físico, porque
 * el sensor no puede distinguir diferencias tan finas. Sirve de piso para que un
 * detector estadístico no calcule bandas de anchura cero.
 */
export const VALUE_RESOLUTION: Readonly<Record<SensorType, number>> = {
  TEMPERATURA: 0.01,
  HUMEDAD: 0.1,
  CALIDAD_AIRE: 1,
};

export interface Reading {
  /** ISO 8601 con milisegundos. */
  timestamp: string;
  /** UUID v4. Estable durante toda la vida del proceso sensor. */
  sensorId: string;
  location: Location;
  /** Tipo de medida. En el sobre del protocolo el discriminador es `kind`, no éste. */
  type: SensorType;
  value: number;
  unit: Unit;
}

export type Severity = "INFO" | "WARNING" | "CRITICAL";

/** Qué estrategia levantó la alerta. Permite comparar detectores lado a lado. */
export type Detector = "WELFORD" | "DECISION_TREE";

export interface Alert {
  alertId: string;
  timestamp: string;
  location: Location;
  sensorId: string;
  type: SensorType;
  value: number;
  unit: Unit;
  detector: Detector;
  severity: Severity;
  /** Puntaje del detector: z-score para Welford, confianza de la hoja para el árbol. */
  score: number;
  lowerLimit: number | null;
  upperLimit: number | null;
  /** Texto legible para el operador. Se redacta en español. */
  message: string;
}
