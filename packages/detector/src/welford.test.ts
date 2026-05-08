import { describe, expect, it } from "vitest";
import { Welford } from "./welford";

/** Cálculo directo en dos pasadas: la referencia numéricamente confiable. */
function directStats(values: readonly number[]): { mean: number; variance: number } {
  if (values.length === 0) return { mean: 0, variance: 0 };
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  if (values.length < 2) return { mean, variance: 0 };
  const sumSquares = values.reduce((acc, x) => acc + (x - mean) ** 2, 0);
  return { mean, variance: sumSquares / (values.length - 1) };
}

describe("Welford", () => {
  it("arranca en ceros", () => {
    const stats = new Welford();
    expect(stats.count).toBe(0);
    expect(stats.mean).toBe(0);
    expect(stats.variance).toBe(0);
    expect(stats.stdDev).toBe(0);
  });

  it("una sola muestra tiene media igual al valor y varianza cero", () => {
    const stats = new Welford();
    stats.add(42);
    expect(stats.mean).toBe(42);
    expect(stats.variance).toBe(0);
  });

  it("coincide con el cálculo directo al acumular", () => {
    const values = [2, 4, 4, 4, 5, 5, 7, 9];
    const stats = new Welford();
    for (const v of values) stats.add(v);

    const expected = directStats(values);
    expect(stats.count).toBe(values.length);
    expect(stats.mean).toBeCloseTo(expected.mean, 12);
    expect(stats.variance).toBeCloseTo(expected.variance, 12);
  });

  it("usa el divisor n−1 (varianza muestral)", () => {
    const stats = new Welford();
    for (const v of [1, 2, 3, 4, 5]) stats.add(v);
    // Varianza muestral = 2.5; la poblacional sería 2.
    expect(stats.variance).toBeCloseTo(2.5, 12);
  });

  it("la eliminación deshace exactamente una adición", () => {
    const stats = new Welford();
    for (const v of [10, 20, 30]) stats.add(v);
    const meanBefore = stats.mean;
    const varianceBefore = stats.variance;

    stats.add(999);
    stats.remove(999);

    expect(stats.count).toBe(3);
    expect(stats.mean).toBeCloseTo(meanBefore, 10);
    expect(stats.variance).toBeCloseTo(varianceBefore, 10);
  });

  it("vaciar la ventana la deja en el estado inicial", () => {
    const stats = new Welford();
    stats.add(5);
    stats.remove(5);
    expect(stats.count).toBe(0);
    expect(stats.mean).toBe(0);
    expect(stats.variance).toBe(0);
  });

  it("no se puede quitar de una ventana vacía", () => {
    expect(() => new Welford().remove(1)).toThrow();
  });

  /**
   * La prueba que de verdad importa: simular la ventana deslizante completa —añadir el
   * nuevo y restar el que sale— y comprobar que en cada paso los estadísticos siguen
   * coincidiendo con recalcular los 50 puntos desde cero. Es la garantía de que la
   * optimización O(1) no se paga con resultados equivocados.
   */
  it("la ventana deslizante coincide con recalcular en cada paso", () => {
    const WINDOW = 50;
    const stats = new Welford();
    const window: number[] = [];

    for (let i = 0; i < 2000; i += 1) {
      // Valores del orden de 450 con variación pequeña: el caso donde la fórmula
      // ingenua Σx²/n − (Σx/n)² se desmorona por cancelación catastrófica.
      const value = 450 + Math.sin(i / 7) * 3 + (Math.random() - 0.5) * 2;

      window.push(value);
      stats.add(value);
      if (window.length > WINDOW) {
        stats.remove(window.shift() as number);
      }

      const expected = directStats(window);
      expect(stats.count).toBe(window.length);
      expect(stats.mean).toBeCloseTo(expected.mean, 9);
      expect(stats.variance).toBeCloseTo(expected.variance, 9);
    }
  });

  it("la varianza nunca sale negativa aunque se acumule error", () => {
    const stats = new Welford();
    const window: number[] = [];
    // Serie constante: el caso que más fácilmente empuja M2 a un negativo diminuto.
    for (let i = 0; i < 5000; i += 1) {
      window.push(1000);
      stats.add(1000);
      if (window.length > 10) stats.remove(window.shift() as number);
      expect(stats.variance).toBeGreaterThanOrEqual(0);
    }
    expect(stats.variance).toBeCloseTo(0, 9);
  });

  it("reset devuelve el objeto al estado inicial", () => {
    const stats = new Welford();
    for (const v of [1, 2, 3]) stats.add(v);
    stats.reset();
    expect(stats.count).toBe(0);
    expect(stats.mean).toBe(0);
  });
});
