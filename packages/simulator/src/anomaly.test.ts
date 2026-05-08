import { describe, expect, it } from "vitest";
import { AnomalyInjector, DEFAULT_ANOMALY, type AnomalyConfig } from "./anomaly";

/**
 * Generador congruencial lineal: aleatorio pero reproducible.
 * Las pruebas de un simulador estocástico sólo sirven si son deterministas.
 */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

/** Siempre dispara el episodio (rate = 1 lo garantiza sin depender del azar). */
function config(overrides: Partial<AnomalyConfig> & { mode: AnomalyConfig["mode"] }): AnomalyConfig {
  return { ...DEFAULT_ANOMALY, rate: 1, ...overrides };
}

const NOISE_SCALE = 0.25;

describe("AnomalyInjector", () => {
  it("con probabilidad cero nunca corrompe", () => {
    const injector = new AnomalyInjector(
      config({ mode: "SPIKE", rate: 0 }),
      NOISE_SCALE,
      seededRandom(1),
    );
    for (let i = 0; i < 200; i += 1) {
      const result = injector.apply(20);
      expect(result.label).toBe("NORMAL");
      expect(result.value).toBe(20);
    }
  });

  it("SPIKE dura exactamente una lectura", () => {
    const injector = new AnomalyInjector(
      config({ mode: "SPIKE", rate: 1 }),
      NOISE_SCALE,
      seededRandom(7),
    );
    const first = injector.apply(20);
    expect(first.label).toBe("SPIKE");
    expect(first.value).not.toBe(20);
    // El episodio terminó; que la siguiente también sea pico se debe a rate = 1,
    // no a que el episodio se haya prolongado.
    expect(injector.active).toBe(false);
  });

  it("SPIKE desplaza en proporción a la magnitud", () => {
    const injector = new AnomalyInjector(
      config({ mode: "SPIKE", rate: 1, magnitude: 12 }),
      NOISE_SCALE,
      seededRandom(3),
    );
    const { value } = injector.apply(20);
    expect(Math.abs(value - 20)).toBeCloseTo(NOISE_SCALE * 12, 6);
  });

  it("SPIKE va en ambas direcciones", () => {
    const directions = new Set<string>();
    for (let seed = 1; seed <= 40; seed += 1) {
      const injector = new AnomalyInjector(
        config({ mode: "SPIKE", rate: 1 }),
        NOISE_SCALE,
        seededRandom(seed),
      );
      directions.add(injector.apply(20).value > 20 ? "arriba" : "abajo");
    }
    expect(directions.size).toBe(2);
  });

  it("DRIFT se acumula: empieza casi imperceptible y termina lejos", () => {
    // Ésta es la propiedad que hace que una banda de control no lo vea: los primeros
    // puntos del episodio son indistinguibles de la normalidad.
    const injector = new AnomalyInjector(
      config({ mode: "DRIFT", rate: 1, durationSamples: 20, magnitude: 12 }),
      NOISE_SCALE,
      seededRandom(11),
    );

    const offsets: number[] = [];
    for (let i = 0; i < 20; i += 1) offsets.push(injector.apply(20).value - 20);

    expect(offsets[0]).toBeLessThan(0.2);
    expect(offsets[19]).toBeCloseTo(NOISE_SCALE * 12, 6);
    // Monótonamente creciente.
    for (let i = 1; i < offsets.length; i += 1) {
      expect(offsets[i]!).toBeGreaterThan(offsets[i - 1]!);
    }
  });

  it("DRIFT dura lo configurado", () => {
    const injector = new AnomalyInjector(
      config({ mode: "DRIFT", rate: 0, durationSamples: 5 }),
      NOISE_SCALE,
      // Primera llamada dispara (0 < rate falla con rate 0), así que se fuerza con rate 1
      // sólo en el primer paso mediante una secuencia controlada.
      (() => {
        let calls = 0;
        return () => (calls++ === 0 ? -1 : 1); // -1 < 0 dispara; 1 nunca vuelve a disparar
      })(),
    );
    const labels: string[] = [];
    for (let i = 0; i < 8; i += 1) labels.push(injector.apply(20).label);
    expect(labels.slice(0, 5)).toEqual(["DRIFT", "DRIFT", "DRIFT", "DRIFT", "DRIFT"]);
    expect(labels.slice(5)).toEqual(["NORMAL", "NORMAL", "NORMAL"]);
  });

  it("STUCK congela el valor aunque el sensor real cambie", () => {
    const injector = new AnomalyInjector(
      config({ mode: "STUCK", rate: 1, durationSamples: 5 }),
      NOISE_SCALE,
      seededRandom(5),
    );
    const first = injector.apply(20);
    expect(first.value).toBe(20);
    expect(first.label).toBe("STUCK");

    // El fenómeno físico sigue moviéndose, pero el instrumento reporta lo mismo.
    for (const real of [21, 25, 30, 40]) {
      const result = injector.apply(real);
      expect(result.value).toBe(20);
      expect(result.label).toBe("STUCK");
    }
  });

  it("NOISE conserva la media y dispara la dispersión", () => {
    const injector = new AnomalyInjector(
      config({ mode: "NOISE", rate: 1, durationSamples: 5000, magnitude: 12 }),
      NOISE_SCALE,
      seededRandom(23),
    );
    const values: number[] = [];
    for (let i = 0; i < 5000; i += 1) values.push(injector.apply(20).value);

    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const spread = Math.max(...values) - Math.min(...values);

    expect(mean).toBeCloseTo(20, 1);
    expect(spread).toBeGreaterThan(NOISE_SCALE * 12);
  });

  it("informa si hay un episodio en curso", () => {
    const injector = new AnomalyInjector(
      config({ mode: "STUCK", rate: 1, durationSamples: 3 }),
      NOISE_SCALE,
      seededRandom(2),
    );
    expect(injector.active).toBe(false);
    injector.apply(20);
    expect(injector.active).toBe(true);
    injector.apply(20);
    injector.apply(20);
    expect(injector.active).toBe(false);
  });
});
