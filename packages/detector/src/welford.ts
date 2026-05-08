/**
 * Media y varianza corrientes por el algoritmo de Welford, con soporte de eliminación.
 *
 * ¿Por qué Welford y no acumular Σx y Σx²?
 * La fórmula ingenua calcula la varianza como `Σx²/n − (Σx/n)²`. Con lecturas de
 * calidad del aire alrededor de 450 ppm y una varianza real de unas pocas unidades,
 * esos dos términos son números grandes y casi iguales: al restarlos se pierden casi
 * todas las cifras significativas (cancelación catastrófica) y la varianza puede
 * salir negativa. Welford actualiza la media y la suma de cuadrados de las
 * desviaciones sin construir nunca esos números grandes.
 *
 * Actualización, para cada nueva muestra x:
 *
 *   n'    = n + 1
 *   μ'    = μ + (x − μ) / n'
 *   M2'   = M2 + (x − μ)(x − μ')
 *   s²    = M2' / (n' − 1)          (varianza muestral)
 *
 * La operación inversa permite que la ventana sea deslizante en O(1): cuando el deque
 * desaloja el valor más viejo, se resta en lugar de recalcular los 50 puntos.
 *
 *   n'    = n − 1
 *   μ'    = (n·μ − x) / n'
 *   M2'   = M2 − (x − μ)(x − μ')
 *
 * La eliminación es algebraicamente exacta pero numéricamente menos estable que la
 * adición: tras muchísimos ciclos de alta y baja, M2 puede acumular error y quedar
 * ligeramente negativo. Por eso se acota a cero al leerlo. La prueba unitaria compara
 * este cálculo contra el directo sobre la misma ventana para acotar la deriva.
 */

export class Welford {
  private n = 0;

  private runningMean = 0;

  /** Suma de cuadrados de las desviaciones respecto de la media corriente. */
  private m2 = 0;

  get count(): number {
    return this.n;
  }

  get mean(): number {
    return this.n === 0 ? 0 : this.runningMean;
  }

  /** Varianza muestral (divisor n−1), la usual en cartas de control. */
  get variance(): number {
    if (this.n < 2) return 0;
    // La cota a cero cubre el error de redondeo acumulado por las eliminaciones.
    return Math.max(0, this.m2) / (this.n - 1);
  }

  get stdDev(): number {
    return Math.sqrt(this.variance);
  }

  add(x: number): void {
    this.n += 1;
    const delta = x - this.runningMean;
    this.runningMean += delta / this.n;
    const deltaAfter = x - this.runningMean;
    this.m2 += delta * deltaAfter;
  }

  /**
   * Quita una muestra que se agregó antes.
   *
   * El que llama es responsable de pasar exactamente un valor presente en la ventana;
   * pasar cualquier otro produce estadísticos sin sentido, no un error.
   */
  remove(x: number): void {
    if (this.n === 0) throw new Error("No se puede quitar de una ventana vacía");

    if (this.n === 1) {
      this.n = 0;
      this.runningMean = 0;
      this.m2 = 0;
      return;
    }

    const meanBefore = this.runningMean;
    this.n -= 1;
    this.runningMean = (this.n + 1) * meanBefore - x;
    this.runningMean /= this.n;
    this.m2 -= (x - meanBefore) * (x - this.runningMean);
  }

  reset(): void {
    this.n = 0;
    this.runningMean = 0;
    this.m2 = 0;
  }
}
