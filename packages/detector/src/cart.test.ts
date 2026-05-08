import { describe, expect, it } from "vitest";
import { DecisionTree, type ClassLabel } from "./cart";
import { FEATURE_NAMES } from "./features";

const Z = FEATURE_NAMES.indexOf("zScore");
const DELTA = FEATURE_NAMES.indexOf("delta");

/** Fila de características en ceros salvo las posiciones indicadas. */
function row(values: Partial<Record<number, number>> = {}): number[] {
  const out = new Array<number>(FEATURE_NAMES.length).fill(0);
  for (const [index, value] of Object.entries(values)) {
    out[Number(index)] = value as number;
  }
  return out;
}

/** Conjunto separable por un solo umbral: zScore > 3 implica anomalía. */
function separableDataset(n = 400): { rows: number[][]; labels: ClassLabel[] } {
  const rows: number[][] = [];
  const labels: ClassLabel[] = [];
  for (let i = 0; i < n; i += 1) {
    const anomalous = i % 4 === 0;
    rows.push(row({ [Z]: anomalous ? 4 + (i % 3) : (i % 5) * 0.4 }));
    labels.push(anomalous ? 1 : 0);
  }
  return { rows, labels };
}

describe("DecisionTree.fit", () => {
  it("rechaza un conjunto vacío", () => {
    expect(() => DecisionTree.fit([], [])).toThrow(/No hay muestras/);
  });

  it("rechaza filas y etiquetas de distinta longitud", () => {
    expect(() => DecisionTree.fit([row(), row()], [0])).toThrow(/no coinciden/);
  });

  it("aprende una regla separable por un umbral", () => {
    const { rows, labels } = separableDataset();
    const tree = DecisionTree.fit(rows, labels, { maxDepth: 3 });

    expect(tree.predict(row({ [Z]: 10 })).prediction).toBe(1);
    expect(tree.predict(row({ [Z]: 0 })).prediction).toBe(0);
  });

  it("parte por la característica informativa y no por el ruido", () => {
    const { rows, labels } = separableDataset();
    const tree = DecisionTree.fit(rows, labels, { maxDepth: 2 });
    const importance = tree.featureImportance();

    expect(importance.zScore).toBeGreaterThan(0.9);
    expect(importance.hourOfDay).toBe(0);
  });

  it("un conjunto de una sola clase produce una hoja", () => {
    const rows = Array.from({ length: 100 }, (_, i) => row({ [Z]: i }));
    const labels = new Array<ClassLabel>(100).fill(0);
    const tree = DecisionTree.fit(rows, labels);

    expect(tree.model.root.kind).toBe("leaf");
    expect(tree.depth).toBe(0);
    expect(tree.predict(row({ [Z]: 999 })).prediction).toBe(0);
  });

  it("respeta la profundidad máxima", () => {
    const rows: number[][] = [];
    const labels: ClassLabel[] = [];
    for (let i = 0; i < 2000; i += 1) {
      rows.push(row({ [Z]: Math.sin(i) * 5, [DELTA]: Math.cos(i) * 5 }));
      labels.push(i % 3 === 0 ? 1 : 0);
    }
    for (const maxDepth of [1, 2, 4]) {
      expect(DecisionTree.fit(rows, labels, { maxDepth }).depth).toBeLessThanOrEqual(
        maxDepth,
      );
    }
  });

  it("respeta el mínimo de muestras por hoja", () => {
    const { rows, labels } = separableDataset(600);
    const minSamplesLeaf = 50;
    const tree = DecisionTree.fit(rows, labels, { maxDepth: 8, minSamplesLeaf });

    const sizes: number[] = [];
    const walk = (node: typeof tree.model.root): void => {
      if (node.kind === "leaf") {
        sizes.push(node.samples);
        return;
      }
      walk(node.left);
      walk(node.right);
    };
    walk(tree.model.root);

    for (const size of sizes) expect(size).toBeGreaterThanOrEqual(minSamplesLeaf);
  });

  it("una ganancia mínima alta impide cualquier corte", () => {
    const { rows, labels } = separableDataset();
    const tree = DecisionTree.fit(rows, labels, { minImpurityDecrease: 10 });
    expect(tree.model.root.kind).toBe("leaf");
  });

  it("las hojas reportan la frecuencia empírica, no la ponderada", () => {
    // Con clases balanceadas artificialmente, una hoja con 5 anomalías de 100
    // muestras debe reportar 0.05, no ~0.5. Si reportara la ponderada, el umbral del
    // detector perdería todo significado.
    const rows: number[][] = [];
    const labels: ClassLabel[] = [];
    for (let i = 0; i < 400; i += 1) {
      const anomalous = i % 40 === 0; // 2.5 %
      rows.push(row({ [Z]: anomalous ? 8 : 0 }));
      labels.push(anomalous ? 1 : 0);
    }
    const tree = DecisionTree.fit(rows, labels, { maxDepth: 2 });

    const normal = tree.predict(row({ [Z]: 0 }));
    expect(normal.probability).toBeLessThan(0.05);
    // La ponderada sí está inflada por el balanceo; ambas conviven a propósito.
    expect(normal.weightedProbability).toBeGreaterThanOrEqual(normal.probability);
  });

  it("el balanceo de clases evita que la minoría se ignore", () => {
    // Las clases tienen que SOLAPARSE para que el balanceo importe: con datos
    // perfectamente separables la hoja queda pura y cualquier criterio acierta.
    // Aquí la región zScore≈5 contiene 20 anomalías y 40 lecturas normales.
    const rows: number[][] = [];
    const labels: ClassLabel[] = [];

    for (let i = 0; i < 20; i += 1) {
      rows.push(row({ [Z]: 5 + (i % 5) * 0.1 }));
      labels.push(1);
    }
    for (let i = 0; i < 40; i += 1) {
      rows.push(row({ [Z]: 5 + (i % 5) * 0.1 }));
      labels.push(0);
    }
    for (let i = 0; i < 940; i += 1) {
      rows.push(row({ [Z]: (i % 10) * 0.1 }));
      labels.push(0);
    }

    const options = { maxDepth: 3, minSamplesLeaf: 5, minSamplesSplit: 10 };
    const balanced = DecisionTree.fit(rows, labels, {
      ...options,
      balanceClasses: true,
    });
    const unbalanced = DecisionTree.fit(rows, labels, {
      ...options,
      balanceClasses: false,
    });

    // Sin balancear, la mayoría de la hoja manda: 40 normales contra 20 anomalías.
    expect(unbalanced.predict(row({ [Z]: 5 })).prediction).toBe(0);
    // Balanceado, cada anomalía pesa 25 veces más y la hoja se declara anómala.
    expect(balanced.predict(row({ [Z]: 5 })).prediction).toBe(1);

    // La frecuencia empírica reportada es la misma en ambos: 20 de 60.
    expect(balanced.predict(row({ [Z]: 5 })).probability).toBeCloseTo(1 / 3, 6);
  });

  it("registra metadatos del entrenamiento", () => {
    const { rows, labels } = separableDataset();
    const model = DecisionTree.fit(rows, labels).toJSON();

    expect(model.version).toBe(1);
    expect(model.trainingSamples).toBe(rows.length);
    expect(model.positiveSamples).toBe(labels.filter((l) => l === 1).length);
    expect(model.featureNames).toEqual(FEATURE_NAMES);
    expect(Date.parse(model.trainedAt)).not.toBeNaN();
  });
});

