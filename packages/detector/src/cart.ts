/**
 * Árbol de decisión CART (Classification And Regression Trees), implementado a mano.
 *
 * Cubre el criterio 2.1.9 del comité —árboles de decisión— y su modelo matemático es
 * el criterio 2.2.
 *
 * ── MODELO MATEMÁTICO ────────────────────────────────────────────────────────────
 *
 * Impureza de Gini de un conjunto S con clases i:
 *
 *     G(S) = 1 − Σ p_i²        donde p_i = proporción de la clase i en S
 *
 * Es la probabilidad de clasificar mal un elemento tomado al azar si se le asigna una
 * etiqueta al azar según la distribución de S. Vale 0 cuando S es puro y 0.5 cuando
 * las dos clases están al 50 %.
 *
 * Un corte parte S en S_izq y S_der según `x_f ≤ t`. Su impureza ponderada es:
 *
 *     G(corte) = (|S_izq|/|S|)·G(S_izq) + (|S_der|/|S|)·G(S_der)
 *
 * y la ganancia —lo que el corte mejora— es:
 *
 *     ΔG = G(S) − G(corte)
 *
 * En cada nodo se elige el par (característica f, umbral t) que maximiza ΔG. El
 * algoritmo es voraz: no busca el árbol globalmente óptimo, que es NP-completo, sino
 * el mejor corte local en cada paso.
 *
 * ── DESBALANCE DE CLASES ─────────────────────────────────────────────────────────
 *
 * Las anomalías son del orden del 3 % de las lecturas. Un árbol que optimiza Gini sin
 * corregir eso aprende que responder siempre "normal" acierta el 97 % de las veces, y
 * no detecta nada. Por eso cada clase se pondera con el inverso de su frecuencia
 * (`w_c = N / (2·N_c)`), de modo que ambas aporten la misma masa total al cómputo de
 * la impureza. Es el equivalente al `class_weight='balanced'` de scikit-learn.
 *
 * ── PODA ─────────────────────────────────────────────────────────────────────────
 *
 * Poda previa por profundidad máxima, mínimo de muestras para partir, mínimo de
 * muestras por hoja y ganancia mínima. Un árbol sin podar memoriza el ruido del
 * conjunto de entrenamiento; con seis características y decenas de miles de muestras
 * llegaría a hojas de un solo elemento.
 */

import { FEATURE_NAMES, type FeatureName } from "./features";

export type ClassLabel = 0 | 1;

export interface SplitNode {
  kind: "split";
  feature: FeatureName;
  featureIndex: number;
  threshold: number;
  /** Impureza del nodo antes de partir. */
  gini: number;
  samples: number;
  left: TreeNode;
  right: TreeNode;
}

export interface LeafNode {
  kind: "leaf";
  prediction: ClassLabel;
  /**
   * Frecuencia EMPÍRICA de anomalías en la hoja, sin ponderar.
   *
   * Los pesos de clase existen para que la búsqueda de cortes no ignore a la minoría,
   * pero aplicarlos también aquí produciría una probabilidad inflada y sin sentido
   * físico: una hoja con 3 anomalías y 97 normales reportaría ~0.5 en vez de 0.03.
   * Con eso el umbral del detector deja de significar nada y moverlo no cambia el
   * punto de operación. Por eso la estructura se aprende ponderada y la estimación se
   * reporta cruda.
   */
  probability: number;
  /** Probabilidad ponderada. Es la que decide la clase mayoritaria de la hoja. */
  weightedProbability: number;
  anomalySamples: number;
  normalSamples: number;
  gini: number;
  samples: number;
}

export type TreeNode = SplitNode | LeafNode;

export interface CartOptions {
  maxDepth: number;
  minSamplesSplit: number;
  minSamplesLeaf: number;
  minImpurityDecrease: number;
  balanceClasses: boolean;
}

export const DEFAULT_CART_OPTIONS: CartOptions = {
  maxDepth: 6,
  minSamplesSplit: 40,
  minSamplesLeaf: 15,
  minImpurityDecrease: 1e-4,
  balanceClasses: true,
};

/** Modelo serializable. Es lo que se guarda en disco y carga el ingestor. */
export interface TreeModel {
  version: 1;
  featureNames: readonly FeatureName[];
  root: TreeNode;
  options: CartOptions;
  trainedAt: string;
  trainingSamples: number;
  positiveSamples: number;
}

