import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Alert, Location, Reading } from "@monitoreo/shared";
import { ShardRepository } from "./shard-repository";

const SENSOR_A = "11111111-1111-4111-8111-111111111111";
const SENSOR_B = "22222222-2222-4222-8222-222222222222";

function reading(overrides: Partial<Reading> = {}): Reading {
  return {
    timestamp: new Date().toISOString(),
    sensorId: SENSOR_A,
    location: "NORTE",
    type: "TEMPERATURA",
    value: 22.5,
    unit: "C",
    ...overrides,
  };
}

function alert(overrides: Partial<Alert> = {}): Alert {
  return {
    alertId: "33333333-3333-4333-8333-333333333333",
    timestamp: new Date().toISOString(),
    location: "NORTE",
    sensorId: SENSOR_A,
    type: "TEMPERATURA",
    value: 45,
    unit: "C",
    detector: "WELFORD",
    severity: "CRITICAL",
    score: 6.2,
    lowerLimit: 15,
    upperLimit: 30,
    message: "Fuera de banda",
    ...overrides,
  };
}

describe("ShardRepository", () => {
  let dir: string;
  let repository: ShardRepository;

  function open(location: Location = "NORTE"): ShardRepository {
    return new ShardRepository(location, { path: join(dir, `${location}.db`) });
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "shard-test-"));
    repository = open();
  });

  afterEach(() => {
    repository.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("crea el esquema y arranca vacío", () => {
    expect(repository.countReadings()).toBe(0);
    expect(repository.countAlerts()).toBe(0);
  });

  it("almacena y cuenta lecturas", () => {
    repository.insert(reading());
    repository.insert(reading({ value: 23.1 }));
    expect(repository.countReadings()).toBe(2);
  });

  it("rechaza una lectura de otra zona", () => {
    // Defensa en profundidad: si el broker enrutara mal, el shard debe explotar en vez
    // de contaminar los datos y romper el particionamiento en silencio.
    expect(() => repository.insert(reading({ location: "SUR" }))).toThrow(
      /no pertenece al shard NORTE/,
    );
    expect(repository.countReadings()).toBe(0);
  });

  it("mantiene una sola zona en el shard", () => {
    repository.insert(reading());
    repository.insert(reading({ sensorId: SENSOR_B }));
    expect(repository.zonesPresent()).toEqual(["NORTE"]);
  });

  it("aísla físicamente los shards en archivos distintos", () => {
    const south = open("SUR");
    south.insert(reading({ location: "SUR" }));

    expect(south.countReadings()).toBe(1);
    expect(repository.countReadings()).toBe(0);
    south.close();
  });

  it("inserta un lote en una transacción", () => {
    repository.insertBatch([reading(), reading(), reading()]);
    expect(repository.countReadings()).toBe(3);
  });

  it("revierte el lote completo si una lectura es de otra zona", () => {
    expect(() =>
      repository.insertBatch([
        reading(),
        reading({ location: "ESTE" }),
        reading(),
      ]),
    ).toThrow();
    // La transacción se deshace: no queda ni la primera, que sí era válida.
    expect(repository.countReadings()).toBe(0);
  });

  it("devuelve las últimas lecturas en orden cronológico ascendente", () => {
    for (let i = 0; i < 5; i += 1) repository.insert(reading({ value: i }));
    expect(repository.latestReadings({ limit: 3 }).map((r) => r.value)).toEqual([
      2, 3, 4,
    ]);
  });

  it("filtra por sensor y por tipo de medida", () => {
    repository.insert(reading({ sensorId: SENSOR_A, value: 1 }));
    repository.insert(reading({ sensorId: SENSOR_B, value: 2 }));
    repository.insert(
      reading({ sensorId: SENSOR_A, type: "HUMEDAD", unit: "%", value: 60 }),
    );

    expect(repository.latestReadings({ sensorId: SENSOR_B })).toHaveLength(1);
    expect(
      repository.latestReadings({ sensorId: SENSOR_A, type: "TEMPERATURA" }),
    ).toHaveLength(1);
    expect(repository.latestReadings({ type: "HUMEDAD" })[0]?.value).toBe(60);
  });

  it("almacena alertas y las devuelve", () => {
    repository.recordAlert(alert());
    expect(repository.countAlerts()).toBe(1);
    expect(repository.latestAlerts()[0]?.message).toBe("Fuera de banda");
  });

  it("ignora una alerta con identificador repetido", () => {
    // El ingestor puede reintentar; la alerta no debe duplicarse.
    repository.recordAlert(alert());
    repository.recordAlert(alert());
    expect(repository.countAlerts()).toBe(1);
  });

  it("una conexión de sólo lectura no puede escribir", () => {
    const readOnly = new ShardRepository("NORTE", {
      path: join(dir, "NORTE.db"),
      readOnly: true,
    });
    expect(() => readOnly.insert(reading())).toThrow();
    expect(readOnly.countReadings()).toBe(0);
    readOnly.close();
  });
});
