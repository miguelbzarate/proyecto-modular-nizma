import { describe, expect, it } from "vitest";
import { median, quickSelect } from "./quickselect";

/** Referencia ingenua contra la cual contrastar: ordenar y tomar el índice. */
function selectBySorting(values: readonly number[], k: number): number {
  return [...values].sort((a, b) => a - b)[k] as number;
}

describe("quickSelect", () => {
  it("encuentra el mínimo, la mediana y el máximo", () => {
    const values = [7, 2, 9, 4, 1];
    expect(quickSelect([...values], 0)).toBe(1);
    expect(quickSelect([...values], 2)).toBe(4);
    expect(quickSelect([...values], 4)).toBe(9);
  });

  it("coincide con ordenar, para todo k y entradas aleatorias", () => {
    for (let ronda = 0; ronda < 100; ronda += 1) {
      const n = 1 + Math.floor(Math.random() * 40);
      const values = Array.from({ length: n }, () => Math.random() * 200 - 100);
      for (let k = 0; k < n; k += 1) {
        expect(quickSelect([...values], k)).toBe(selectBySorting(values, k));
      }
    }
  });

  it("soporta valores repetidos", () => {
    const values = [5, 5, 5, 5, 5];
    expect(quickSelect([...values], 0)).toBe(5);
    expect(quickSelect([...values], 4)).toBe(5);
  });

  it("no degenera con entradas ya ordenadas ni invertidas", () => {
    // La mediana de tres existe justamente para este caso: con pivote fijo, una
    // entrada ordenada lleva QuickSelect a O(n²).
    const ascending = Array.from({ length: 500 }, (_, i) => i);
    const descending = [...ascending].reverse();
    expect(quickSelect([...ascending], 250)).toBe(250);
    expect(quickSelect([...descending], 250)).toBe(250);
  });

  it("rechaza un arreglo vacío o un k fuera de rango", () => {
    expect(() => quickSelect([], 0)).toThrow();
    expect(() => quickSelect([1, 2, 3], 3)).toThrow();
    expect(() => quickSelect([1, 2, 3], -1)).toThrow();
  });
});

describe("median", () => {
  it("devuelve el central con longitud impar", () => {
    expect(median([3, 1, 2])).toBe(2);
  });

  it("promedia los dos centrales con longitud par", () => {
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  it("no altera el arreglo del llamador", () => {
    const values = [9, 1, 5];
    median(values);
    expect(values).toEqual([9, 1, 5]);
  });

  it("es robusta ante un valor extremo, a diferencia de la media", () => {
    // Ésta es la razón de usar la mediana como referencia adicional en el detector:
    // un solo valor extremo arrastra la media un orden de magnitud, la mediana no.
    const values = [10, 11, 12, 11, 10, 1000];
    const mean = values.reduce((a, b) => a + b, 0) / values.length;

    expect(median(values)).toBe(11);
    expect(mean).toBeGreaterThan(10 * median(values));
  });

  it("coincide con ordenar, para entradas aleatorias", () => {
    for (let ronda = 0; ronda < 50; ronda += 1) {
      const n = 1 + Math.floor(Math.random() * 30);
      const values = Array.from({ length: n }, () => Math.random() * 100);
      const sorted = [...values].sort((a, b) => a - b);
      const mid = n >> 1;
      const expected =
        n % 2 === 1
          ? (sorted[mid] as number)
          : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
      expect(median(values)).toBeCloseTo(expected, 10);
    }
  });

  it("rechaza un arreglo vacío", () => {
    expect(() => median([])).toThrow();
  });
});