interface ClassWeights {
  normal: number;
  anomaly: number;
}

/** Impureza de Gini a partir de las masas ponderadas de cada clase. */
function gini(weightNormal: number, weightAnomaly: number): number {
  const total = weightNormal + weightAnomaly;
  if (total <= 0) return 0;
  const p0 = weightNormal / total;
  const p1 = weightAnomaly / total;
  return 1 - p0 * p0 - p1 * p1;
}

function computeClassWeights(
  labels: readonly ClassLabel[],
  balance: boolean,
): ClassWeights {
  if (!balance) return { normal: 1, anomaly: 1 };

  const total = labels.length;
  let positives = 0;
  for (const label of labels) positives += label;
  const negatives = total - positives;

  // Si falta una clase por completo no hay nada que balancear.
  if (positives === 0 || negatives === 0) return { normal: 1, anomaly: 1 };

  return {
    normal: total / (2 * negatives),
    anomaly: total / (2 * positives),
  };
}

interface Candidate {
  featureIndex: number;
  threshold: number;
  impurityDecrease: number;
}

/**
 * Mejor corte para una característica.
 *
 * Ordena los índices por el valor de la característica y barre una sola vez,
 * manteniendo las masas acumuladas a la izquierda. Sólo se consideran umbrales en el
 * punto medio entre dos valores *distintos* consecutivos: partir entre dos valores
 * iguales dejaría muestras idénticas en lados opuestos, lo cual es imposible de
 * aplicar después en la inferencia.
 */
function bestSplitForFeature(
  rows: number[][],
  labels: readonly ClassLabel[],
  indices: readonly number[],
  featureIndex: number,
  weights: ClassWeights,
  parentGini: number,
  nodeNormal: number,
  nodeAnomaly: number,
  minSamplesLeaf: number,
): Candidate | null {
  const ordered = [...indices].sort(
    (a, b) => (rows[a]![featureIndex] as number) - (rows[b]![featureIndex] as number),
  );

  const totalWeight = nodeNormal + nodeAnomaly;
  let leftNormal = 0;
  let leftAnomaly = 0;
  let best: Candidate | null = null;

  for (let i = 0; i < ordered.length - 1; i += 1) {
    const index = ordered[i]!;
    if (labels[index] === 1) leftAnomaly += weights.anomaly;
    else leftNormal += weights.normal;

    const current = rows[index]![featureIndex] as number;
    const next = rows[ordered[i + 1]!]![featureIndex] as number;
    // Partir entre dos valores idénticos dejaría muestras iguales en lados opuestos,
    // algo que la inferencia no podría reproducir.
    if (current === next) continue;

    const leftCount = i + 1;
    if (leftCount < minSamplesLeaf || ordered.length - leftCount < minSamplesLeaf) {
      continue;
    }

    const leftWeight = leftNormal + leftAnomaly;
    const rightWeight = totalWeight - leftWeight;
    if (leftWeight <= 0 || rightWeight <= 0) continue;

    // Las masas de la derecha se obtienen restando: mantener el barrido incremental
    // es lo que hace que la búsqueda sea O(n log n) por característica y no O(n²).
    const weighted =
      (leftWeight / totalWeight) * gini(leftNormal, leftAnomaly) +
      (rightWeight / totalWeight) *
        gini(nodeNormal - leftNormal, nodeAnomaly - leftAnomaly);

    const decrease = parentGini - weighted;
    if (best === null || decrease > best.impurityDecrease) {
      best = {
        featureIndex,
        threshold: (current + next) / 2,
        impurityDecrease: decrease,
      };
    }
  }

  return best;
}

function weightSumNormal(
  labels: readonly ClassLabel[],
  indices: readonly number[],
  weights: ClassWeights,
): number {
  let sum = 0;
  for (const index of indices) if (labels[index] === 0) sum += weights.normal;
  return sum;
}

function weightSumAnomaly(
  labels: readonly ClassLabel[],
  indices: readonly number[],
  weights: ClassWeights,
): number {
  let sum = 0;
  for (const index of indices) if (labels[index] === 1) sum += weights.anomaly;
  return sum;
}

export class DecisionTree {
  private constructor(readonly model: TreeModel) {}

  static fromModel(model: TreeModel): DecisionTree {
    if (model.version !== 1) {
      throw new Error(`Versión de modelo no soportada: ${String(model.version)}`);
    }
    return new DecisionTree(model);
  }

