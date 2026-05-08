/**
 * Validación en tiempo de ejecución con Zod.
 *
 * Por qué existe esto si ya hay TypeScript: TypeScript desaparece al compilar. Un byte
 * que llega por un socket no tiene tipo. Todo lo que cruza la frontera de la red se
 * valida aquí antes de tocar la lógica de negocio o la base de datos.
 *
 * Las reglas semánticas de una lectura (coherencia unidad/tipo, rango físico) se
 * exponen como funciones sueltas porque se necesitan en dos lugares: sobre el esquema
 * de lectura a secas y dentro del sobre del protocolo. `z.discriminatedUnion` sólo
 * acepta `ZodObject`, así que un `.refine` incrustado impediría construir el sobre.
 */

import { z } from "zod";
import {
  LOCATIONS,
  SENSOR_TYPES,
  UNITS,
  UNIT_BY_SENSOR_TYPE,
  VALUE_BOUNDS,
  type SensorType,
  type Unit,
} from "./types";

export const locationSchema = z.enum(LOCATIONS);
export const sensorTypeSchema = z.enum(SENSOR_TYPES);
export const unitSchema = z.enum(UNITS);

/** ISO 8601; exige el sufijo `Z` o un desfase horario explícito. */
export const isoTimestamp = z.string().datetime({ offset: true });

/** Forma estructural de una lectura, sin reglas semánticas. */
export const readingBaseSchema = z.object({
  timestamp: isoTimestamp,
  sensorId: z.string().uuid(),
  location: locationSchema,
  type: sensorTypeSchema,
  value: z.number().finite(),
  unit: unitSchema,
});

/**
 * La unidad tiene que corresponder al tipo de medida. Éste es el equivalente en tiempo
 * de ejecución de la unión discriminada que proponía el documento original: hace
 * imposible una TEMPERATURA en '%' sin complicar el formato de cable.
 */
export function unitMatchesType(r: {
  type: SensorType;
  unit: Unit;
}): boolean {
  return r.unit === UNIT_BY_SENSOR_TYPE[r.type];
}

/** Rango de cordura: descarta basura de red, no anomalías. */
export function valueWithinPhysicalRange(r: {
  type: SensorType;
  value: number;
}): boolean {
  const { min, max } = VALUE_BOUNDS[r.type];
  return r.value >= min && r.value <= max;
}

/** Aplica ambas reglas semánticas a un objeto ya validado estructuralmente. */
export function applyReadingRules(
  r: { type: SensorType; unit: Unit; value: number },
  ctx: z.RefinementCtx,
): void {
  if (!unitMatchesType(r)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `La unidad '${r.unit}' no corresponde al tipo '${r.type}' (se esperaba '${UNIT_BY_SENSOR_TYPE[r.type]}')`,
      path: ["unit"],
    });
  }
  if (!valueWithinPhysicalRange(r)) {
    const { min, max } = VALUE_BOUNDS[r.type];
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Valor ${r.value} fuera del rango físico de '${r.type}' [${min}, ${max}]`,
      path: ["value"],
    });
  }
}

export const readingSchema = readingBaseSchema.superRefine(applyReadingRules);

export const severitySchema = z.enum(["INFO", "WARNING", "CRITICAL"]);
export const detectorSchema = z.enum(["WELFORD", "DECISION_TREE"]);

export const alertBaseSchema = z.object({
  alertId: z.string().uuid(),
  timestamp: isoTimestamp,
  location: locationSchema,
  sensorId: z.string().uuid(),
  type: sensorTypeSchema,
  value: z.number().finite(),
  unit: unitSchema,
  detector: detectorSchema,
  severity: severitySchema,
  score: z.number().finite(),
  lowerLimit: z.number().finite().nullable(),
  upperLimit: z.number().finite().nullable(),
  message: z.string().min(1),
});

export const alertSchema = alertBaseSchema;
