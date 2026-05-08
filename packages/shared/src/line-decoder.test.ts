import { describe, expect, it } from "vitest";
import { LineDecoder, LineTooLongError } from "./line-decoder";

describe("LineDecoder", () => {
  it("entrega una línea completa", () => {
    const decoder = new LineDecoder();
    expect(decoder.push(Buffer.from('{"a":1}\n'))).toEqual(['{"a":1}']);
  });

  it("entrega varias líneas llegadas en un solo chunk", () => {
    const decoder = new LineDecoder();
    expect(decoder.push(Buffer.from("uno\ndos\ntres\n"))).toEqual([
      "uno",
      "dos",
      "tres",
    ]);
  });

  it("reensambla una línea partida entre chunks", () => {
    const decoder = new LineDecoder();
    expect(decoder.push(Buffer.from('{"valor":2'))).toEqual([]);
    expect(decoder.push(Buffer.from("3.5}\n"))).toEqual(['{"valor":23.5}']);
  });

  it("conserva el resto incompleto tras una línea completa", () => {
    const decoder = new LineDecoder();
    expect(decoder.push(Buffer.from("completa\nparcial"))).toEqual(["completa"]);
    expect(decoder.pending).toBe("parcial");
    expect(decoder.push(Buffer.from("-fin\n"))).toEqual(["parcial-fin"]);
  });

  it("reensambla un carácter UTF-8 partido entre chunks", () => {
    const decoder = new LineDecoder();
    // 'í' son dos bytes en UTF-8; se parten a propósito.
    const bytes = Buffer.from("temperatura mínima\n", "utf8");
    const cut = bytes.indexOf(0xc3); // primer byte de 'í'
    expect(decoder.push(bytes.subarray(0, cut + 1))).toEqual([]);
    expect(decoder.push(bytes.subarray(cut + 1))).toEqual(["temperatura mínima"]);
  });

  it("descarta líneas vacías", () => {
    const decoder = new LineDecoder();
    expect(decoder.push(Buffer.from("\n\nuno\n\n"))).toEqual(["uno"]);
  });

  it("lanza si se supera el tope sin ver terminador", () => {
    const decoder = new LineDecoder(16);
    expect(() => decoder.push(Buffer.from("x".repeat(32)))).toThrow(
      LineTooLongError,
    );
  });

  it("queda utilizable tras reset", () => {
    const decoder = new LineDecoder();
    decoder.push(Buffer.from("basura-sin-fin"));
    decoder.reset();
    expect(decoder.push(Buffer.from("limpio\n"))).toEqual(["limpio"]);
  });
});
