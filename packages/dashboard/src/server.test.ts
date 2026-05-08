/**
 * Pruebas del tablero contra un servidor HTTP real y shards reales en disco.
 *
 * Se siembra un shard temporal con lecturas normales y una anómala, para comprobar de
 * punta a punta que el tablero lee de la base y calcula la banda de control igual que
 * el ingestor.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ShardRepository } from "@monitoreo/ingestor";
import type { Alert, Reading } from "@monitoreo/shared";
import { Dashboard } from "./server";

const SENSOR = "11111111-1111-4111-8111-111111111111";
const T0 = Date.parse("2026-05-05T12:00:00.000Z");

const silentLog = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

let dir: string;
let dashboard: Dashboard;
let baseUrl: string;

function reading(value: number, index: number): Reading {
  return {
    timestamp: new Date(T0 + index * 30_000).toISOString(),
    sensorId: SENSOR,
    location: "NORTE",
    type: "TEMPERATURA",
    value,
    unit: "C",
  };
}

function alert(): Alert {
  return {
    alertId: "33333333-3333-4333-8333-333333333333",
    timestamp: new Date(T0 + 60 * 30_000).toISOString(),
    location: "NORTE",
    sensorId: SENSOR,
    type: "TEMPERATURA",
    value: 45,
    unit: "C",
    detector: "WELFORD",
    severity: "CRITICAL",
    score: 9.1,
    lowerLimit: 20,
    upperLimit: 24,
    message: "Temperatura fuera de la banda de control",
  };
}

async function get(path: string): Promise<{ status: number; body: string }> {
  const response = await fetch(`${baseUrl}${path}`);
  return { status: response.status, body: await response.text() };
}

async function getJson<T>(path: string): Promise<T> {
  const { body } = await get(path);
  return JSON.parse(body) as T;
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "tablero-"));
  process.env.SHARDS_DIR = dir;
  process.env.DATA_DIR = dir;

  const repository = new ShardRepository("NORTE");
  // Serie estable con una anomalía clara al final.
  const readings: Reading[] = [];
  for (let i = 0; i < 60; i += 1) {
    readings.push(reading(22 + Math.sin(i / 3) * 0.4, i));
  }
  readings.push(reading(45, 60));
  repository.insertBatch(readings);
  repository.recordAlert(alert());
  repository.close();

  dashboard = new Dashboard({ port: 0, host: "127.0.0.1", logger: silentLog });
  const port = await dashboard.listen();
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await dashboard.close();
  rmSync(dir, { recursive: true, force: true });
  delete process.env.SHARDS_DIR;
  delete process.env.DATA_DIR;
});

describe("Tablero: página", () => {
  it("sirve la página en la raíz", async () => {
    const { status, body } = await get("/");
    expect(status).toBe(200);
    expect(body).toContain("Sistema de Monitoreo Ambiental IoT");
  });

  it("la página no depende de ninguna red externa", async () => {
    // Si el día de la defensa no hay internet, el tablero debe verse igual.
    const { body } = await get("/");
    expect(body).not.toMatch(/src\s*=\s*["']https?:/i);
    expect(body).not.toMatch(/href\s*=\s*["']https?:/i);
    expect(body).not.toContain("cdn");
  });
});

describe("Tablero: API", () => {
  it("el resumen reporta las cuatro zonas", async () => {
    const data = await getJson<{ zones: { location: string; readings: number }[] }>(
      "/api/resumen",
    );
    expect(data.zones).toHaveLength(4);
    expect(data.zones.find((z) => z.location === "NORTE")?.readings).toBe(61);
  });

  it("una zona sin shard se reporta como no disponible, sin fallar", async () => {
    const data = await getJson<{ zones: { location: string; online: boolean }[] }>(
      "/api/resumen",
    );
    expect(data.zones.find((z) => z.location === "SUR")?.online).toBe(false);
  });

  it("el resumen incluye las alertas recientes", async () => {
    const data = await getJson<{ alerts: { severity: string }[] }>("/api/resumen");
    expect(data.alerts).toHaveLength(1);
    expect(data.alerts[0]?.severity).toBe("CRITICAL");
  });

  it("la serie trae los puntos con su banda de control", async () => {
    const data = await getJson<{
      points: { value: number; upper: number | null; outside: boolean }[];
      unit: string;
    }>("/api/serie?zona=NORTE&tipo=TEMPERATURA");

    expect(data.unit).toBe("C");
    expect(data.points.length).toBeGreaterThan(50);

    // Los primeros puntos son de calentamiento: aún no hay banda.
    expect(data.points[0]?.upper).toBeNull();
    // Los tardíos sí la tienen.
    expect(data.points[data.points.length - 1]?.upper).not.toBeNull();
  });

  it("marca como fuera de banda el punto anómalo", async () => {
    const data = await getJson<{ points: { value: number; outside: boolean }[] }>(
      "/api/serie?zona=NORTE&tipo=TEMPERATURA",
    );
    const spike = data.points.find((p) => p.value === 45);
    expect(spike?.outside).toBe(true);
    expect(data.points.filter((p) => p.outside)).toHaveLength(1);
  });

  it("lista los sensores de una zona", async () => {
    const data = await getJson<{ sensors: { sensorId: string }[] }>(
      "/api/sensores?zona=NORTE",
    );
    expect(data.sensors).toHaveLength(1);
    expect(data.sensors[0]?.sensorId).toBe(SENSOR);
  });
});

describe("Tablero: validación de parámetros", () => {
  it("rechaza una zona inexistente con 400", async () => {
    const { status, body } = await get("/api/serie?zona=CENTRO&tipo=TEMPERATURA");
    expect(status).toBe(400);
    expect(body).toContain("zona");
  });

  it("rechaza un tipo de medida inexistente con 400", async () => {
    const { status } = await get("/api/serie?zona=NORTE&tipo=PRESION");
    expect(status).toBe(400);
  });

  it("rechaza un límite fuera de rango con 400", async () => {
    expect((await get("/api/serie?zona=NORTE&tipo=TEMPERATURA&limite=0")).status).toBe(400);
    expect((await get("/api/serie?zona=NORTE&tipo=TEMPERATURA&limite=99999")).status).toBe(400);
    expect((await get("/api/serie?zona=NORTE&tipo=TEMPERATURA&limite=abc")).status).toBe(400);
  });

  it("acepta la zona en minúsculas", async () => {
    expect((await get("/api/serie?zona=norte&tipo=temperatura")).status).toBe(200);
  });

  it("responde 404 en una ruta desconocida", async () => {
    expect((await get("/no-existe")).status).toBe(404);
  });

  it("rechaza métodos distintos de GET", async () => {
    const response = await fetch(`${baseUrl}/api/resumen`, { method: "POST" });
    expect(response.status).toBe(405);
  });
});

describe("Tablero: métricas", () => {
  it("expone /metrics en formato de texto de Prometheus", async () => {
    const response = await fetch(`${baseUrl}/metrics`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain");

    const body = await response.text();
    expect(body).toContain('monitoreo_lecturas_total{zona="NORTE"} 61');
    expect(body).toContain("monitoreo_event_loop_lag_ms");
  });

  it("el endpoint de salud responde sin tocar disco", async () => {
    const data = await getJson<{ ok: boolean; uptimeSeconds: number }>("/salud");
    expect(data.ok).toBe(true);
    expect(data.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });
});

describe("Tablero: sólo lectura", () => {
  it("no modifica el shard al consultarlo", async () => {
    const before = new ShardRepository("NORTE", { readOnly: true });
    const countBefore = before.countReadings();
    before.close();

    await get("/api/resumen");
    await get("/api/serie?zona=NORTE&tipo=TEMPERATURA");
    await get("/metrics");

    const after = new ShardRepository("NORTE", { readOnly: true });
    expect(after.countReadings()).toBe(countBefore);
    after.close();
  });
});
