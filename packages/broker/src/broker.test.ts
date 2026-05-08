/**
 * Pruebas de integración del broker con sockets TCP reales.
 *
 * No hay dobles de prueba ni sockets simulados: se levanta un broker en un puerto
 * efímero y se conectan clientes de verdad. Es lo único que demuestra que el
 * enrutamiento por zona funciona de extremo a extremo, que era justo lo que estaba
 * roto (el broker anterior hacía eco al emisor y jamás entregaba a los suscriptores).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BrokerClient,
  readingToMessage,
  type Alert,
  type Location,
  type Message,
  type Reading,
  type Topic,
} from "@monitoreo/shared";
import { Broker } from "./broker";

const SENSOR_A = "11111111-1111-4111-8111-111111111111";
const SENSOR_B = "22222222-2222-4222-8222-222222222222";

/** Silencia el log durante las pruebas para no ensuciar la salida. */
const silentLog = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

function reading(
  location: Location,
  sensorId = SENSOR_A,
  value = 22.5,
): Reading {
  return {
    timestamp: new Date().toISOString(),
    sensorId,
    location,
    type: "TEMPERATURA",
    value,
    unit: "C",
  };
}

function alert(location: Location): Alert {
  return {
    alertId: "33333333-3333-4333-8333-333333333333",
    timestamp: new Date().toISOString(),
    location,
    sensorId: SENSOR_A,
    type: "TEMPERATURA",
    value: 45,
    unit: "C",
    detector: "WELFORD",
    severity: "CRITICAL",
    score: 6.2,
    lowerLimit: 15,
    upperLimit: 30,
    message: "Temperatura fuera de la banda de control",
  };
}

