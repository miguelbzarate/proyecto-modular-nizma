/**
 * Cliente TCP del broker, con reconexión.
 *
 * Lo usan el ingestor, el alert-manager y el simulador. Una sola implementación
 * correcta en lugar de tres a medias: la versión anterior en `worker.ts` creaba un
 * socket nuevo dentro del handler `close` sin desmontar el viejo (sus listeners
 * seguían vivos), declaraba un techo de retroceso que nunca usaba, y parseaba JSON
 * directo del chunk sin reensamblar líneas.
 */

import { EventEmitter } from "node:events";
import * as net from "node:net";
import {
  DEFAULT_BACKOFF,
  computeBackoff,
  type BackoffOptions,
} from "./backoff";
import { LineDecoder } from "./line-decoder";
import { decodeLine, encodeLine, type Message, type Topic } from "./protocol";

export interface BrokerClientOptions {
  host: string;
  port: number;
  /** Identifica al cliente en los logs del broker y en los latidos. */
  clientId: string;
  /** Temas a los que suscribirse en cuanto se establezca la conexión. */
  topics?: readonly Topic[];
  /** Periodo de latido en ms. `0` lo desactiva. */
  heartbeatMs?: number;
  backoff?: BackoffOptions;
}

/**
 * Fusión de declaraciones para tipar los eventos.
 *
 * `EventEmitter` acepta cualquier nombre de evento y cualquier carga útil, así que un
 * `on('conected')` mal escrito compilaría y nunca dispararía. Declarar las firmas aquí
 * hace que el compilador rechace nombres inexistentes y tipe los argumentos del
 * callback. La regla de ESLint desconfía de este patrón porque en general una interfaz
 * puede prometer métodos que la clase no implementa; aquí sólo se refinan sobrecargas
 * de un método que `EventEmitter` ya provee.
 */
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export interface BrokerClient {
  on(event: "connected", cb: () => void): this;
  on(event: "disconnected", cb: (reason: string) => void): this;
  on(event: "message", cb: (message: Message) => void): this;
  on(event: "invalid-protocol", cb: (error: string) => void): this;
  once(event: "connected", cb: () => void): this;
  once(event: "message", cb: (message: Message) => void): this;
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export class BrokerClient extends EventEmitter {
  private socket: net.Socket | null = null;

  private decoder = new LineDecoder();

  private attempt = 0;

  private reconnectTimer: NodeJS.Timeout | null = null;

  private heartbeatTimer: NodeJS.Timeout | null = null;

  private closedOnPurpose = false;

  private readonly heartbeatMs: number;

  private readonly backoff: BackoffOptions;

  constructor(private readonly options: BrokerClientOptions) {
    super();
    this.heartbeatMs = options.heartbeatMs ?? 30_000;
    this.backoff = options.backoff ?? DEFAULT_BACKOFF;
  }

  get connected(): boolean {
    return this.socket !== null && !this.socket.destroyed;
  }

  connect(): void {
    this.closedOnPurpose = false;
    this.openSocket();
  }

  private openSocket(): void {
    // Desmontar cualquier socket previo antes de crear uno nuevo. Ésta es la fuga que
    // tenía la versión original: los listeners del socket viejo seguían registrados y
    // cada ciclo de reconexión duplicaba el manejo de eventos.
    this.teardownSocket();

    const socket = new net.Socket();
    this.socket = socket;
    this.decoder = new LineDecoder();

    socket.setKeepAlive(true, 10_000);
    socket.setNoDelay(true);

    socket.on("connect", () => {
      this.attempt = 0;
      this.emit("connected");
      if (this.options.topics && this.options.topics.length > 0) {
        this.send({
          kind: "SUBSCRIBE",
          clientId: this.options.clientId,
          topics: [...this.options.topics],
        });
      }
      this.startHeartbeat();
    });

    socket.on("data", (chunk: Buffer) => {
      let lines: string[];
      try {
        lines = this.decoder.push(chunk);
      } catch (err) {
        this.emit("invalid-protocol", (err as Error).message);
        socket.destroy();
        return;
      }
      for (const line of lines) {
        const result = decodeLine(line);
        if (result.ok) this.emit("message", result.message);
        else this.emit("invalid-protocol", result.error);
      }
    });

    // 'error' siempre va seguido de 'close', así que la reconexión se agenda una sola
    // vez, en 'close'. Aquí sólo se reporta el motivo.
    socket.on("error", (err) => {
      this.emit("disconnected", err.message);
    });

    socket.on("close", () => {
      this.stopHeartbeat();
      if (!this.closedOnPurpose) this.scheduleReconnect();
    });

    socket.connect({ host: this.options.host, port: this.options.port });
  }

  private scheduleReconnect(): void {
    // Un solo temporizador en vuelo. Sin esta guarda, un 'close' que llegue mientras
    // otro reintento está pendiente multiplica las conexiones.
    if (this.reconnectTimer !== null) return;

    const delay = computeBackoff(this.attempt, this.backoff);
    this.attempt += 1;
    this.emit("disconnected", `reintento en ${delay} ms`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.closedOnPurpose) this.openSocket();
    }, delay);

    // DELIBERADAMENTE SIN `unref()`.
    //
    // `unref()` le dice a Node que ese temporizador no cuenta para mantener vivo el
    // proceso. Cuando el broker se cae, el socket muere y este temporizador es lo
    // único que queda pendiente: con `unref()` el bucle de eventos se vacía y el
    // proceso termina en silencio con código 0, como si hubiera acabado su trabajo.
    //
    // Un ingestor que se apaga solo porque el broker se reinició es peor que uno que
    // falla ruidosamente: nadie se entera de que la zona dejó de vigilarse. Mientras
    // haya una reconexión pendiente, el proceso tiene trabajo y debe seguir vivo.
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    if (this.heartbeatMs <= 0) return;
    this.heartbeatTimer = setInterval(() => {
      this.send({
        kind: "HEARTBEAT",
        clientId: this.options.clientId,
        timestamp: new Date().toISOString(),
      });
    }, this.heartbeatMs);
    this.heartbeatTimer.unref();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private teardownSocket(): void {
    if (this.socket === null) return;
    this.socket.removeAllListeners();
    this.socket.destroy();
    this.socket = null;
  }

  /**
   * Escribe un mensaje. Devuelve `false` si el búfer de salida del kernel está lleno
   * (contrapresión) o si no hay conexión; el que llama decide si descartar o esperar
   * el evento `drain`.
   */
  send(message: Message): boolean {
    if (!this.connected) return false;
    return this.socket!.write(encodeLine(message));
  }

  close(): void {
    this.closedOnPurpose = true;
    this.stopHeartbeat();
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.teardownSocket();
  }
}
