import { describe, expect, it } from "vitest";
import type { Reading } from "@monitoreo/shared";
import { buildAlert } from "./detector";
import { SensorWindow } from "./sliding-window";
import { WelfordDetector } from "./welford-detector";

const SENSOR = "11111111-1111-4111-8111-111111111111";
const BASE_TIME = Date.parse("2026-05-05T12:00:00.000Z");

function reading(value: number, secondsOffset = 0): Reading {
  return {
    timestamp: new Date(BASE_TIME + secondsOffset * 1000).toISOString(),
    sensorId: SENSOR,
    location: "NORTE",
    type: "TEMPERATURA",
    value,
    unit: "C",
  };
}

/** Alimenta una serie normal y devuelve el veredicto sobre la última lectura. */
function runSeries(
  values: readonly number[],
  detector = new WelfordDetector(),
  window = new SensorWindow(50),
) {
  let last = null;
  values.forEach((value, i) => {
    const r = reading(value, i);
    last = detector.evaluate(window.observe(r), r);
  });
  return last;
}

/** Serie ruidosa pero estable alrededor de 22 °C, determinista. */
function calmSeries(n: number): number[] {
  return Array.from({ length: n }, (_, i) => 22 + Math.sin(i / 3) * 0.5);
}

describe("WelfordDetector", () => {
  it("rechaza una configuración inválida", () => {
    expect(() => new WelfordDetector({ k: 0 })).toThrow();
    expect(() => new WelfordDetector({ k: -1 })).toThrow();
    expect(() => new WelfordDetector({ minSamples: 1 })).toThrow();
  });

  it("se abstiene durante el calentamiento", () => {
    const detector = new WelfordDetector({ minSamples: 20 });
    const window = new SensorWindow(50);

    // Aunque la lectura 6 sea absurda, con cinco muestras previas los estadísticos no
    // significan nada y emitir una alerta sería ruido.
    const values = [22, 22, 22, 22, 22, 500];
    let verdict = null;
    values.forEach((value, i) => {
      const r = reading(value, i);
      verdict = detector.evaluate(window.observe(r), r);
    });
    expect(verdict).toBeNull();
  });

  it("no alerta sobre una serie normal", () => {
    expect(runSeries(calmSeries(60))).toBeNull();
  });

  it("detecta un pico por encima de la banda", () => {
    const detector = new WelfordDetector();
    const window = new SensorWindow(50);
    const series = calmSeries(40);
    series.forEach((value, i) => {
      const r = reading(value, i);
      detector.evaluate(window.observe(r), r);
    });

    const spike = reading(45, 40);
    const verdict = detector.evaluate(window.observe(spike), spike);

    expect(verdict).not.toBeNull();
    expect(verdict!.score).toBeGreaterThan(3);
    expect(verdict!.severity).toBe("CRITICAL");
    expect(verdict!.message).toContain("por encima");
    expect(verdict!.upperLimit).not.toBeNull();
    expect(spike.value).toBeGreaterThan(verdict!.upperLimit!);
  });

  it("detecta un pico por debajo de la banda", () => {
    const detector = new WelfordDetector();
    const window = new SensorWindow(50);
    calmSeries(40).forEach((value, i) => {
      const r = reading(value, i);
      detector.evaluate(window.observe(r), r);
    });

    const dip = reading(-5, 40);
    const verdict = detector.evaluate(window.observe(dip), dip);

    expect(verdict).not.toBeNull();
    expect(verdict!.message).toContain("por debajo");
  });

  it("gradúa la severidad según la magnitud", () => {
    const detector = new WelfordDetector({ k: 3, criticalFactor: 1.5 });
    const window = new SensorWindow(50);
    calmSeries(40).forEach((value, i) => {
      const r = reading(value, i);
      detector.evaluate(window.observe(r), r);
    });

    // La serie tiene σ ≈ 0.35: un valor a ~3.5σ es advertencia, a ~10σ es crítico.
    const features = window.observe(reading(22 + 0.35 * 3.4, 40));
    const mild = detector.evaluate(features, reading(features.value, 40));
    expect(mild?.severity).toBe("WARNING");
  });

  it("una k más grande hace al detector más tolerante", () => {
    const strict = runSeries([...calmSeries(40), 24], new WelfordDetector({ k: 2 }));
    const lax = runSeries([...calmSeries(40), 24], new WelfordDetector({ k: 10 }));

    expect(strict).not.toBeNull();
    expect(lax).toBeNull();
  });

  it("se abstiene si la ventana es constante en vez de alertar sin parar", () => {
    // Un sensor atorado da σ = 0. La banda tendría anchura cero y cualquier decimal
    // dispararía una alerta; el detector prefiere callarse.
    const detector = new WelfordDetector({ minSamples: 5 });
    const window = new SensorWindow(50);
    for (let i = 0; i < 30; i += 1) {
      const r = reading(20, i);
      detector.evaluate(window.observe(r), r);
    }
    const r = reading(20.0001, 30);
    expect(detector.evaluate(window.observe(r), r)).toBeNull();
  });

  /**
   * Limitación documentada del detector, verificada como tal.
   *
   * No es un defecto disfrazado de prueba: es la justificación medible de por qué la
   * Fase D agrega un árbol de decisión con cinco características en vez de una.
   */
  it("NO detecta una deriva lenta: la ventana la adopta como normalidad", () => {
    const detector = new WelfordDetector();
    const window = new SensorWindow(50);
    let verdict = null;

    // 200 lecturas subiendo 0.1 °C cada una: de 22 °C a 42 °C sin una sola alerta.
    for (let i = 0; i < 200; i += 1) {
      const r = reading(22 + i * 0.1, i);
      verdict = detector.evaluate(window.observe(r), r);
      if (verdict !== null) break;
    }

    expect(verdict).toBeNull();
  });

  it("NO detecta un sensor atorado, que parece el más sano del sistema", () => {
    const detector = new WelfordDetector({ minSamples: 10 });
    const window = new SensorWindow(50);
    calmSeries(40).forEach((value, i) => {
      const r = reading(value, i);
      detector.evaluate(window.observe(r), r);
    });

    // El sensor se queda pegado en su último valor durante 100 lecturas.
    let alerts = 0;
    for (let i = 40; i < 140; i += 1) {
      const r = reading(22, i);
      if (detector.evaluate(window.observe(r), r) !== null) alerts += 1;
    }
    expect(alerts).toBe(0);
  });
});

describe("buildAlert", () => {
  it("arma una alerta válida a partir del veredicto", () => {
    const r = reading(45, 0);
    const alert = buildAlert(
      r,
      {
        score: 8.1,
        severity: "CRITICAL",
        lowerLimit: 15,
        upperLimit: 30,
        message: "Fuera de banda",
      },
      "WELFORD",
    );

    expect(alert.sensorId).toBe(SENSOR);
    expect(alert.location).toBe("NORTE");
    expect(alert.detector).toBe("WELFORD");
    expect(alert.value).toBe(45);
    expect(alert.alertId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("cada alerta lleva un identificador distinto", () => {
    const r = reading(45, 0);
    const detection = {
      score: 8.1,
      severity: "CRITICAL" as const,
      lowerLimit: 15,
      upperLimit: 30,
      message: "Fuera de banda",
    };
    const first = buildAlert(r, detection, "WELFORD");
    const second = buildAlert(r, detection, "WELFORD");
    expect(first.alertId).not.toBe(second.alertId);
  });
});
