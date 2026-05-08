import { describe, expect, it } from "vitest";
import { confusionMatrix, evaluate, formatMatrix, report } from "./metrics";

describe("confusionMatrix", () => {
  it("clasifica los cuatro cuadrantes", () => {
    const actual = [1, 1, 0, 0, 1, 0] as const;
    const predicted = [1, 0, 1, 0, 1, 0] as const;

    expect(confusionMatrix(actual, predicted)).toEqual({
      truePositives: 2,
      falseNegatives: 1,
      falsePositives: 1,
      trueNegatives: 2,
    });
  });

  it("rechaza longitudes distintas", () => {
    expect(() => confusionMatrix([1, 0], [1])).toThrow(/Longitudes distintas/);
  });

  it("un conjunto vacío da todo en ceros", () => {
    expect(confusionMatrix([], [])).toEqual({
      truePositives: 0,
      falseNegatives: 0,
      falsePositives: 0,
      trueNegatives: 0,
    });
  });
});

describe("report", () => {
  it("calcula precisión, exhaustividad y F1", () => {
    const r = report({
      truePositives: 80,
      falsePositives: 20,
      falseNegatives: 40,
      trueNegatives: 860,
    });

    expect(r.precision).toBeCloseTo(0.8, 10);
    expect(r.recall).toBeCloseTo(0.6667, 4);
    expect(r.f1).toBeCloseTo(0.7273, 4);
    expect(r.accuracy).toBeCloseTo(0.94, 10);
    expect(r.specificity).toBeCloseTo(0.9773, 4);
    expect(r.falseAlarmRate).toBeCloseTo(0.0227, 4);
    expect(r.total).toBe(1000);
  });

  it("un clasificador perfecto obtiene F1 = 1", () => {
    const r = evaluate([1, 0, 1, 0], [1, 0, 1, 0]);
    expect(r.precision).toBe(1);
    expect(r.recall).toBe(1);
    expect(r.f1).toBe(1);
  });

  /**
   * La razón por la que este proyecto no reporta la exactitud como métrica principal.
   */
  it("responder siempre 'normal' da 96 % de exactitud y F1 = 0", () => {
    const actual = Array.from({ length: 1000 }, (_, i) => (i % 25 === 0 ? 1 : 0)) as (
      | 0
      | 1
    )[];
    const predicted = new Array<0 | 1>(1000).fill(0);

    const r = evaluate(actual, predicted);
    expect(r.accuracy).toBeCloseTo(0.96, 10);
    expect(r.recall).toBe(0);
    expect(r.f1).toBe(0);
  });

  it("alertar de todo da exhaustividad perfecta y F1 pésimo", () => {
    // La media armónica castiga el desequilibrio: 100 % y 4 % no promedian 52 %.
    const actual = Array.from({ length: 1000 }, (_, i) => (i % 25 === 0 ? 1 : 0)) as (
      | 0
      | 1
    )[];
    const predicted = new Array<0 | 1>(1000).fill(1);

    const r = evaluate(actual, predicted);
    expect(r.recall).toBe(1);
    expect(r.precision).toBeCloseTo(0.04, 10);
    expect(r.f1).toBeLessThan(0.08);
  });

  it("no devuelve NaN cuando falta un denominador", () => {
    const r = report({
      truePositives: 0,
      falsePositives: 0,
      falseNegatives: 0,
      trueNegatives: 0,
    });
    for (const value of [r.precision, r.recall, r.f1, r.accuracy, r.specificity]) {
      expect(Number.isNaN(value)).toBe(false);
      expect(value).toBe(0);
    }
  });

  it("sin alertas emitidas, la precisión es 0 y no NaN", () => {
    const r = evaluate([1, 1, 0], [0, 0, 0]);
    expect(r.precision).toBe(0);
    expect(r.f1).toBe(0);
  });
});

describe("formatMatrix", () => {
  it("dibuja la matriz con las cuatro celdas", () => {
    const text = formatMatrix(
      report({
        truePositives: 7,
        falsePositives: 3,
        falseNegatives: 2,
        trueNegatives: 88,
      }),
    );

    expect(text).toContain("real normal");
    expect(text).toContain("real anomalía");
    expect(text).toContain("88");
    expect(text).toContain("7");
  });
});
