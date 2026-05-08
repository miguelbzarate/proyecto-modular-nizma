/**
 * Broker TCP publicador/suscriptor, construido sobre `net.createServer`.
 *
 * Por qué escrito a mano y no MQTT/Kafka/Redis: el criterio 3.2 del comité exige
 * "desarrollar un algoritmo que use el modelo cliente servidor", con la nota explícita
 * de que no basta usar un servicio ya creado. El enrutamiento, el registro de
 * suscriptores, el reensamblado de líneas y la contrapresión son la sustancia del
 * módulo de sistemas distribuidos.
 *
 * Modelo: cualquier conexión puede publicar y/o suscribirse. Los sensores publican
 * `LECTURA`; los ingestores se suscriben a su zona; el alert-manager se suscribe a
 * `ALERTS` y los ingestores publican `ALERTA` ahí.
 */

import * as net from "node:net";
import {
  LineDecoder,
  createLogger,
  decodeLine,
  encodeLine,
  type Logger,
  type Message,
  type Topic,
} from "@monitoreo/shared";

/** Sin señales de vida en este lapso, el cliente se considera caído. */
export const IDLE_TIMEOUT_MS = 90_000;

/** Cada cuánto se revisa la tabla de clientes en busca de silenciosos. */
export const SWEEP_INTERVAL_MS = 15_000;

interface ClientState {
  readonly socket: net.Socket;
  readonly address: string;
  readonly decoder: LineDecoder;
  clientId: string | null;
  topics: Set<Topic>;
  lastSeen: number;
  readingsPublished: number;
  invalidMessages: number;
}

export interface BrokerMetrics {
  connectedClients: number;
  subscribers: number;
  readingsReceived: number;
  readingsRouted: number;
  alertsRouted: number;
  invalidMessages: number;
  idleDisconnects: number;
  backpressurePauses: number;
}

export interface BrokerOptions {
  port: number;
  host?: string;
  logger?: Logger;
  idleTimeoutMs?: number;
  sweepIntervalMs?: number;
}

export class Broker {
  private readonly server: net.Server;

  private readonly clients = new Map<net.Socket, ClientState>();

  /** Suscriptores saturados: mientras haya uno, se pausa la entrada de todos. */
  private readonly saturated = new Set<net.Socket>();

  private sweeper: NodeJS.Timeout | null = null;

  private readonly log: Logger;

  private readonly idleTimeoutMs: number;

  private readonly sweepIntervalMs: number;

  private readonly metrics: BrokerMetrics = {
    connectedClients: 0,
    subscribers: 0,
    readingsReceived: 0,
    readingsRouted: 0,
    alertsRouted: 0,
    invalidMessages: 0,
    idleDisconnects: 0,
    backpressurePauses: 0,
  };

  constructor(private readonly options: BrokerOptions) {
    this.log = options.logger ?? createLogger("BROKER");
    this.idleTimeoutMs = options.idleTimeoutMs ?? IDLE_TIMEOUT_MS;
    this.sweepIntervalMs = options.sweepIntervalMs ?? SWEEP_INTERVAL_MS;
    this.server = net.createServer((socket) => this.accept(socket));
  }

