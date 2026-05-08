import { describe, expect, it } from "vitest";
import { computeBackoff, type BackoffOptions } from "./backoff";

const OPTIONS: BackoffOptions = { baseMs: 500, maxMs: 30_000 };

describe("computeBackoff", () => {
  it("crece exponencialmente cuando el jitter devuelve el máximo", () => {
    const atMax = () => 0.999_999;
    expect(computeBackoff(0, OPTIONS, atMax)).toBe(499);
    expect(computeBackoff(1, OPTIONS, atMax)).toBe(999);
    expect(computeBackoff(2, OPTIONS, atMax)).toBe(1999);
    expect(computeBackoff(3, OPTIONS, atMax)).toBe(3999);
  });

  it("respeta el techo", () => {
    const atMax = () => 0.999_999;
    // 500 · 2^10 = 512 000 ms, muy por encima del techo de 30 s.
    expect(computeBackoff(10, OPTIONS, atMax)).toBeLessThanOrEqual(OPTIONS.maxMs);
    expect(computeBackoff(100, OPTIONS, atMax)).toBeLessThanOrEqual(OPTIONS.maxMs);
  });

  it("no desborda a Infinity con exponentes grandes", () => {
    expect(Number.isFinite(computeBackoff(5000, OPTIONS, () => 0.5))).toBe(true);
  });

  it("aplica jitter completo: el mínimo es 0", () => {
    expect(computeBackoff(5, OPTIONS, () => 0)).toBe(0);
  });

  it("produce valores distintos para el mismo intento (evita la manada atronadora)", () => {
    const samples = new Set(
      Array.from({ length: 50 }, () => computeBackoff(8, OPTIONS)),
    );
    expect(samples.size).toBeGreaterThan(1);
  });

  it("trata un intento negativo como el primero", () => {
    expect(computeBackoff(-3, OPTIONS, () => 0.999_999)).toBe(499);
  });
});
