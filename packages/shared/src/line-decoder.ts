/**
 * Reensamblado de líneas sobre un flujo TCP.
 *
 * TCP entrega un flujo de bytes, no mensajes. Un `socket.on('data')` puede traer media
 * lectura, tres lecturas y media, o un carácter UTF-8 partido a la mitad entre dos
 * chunks. Hacer `JSON.parse(chunk.toString())` funciona en pruebas con un sensor lento
 * y falla en cuanto sube la tasa de mensajes.
 *
 * Esta clase centraliza el reensamblado para que broker, ingestor, alert-manager y
 * simulador compartan exactamente el mismo comportamiento.
 */

import { StringDecoder } from "node:string_decoder";

/** Tope de bytes acumulados sin ver un `\n`. Protege contra un cliente que nunca cierra la línea. */
export const MAX_LINE_BYTES = 64 * 1024;

export class LineTooLongError extends Error {
  constructor(limit: number) {
    super(`Línea sin terminador tras ${limit} bytes; conexión inutilizable`);
    this.name = "LineTooLongError";
  }
}

export class LineDecoder {
  /** `StringDecoder` retiene los bytes de un carácter multibyte incompleto. */
  private readonly decoder = new StringDecoder("utf8");

  private buffer = "";

  constructor(private readonly maxLineBytes: number = MAX_LINE_BYTES) {}

  /**
   * Consume un chunk y devuelve las líneas completas que se hayan formado.
   * Las líneas vacías se descartan (un `\n\n` no es un mensaje).
   *
   * @throws {LineTooLongError} si se supera el tope sin ver un terminador.
   */
  push(chunk: Buffer): string[] {
    this.buffer += this.decoder.write(chunk);

    const lines: string[] = [];
    let cut = this.buffer.indexOf("\n");
    while (cut !== -1) {
      const line = this.buffer.slice(0, cut).trim();
      this.buffer = this.buffer.slice(cut + 1);
      if (line.length > 0) lines.push(line);
      cut = this.buffer.indexOf("\n");
    }

    if (Buffer.byteLength(this.buffer, "utf8") > this.maxLineBytes) {
      this.buffer = "";
      throw new LineTooLongError(this.maxLineBytes);
    }

    return lines;
  }

  /** Bytes pendientes de terminador. Útil para diagnóstico y pruebas. */
  get pending(): string {
    return this.buffer;
  }

  reset(): void {
    this.buffer = "";
  }
}
