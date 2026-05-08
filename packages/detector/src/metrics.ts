/**
 * Métricas de clasificación binaria.
 *
 * Son la evidencia que pide el criterio 2.3: justificar la selección del algoritmo.
 * "Funciona bien" no es una justificación; una matriz de confusión sí.
 *
 * Por qué no se reporta la exactitud como métrica principal: con un 3 % de anomalías,
 * un detector que responda siempre "normal" alcanza 97 % de exactitud y no sirve para
 * nada. En detección de anomalías las métricas que importan son:
 *
 *   Precisión = VP / (VP + FP)   ¿de las alertas emitidas, cuántas eran reales?
 *   Exhaustividad = VP / (VP + FN)   ¿de las anomalías reales, cuántas se detectaron?
 *   F1 = media armónica de ambas
 *
 * La media armónica castiga el desequilibrio: un detector con 100 % de exhaustividad
 * y 5 % de precisión —el que alerta de todo— obtiene F1 = 0.095, no 0.525.
 */

export interface ConfusionMatrix {
  /** Anomalías correctamente detectadas. */
  truePositives: number;
  /** Falsas alarmas: lecturas normales marcadas como anómalas. */
  falsePositives: number;
  /** Anomalías que pasaron desapercibidas. */
  falseNegatives: number;
  /** Lecturas normales correctamente ignoradas. */
  trueNegatives: number;
}

export interface ClassificationReport extends ConfusionMatrix {
  total: number;
  precision: number;
  recall: number;
  f1: number;
  accuracy: number;
  /** Proporción de normales bien clasificadas; complemento de la tasa de falsas alarmas. */
  specificity: number;
  /** Porcentaje de lecturas normales que dispararon una alerta. */
  falseAlarmRate: number;
}

export function confusionMatrix(
  actual: readonly (0 | 1)[],
  predicted: readonly (0 | 1)[],
): ConfusionMatrix {
  if (actual.length !== predicted.length) {
    throw new Error(
      `Longitudes distintas: ${actual.length} reales contra ${predicted.length} predichas`,
    );
  }

  const matrix: ConfusionMatrix = {
    truePositives: 0,
    falsePositives: 0,
    falseNegatives: 0,
    trueNegatives: 0,
  };

  for (let i = 0; i < actual.length; i += 1) {
    const real = actual[i];
    const guess = predicted[i];
    if (real === 1 && guess === 1) matrix.truePositives += 1;
    else if (real === 0 && guess === 1) matrix.falsePositives += 1;
    else if (real === 1 && guess === 0) matrix.falseNegatives += 1;
    else matrix.trueNegatives += 1;
  }

  return matrix;
}

/** Divide devolviendo 0 cuando no hay denominador, en vez de NaN. */
function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

export function report(matrix: ConfusionMatrix): ClassificationReport {
  const { truePositives, falsePositives, falseNegatives, trueNegatives } = matrix;
  const total = truePositives + falsePositives + falseNegatives + trueNegatives;

  const precision = ratio(truePositives, truePositives + falsePositives);
  const recall = ratio(truePositives, truePositives + falseNegatives);

  return {
    ...matrix,
    total,
    precision,
    recall,
    f1: ratio(2 * precision * recall, precision + recall),
    accuracy: ratio(truePositives + trueNegatives, total),
    specificity: ratio(trueNegatives, trueNegatives + falsePositives),
    falseAlarmRate: ratio(falsePositives, trueNegatives + falsePositives),
  };
}

export function evaluate(
  actual: readonly (0 | 1)[],
  predicted: readonly (0 | 1)[],
): ClassificationReport {
  return report(confusionMatrix(actual, predicted));
}

const percent = (value: number): string => `${(value * 100).toFixed(1)} %`;

/** Fila compacta para la tabla comparativa entre detectores. */
export function formatRow(name: string, r: ClassificationReport): string {
  return (
    `${name.padEnd(22)} ` +
    `${percent(r.precision).padStart(8)} ` +
    `${percent(r.recall).padStart(9)} ` +
    `${r.f1.toFixed(3).padStart(7)} ` +
    `${percent(r.falseAlarmRate).padStart(10)} ` +
    `${String(r.truePositives).padStart(6)} ` +
    `${String(r.falseNegatives).padStart(6)}`
  );
}

export const TABLE_HEADER =
  `${"Detector".padEnd(22)} ${"Precisión".padStart(8)} ${"Exhaust.".padStart(9)} ` +
  `${"F1".padStart(7)} ${"F.alarma".padStart(10)} ${"VP".padStart(6)} ${"FN".padStart(6)}`;

/** Matriz de confusión en dos por dos, para el documento. */
export function formatMatrix(r: ClassificationReport): string {
  const width = Math.max(
    6,
    ...[r.truePositives, r.falsePositives, r.falseNegatives, r.trueNegatives].map(
      (n) => String(n).length,
    ),
  );
  const cell = (n: number): string => String(n).padStart(width);
  return [
    `${" ".repeat(18)}${"pred. normal".padStart(width)}  ${"pred. anomalía".padStart(width)}`,
    `${"real normal".padEnd(18)}${cell(r.trueNegatives)}  ${cell(r.falsePositives)}`,
    `${"real anomalía".padEnd(18)}${cell(r.falseNegatives)}  ${cell(r.truePositives)}`,
  ].join("\n");
}
