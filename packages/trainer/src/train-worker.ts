/**
 * Worker Thread que entrena el modelo de una zona.
 *
 * Aquí es donde el paralelismo tiene una razón real de existir, y por eso está aquí y
 * no en el camino de inferencia. Generar el conjunto de datos y buscar los cortes del
 * CART son tareas intensivas en CPU: la búsqueda del mejor corte ordena cada
 * característica en cada nodo, y con decenas de miles de muestras eso bloquearía el
 * event loop durante segundos.
 *
 * Como los cuatro modelos son independientes —uno por shard geográfico—, se entrenan
 * simultáneamente en hilos distintos. Es el criterio 3.1.4 del comité, distribuir el
 * procesamiento de cálculos, con una ganancia medible y no decorativa.
 *
 * La inferencia, en cambio, se queda en el hilo principal del ingestor: recorrer un
 * árbol ya construido son una decena de comparaciones. Montar un hilo para eso sería
 * paralelismo de adorno.
 */

import { parentPort, workerData } from "node:worker_threads";
import { DecisionTree, type CartOptions, type TreeModel } from "@monitoreo/detector";
import { generateDataset, summarize, type DatasetOptions } from "./dataset";

export interface TrainRequest {
  dataset: DatasetOptions;
  cart: Partial<CartOptions>;
}

export interface TrainResult {
  location: string;
  model: TreeModel;
  totalSamples: number;
  positiveSamples: number;
  positiveRate: number;
  depth: number;
  leafCount: number;
  elapsedMs: number;
}

if (parentPort === null) {
  throw new Error("train-worker.ts sólo puede ejecutarse como Worker Thread");
}

const request = workerData as TrainRequest;
const startedAt = Date.now();

const dataset = generateDataset(request.dataset);
const stats = summarize(dataset);
const tree = DecisionTree.fit(dataset.rows, dataset.labels, request.cart);

const result: TrainResult = {
  location: request.dataset.location,
  model: tree.toJSON(),
  totalSamples: stats.total,
  positiveSamples: stats.positives,
  positiveRate: stats.positiveRate,
  depth: tree.depth,
  leafCount: tree.leafCount,
  elapsedMs: Date.now() - startedAt,
};

parentPort.postMessage(result);