  static fit(
    rows: number[][],
    labels: readonly ClassLabel[],
    partial: Partial<CartOptions> = {},
  ): DecisionTree {
    if (rows.length === 0) throw new Error("No hay muestras para entrenar");
    if (rows.length !== labels.length) {
      throw new Error(
        `Filas (${rows.length}) y etiquetas (${labels.length}) no coinciden`,
      );
    }

    const options: CartOptions = { ...DEFAULT_CART_OPTIONS, ...partial };
    const weights = computeClassWeights(labels, options.balanceClasses);
    const indices = rows.map((_, i) => i);

    const root = buildNode(rows, labels, indices, weights, options, 0);

    let positives = 0;
    for (const label of labels) positives += label;

    return new DecisionTree({
      version: 1,
      featureNames: FEATURE_NAMES,
      root,
      options,
      trainedAt: new Date().toISOString(),
      trainingSamples: rows.length,
      positiveSamples: positives,
    });
  }

  /**
   * Clasifica un vector de características ya proyectado a arreglo.
   *
   * `probability` es la frecuencia empírica de la hoja, no la ponderada: es la que
   * tiene sentido comparar contra un umbral configurable.
   */
  predict(row: readonly number[]): {
    prediction: ClassLabel;
    probability: number;
    weightedProbability: number;
  } {
    let node = this.model.root;
    while (node.kind === "split") {
      const value = row[node.featureIndex] as number;
      node = value <= node.threshold ? node.left : node.right;
    }
    return {
      prediction: node.prediction,
      probability: node.probability,
      weightedProbability: node.weightedProbability,
    };
  }

  get depth(): number {
    return measureDepth(this.model.root);
  }

  get leafCount(): number {
    return countLeaves(this.model.root);
  }

  /**
   * Reparto de la ganancia total de impureza entre las características.
   *
   * Sirve para revisar que el árbol no se esté apoyando en una característica
   * espuria: si `hourOfDay` acumulara una fracción alta, significaría que aprendió a
   * qué hora se generó el conjunto de datos y no qué es una anomalía.
   */
  featureImportance(): Record<FeatureName, number> {
    const totals = Object.fromEntries(
      FEATURE_NAMES.map((name) => [name, 0]),
    ) as Record<FeatureName, number>;

    accumulateImportance(this.model.root, totals);

    const sum = Object.values(totals).reduce((a, b) => a + b, 0);
    if (sum > 0) {
      for (const name of FEATURE_NAMES) totals[name] /= sum;
    }
    return totals;
  }

  /**
   * Representación legible del árbol, para el documento y la defensa.
   *
   * @param displayDepth si se indica, se colapsan los subárboles más profundos en una
   * hoja resumen. Un árbol de profundidad 6 tiene decenas de hojas y no cabe en una
   * lámina; recortarlo a 3 lo vuelve explicable en voz alta sin alterar el modelo.
   */
  toText(displayDepth = Number.POSITIVE_INFINITY): string {
    const lines: string[] = [];
    renderNode(this.model.root, "", true, true, displayDepth, lines);
    return lines.join("\n");
  }

  toJSON(): TreeModel {
    return this.model;
  }
}