describe("Broker", () => {
  let broker: Broker;
  let port: number;
  const clients: BrokerClient[] = [];

  beforeEach(async () => {
    broker = new Broker({ port: 0, host: "127.0.0.1", logger: silentLog });
    port = await broker.listen();
  });

  afterEach(async () => {
    for (const client of clients) client.close();
    clients.length = 0;
    await broker.close();
  });

  /** Crea un cliente conectado y esperando a que el broker confirme la suscripción. */
  async function connect(
    clientId: string,
    topics?: readonly Topic[],
  ): Promise<BrokerClient> {
    const client = new BrokerClient({
      host: "127.0.0.1",
      port,
      clientId,
      topics,
      heartbeatMs: 0,
    });
    clients.push(client);

    const ready = new Promise<void>((resolve) => {
      if (topics === undefined || topics.length === 0) {
        client.once("connected", () => resolve());
        return;
      }
      client.on("message", (msg) => {
        if (msg.kind === "SUBACK") resolve();
      });
    });

    client.connect();
    await ready;
    return client;
  }

  function collect(client: BrokerClient): Message[] {
    const received: Message[] = [];
    client.on("message", (msg) => received.push(msg));
    return received;
  }

  /** Espera a que se cumpla una condición, o falla por tiempo agotado. */
  async function until(condition: () => boolean, ms = 2000): Promise<void> {
    const deadline = Date.now() + ms;
    while (!condition()) {
      if (Date.now() > deadline) {
        throw new Error("condición no cumplida a tiempo");
      }
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  /** Da tiempo a que un mensaje que NO debería llegar tuviera oportunidad de llegar. */
  async function settle(ms = 150): Promise<void> {
    await new Promise((r) => setTimeout(r, ms));
  }

  it("confirma la suscripción con SUBACK", async () => {
    const subscriber = await connect("ingestor-NORTE", ["NORTE"]);
    expect(subscriber.connected).toBe(true);
    expect(broker.snapshot().subscribers).toBe(1);
  });

  it("entrega una lectura al suscriptor de su zona", async () => {
    const subscriber = await connect("ingestor-NORTE", ["NORTE"]);
    const received = collect(subscriber);
    const publisher = await connect("sensor-1");

    publisher.send(readingToMessage(reading("NORTE")));

    await until(() => received.some((m) => m.kind === "LECTURA"));
    expect(received.find((m) => m.kind === "LECTURA")).toMatchObject({
      location: "NORTE",
      value: 22.5,
    });
  });

  it("aísla las zonas: NORTE no recibe lecturas de SUR", async () => {
    const north = await connect("ingestor-NORTE", ["NORTE"]);
    const south = await connect("ingestor-SUR", ["SUR"]);
    const atNorth = collect(north);
    const atSouth = collect(south);
    const publisher = await connect("sensor-1");

    publisher.send(readingToMessage(reading("SUR", SENSOR_B, 31)));

    await until(() => atSouth.some((m) => m.kind === "LECTURA"));
    await settle();

    expect(atSouth.filter((m) => m.kind === "LECTURA")).toHaveLength(1);
    expect(atNorth.filter((m) => m.kind === "LECTURA")).toHaveLength(0);
  });

  it("no devuelve la lectura al que la publicó", async () => {
    // Regresión directa del bug original: el broker hacía `socket.write` de vuelta al
    // emisor y nunca entregaba a nadie más.
    const publisher = await connect("sensor-1", ["NORTE"]);
    const own = collect(publisher);

    publisher.send(readingToMessage(reading("NORTE")));
    await settle();

    expect(own.filter((m) => m.kind === "LECTURA")).toHaveLength(0);
  });

  it("entrega alertas a los suscriptores de ALERTS", async () => {
    const manager = await connect("alert-manager", ["ALERTS"]);
    const received = collect(manager);
    const ingestor = await connect("ingestor-NORTE", ["NORTE"]);

    ingestor.send({ kind: "ALERTA", ...alert("NORTE") });

    await until(() => received.some((m) => m.kind === "ALERTA"));
    expect(received.find((m) => m.kind === "ALERTA")).toMatchObject({
      severity: "CRITICAL",
      detector: "WELFORD",
    });
  });

  it("un suscriptor de zona no recibe alertas", async () => {
    const ingestor = await connect("ingestor-NORTE", ["NORTE"]);
    const atIngestor = collect(ingestor);
    const other = await connect("ingestor-SUR", ["SUR"]);

    other.send({ kind: "ALERTA", ...alert("SUR") });
    await settle();

    expect(atIngestor.filter((m) => m.kind === "ALERTA")).toHaveLength(0);
  });

  it("reparte la misma lectura entre varios suscriptores de la zona", async () => {
    const one = await connect("ingestor-NORTE-a", ["NORTE"]);
    const two = await connect("dashboard", ["NORTE"]);
    const atOne = collect(one);
    const atTwo = collect(two);
    const publisher = await connect("sensor-1");

    publisher.send(readingToMessage(reading("NORTE")));

    await until(() => atOne.some((m) => m.kind === "LECTURA"));
    await until(() => atTwo.some((m) => m.kind === "LECTURA"));
    expect(broker.snapshot().readingsRouted).toBe(2);
  });

  it("rechaza un mensaje inválido sin cerrar la conexión", async () => {
    const publisher = await connect("sensor-malo");
    const replies = collect(publisher);

    // Unidad incoherente con el tipo de medida.
    publisher.send(
      readingToMessage({ ...reading("NORTE"), unit: "%" } as Reading),
    );

    await until(() => replies.some((m) => m.kind === "ERROR"));
    expect(broker.snapshot().invalidMessages).toBe(1);
    expect(publisher.connected).toBe(true);

    // La conexión sigue sirviendo: una lectura válida después sí se enruta.
    const subscriber = await connect("ingestor-NORTE", ["NORTE"]);
    const received = collect(subscriber);
    publisher.send(readingToMessage(reading("NORTE")));
    await until(() => received.some((m) => m.kind === "LECTURA"));
  });

  it("cuenta las lecturas recibidas aunque nadie esté suscrito", async () => {
    const publisher = await connect("sensor-1");
    publisher.send(readingToMessage(reading("OESTE")));

    await until(() => broker.snapshot().readingsReceived === 1);
    expect(broker.snapshot().readingsRouted).toBe(0);
  });

  it("libera al suscriptor de la tabla al desconectarse", async () => {
    const subscriber = await connect("efimero", ["ESTE"]);
    await until(() => broker.snapshot().subscribers === 1);

    subscriber.close();
    await until(() => broker.snapshot().connectedClients === 0);
  });
});

describe("Broker: detección de cortes silenciosos", () => {
  it("desconecta al cliente que deja de dar señales de vida", async () => {
    // Un cable desenchufado no produce FIN de TCP: el socket queda abierto para
    // siempre. Por eso el protocolo lleva latidos a nivel de aplicación.
    const broker = new Broker({
      port: 0,
      host: "127.0.0.1",
      logger: silentLog,
      idleTimeoutMs: 120,
      sweepIntervalMs: 30,
    });
    const port = await broker.listen();

    const client = new BrokerClient({
      host: "127.0.0.1",
      port,
      clientId: "mudo",
      topics: ["NORTE"],
      heartbeatMs: 0, // nunca late
    });
    const connected = new Promise<void>((r) =>
      client.once("connected", () => r()),
    );
    client.connect();
    await connected;

    const deadline = Date.now() + 3000;
    while (broker.snapshot().idleDisconnects === 0) {
      if (Date.now() > deadline) break;
      await new Promise((r) => setTimeout(r, 20));
    }

    expect(broker.snapshot().idleDisconnects).toBeGreaterThan(0);

    client.close();
    await broker.close();
  });
});

describe("Broker: recuperación tras una caída", () => {
  /**
   * Regresión de un defecto real: el temporizador de reconexión llevaba `unref()`, así
   * que al caerse el broker no quedaba ninguna asa viva en el bucle de eventos y el
   * proceso ingestor terminaba solo, con código 0, sin que nadie se enterara de que la
   * zona había dejado de vigilarse.
   */
  it("el cliente se reconecta solo cuando el broker vuelve al mismo puerto", async () => {
    const first = new Broker({ port: 0, host: "127.0.0.1", logger: silentLog });
    const port = await first.listen();

    const client = new BrokerClient({
      host: "127.0.0.1",
      port,
      clientId: "ingestor-NORTE",
      topics: ["NORTE"],
      heartbeatMs: 0,
      backoff: { baseMs: 20, maxMs: 200 },
    });

    let subacks = 0;
    client.on("message", (msg) => {
      if (msg.kind === "SUBACK") subacks += 1;
    });

    client.connect();
    await until(() => subacks === 1, 3000);

    // Se cae el broker. El cliente debe quedarse esperando, no rendirse.
    await first.close();
    await new Promise((r) => setTimeout(r, 300));
    expect(subacks).toBe(1);

    // Vuelve un broker nuevo al mismo puerto; nadie toca al cliente.
    const second = new Broker({ port, host: "127.0.0.1", logger: silentLog });
    await second.listen();

    await until(() => subacks === 2, 8000);
    expect(client.connected).toBe(true);

    client.close();
    await second.close();
  });

  it("el cliente deja de reintentar si se le cierra a propósito", async () => {
    const broker = new Broker({ port: 0, host: "127.0.0.1", logger: silentLog });
    const port = await broker.listen();

    const client = new BrokerClient({
      host: "127.0.0.1",
      port,
      clientId: "efimero",
      topics: ["NORTE"],
      heartbeatMs: 0,
      backoff: { baseMs: 10, maxMs: 50 },
    });
    const connected = new Promise<void>((r) => client.once("connected", () => r()));
    client.connect();
    await connected;

    client.close();
    await new Promise((r) => setTimeout(r, 300));
    expect(client.connected).toBe(false);

    await broker.close();
  });
});

/** Espera a que se cumpla una condición, o falla por tiempo agotado. */
async function until(condition: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condición no cumplida a tiempo");
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("Broker: métricas", () => {
  it("arranca en ceros", async () => {
    const broker = new Broker({ port: 0, host: "127.0.0.1", logger: silentLog });
    await broker.listen();
    expect(broker.snapshot()).toEqual({
      connectedClients: 0,
      subscribers: 0,
      readingsReceived: 0,
      readingsRouted: 0,
      alertsRouted: 0,
      invalidMessages: 0,
      idleDisconnects: 0,
      backpressurePauses: 0,
    });
    await broker.close();
  });
});
