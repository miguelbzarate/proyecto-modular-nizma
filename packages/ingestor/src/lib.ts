/**
 * Superficie del ingestor como biblioteca.
 *
 * `index.ts` es el proceso: importarlo abriría sockets y empezaría a ingerir. El
 * tablero necesita el repositorio para leer los shards en sólo lectura y nada más, así
 * que la biblioteca y el ejecutable son puntos de entrada distintos.
 */

export * from "./shard-repository";
