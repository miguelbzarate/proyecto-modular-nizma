import { describe, expect, it } from "vitest";
import {
  decodeLine,
  encodeLine,
  messageToReading,
  readingToMessage,
  type ReadingMessage,
} from "./protocol";
import type { Reading } from "./types";

const SENSOR_ID = "11111111-1111-4111-8111-111111111111";

function validReading(overrides: Partial<Reading> = {}): Reading {
  return {
    timestamp: "2026-05-05T12:34:56.789Z",
    sensorId: SENSOR_ID,
    location: "NORTE",
    type: "TEMPERATURA",
    value: 23.5,
    unit: "C",
    ...overrides,
  };
}

function decode(payload: unknown) {
  return decodeLine(JSON.stringify(payload));
}

describe("decodeLine", () => {
  it("acepta una lectura bien formada", () => {
    expect(decode(readingToMessage(validReading())).ok).toBe(true);
  });

  it("rechaza JSON mal formado sin lanzar", () => {
    expect(decodeLine("{esto no es json")).toEqual({
      ok: false,
      error: "JSON mal formado",
    });
  });

  it("rechaza un sobre con `kind` desconocido", () => {
    expect(decode({ kind: "LO_QUE_SEA" }).ok).toBe(false);
  });

  it("rechaza una unidad incoherente con el tipo de medida", () => {
    const result = decode(
      readingToMessage(validReading({ type: "TEMPERATURA", unit: "%" })),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("no corresponde al tipo");
  });

  it("acepta HUMEDAD en '%' y CALIDAD_AIRE en 'PPM'", () => {
    expect(
      decode(
        readingToMessage(validReading({ type: "HUMEDAD", value: 55, unit: "%" })),
      ).ok,
    ).toBe(true);
    expect(
      decode(
        readingToMessage(
          validReading({ type: "CALIDAD_AIRE", value: 420, unit: "PPM" }),
        ),
      ).ok,
    ).toBe(true);
  });

  it("rechaza un valor fuera del rango físico", () => {
    const result = decode(readingToMessage(validReading({ value: 9999 })));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("rango físico");
  });

  it("rechaza un sensorId que no es UUID", () => {
    // El UUID de ejemplo del documento original tenía letras fuera del alfabeto hex.
    const result = decode(
      readingToMessage(
        validReading({ sensorId: "a1b2c3d4-e5f6-7890-g1h2-i3j4k5l6m7n8" }),
      ),
    );
    expect(result.ok).toBe(false);
  });

  it("rechaza una zona geográfica inexistente", () => {
    const result = decode({
      ...readingToMessage(validReading()),
      location: "CENTRO",
    });
    expect(result.ok).toBe(false);
  });

  it("rechaza un timestamp sin zona horaria", () => {
    const result = decode(
      readingToMessage(validReading({ timestamp: "2026-05-05 12:34:56" })),
    );
    expect(result.ok).toBe(false);
  });

  it("acepta SUBSCRIBE y HEARTBEAT", () => {
    expect(
      decode({
        kind: "SUBSCRIBE",
        clientId: "ingestor-NORTE",
        topics: ["NORTE"],
      }).ok,
    ).toBe(true);
    expect(
      decode({
        kind: "HEARTBEAT",
        clientId: "sim-1",
        timestamp: "2026-05-05T12:34:56.789Z",
      }).ok,
    ).toBe(true);
  });

  it("rechaza SUBSCRIBE sin temas", () => {
    expect(decode({ kind: "SUBSCRIBE", clientId: "x", topics: [] }).ok).toBe(
      false,
    );
  });
});

describe("encodeLine", () => {
  it("termina en salto de línea y no lo contiene en medio", () => {
    const line = encodeLine(readingToMessage(validReading()));
    expect(line.endsWith("\n")).toBe(true);
    expect(line.slice(0, -1)).not.toContain("\n");
  });

  it("ida y vuelta sin pérdida", () => {
    const original = validReading();
    const line = encodeLine(readingToMessage(original));
    const result = decodeLine(line.trim());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(messageToReading(result.message as ReadingMessage)).toEqual(original);
    }
  });
});
