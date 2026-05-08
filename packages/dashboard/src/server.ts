/**
 * Servidor HTTP del tablero, sobre `http.createServer`.
 *
 * Sin framework, por la misma razón que el broker no usa MQTT: el enrutamiento de
 * media docena de rutas cabe en un `switch` y meter Express añadiría dependencias sin
 * enseñar nada. Lo que sí se cuida es lo que un framework daría gratis y aquí hay que
 * hacer a mano: validar los parámetros de la consulta, responder los códigos de estado
 * correctos y no dejar que una excepción tumbe el proceso.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { monitorEventLoopDelay } from "node:perf_hooks";
import {
  LOCATIONS,
  SENSOR_TYPES,
  createLogger,
  type Location,
  type Logger,
  type SensorType,
} from "@monitoreo/shared";
import { renderPage } from "./page";
import { renderMetrics, type ProcessMetrics } from "./prometheus";
import {
  allZoneSummaries,
  detectorComparison,
  recentAlerts,
  sensorsInZone,
  series,
} from "./queries";

export interface DashboardOptions {
  port: number;
  host?: string;
  logger?: Logger;
}

export class Dashboard {
  private readonly server: Server;

  private readonly log: Logger;

  /**
   * Histograma del retraso del bucle de eventos.
   *
   * La propuesta se comprometía a exponer esta métrica. Mide cuánto tarda Node en
   * atender un temporizador que debía dispararse ya: si crece, algo está bloqueando el
   * hilo principal y las respuestas se van a empezar a demorar.
   */
  private readonly loopDelay = monitorEventLoopDelay({ resolution: 10 });

  private readonly startedAt = Date.now();

  constructor(private readonly options: DashboardOptions) {
    this.log = options.logger ?? createLogger("TABLERO");
    this.loopDelay.enable();
    this.server = createServer((req, res) => this.handle(req, res));
  }

  async listen(): Promise<number> {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.options.port, this.options.host ?? "0.0.0.0", () => {
        this.server.removeListener("error", reject);
        resolve();
      });
    });
    const address = this.server.address();
    const port = typeof address === "object" && address !== null ? address.port : -1;
    this.log.info(`escuchando en http://localhost:${port}`);
    return port;
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    // Una excepción dentro de un manejador de petición no debe tumbar el tablero
    // entero: se responde 500 y el proceso sigue sirviendo a los demás.
    try {
      this.route(req, res);
    } catch (err) {
      this.log.error(`error atendiendo ${req.url}: ${(err as Error).message}`);
      if (!res.headersSent) {
        this.json(res, 500, { error: "Error interno del tablero" });
      }
    }
  }

  private route(req: IncomingMessage, res: ServerResponse): void {
    if (req.method !== "GET") {
      res.writeHead(405, { allow: "GET" }).end("Sólo se permite GET");
      return;
    }

    const url = new URL(req.url ?? "/", "http://localhost");

    switch (url.pathname) {
      case "/":
        res
          .writeHead(200, { "content-type": "text/html; charset=utf-8" })
          .end(renderPage());
        return;

      case "/api/resumen":
        this.json(res, 200, {
          zones: allZoneSummaries(),
          types: SENSOR_TYPES,
          alerts: recentAlerts(40),
          serverTime: new Date().toISOString(),
        });
        return;

      case "/api/serie":
        this.serie(url, res);
        return;

      case "/api/comparacion":
        this.json(res, 200, detectorComparison());
        return;

      case "/api/sensores": {
        const location = this.parseLocation(url.searchParams.get("zona"));
        if (location === null) {
          this.json(res, 400, { error: "Parámetro 'zona' inválido o ausente" });
          return;
        }
        this.json(res, 200, { location, sensors: sensorsInZone(location) });
        return;
      }

      case "/metrics":
        res
          .writeHead(200, { "content-type": "text/plain; version=0.0.4; charset=utf-8" })
          .end(renderMetrics(allZoneSummaries(), this.processMetrics()));
        return;

      case "/salud":
        // Endpoint mínimo para comprobar que el proceso responde, sin tocar disco.
        this.json(res, 200, { ok: true, uptimeSeconds: this.uptimeSeconds() });
        return;

      default:
        this.json(res, 404, { error: `Ruta desconocida: ${url.pathname}` });
    }
  }

  private serie(url: URL, res: ServerResponse): void {
    const location = this.parseLocation(url.searchParams.get("zona"));
    if (location === null) {
      this.json(res, 400, {
        error: `Parámetro 'zona' inválido. Opciones: ${LOCATIONS.join(", ")}`,
      });
      return;
    }

    const type = this.parseType(url.searchParams.get("tipo"));
    if (type === null) {
      this.json(res, 400, {
        error: `Parámetro 'tipo' inválido. Opciones: ${SENSOR_TYPES.join(", ")}`,
      });
      return;
    }

    const rawLimit = url.searchParams.get("limite");
    const limit = rawLimit === null ? 120 : Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 2 || limit > 2000) {
      this.json(res, 400, { error: "Parámetro 'limite' fuera de rango (2 a 2000)" });
      return;
    }

    const sensorId = url.searchParams.get("sensor") ?? undefined;
    this.json(res, 200, series(location, type, limit, sensorId));
  }

  private parseLocation(raw: string | null): Location | null {
    if (raw === null) return null;
    return LOCATIONS.find((l) => l === raw.toUpperCase()) ?? null;
  }

  private parseType(raw: string | null): SensorType | null {
    if (raw === null) return null;
    return SENSOR_TYPES.find((t) => t === raw.toUpperCase()) ?? null;
  }

  private uptimeSeconds(): number {
    return (Date.now() - this.startedAt) / 1000;
  }

  processMetrics(): ProcessMetrics {
    return {
      // El histograma reporta en nanosegundos.
      eventLoopLagP99Ms: this.loopDelay.percentile(99) / 1e6,
      memoryBytes: process.memoryUsage().rss,
      uptimeSeconds: this.uptimeSeconds(),
    };
  }

  private json(res: ServerResponse, status: number, body: unknown): void {
    res
      .writeHead(status, { "content-type": "application/json; charset=utf-8" })
      .end(JSON.stringify(body));
  }

  async close(): Promise<void> {
    this.loopDelay.disable();
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve());
    });
    this.log.info("tablero detenido");
  }
}
