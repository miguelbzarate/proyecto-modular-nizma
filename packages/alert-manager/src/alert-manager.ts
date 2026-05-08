/**
 * Agrupación de alertas en incidentes.
 *
 * EL PROBLEMA QUE RESUELVE
 *
 * Un sensor averiado no falla una vez: falla en cada lectura. Un sensor congelado
 * produce una alerta por segundo, indefinidamente. En las pruebas de la fase anterior,
 * siete segundos de sensor atorado generaron veintinueve alertas idénticas.
 *
 * Volcar eso a una consola o a un correo es inútil: el operador ve un muro de texto
 * repetido, y la única forma de sobrevivirlo es dejar de leerlo. Una avalancha de
 * alertas y ningún aviso son, en la práctica, lo mismo.
 *
 * LA SOLUCIÓN
 *
 * Las alertas consecutivas del mismo sensor se agrupan en un INCIDENTE, que tiene
 * apertura, duración y cierre. El operador recibe tres avisos —se abrió, se agravó, se
 * cerró— en lugar de cientos. El detalle completo de cada alerta individual sigue
 * guardándose en el archivo de bitácora, para poder auditarlo después.
 *
 * Un incidente se cierra tras un periodo de silencio: si el sensor deja de alertar
 * durante ese lapso, se considera recuperado.
 */

import type { Alert, Location, SensorType, Severity } from "@monitoreo/shared";

/** Silencio tras el cual un incidente se da por terminado. */
export const DEFAULT_QUIET_PERIOD_MS = 60_000;

const SEVERITY_ORDER: Record<Severity, number> = {
  INFO: 0,
  WARNING: 1,
  CRITICAL: 2,
};

export interface Incident {
  key: string;
  location: Location;
  sensorId: string;
  type: SensorType;
  /** Marca de tiempo de la primera alerta, en milisegundos. */
  startedAt: number;
  lastAt: number;
  alertCount: number;
  maxSeverity: Severity;
  firstValue: number;
  lastValue: number;
  unit: string;
  /** Qué detector lo levantó. Permite comparar estrategias en operación. */
  detector: string;
  lastMessage: string;
}

export type IncidentEventKind = "opened" | "escalated" | "continued" | "closed";

export interface IncidentEvent {
  kind: IncidentEventKind;
  incident: Incident;
}

export interface AlertManagerSnapshot {
  openIncidents: number;
  totalIncidents: number;
  totalAlerts: number;
  alertsByZone: Record<string, number>;
  incidentsBySeverity: Record<Severity, number>;
  suppressedAlerts: number;
}

export interface AlertManagerOptions {
  quietPeriodMs?: number;
}

export class AlertManager {
  private readonly open = new Map<string, Incident>();

  private readonly quietPeriodMs: number;

  private totalIncidents = 0;

  private totalAlerts = 0;

  private suppressedAlerts = 0;

  private readonly alertsByZone: Record<string, number> = {};

  private readonly incidentsBySeverity: Record<Severity, number> = {
    INFO: 0,
    WARNING: 0,
    CRITICAL: 0,
  };

  constructor(options: AlertManagerOptions = {}) {
    this.quietPeriodMs = options.quietPeriodMs ?? DEFAULT_QUIET_PERIOD_MS;
  }

  /**
   * Incorpora una alerta.
   *
   * @param now instante de referencia, inyectable para poder probar el paso del tiempo
   * sin esperar de verdad.
   * @returns el evento que el operador debe ver, o `null` si la alerta sólo engrosa un
   * incidente ya conocido y no aporta información nueva.
   */
  receive(alert: Alert, now: number = Date.now()): IncidentEvent | null {
    this.totalAlerts += 1;
    this.alertsByZone[alert.location] = (this.alertsByZone[alert.location] ?? 0) + 1;

    const key = `${alert.sensorId}|${alert.type}`;
    const existing = this.open.get(key);

    if (existing === undefined) {
      const incident: Incident = {
        key,
        location: alert.location,
        sensorId: alert.sensorId,
        type: alert.type,
        startedAt: now,
        lastAt: now,
        alertCount: 1,
        maxSeverity: alert.severity,
        firstValue: alert.value,
        lastValue: alert.value,
        unit: alert.unit,
        detector: alert.detector,
        lastMessage: alert.message,
      };
      this.open.set(key, incident);
      this.totalIncidents += 1;
      this.incidentsBySeverity[alert.severity] += 1;
      return { kind: "opened", incident };
    }

    existing.lastAt = now;
    existing.alertCount += 1;
    existing.lastValue = alert.value;
    existing.lastMessage = alert.message;

    // Sólo se vuelve a molestar al operador si la situación empeoró.
    if (SEVERITY_ORDER[alert.severity] > SEVERITY_ORDER[existing.maxSeverity]) {
      this.incidentsBySeverity[existing.maxSeverity] -= 1;
      existing.maxSeverity = alert.severity;
      this.incidentsBySeverity[alert.severity] += 1;
      return { kind: "escalated", incident: existing };
    }

    this.suppressedAlerts += 1;
    return null;
  }

  /**
   * Cierra los incidentes que llevan callados más del periodo de silencio.
   *
   * Debe llamarse periódicamente: un incidente no se entera por sí solo de que el
   * sensor se recuperó, porque la recuperación es precisamente la *ausencia* de
   * mensajes.
   */
  sweep(now: number = Date.now()): IncidentEvent[] {
    const closed: IncidentEvent[] = [];
    for (const [key, incident] of [...this.open.entries()]) {
      if (now - incident.lastAt < this.quietPeriodMs) continue;
      this.open.delete(key);
      closed.push({ kind: "closed", incident });
    }
    return closed;
  }

  /** Incidentes abiertos, del más antiguo al más reciente. */
  activeIncidents(): Incident[] {
    return [...this.open.values()].sort((a, b) => a.startedAt - b.startedAt);
  }

  snapshot(): AlertManagerSnapshot {
    return {
      openIncidents: this.open.size,
      totalIncidents: this.totalIncidents,
      totalAlerts: this.totalAlerts,
      alertsByZone: { ...this.alertsByZone },
      incidentsBySeverity: { ...this.incidentsBySeverity },
      suppressedAlerts: this.suppressedAlerts,
    };
  }
}

/** Duración legible: 1500 ms se lee mejor como "1.5 s". */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} min ${Math.round(seconds % 60)} s`;
}

/** Línea que ve el operador en consola para cada evento de incidente. */
export function describeEvent(event: IncidentEvent, now: number = Date.now()): string {
  const { incident: i } = event;
  const who = `${i.location}/${i.type}/${i.sensorId.slice(0, 8)}`;

  switch (event.kind) {
    case "opened":
      return `INCIDENTE ABIERTO  ${who} [${i.maxSeverity}] ${i.lastMessage}`;
    case "escalated":
      return (
        `INCIDENTE AGRAVADO ${who} [${i.maxSeverity}] tras ${i.alertCount} alertas: ` +
        i.lastMessage
      );
    case "continued":
      return `INCIDENTE EN CURSO ${who} ${i.alertCount} alertas acumuladas`;
    case "closed":
      return (
        `INCIDENTE CERRADO  ${who} duró ${formatDuration(i.lastAt - i.startedAt)} ` +
        `con ${i.alertCount} alertas (${i.firstValue}${i.unit} → ${i.lastValue}${i.unit}); ` +
        `sin novedades desde hace ${formatDuration(now - i.lastAt)}`
      );
    default: {
      const _exhaustive: never = event.kind;
      throw new Error(`Evento no manejado: ${String(_exhaustive)}`);
    }
  }
}
