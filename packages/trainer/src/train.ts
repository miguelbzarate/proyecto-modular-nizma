/**
 * Entrenamiento de los modelos, una zona por Worker Thread.
 *
 *   node dist/train.js [--modes SPIKE,DRIFT,STUCK,NOISE] [--samples 4000]
 *                      [--max-depth 6] [--seed 42] [--sequential]
 *
 * Guarda un `modelo-<ZONA>.json` por zona en el directorio de datos e imprime el
 * árbol de la primera zona en texto, que es lo que se lleva al documento.
 */

import { writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { Worker } from "node:worker_threads";
import {
  DecisionTree,
  FEATURE_NAMES,
  type CartOptions,
} from "@monitoreo/detector";
import {
  LOCATIONS,
  createLogger,
  dataDir,
  relativeToRepo,
  type Location,
} from "@monitoreo/shared";
import { ANOMALY_MODES, type AnomalyMode } from "@monitoreo/simulator";
import { DEFAULT_DATASET } from "./dataset";
import type { TrainRequest, TrainResult } from "./train-worker";

const log = createLogger("ENTRENADOR");

export function modelPath(location: Location): string {
  return join(dataDir(), `modelo-${location}.json`);
}

function parseModes(value: string | undefined): AnomalyMode[] {
  if (value === undefined) return [...ANOMALY_MODES];
  return value
    .split(",")
    .map((m) => m.trim().toUpperCase())
    .map((requested) => {
      const mode = ANOMALY_MODES.find((m) => m === requested);
      if (mode === undefined) {
        throw new Error(
          `Modo inválido: '${requested}'. Opciones: ${ANOMALY_MODES.join(", ")}`,
        );
      }
      return mode;
    });
}

function runWorker(request: TrainRequest): Promise<TrainResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(join(__dirname, "train-worker.js"), {
      workerData: request,
    });
    worker.once("message", (result: TrainResult) => resolve(result));
    worker.once("error", reject);
    worker.once("exit", (code) => {
      if (code !== 0) reject(new Error(`El worker terminó con código ${code}`));
    });
  });
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      modes: { type: "string", short: "m" },
      samples: { type: "string", short: "n" },
      "max-depth": { type: "string" },
      "anomaly-rate": { type: "string" },
      seed: { type: "string" },
      sequential: { type: "boolean" },
    },
  });

  const modes = parseModes(values.modes);
  const samplesPerSensor = Number(values.samples ?? 4000);
  const maxDepth = Number(values["max-depth"] ?? 6);
  const anomalyRate = Number(values["anomaly-rate"] ?? DEFAULT_DATASET.anomalyRate);
  const seed = Number(values.seed ?? DEFAULT_DATASET.seed);

  const cart: Partial<CartOptions> = { maxDepth };

  log.info(
    `entrenando ${LOCATIONS.length} modelos | modos=[${modes.join(", ")}] ` +
      `muestras_por_sensor=${samplesPerSensor} profundidad_max=${maxDepth} semilla=${seed}`,
  );
  log.info(
    `paralelismo disponible: ${availableParallelism()} hilos; ` +
      `modo ${values.sequential ? "secuencial" : "paralelo"}`,
  );

  const requests: TrainRequest[] = LOCATIONS.map((location, i) => ({
    dataset: {
      location,
      modes,
      samplesPerSensor,
      anomalyRate,
      // Una semilla distinta por zona: si todas compartieran la misma, los cuatro
      // shards tendrían series idénticas salvo el sesgo geográfico.
      seed: seed + i * 1000,
    },
    cart,
  }));

  const startedAt = Date.now();
  const results = values.sequential
    ? await runSequentially(requests)
    : await Promise.all(requests.map(runWorker));
  const wallClockMs = Date.now() - startedAt;

  for (const result of results) {
    writeFileSync(
      modelPath(result.location as Location),
      `${JSON.stringify(result.model, null, 2)}\n`,
    );
  }

  reportResults(results, wallClockMs, Boolean(values.sequential));
  printFirstTree(results);
}

async function runSequentially(requests: TrainRequest[]): Promise<TrainResult[]> {
  const results: TrainResult[] = [];
  for (const request of requests) results.push(await runWorker(request));
  return results;
}

function reportResults(
  results: readonly TrainResult[],
  wallClockMs: number,
  sequential: boolean,
): void {
  console.log(`\n${"Zona".padEnd(8)}${"Muestras".padStart(10)}${"Anomalías".padStart(11)}${"Tasa".padStart(8)}${"Prof.".padStart(7)}${"Hojas".padStart(7)}${"Tiempo".padStart(9)}`);
  console.log("─".repeat(60));

  let cpuMs = 0;
  for (const r of results) {
    cpuMs += r.elapsedMs;
    console.log(
      r.location.padEnd(8) +
        String(r.totalSamples).padStart(10) +
        String(r.positiveSamples).padStart(11) +
        `${(r.positiveRate * 100).toFixed(1)} %`.padStart(8) +
        String(r.depth).padStart(7) +
        String(r.leafCount).padStart(7) +
        `${r.elapsedMs} ms`.padStart(9),
    );
  }

  console.log("─".repeat(60));
  console.log(
    `Tiempo de pared: ${wallClockMs} ms | trabajo total de CPU: ${cpuMs} ms`,
  );
  if (!sequential) {
    // Con cuatro hilos, el tiempo de pared debería acercarse al del modelo más lento
    // y no a la suma. Ésa es la ganancia observable del paralelismo.
    console.log(
      `Aceleración observada: ${(cpuMs / Math.max(wallClockMs, 1)).toFixed(2)}× ` +
        `(compárese con --sequential)`,
    );
  }
  console.log(`\nModelos guardados en ${relativeToRepo(dataDir())}/`);
}

function printFirstTree(results: readonly TrainResult[]): void {
  const first = results[0];
  if (first === undefined) return;

  const tree = DecisionTree.fromModel(first.model);
  console.log(`\n${"═".repeat(72)}`);
  console.log(`ÁRBOL DE DECISIÓN APRENDIDO — zona ${first.location}`);
  console.log("═".repeat(72));
  console.log(tree.toText());

  console.log("\nImportancia de las características (reparto de la ganancia de Gini):");
  const importance = tree.featureImportance();
  const ordered = [...FEATURE_NAMES].sort((a, b) => importance[b] - importance[a]);
  for (const name of ordered) {
    const share = importance[name];
    const bar = "█".repeat(Math.round(share * 40));
    console.log(`  ${name.padEnd(17)} ${(share * 100).toFixed(1).padStart(5)} %  ${bar}`);
  }
}

main().catch((err: unknown) => {
  log.error(`fallo: ${(err as Error).message}`);
  process.exit(1);
});
