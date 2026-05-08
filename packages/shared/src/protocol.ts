/**
 * Protocolo de aplicación sobre TCP.
 *
 * Formato: una línea de texto por mensaje, JSON, terminada en `\n`. Elegido sobre un
 * formato binario porque se puede inspeccionar con `nc localhost 8080` durante la
 * defensa del proyecto, y el costo de parseo es irrelevante a la escala de este sistema.
 *
 * El sobre discrimina con `kind`. La carga útil de una lectura conserva el campo `type`
 * como tipo de medida — son dos cosas distintas y por eso llevan nombres distintos
 * (los documentos originales usaban `type` para ambas, lo que hacía colisionar
 * `{"type":"HEARTBEAT"}` con `{"type":"TEMPERATURA"}`).
 */

import { z } from "zod";
import { LOCATIONS, type Alert, type Location, type Reading } from "./types";
import {
  alertBaseSchema,
  applyReadingRules,
  isoTimestamp,
  readingBaseSchema,
} from "./schemas";

/** Un suscriptor puede pedir zonas geográficas y/o el canal de alertas. */
export const TOPICS = [...LOCATIONS, "ALERTS"] as const;
export type Topic = (typeof TOPICS)[number];
export const topicSchema = z.enum(TOPICS);

export function isZoneTopic(topic: Topic): topic is Location {
  return (LOCATIONS as readonly string[]).includes(topic);
}

export const subscribeSchema = z.object({
  kind: z.literal("SUBSCRIBE"),
  clientId: z.string().min(1).max(64),
  topics: z.array(topicSchema).min(1),
});

export const subackSchema = z.object({
  kind: z.literal("SUBACK"),
  topics: z.array(topicSchema),
});

export const readingMessageSchema = readingBaseSchema.extend({
  kind: z.literal("LECTURA"),
});

export const alertMessageSchema = alertBaseSchema.extend({
  kind: z.literal("ALERTA"),
});

export const heartbeatSchema = z.object({
  kind: z.literal("HEARTBEAT"),
  clientId: z.string().min(1).max(64),
  timestamp: isoTimestamp,
});

export const errorMessageSchema = z.object({
  kind: z.literal("ERROR"),
  message: z.string(),
});

/**
 * Unión discriminada del protocolo. Las reglas semánticas de lectura se aplican en un
 * `superRefine` externo porque `discriminatedUnion` exige miembros `ZodObject` planos.
 */
export const messageSchema = z
  .discriminatedUnion("kind", [
    subscribeSchema,
    subackSchema,
    readingMessageSchema,
    alertMessageSchema,
    heartbeatSchema,
    errorMessageSchema,
  ])
  .superRefine((msg, ctx) => {
    if (msg.kind === "LECTURA") applyReadingRules(msg, ctx);
  });

export type Message = z.infer<typeof messageSchema>;
export type SubscribeMessage = z.infer<typeof subscribeSchema>;
export type ReadingMessage = z.infer<typeof readingMessageSchema>;
export type AlertMessage = z.infer<typeof alertMessageSchema>;
export type HeartbeatMessage = z.infer<typeof heartbeatSchema>;

/** Serializa un mensaje a su representación de cable (incluye el `\n` terminal). */
export function encodeLine(msg: Message): string {
  return `${JSON.stringify(msg)}\n`;
}

export type DecodeResult =
  | { ok: true; message: Message }
  | { ok: false; error: string };

/**
 * Convierte una línea cruda en un mensaje validado.
 *
 * Nunca lanza: un cliente que manda basura no debe poder tumbar al broker. El que
 * llama decide qué hacer con el error (contarlo, registrarlo, cerrar la conexión).
 */
export function decodeLine(line: string): DecodeResult {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return { ok: false, error: "JSON mal formado" };
  }
  const parsed = messageSchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(raíz)"}: ${i.message}`)
      .join("; ");
    return { ok: false, error: detail };
  }
  return { ok: true, message: parsed.data };
}

/** Adapta una `Reading` del dominio al sobre del protocolo. */
export function readingToMessage(reading: Reading): ReadingMessage {
  return { kind: "LECTURA", ...reading };
}

/** Extrae la `Reading` del dominio de su sobre. */
export function messageToReading(msg: ReadingMessage): Reading {
  const { kind: _kind, ...reading } = msg;
  return reading;
}

export function alertToMessage(alert: Alert): AlertMessage {
  return { kind: "ALERTA", ...alert };
}

export function messageToAlert(msg: AlertMessage): Alert {
  const { kind: _kind, ...alert } = msg;
  return alert;
}
