import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Reading } from "@monitoreo/shared";
import { DecisionTree, type ClassLabel } from "./cart";
import { DecisionTreeDetector } from "./decision-tree-detector";
import { FEATURE_NAMES, type FeatureVector } from "./features";

const Z = FEATURE_NAMES.indexOf("zScore");

function features(overrides: Partial<FeatureVector> = {}): FeatureVector {
  return {
    value: 22,
    zScore: 0,
    delta: 0.1,
    rateOfChange: 0.1,
    medianDeviation: 0,
    trend: 0,
    hourOfDay: 12,
    sampleCount: 50,
    mean: 22,
    stdDev: 0.5,
    median: 22,
    ...overrides,
  };
}

const reading: Reading = {
  timestamp: "2026-05-05T12:00:00.000Z",
  sensorId: "11111111-1111-4111-8111-111111111111",
  location: "NORTE",
  type: "TEMPERATURA",
  value: 22,
  unit: "C",
};

/** Árbol entrenado sobre una regla simple: zScore alto implica anomalía. */
function trainedTree(): DecisionTree {
  const rows: number[][] = [];
  const labels: ClassLabel[] = [];
  for (let i = 0; i < 400; i += 1) {
    const anomalous = i % 2 === 0;
    const row = new Array<number>(FEATURE_NAMES.length).fill(0);
    row[Z] = anomalous ? 6 + (i % 3) : (i % 4) * 0.3;
    rows.push(row);
    labels.push(anomalous ? 1 : 0);
  }
  return DecisionTree.fit(rows, labels, { maxDepth: 3 });
}

describe("DecisionTreeDetector", () => {
  it("rechaza un umbral fuera de (0, 1]", () => {
    const tree = trainedTree();
    expect(() => new DecisionTreeDetector(tree, { threshold: 0 })).toThrow();
    expect(() => new DecisionTreeDetector(tree, { threshold: 1.5 })).toThrow();
    expect(() => new DecisionTreeDetector(tree, { threshold: -0.2 })).toThrow();
  });

  it("se declara como detector de árbol de decisión", () => {
    expect(new DecisionTreeDetector(trainedTree()).name).toBe("DECISION_TREE");
  });

  it("se abstiene durante el calentamiento", () => {
    const detector = new DecisionTreeDetector(trainedTree(), { minSamples: 20 });
    const verdict = detector.evaluate(
      features({ zScore: 50, sampleCount: 5 }),
      reading,
    );
    expect(verdict).toBeNull();
  });

  it("detecta una lectura claramente anómala", () => {
    const detector = new DecisionTreeDetector(trainedTree());
    const verdict = detector.evaluate(features({ zScore: 9 }), reading);

    expect(verdict).not.toBeNull();
    expect(verdict!.score).toBeGreaterThan(0.5);
    expect(verdict!.message).toContain("árbol de decisión");
  });

  it("deja pasar una lectura normal", () => {
    const detector = new DecisionTreeDetector(trainedTree());
    expect(detector.evaluate(features({ zScore: 0 }), reading)).toBeNull();
  });

  it("no reporta límites de banda, que no le corresponden", () => {
    const detector = new DecisionTreeDetector(trainedTree());
    const verdict = detector.evaluate(features({ zScore: 9 }), reading);
    expect(verdict!.lowerLimit).toBeNull();
    expect(verdict!.upperLimit).toBeNull();
  });

  it("un umbral más alto hace al detector más conservador", () => {
    const tree = trainedTree();
    const permissive = new DecisionTreeDetector(tree, { threshold: 0.05 });
    const strict = new DecisionTreeDetector(tree, { threshold: 1 });

    const borderline = features({ zScore: 1.2 });
    const permissiveVerdict = permissive.evaluate(borderline, reading);
    const strictVerdict = strict.evaluate(borderline, reading);

    // El estricto nunca puede alertar más que el permisivo.
    if (strictVerdict !== null) expect(permissiveVerdict).not.toBeNull();
  });

  it("gradúa la severidad con la confianza de la hoja", () => {
    const detector = new DecisionTreeDetector(trainedTree(), {
      threshold: 0.2,
      criticalProbability: 0.9,
    });
    const verdict = detector.evaluate(features({ zScore: 9 }), reading);
    expect(["WARNING", "CRITICAL"]).toContain(verdict!.severity);
  });

  it("nombra la evidencia dominante en el mensaje", () => {
    const detector = new DecisionTreeDetector(trainedTree(), { threshold: 0.1 });
    const verdict = detector.evaluate(
      features({ zScore: 9, trend: 0.2, medianDeviation: 0.1 }),
      reading,
    );
    expect(verdict!.message).toContain("z=9.0σ");
  });

  it("reconoce un sensor sin variación en el mensaje", () => {
    const detector = new DecisionTreeDetector(trainedTree(), { threshold: 0.1 });
    const verdict = detector.evaluate(
      features({ zScore: 9, delta: 0 }),
      reading,
    );
    expect(verdict!.message).toContain("sensor sin variación");
  });
});

describe("DecisionTreeDetector.fromFile", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "modelo-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("carga un modelo guardado y predice igual que el original", () => {
    const tree = trainedTree();
    const path = join(dir, "modelo.json");
    writeFileSync(path, JSON.stringify(tree.toJSON()));

    const detector = DecisionTreeDetector.fromFile(path);
    expect(detector.model.version).toBe(1);
    expect(detector.evaluate(features({ zScore: 9 }), reading)).not.toBeNull();
  });

  it("da un error claro si el archivo no existe", () => {
    expect(() => DecisionTreeDetector.fromFile(join(dir, "no-existe.json"))).toThrow(
      /No se pudo leer el modelo/,
    );
  });

  it("da un error claro si el archivo no es JSON válido", () => {
    const path = join(dir, "roto.json");
    writeFileSync(path, "{ esto no es json");
    expect(() => DecisionTreeDetector.fromFile(path)).toThrow(
      /No se pudo leer el modelo/,
    );
  });
});
