/**
 * Evaluación comparada de los detectores. Produce la evidencia del criterio 2.3.
 *
 *   node dist/evaluate.js [--samples 4000] [--seed 42]
 *
 * Se corren dos experimentos, porque responden preguntas distintas:
 *
 * EXPERIMENTO 1 — Generalización.
 *   Se entrena el árbol viendo ÚNICAMENTE picos y se evalúa contra los cuatro tipos
 *   de falla. Existe para desarmar la objeción evidente: "tu modelo sólo memorizó la
 *   regla con la que inyectaste las anomalías". Si eso fuera cierto, fallaría en todo
 *   lo que no sea un pico. Lo que se observe aquí —acierte o falle— es un resultado
 *   honesto sobre hasta dónde transfiere lo aprendido.
 *
 * EXPERIMENTO 2 — Modelo de producción.
 *   Se entrena con los cuatro tipos y se evalúa sobre un conjunto generado con OTRA
 *   semilla, es decir con series que el modelo nunca vio. Éste es el modelo que se
 *   despliega, y sus métricas son las que van al documento.
 *
 * En ambos se compara contra la banda de control de Welford sobre exactamente las
 * mismas muestras. Las dos estrategias reciben el mismo vector de características, de
 * modo que cualquier diferencia venga del modelo y no de los datos.
 */

import { parseArgs } from "node:util";
import {
  DecisionTree,
  DecisionTreeDetector,
  FEATURE_NAMES,
  TABLE_HEADER,
  WelfordDetector,
  evaluate as computeReport,
  formatMatrix,
  formatRow,
  type AnomalyDetector,
  type ClassLabel,
} from "@monitoreo/detector";
import { createLogger } from "@monitoreo/shared";
import { ANOMALY_MODES } from "@monitoreo/simulator";
import { generateDataset, summarize, type Dataset, type LabeledSample } from "./dataset";

const log = createLogger("EVALUACIÓN");

/** Lectura mínima que el detector necesita para redactar el mensaje. */
function readingFor(sample: LabeledSample) {
  return {
    timestamp: new Date().toISOString(),
    sensorId: "00000000-0000-4000-8000-000000000000",
    location: "NORTE" as const,
    type: sample.sensorType,
    value: sample.features.value,
    unit: "C" as const,
  };
}

function predictAll(
  detector: AnomalyDetector,
  dataset: Dataset,
): ClassLabel[] {
  return dataset.samples.map((sample) =>
    detector.evaluate(sample.features, readingFor(sample)) === null ? 0 : 1,
  );
}

/** Exhaustividad desglosada por tipo de falla: dónde acierta y dónde no. */
function recallByType(
  dataset: Dataset,
  predictions: readonly ClassLabel[],
): Map<string, { detected: number; total: number }> {
  const perType = new Map<string, { detected: number; total: number }>();
  dataset.samples.forEach((sample, i) => {
    if (sample.label !== 1) return;
    const entry = perType.get(sample.anomalyType) ?? { detected: 0, total: 0 };
    entry.total += 1;
    if (predictions[i] === 1) entry.detected += 1;
    perType.set(sample.anomalyType, entry);
  });
  return perType;
}

function printRecallByType(
  title: string,
  dataset: Dataset,
  predictions: readonly ClassLabel[],
): void {
  console.log(`\n  Exhaustividad por tipo de falla — ${title}`);
  const perType = recallByType(dataset, predictions);
  for (const mode of ANOMALY_MODES) {
    const entry = perType.get(mode);
    if (entry === undefined) continue;
    const rate = entry.total === 0 ? 0 : entry.detected / entry.total;
    const bar = "█".repeat(Math.round(rate * 30)).padEnd(30, "·");
    console.log(
      `    ${mode.padEnd(7)} ${bar} ${(rate * 100).toFixed(1).padStart(5)} % ` +
        `(${entry.detected}/${entry.total})`,
    );
  }
}

function heading(text: string): void {
  console.log(`\n${"═".repeat(76)}`);
  console.log(text);
  console.log("═".repeat(76));
}