function buildNode(
  rows: number[][],
  labels: readonly ClassLabel[],
  indices: readonly number[],
  weights: ClassWeights,
  options: CartOptions,
  depth: number,
): TreeNode {
  const weightNormal = weightSumNormal(labels, indices, weights);
  const weightAnomaly = weightSumAnomaly(labels, indices, weights);
  const nodeGini = gini(weightNormal, weightAnomaly);

  const makeLeaf = (): LeafNode => {
    let anomalySamples = 0;
    for (const index of indices) anomalySamples += labels[index] as number;
    const normalSamples = indices.length - anomalySamples;

    const weightTotal = weightNormal + weightAnomaly;
    const weightedProbability = weightTotal > 0 ? weightAnomaly / weightTotal : 0;

    return {
      kind: "leaf",
      prediction: weightedProbability >= 0.5 ? 1 : 0,
      probability: indices.length > 0 ? anomalySamples / indices.length : 0,
      weightedProbability,
      anomalySamples,
      normalSamples,
      gini: nodeGini,
      samples: indices.length,
    };
  };

  const pure = weightNormal === 0 || weightAnomaly === 0;
  if (
    pure ||
    depth >= options.maxDepth ||
    indices.length < options.minSamplesSplit ||
    indices.length < 2 * options.minSamplesLeaf
  ) {
    return makeLeaf();
  }

  let best: Candidate | null = null;

  for (let featureIndex = 0; featureIndex < FEATURE_NAMES.length; featureIndex += 1) {
    const candidate = bestSplitForFeature(
      rows,
      labels,
      indices,
      featureIndex,
      weights,
      nodeGini,
      weightNormal,
      weightAnomaly,
      options.minSamplesLeaf,
    );
    if (
      candidate !== null &&
      (best === null || candidate.impurityDecrease > best.impurityDecrease)
    ) {
      best = candidate;
    }
  }

  if (best === null || best.impurityDecrease < options.minImpurityDecrease) {
    return makeLeaf();
  }

  const leftIndices: number[] = [];
  const rightIndices: number[] = [];
  for (const index of indices) {
    if ((rows[index]![best.featureIndex] as number) <= best.threshold) {
      leftIndices.push(index);
    } else {
      rightIndices.push(index);
    }
  }

  // Salvaguarda: si por redondeo el corte dejara un lado vacío, se convierte en hoja
  // en vez de recursar infinitamente sobre el mismo conjunto.
  if (leftIndices.length === 0 || rightIndices.length === 0) return makeLeaf();

  return {
    kind: "split",
    feature: FEATURE_NAMES[best.featureIndex] as FeatureName,
    featureIndex: best.featureIndex,
    threshold: best.threshold,
    gini: nodeGini,
    samples: indices.length,
    left: buildNode(rows, labels, leftIndices, weights, options, depth + 1),
    right: buildNode(rows, labels, rightIndices, weights, options, depth + 1),
  };
}

function measureDepth(node: TreeNode): number {
  if (node.kind === "leaf") return 0;
  return 1 + Math.max(measureDepth(node.left), measureDepth(node.right));
}

function countLeaves(node: TreeNode): number {
  if (node.kind === "leaf") return 1;
  return countLeaves(node.left) + countLeaves(node.right);
}

function accumulateImportance(
  node: TreeNode,
  totals: Record<FeatureName, number>,
): void {
  if (node.kind === "leaf") return;

  const childImpurity =
    (node.left.samples / node.samples) * node.left.gini +
    (node.right.samples / node.samples) * node.right.gini;
  totals[node.feature] += node.samples * (node.gini - childImpurity);

  accumulateImportance(node.left, totals);
  accumulateImportance(node.right, totals);
}

/** Proporción de anomalías bajo un nodo, para resumir un subárbol colapsado. */
function anomalyShare(node: TreeNode): number {
  if (node.kind === "leaf") return node.probability;
  const left = anomalyShare(node.left) * node.left.samples;
  const right = anomalyShare(node.right) * node.right.samples;
  return (left + right) / node.samples;
}

function renderNode(
  node: TreeNode,
  prefix: string,
  isRoot: boolean,
  isLast: boolean,
  remainingDepth: number,
  lines: string[],
): void {
  // La raíz no lleva conector; los demás cuelgan de su padre con ├─ o └─. El prefijo
  // de los hijos continúa la línea vertical salvo en la última rama.
  const connector = isRoot ? "" : isLast ? "└─ no → " : "├─ sí → ";
  const childPrefix = isRoot ? "" : `${prefix}${isLast ? "         " : "│        "}`;

  if (node.kind === "leaf") {
    const verdict = node.prediction === 1 ? "ANOMALÍA" : "normal";
    lines.push(
      `${prefix}${connector}${verdict} ` +
        `(${node.anomalySamples}/${node.samples} anómalas = ${(node.probability * 100).toFixed(1)} %, ` +
        `gini=${node.gini.toFixed(3)})`,
    );
    return;
  }

  if (remainingDepth <= 0) {
    const share = anomalyShare(node);
    lines.push(
      `${prefix}${connector}[subárbol de ${countLeaves(node)} hojas, ` +
        `n=${node.samples}, ${(share * 100).toFixed(0)} % anómalas]`,
    );
    return;
  }

  lines.push(
    `${prefix}${connector}¿${node.feature} ≤ ${node.threshold.toFixed(4)}? ` +
      `(n=${node.samples}, gini=${node.gini.toFixed(3)})`,
  );
  renderNode(node.left, childPrefix, false, false, remainingDepth - 1, lines);
  renderNode(node.right, childPrefix, false, true, remainingDepth - 1, lines);
}
