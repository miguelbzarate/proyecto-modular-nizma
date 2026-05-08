import { describe, expect, it } from "vitest";
import { renderMetrics, type ProcessMetrics } from "./prometheus";
import type { ZoneSummary } from "./queries";

const PROCESS: ProcessMetrics = {
  eventLoopLagP99Ms: 1.234_56,
  memoryBytes: 52_428_800,
  uptimeSeconds: 123.456,
};

function zone(overrides: Partial<ZoneSummary> = {}): ZoneSummary {
  return {
    location: "NORTE",
    readings: 1000,
    alerts: 12,
    sensors: 6,
    criticalAlerts: 3,
    lastReadingAt: "2026-05-05T12:00:00.000Z",
    online: true,
    ...overrides,
  };
}

describe("renderMetrics", () => {
  it("emite una línea por zona con su etiqueta", () => {
    const text = renderMetrics(
      [zone({ location: "NORTE", readings: 100 }), zone({ location: "SUR", readings: 250 })],
      PROCESS,
      {},
    );

    expect(text).toContain('monitoreo_lecturas_total{zona="NORTE"} 100');
    expect(text).toContain('monitoreo_lecturas_total{zona="SUR"} 250');
  });

  it("declara HELP y TYPE de cada métrica", () => {
    const text = renderMetrics([zone()], PROCESS, {});
    expect(text).toContain("# HELP monitoreo_lecturas_total");
    expect(text).toContain("# TYPE monitoreo_lecturas_total counter");
    expect(text).toContain("# TYPE monitoreo_sensores_activos gauge");
  });

  it("los nombres terminados en _total son contadores y el resto indicadores", () => {
    // Confundirlos rompe las gráficas de tasa del recolector.
    const text = renderMetrics([zone()], PROCESS, { readingsReceived: 5 });
    for (const line of text.split("\n")) {
      const match = /^# TYPE (\S+) (counter|gauge)$/.exec(line);
      if (match === null) continue;
      const [, name, type] = match;
      expect(type).toBe(name!.endsWith("_total") ? "counter" : "gauge");
    }
  });

  it("traduce la disponibilidad del shard a 1 y 0", () => {
    const text = renderMetrics(
      [zone({ location: "NORTE", online: true }), zone({ location: "SUR", online: false })],
      PROCESS,
      {},
    );
    expect(text).toContain('monitoreo_shard_disponible{zona="NORTE"} 1');
    expect(text).toContain('monitoreo_shard_disponible{zona="SUR"} 0');
  });

  it("incluye las métricas del broker cuando están disponibles", () => {
    const text = renderMetrics([zone()], PROCESS, {
      connectedClients: 9,
      readingsReceived: 4200,
      backpressurePauses: 2,
    });
    expect(text).toContain("monitoreo_broker_clientes 9");
    expect(text).toContain("monitoreo_broker_lecturas_recibidas_total 4200");
    expect(text).toContain("monitoreo_broker_contrapresion_total 2");
  });

  it("omite las métricas del broker si el archivo no existe", () => {
    // El tablero debe seguir sirviendo aunque el broker esté apagado.
    const text = renderMetrics([zone()], PROCESS, {});
    expect(text).not.toContain("monitoreo_broker_clientes");
    expect(text).toContain("monitoreo_lecturas_total");
  });

  it("expone el retraso del bucle de eventos y la memoria", () => {
    const text = renderMetrics([zone()], PROCESS, {});
    expect(text).toContain("monitoreo_event_loop_lag_ms 1.235");
    expect(text).toContain("monitoreo_memoria_bytes 52428800");
  });

  it("termina en salto de línea, como exige el formato", () => {
    expect(renderMetrics([zone()], PROCESS, {}).endsWith("\n")).toBe(true);
  });

  it("no produce líneas con valores no numéricos", () => {
    const text = renderMetrics([zone()], PROCESS, { connectedClients: 3 });
    for (const line of text.split("\n")) {
      if (line.startsWith("#") || line.trim() === "") continue;
      const value = line.slice(line.lastIndexOf(" ") + 1);
      expect(Number.isNaN(Number(value))).toBe(false);
    }
  });
});