  async listen(): Promise<number> {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(
        this.options.port,
        this.options.host ?? "0.0.0.0",
        () => {
          this.server.removeListener("error", reject);
          resolve();
        },
      );
    });

    this.sweeper = setInterval(() => this.sweepIdle(), this.sweepIntervalMs);
    this.sweeper.unref();

    const address = this.server.address() as net.AddressInfo;
    this.log.info(`escuchando en ${address.address}:${address.port}`);
    return address.port;
  }

  get port(): number {
    const address = this.server.address();
    if (address === null || typeof address === "string") return -1;
    return address.port;
  }

  snapshot(): BrokerMetrics {
    return {
      ...this.metrics,
      connectedClients: this.clients.size,
      subscribers: [...this.clients.values()].filter((c) => c.topics.size > 0)
        .length,
    };
  }

  private accept(socket: net.Socket): void {
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 10_000);

    const address = `${socket.remoteAddress ?? "?"}:${socket.remotePort ?? 0}`;
    const state: ClientState = {
      socket,
      address,
      decoder: new LineDecoder(),
      clientId: null,
      topics: new Set(),
      lastSeen: Date.now(),
      readingsPublished: 0,
      invalidMessages: 0,
    };
    this.clients.set(socket, state);
    this.log.info(`conexión de ${address} (${this.clients.size} activas)`);

    socket.on("data", (chunk: Buffer) => this.onData(state, chunk));
    socket.on("error", (err) =>
      this.log.warn(`socket ${address}: ${err.message}`),
    );
    socket.on("close", () => this.teardown(state, "cierre de conexión"));
  }

  private onData(state: ClientState, chunk: Buffer): void {
    state.lastSeen = Date.now();

    let lines: string[];
    try {
      lines = state.decoder.push(chunk);
    } catch (err) {
      // Una línea sin terminador que crece sin fin no se puede recuperar: la conexión
      // quedó desincronizada y lo correcto es cortarla, no seguir acumulando memoria.
      this.log.warn(
        `${state.address}: ${(err as Error).message}; cerrando conexión`,
      );
      state.socket.destroy();
      return;
    }

    for (const line of lines) {
      const result = decodeLine(line);
      if (!result.ok) {
        // Un mensaje inválido se cuenta y se descarta. No tumba la conexión: un sensor
        // con un bug no debe poder desconectarse a sí mismo del sistema.
        state.invalidMessages += 1;
        this.metrics.invalidMessages += 1;
        this.log.debug(`${state.address}: mensaje inválido -> ${result.error}`);
        this.write(state, { kind: "ERROR", message: result.error });
        continue;
      }
      this.dispatch(state, result.message);
    }
  }

  private dispatch(state: ClientState, message: Message): void {
    switch (message.kind) {
      case "SUBSCRIBE": {
        state.clientId = message.clientId;
        for (const topic of message.topics) state.topics.add(topic);
        this.log.info(
          `${message.clientId} suscrito a [${[...state.topics].join(", ")}]`,
        );
        this.write(state, { kind: "SUBACK", topics: [...state.topics] });
        break;
      }

      case "LECTURA": {
        state.readingsPublished += 1;
        this.metrics.readingsReceived += 1;
        // Una lectura va a los suscriptores de su zona geográfica. Ésta es la
        // partición horizontal en la capa de mensajería, espejo del sharding en disco.
        this.metrics.readingsRouted += this.publish(
          message.location,
          message,
          state.socket,
        );
        break;
      }

      case "ALERTA": {
        this.metrics.alertsRouted += this.publish(
          "ALERTS",
          message,
          state.socket,
        );
        break;
      }

      case "HEARTBEAT": {
        // `lastSeen` ya se actualizó al recibir el chunk. No se reenvía.
        //
        // El latido es además la única forma de saber cómo se llama un cliente que
        // sólo publica: los sensores nunca mandan SUBSCRIBE, así que sin esto
        // quedarían anónimos y el broker reportaría "127.0.0.1:54321 sin señales",
        // que no le sirve de nada a quien tiene que ir a revisar el sensor.
        state.clientId ??= message.clientId;
        this.log.debug(`latido de ${message.clientId}`);
        break;
      }

      case "SUBACK":
      case "ERROR": {
        // Mensajes que sólo emite el broker. Si llegan de un cliente, se ignoran.
        this.log.debug(`${state.address} envió ${message.kind}; ignorado`);
        break;
      }

      default: {
        // Exhaustividad: si se agrega un `kind` al protocolo y no se maneja aquí,
        // esto deja de compilar en lugar de fallar en silencio en producción.
        const _exhaustive: never = message;
        throw new Error(`kind no manejado: ${JSON.stringify(_exhaustive)}`);
      }
    }
  }

  /** Entrega un mensaje a los suscriptores del tema. Devuelve cuántos lo recibieron. */
  private publish(
    topic: Topic,
    message: Message,
    origin: net.Socket | null,
  ): number {
    let delivered = 0;
    for (const client of this.clients.values()) {
      if (client.socket === origin) continue;
      if (!client.topics.has(topic)) continue;
      this.write(client, message);
      delivered += 1;
    }
    return delivered;
  }

  /**
   * Escribe respetando la contrapresión.
   *
   * Si el búfer de salida hacia un suscriptor se llena, `write` devuelve `false`. En
   * ese momento se pausa la lectura de *todas* las conexiones: si se siguiera
   * aceptando lecturas de los sensores, la memoria del broker crecería sin límite
   * hasta tumbar el proceso. Se reanuda cuando todos los saturados drenan.
   */
  private write(client: ClientState, message: Message): void {
    if (client.socket.destroyed) return;

    const hasRoom = client.socket.write(encodeLine(message));
    if (hasRoom || this.saturated.has(client.socket)) return;

    this.saturated.add(client.socket);
    this.metrics.backpressurePauses += 1;
    this.log.debug(`contrapresión hacia ${client.address}`);
    this.applyBackpressure();

    client.socket.once("drain", () => {
      this.saturated.delete(client.socket);
      this.applyBackpressure();
    });
  }

  private applyBackpressure(): void {
    const shouldPause = this.saturated.size > 0;
    for (const client of this.clients.values()) {
      if (shouldPause) client.socket.pause();
      else client.socket.resume();
    }
  }

  /**
   * Detección de cortes silenciosos.
   *
   * Un cable desconectado o una máquina apagada no producen un FIN de TCP: el socket
   * se queda abierto para siempre. Por eso el protocolo lleva latidos a nivel de
   * aplicación, y aquí se cobran.
   */
  private sweepIdle(): void {
    const now = Date.now();
    for (const client of [...this.clients.values()]) {
      if (now - client.lastSeen <= this.idleTimeoutMs) continue;
      const who = client.clientId ?? client.address;
      const silence = Math.round((now - client.lastSeen) / 1000);
      this.log.warn(`${who} sin señales por ${silence}s; desconectando`);
      this.metrics.idleDisconnects += 1;
      client.socket.destroy();
    }
  }

  private teardown(state: ClientState, reason: string): void {
    if (!this.clients.has(state.socket)) return;
    this.clients.delete(state.socket);
    this.saturated.delete(state.socket);
    state.socket.removeAllListeners();
    const who = state.clientId ?? state.address;
    this.log.info(`${who} desconectado (${reason}); quedan ${this.clients.size}`);
    // Un suscriptor saturado que se va no debe dejar pausado al resto del sistema.
    this.applyBackpressure();
  }

  async close(): Promise<void> {
    if (this.sweeper !== null) {
      clearInterval(this.sweeper);
      this.sweeper = null;
    }
    for (const client of [...this.clients.values()]) client.socket.destroy();
    this.clients.clear();
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve());
    });
    this.log.info("broker detenido");
  }
}
