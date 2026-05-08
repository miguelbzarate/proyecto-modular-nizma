import { describe, expect, it } from "vitest";
import type { Reading } from "@monitoreo/shared";
import { SensorWindow, WindowRegistry } from "./sliding-window";

const SENSOR_A = "11111111-1111-4111-8111-111111111111";
const SENSOR_B = "22222222-2222-4222-8222-222222222222";
const BASE_TIME = Date.parse("2026-05-05T12:00:00.000Z");

function reading(
  value: number,
  secondsOffset = 0,
  overrides: Partial<Reading> = {},
): Reading {
  return {
    timestamp: new Date(BASE_TIME + secondsOffset * 1000).toISOString(),
    sensorId: SENSOR_A,
    location: "NORTE",
    type: "TEMPERATURA",
    value,
    unit: "C",
    ...overrides,
  };
}

describe("SensorWindow", () => {
  it("la primera lectura no tiene historial contra el cual compararse", () => {
    const window = new SensorWindow(10);
    const features = window.observe(reading(22));

    expect(features.sampleCount).toBe(0);
    expect(features.zScore).toBe(0);
    expect(features.delta).toBe(0);
    expect(features.rateOfChange).toBe(0);
    expect(features.value).toBe(22);
  });

  it("calcula las características contra el pasado, no incluyéndose a sí misma", () => {
    // Éste es el punto de diseño central: si el valor entrara antes de calcular, se
    // metería en su propia media y su z-score saldría artificialmente pequeño.
    const window = new SensorWindow(10);
    for (let i = 0; i < 5; i += 1) window.observe(reading(20, i));

    const features = window.observe(reading(30, 5));

    // La ventana previa era constante en 20, así que la media previa es exactamente 20.
    expect(features.mean).toBe(20);
    expect(features.sampleCount).toBe(5);
    // Si se hubiera incluido a sí misma, la media habría sido 21.67.
    expect(features.value).toBe(30);
  });

  it("delta y tasa de cambio se miden contra la lectura anterior", () => {
    const window = new SensorWindow(10);
    window.observe(reading(20, 0));
    const features = window.observe(reading(26, 3)); // +6 °C en 3 s

    expect(features.delta).toBe(6);
    expect(features.rateOfChange).toBeCloseTo(2, 10);
  });

  it("dos lecturas con el mismo sello de tiempo no producen tasa infinita", () => {
    const window = new SensorWindow(10);
    window.observe(reading(20, 0));
    const features = window.observe(reading(25, 0));

    expect(features.delta).toBe(5);
    expect(features.rateOfChange).toBe(0);
    expect(Number.isFinite(features.rateOfChange)).toBe(true);
  });

  it("un sensor atorado no produce z-score infinito", () => {
    // Sin el piso de desviación estándar, σ = 0 haría explotar la división.
    const window = new SensorWindow(10);
    for (let i = 0; i < 8; i += 1) window.observe(reading(20, i));
    const features = window.observe(reading(20, 8));

    expect(Number.isFinite(features.zScore)).toBe(true);
    expect(features.stdDev).toBe(0);
    expect(features.zScore).toBe(0);
  });

  it("el z-score crece con la desviación", () => {
    const window = new SensorWindow(50);
    // Serie alterna alrededor de 20 para que σ no sea cero.
    for (let i = 0; i < 30; i += 1) window.observe(reading(i % 2 === 0 ? 19 : 21, i));

    const normal = new SensorWindow(50);
    for (let i = 0; i < 30; i += 1) normal.observe(reading(i % 2 === 0 ? 19 : 21, i));

    const spike = window.observe(reading(40, 30));
    const calm = normal.observe(reading(20, 30));

    expect(Math.abs(spike.zScore)).toBeGreaterThan(Math.abs(calm.zScore));
    expect(Math.abs(spike.zScore)).toBeGreaterThan(10);
  });

  it("la desviación contra la mediana resiste valores extremos ya ingeridos", () => {
    const window = new SensorWindow(50);
    for (let i = 0; i < 20; i += 1) window.observe(reading(20 + (i % 2), i));
    // Entran tres picos que contaminan la media.
    for (let i = 0; i < 3; i += 1) window.observe(reading(200, 20 + i));

    const features = window.observe(reading(20, 25));
    // La mediana sigue cerca de 20; la media está muy por encima.
    expect(features.median).toBeLessThan(30);
    expect(features.mean).toBeGreaterThan(features.median);
  });

  it("la ventana desliza y olvida lo viejo", () => {
    const window = new SensorWindow(5);
    for (let i = 0; i < 5; i += 1) window.observe(reading(100, i));
    for (let i = 5; i < 10; i += 1) window.observe(reading(50, i));

    const features = window.observe(reading(50, 10));
    // Las cinco lecturas de 100 ya salieron: la media debe ser exactamente 50.
    expect(features.sampleCount).toBe(5);
    expect(features.mean).toBeCloseTo(50, 9);
  });

  it("extrae la hora del día", () => {
    const window = new SensorWindow(5);
    const features = window.observe(reading(20));
    const expected = new Date(BASE_TIME).getHours() + new Date(BASE_TIME).getMinutes() / 60;
    expect(features.hourOfDay).toBeCloseTo(expected, 6);
  });

  it("reset vacía el historial", () => {
    const window = new SensorWindow(5);
    for (let i = 0; i < 5; i += 1) window.observe(reading(20, i));
    window.reset();
    expect(window.size).toBe(0);
    expect(window.observe(reading(20, 5)).sampleCount).toBe(0);
  });
});

describe("WindowRegistry", () => {
  it("mantiene una ventana por sensor", () => {
    const registry = new WindowRegistry(10);
    registry.observe(reading(20, 0, { sensorId: SENSOR_A }));
    registry.observe(reading(500, 0, { sensorId: SENSOR_B }));

    expect(registry.size).toBe(2);
    // Cada sensor conserva su propia media: la del A no se contamina con la del B.
    const features = registry.observe(reading(21, 1, { sensorId: SENSOR_A }));
    expect(features.mean).toBe(20);
  });

  it("separa las series de un mismo sensor por tipo de medida", () => {
    // Un dispositivo puede reportar temperatura y humedad; promediarlas juntas daría
    // una media sin significado físico.
    const registry = new WindowRegistry(10);
    registry.observe(reading(22, 0, { type: "TEMPERATURA", unit: "C" }));
    registry.observe(reading(60, 0, { type: "HUMEDAD", unit: "%" }));

    expect(registry.size).toBe(2);
    const features = registry.observe(reading(23, 1, { type: "TEMPERATURA", unit: "C" }));
    expect(features.mean).toBe(22);
  });

  it("clear elimina todas las ventanas", () => {
    const registry = new WindowRegistry(10);
    registry.observe(reading(20));
    registry.clear();
    expect(registry.size).toBe(0);
  });
});
