import { describe, expect, it } from "vitest";
import { UNIT_BY_SENSOR_TYPE, VALUE_BOUNDS } from "@monitoreo/shared";
import { DEFAULT_ANOMALY } from "./anomaly";
import { SimulatedSensor, createSensors } from "./sensor";

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

describe("SimulatedSensor", () => {
  it("conserva el mismo sensorId en todas sus lecturas", () => {
    // Ésta es la regresión del bug que bloqueaba el Módulo 2 entero: la versión
    // anterior generaba un UUID nuevo dentro del generador de cada lectura, así que
    // no existía serie temporal por sensor.
    const sensor = new SimulatedSensor("NORTE", "TEMPERATURA", seededRandom(1));
    const ids = new Set(
      Array.from({ length: 100 }, () => sensor.measure().reading.sensorId),
    );
    expect(ids.size).toBe(1);
    expect([...ids][0]).toBe(sensor.sensorId);
  });

  it("cada sensor tiene un identificador distinto", () => {
    const sensors = Array.from(
      { length: 20 },
      () => new SimulatedSensor("NORTE", "TEMPERATURA", seededRandom(1)),
    );
    expect(new Set(sensors.map((s) => s.sensorId)).size).toBe(20);
  });

  it("reporta la unidad que corresponde al tipo de medida", () => {
    for (const type of ["TEMPERATURA", "HUMEDAD", "CALIDAD_AIRE"] as const) {
      const sensor = new SimulatedSensor("SUR", type, seededRandom(3));
      expect(sensor.measure().reading.unit).toBe(UNIT_BY_SENSOR_TYPE[type]);
    }
  });

  it("nunca sale del rango físico que el protocolo acepta", () => {
    // Si se saliera, el broker rechazaría la lectura como basura y el detector jamás
    // la vería. Aplica también con anomalías muy intensas.
    const sensor = new SimulatedSensor("SUR", "TEMPERATURA", seededRandom(9), {
      ...DEFAULT_ANOMALY,
      mode: "SPIKE",
      rate: 1,
      magnitude: 10_000,
    });
    const { min, max } = VALUE_BOUNDS.TEMPERATURA;
    for (let i = 0; i < 500; i += 1) {
      const { value } = sensor.measure().reading;
      expect(value).toBeGreaterThanOrEqual(min);
      expect(value).toBeLessThanOrEqual(max);
    }
  });

  it("sin inyector, todas las lecturas son normales", () => {
    const sensor = new SimulatedSensor("ESTE", "HUMEDAD", seededRandom(4));
    for (let i = 0; i < 200; i += 1) {
      expect(sensor.measure().label).toBe("NORMAL");
    }
  });

  it("con inyector, etiqueta las lecturas corrompidas", () => {
    const sensor = new SimulatedSensor("ESTE", "HUMEDAD", seededRandom(4), {
      ...DEFAULT_ANOMALY,
      mode: "SPIKE",
      rate: 1,
    });
    expect(sensor.measure().label).toBe("SPIKE");
  });

  it("sigue el ciclo diario: más caliente por la tarde que de madrugada", () => {
    const sensor = new SimulatedSensor("NORTE", "TEMPERATURA", seededRandom(2));
    // Se promedian varias muestras para que el ruido no domine la comparación.
    const average = (hour: number): number => {
      const at = new Date();
      at.setHours(hour, 0, 0, 0);
      let total = 0;
      for (let i = 0; i < 200; i += 1) total += sensor.measure(at).reading.value;
      return total / 200;
    };

    expect(average(15)).toBeGreaterThan(average(3));
  });

  it("las zonas tienen distribuciones distintas", () => {
    // Si todas las zonas fueran idénticas no habría forma de notar a simple vista un
    // error de enrutamiento entre shards.
    const average = (location: "NORTE" | "SUR"): number => {
      const sensor = new SimulatedSensor(location, "TEMPERATURA", seededRandom(5));
      const at = new Date();
      at.setHours(12, 0, 0, 0);
      let total = 0;
      for (let i = 0; i < 300; i += 1) total += sensor.measure(at).reading.value;
      return total / 300;
    };

    expect(average("SUR")).toBeGreaterThan(average("NORTE"));
  });

  it("respeta la resolución declarada por tipo", () => {
    const airQuality = new SimulatedSensor("OESTE", "CALIDAD_AIRE", seededRandom(6));
    for (let i = 0; i < 50; i += 1) {
      expect(Number.isInteger(airQuality.measure().reading.value)).toBe(true);
    }
  });
});

describe("createSensors", () => {
  it("crea la cantidad indicada por cada tipo", () => {
    const sensors = createSensors("NORTE", ["TEMPERATURA", "HUMEDAD"], 3);
    expect(sensors).toHaveLength(6);
    expect(sensors.filter((s) => s.type === "TEMPERATURA")).toHaveLength(3);
    expect(sensors.filter((s) => s.type === "HUMEDAD")).toHaveLength(3);
  });

  it("todos quedan en la zona pedida y con identificadores únicos", () => {
    const sensors = createSensors("OESTE", ["TEMPERATURA"], 5);
    expect(sensors.every((s) => s.location === "OESTE")).toBe(true);
    expect(new Set(sensors.map((s) => s.sensorId)).size).toBe(5);
  });

  it("propaga la configuración de anomalías a cada sensor", () => {
    const sensors = createSensors("NORTE", ["TEMPERATURA"], 2, seededRandom(8), {
      ...DEFAULT_ANOMALY,
      mode: "STUCK",
      rate: 1,
    });
    expect(sensors.every((s) => s.measure().label === "STUCK")).toBe(true);
  });
});