describe("DecisionTree: serialización", () => {
  it("sobrevive a una vuelta por JSON", () => {
    const { rows, labels } = separableDataset();
    const original = DecisionTree.fit(rows, labels, { maxDepth: 4 });
    const revived = DecisionTree.fromModel(
      JSON.parse(JSON.stringify(original.toJSON())),
    );

    for (const value of [-5, 0, 2.5, 4, 12]) {
      expect(revived.predict(row({ [Z]: value }))).toEqual(
        original.predict(row({ [Z]: value })),
      );
    }
  });

  it("rechaza una versión de modelo desconocida", () => {
    const { rows, labels } = separableDataset();
    const model = { ...DecisionTree.fit(rows, labels).toJSON(), version: 99 };
    expect(() => DecisionTree.fromModel(model as never)).toThrow(/no soportada/);
  });
});

describe("DecisionTree: interpretabilidad", () => {
  it("la importancia reparte el total entre las características", () => {
    const { rows, labels } = separableDataset();
    const importance = DecisionTree.fit(rows, labels, { maxDepth: 4 }).featureImportance();
    const total = Object.values(importance).reduce((a, b) => a + b, 0);

    expect(total).toBeCloseTo(1, 9);
    for (const value of Object.values(importance)) {
      expect(value).toBeGreaterThanOrEqual(0);
    }
  });

  it("un árbol de una sola hoja reparte importancia cero", () => {
    const rows = Array.from({ length: 50 }, () => row());
    const labels = new Array<ClassLabel>(50).fill(0);
    const importance = DecisionTree.fit(rows, labels).featureImportance();
    expect(Object.values(importance).every((v) => v === 0)).toBe(true);
  });

  it("el texto muestra la estructura con sangría y ramas sí/no", () => {
    const { rows, labels } = separableDataset();
    const text = DecisionTree.fit(rows, labels, { maxDepth: 3 }).toText();

    expect(text).toContain("¿zScore ≤");
    expect(text).toContain("sí →");
    expect(text).toContain("no →");
    expect(text).toContain("ANOMALÍA");
    // La segunda línea debe colgar de la primera, no empezar en la columna cero.
    expect(text.split("\n")[1]).toMatch(/^[├└]/);
  });

  it("recortar la profundidad de exposición colapsa los subárboles", () => {
    // Patrón de bandas alternadas: obliga a muchos cortes sobre la misma
    // característica y por lo tanto a un árbol profundo, que es el caso donde recortar
    // sirve de algo.
    const rows: number[][] = [];
    const labels: ClassLabel[] = [];
    for (let i = 0; i < 3000; i += 1) {
      const z = (i % 100) / 10; // 0.0 … 9.9
      rows.push(row({ [Z]: z, [DELTA]: (i % 7) * 0.5 }));
      labels.push(Math.floor(z) % 2 === 1 ? 1 : 0);
    }
    const tree = DecisionTree.fit(rows, labels, { maxDepth: 6 });

    // Precondición: sin un árbol profundo la prueba no comprobaría nada.
    expect(tree.depth).toBeGreaterThanOrEqual(3);

    const full = tree.toText();
    const trimmed = tree.toText(2);

    expect(trimmed.split("\n").length).toBeLessThan(full.split("\n").length);
    expect(trimmed).toContain("subárbol de");
  });
});
