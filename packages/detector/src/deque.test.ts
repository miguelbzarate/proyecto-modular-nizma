import { describe, expect, it } from "vitest";
import { Deque } from "./deque";

describe("Deque", () => {
  it("rechaza capacidades inválidas", () => {
    expect(() => new Deque<number>(0)).toThrow();
    expect(() => new Deque<number>(-1)).toThrow();
    expect(() => new Deque<number>(2.5)).toThrow();
  });

  it("arranca vacío", () => {
    const deque = new Deque<number>(3);
    expect(deque.size).toBe(0);
    expect(deque.isFull).toBe(false);
    expect(deque.newest).toBeUndefined();
    expect(deque.oldest).toBeUndefined();
    expect(deque.toArray()).toEqual([]);
  });

  it("crece hasta llenarse sin desalojar", () => {
    const deque = new Deque<number>(3);
    expect(deque.push(1)).toBeUndefined();
    expect(deque.push(2)).toBeUndefined();
    expect(deque.push(3)).toBeUndefined();
    expect(deque.isFull).toBe(true);
    expect(deque.toArray()).toEqual([1, 2, 3]);
  });

  it("desaloja el más viejo y lo devuelve", () => {
    const deque = new Deque<number>(3);
    deque.push(1);
    deque.push(2);
    deque.push(3);
    expect(deque.push(4)).toBe(1);
    expect(deque.toArray()).toEqual([2, 3, 4]);
    expect(deque.size).toBe(3);
  });

  it("mantiene el orden cronológico tras varias vueltas al arreglo circular", () => {
    const deque = new Deque<number>(3);
    for (let i = 1; i <= 10; i += 1) deque.push(i);
    expect(deque.toArray()).toEqual([8, 9, 10]);
    expect(deque.oldest).toBe(8);
    expect(deque.newest).toBe(10);
  });

  it("expone extremos correctos con la ventana a medio llenar", () => {
    const deque = new Deque<number>(5);
    deque.push(7);
    deque.push(8);
    expect(deque.oldest).toBe(7);
    expect(deque.newest).toBe(8);
  });

  it("funciona con capacidad uno", () => {
    const deque = new Deque<number>(1);
    expect(deque.push(1)).toBeUndefined();
    expect(deque.push(2)).toBe(1);
    expect(deque.toArray()).toEqual([2]);
  });

  it("queda utilizable tras clear", () => {
    const deque = new Deque<number>(2);
    deque.push(1);
    deque.push(2);
    deque.clear();
    expect(deque.size).toBe(0);
    expect(deque.push(9)).toBeUndefined();
    expect(deque.toArray()).toEqual([9]);
  });
});
