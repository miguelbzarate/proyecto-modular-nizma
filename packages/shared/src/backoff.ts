/**
 * Retroceso exponencial con jitter para reconexiones.
 *
 * Sin jitter, si el broker se cae y vuelve, todos los clientes reintentan en el mismo
 * instante y lo tumban otra vez (el "problema de la manada atronadora"). La variante
 * implementada es *full jitter*: se toma un valor uniforme entre 0 y el techo
 * exponencial, no el techo mismo.
 *
 *   retardo = aleatorio(0, min(techo, base · 2^intento))
 */

export interface BackoffOptions {
  /** Retardo base en milisegundos. */
  baseMs: number;
  /** Techo absoluto del retardo, en milisegundos. */
  maxMs: number;
}

/**
 * El techo de 10 s es deliberadamente bajo.
 *
 * Con un techo de 30 s y jitter completo, una caída de cuatro segundos podía dejar al
 * ingestor esperando media horita larga antes del siguiente intento: para entonces el
 * broker llevaba rato disponible y la zona seguía sin vigilancia. En un sistema de
 * monitoreo, el costo de un intento fallido es despreciable y el de un punto ciego
 * prolongado no lo es.
 */
export const DEFAULT_BACKOFF: BackoffOptions = {
  baseMs: 500,
  maxMs: 10_000,
};

/**
 * @param attempt Número de reintento, empezando en 0 para el primero.
 * @param random Inyectable para poder probar el cálculo de forma determinista.
 */
export function computeBackoff(
  attempt: number,
  options: BackoffOptions = DEFAULT_BACKOFF,
  random: () => number = Math.random,
): number {
  const safe = Math.max(0, attempt);
  // El exponente se limita antes de la potencia para no desbordar a Infinity.
  const exponent = Math.min(safe, 32);
  const ceiling = Math.min(options.maxMs, options.baseMs * 2 ** exponent);
  return Math.floor(random() * ceiling);
}