function main(): void {
  const { values } = parseArgs({
    options: {
      samples: { type: "string", short: "n" },
      seed: { type: "string" },
      "max-depth": { type: "string" },
    },
  });

  const samplesPerSensor = Number(values.samples ?? 4000);
  const seed = Number(values.seed ?? 42);
  const maxDepth = Number(values["max-depth"] ?? 6);
  const allModes = [...ANOMALY_MODES];

  log.info(
    `muestras_por_sensor=${samplesPerSensor} semilla=${seed} profundidad_max=${maxDepth}`,
  );

  // ── Conjunto de prueba: los cuatro tipos, semilla distinta a la de entrenamiento.
  const testSet = generateDataset({
    location: "NORTE",
    modes: allModes,
    samplesPerSensor,
    seed: seed + 90_000,
  });
  const testStats = summarize(testSet);

  log.info(
    `conjunto de prueba: ${testStats.total} muestras, ${testStats.positives} anómalas ` +
      `(${(testStats.positiveRate * 100).toFixed(1)} %)`,
  );

  const welford = new WelfordDetector();

  // ── EXPERIMENTO 1 ───────────────────────────────────────────────────────────────
  heading("EXPERIMENTO 1 — ¿Generaliza, o sólo memorizó la regla de inyección?");
  console.log("Entrenamiento: SÓLO picos.  Evaluación: los cuatro tipos de falla.\n");

  const spikeOnly = generateDataset({
    location: "NORTE",
    modes: ["SPIKE"],
    samplesPerSensor,
    seed,
  });
  const spikeTree = DecisionTree.fit(spikeOnly.rows, spikeOnly.labels, { maxDepth });
  const spikeDetector = new DecisionTreeDetector(spikeTree);

  const spikePredictions = predictAll(spikeDetector, testSet);
  const welfordPredictions = predictAll(welford, testSet);

  console.log(TABLE_HEADER);
  console.log("─".repeat(76));
  console.log(
    formatRow("Welford (k=3)", computeReport(testSet.labels, welfordPredictions)),
  );
  console.log(
    formatRow("Árbol (sólo picos)", computeReport(testSet.labels, spikePredictions)),
  );

  printRecallByType("Welford", testSet, welfordPredictions);
  printRecallByType("Árbol entrenado sólo con picos", testSet, spikePredictions);

  // ── EXPERIMENTO 2 ───────────────────────────────────────────────────────────────
  heading("EXPERIMENTO 2 — Modelo de producción");
  console.log(
    "Entrenamiento: los cuatro tipos.  Evaluación: series nunca vistas (otra semilla).\n",
  );

  const trainSet = generateDataset({
    location: "NORTE",
    modes: allModes,
    samplesPerSensor,
    seed,
  });
  const fullTree = DecisionTree.fit(trainSet.rows, trainSet.labels, { maxDepth });
  const fullDetector = new DecisionTreeDetector(fullTree);
  const fullPredictions = predictAll(fullDetector, testSet);

  console.log(TABLE_HEADER);
  console.log("─".repeat(76));
  console.log(
    formatRow("Welford (k=3)", computeReport(testSet.labels, welfordPredictions)),
  );
  console.log(
    formatRow("Árbol (4 tipos)", computeReport(testSet.labels, fullPredictions)),
  );

  printRecallByType("Árbol de producción", testSet, fullPredictions);

  console.log("\n  Matriz de confusión — árbol de producción\n");
  console.log(
    formatMatrix(computeReport(testSet.labels, fullPredictions))
      .split("\n")
      .map((line) => `    ${line}`)
      .join("\n"),
  );

  // ── Punto de operación ──────────────────────────────────────────────────────────
  heading("PUNTO DE OPERACIÓN — barrido del umbral de confianza");
  console.log(
    "El umbral mueve el compromiso entre detectar todo y no molestar al operador.\n" +
      "No hay un valor correcto universal: depende del costo de una falsa alarma\n" +
      "frente al de una anomalía no vista.\n",
  );
  console.log(
    `${"Umbral".padEnd(9)}${"Precisión".padStart(10)}${"Exhaust.".padStart(10)}` +
      `${"F1".padStart(8)}${"F.alarma".padStart(10)}`,
  );
  console.log("─".repeat(47));
  for (const threshold of [0.05, 0.1, 0.2, 0.3, 0.4, 0.5, 0.7]) {
    const detector = new DecisionTreeDetector(fullTree, { threshold });
    const r = computeReport(testSet.labels, predictAll(detector, testSet));
    console.log(
      String(threshold).padEnd(9) +
        `${(r.precision * 100).toFixed(1)} %`.padStart(10) +
        `${(r.recall * 100).toFixed(1)} %`.padStart(10) +
        r.f1.toFixed(3).padStart(8) +
        `${(r.falseAlarmRate * 100).toFixed(1)} %`.padStart(10),
    );
  }

  // ── Interpretabilidad ───────────────────────────────────────────────────────────
  heading("MODELO APRENDIDO — primeros tres niveles");
  console.log(
    `Árbol completo: profundidad ${fullTree.depth}, ${fullTree.leafCount} hojas. ` +
      `Se recortan los niveles profundos para poder leerlo.\n`,
  );
  console.log(fullTree.toText(3));

  console.log("\nImportancia de las características:");
  const importance = fullTree.featureImportance();
  const ordered = [...FEATURE_NAMES].sort((a, b) => importance[b] - importance[a]);
  for (const name of ordered) {
    const share = importance[name];
    console.log(
      `  ${name.padEnd(17)} ${(share * 100).toFixed(1).padStart(5)} %  ` +
        "█".repeat(Math.round(share * 40)),
    );
  }

  const hourShare = importance.hourOfDay;
  if (hourShare > 0.15) {
    // Señal de alarma metodológica: si el árbol se apoya en la hora, aprendió cuándo
    // se generaron los datos en vez de qué es una anomalía.
    console.log(
      `\n  ADVERTENCIA: hourOfDay concentra ${(hourShare * 100).toFixed(1)} % de la ` +
        `ganancia. Revisar que el conjunto abarque varios días completos.`,
    );
  }

  // ── Verificación del sesgo de entrenamiento ─────────────────────────────────────
  heading("CONTROL — el árbol de producción sobre sus propios datos");
  console.log(
    "Si estas cifras fueran muy superiores a las del conjunto de prueba, el modelo\n" +
      "estaría memorizando en vez de generalizando.\n",
  );
  const trainPredictions = predictAll(fullDetector, trainSet);
  console.log(TABLE_HEADER);
  console.log("─".repeat(76));
  console.log(
    formatRow("Entrenamiento", computeReport(trainSet.labels, trainPredictions)),
  );
  console.log(formatRow("Prueba", computeReport(testSet.labels, fullPredictions)));
  console.log();
}

try {
  main();
} catch (err) {
  log.error(`fallo: ${(err as Error).message}`);
  process.exit(1);
}
