import { describe, expect, it } from "vitest";
import type { Alert, Severity } from "@monitoreo/shared";
import { AlertManager, describeEvent, formatDuration } from "./alert-manager";

const SENSOR_A = "11111111-1111-4111-8111-111111111111";
const SENSOR_B = "22222222-2222-4222-8222-222222222222";
const T0 = Date.parse("2026-05-05T12:00:00.000Z");

let counter = 0;
function alert(overrides: Partial<Alert> = {}): Alert {
  counter += 1;
  return {
    alertId: `3333333${counter % 10}-3333-4333-8333-333333333333`,
    timestamp: new Date(T0).toISOString(),
    location: "NORTE",
    sensorId: SENSOR_A,
    type: "TEMPERATURA",
    value: 45,
    unit: "C",
    detector: "WELFORD",
    severity: "WARNING" as Severity,
    score: 4.2,
    lowerLimit: 15,
    upperLimit: 30,
    message: "Fuera de banda",
    ...overrides,
  };
}

describe("AlertManager: agrupación en incidentes", () => {
  it("la primera alerta abre un incidente", () => {
    const manager = new AlertManager();
    const event = manager.receive(alert(), T0);

    expect(event?.kind).toBe("opened");
    expect(event?.incident.alertCount).toBe(1);
    expect(manager.snapshot().openIncidents).toBe(1);
  });

  it("las alertas repetidas del mismo sensor no vuelven a avisar", () => {
    // El caso real: un sensor congelado produjo 29 alertas idénticas en 7 segundos.
    // El operador debe ver una, no veintinueve.
    const manager = new AlertManager();
    manager.receive(alert(), T0);

    const events = [];
    for (let i = 1; i <= 28; i += 1) {
      events.push(manager.receive(alert(), T0 + i * 250));
    }

    expect(events.every((e) => e === null)).toBe(true);
    expect(manager.snapshot().totalAlerts).toBe(29);
    expect(manager.snapshot().suppressedAlerts).toBe(28);
    expect(manager.snapshot().totalIncidents).toBe(1);
  });

  it("acumula el conteo dentro del incidente aunque no avise", () => {
    const manager = new AlertManager();
    manager.receive(alert(), T0);
    for (let i = 1; i <= 5; i += 1) manager.receive(alert(), T0 + i * 100);

    expect(manager.activeIncidents()[0]?.alertCount).toBe(6);
  });

  it("avisa de nuevo sólo si la situación empeora", () => {
    const manager = new AlertManager();
    manager.receive(alert({ severity: "WARNING" }), T0);

    expect(manager.receive(alert({ severity: "WARNING" }), T0 + 100)).toBeNull();

    const escalation = manager.receive(alert({ severity: "CRITICAL" }), T0 + 200);
    expect(escalation?.kind).toBe("escalated");
    expect(escalation?.incident.maxSeverity).toBe("CRITICAL");
  });

  it("no degrada la severidad de un incidente ya agravado", () => {
    const manager = new AlertManager();
    manager.receive(alert({ severity: "CRITICAL" }), T0);
    expect(manager.receive(alert({ severity: "WARNING" }), T0 + 100)).toBeNull();
    expect(manager.activeIncidents()[0]?.maxSeverity).toBe("CRITICAL");
  });

  it("separa los incidentes por sensor", () => {
    const manager = new AlertManager();
    manager.receive(alert({ sensorId: SENSOR_A }), T0);
    const second = manager.receive(alert({ sensorId: SENSOR_B }), T0);

    expect(second?.kind).toBe("opened");
    expect(manager.snapshot().openIncidents).toBe(2);
  });

  it("separa los incidentes por tipo de medida del mismo sensor", () => {
    const manager = new AlertManager();
    manager.receive(alert({ type: "TEMPERATURA", unit: "C" }), T0);
    const second = manager.receive(alert({ type: "HUMEDAD", unit: "%" }), T0);

    expect(second?.kind).toBe("opened");
    expect(manager.snapshot().openIncidents).toBe(2);
  });
});

describe("AlertManager: cierre por silencio", () => {
  it("cierra el incidente tras el periodo de silencio", () => {
    const manager = new AlertManager({ quietPeriodMs: 1000 });
    manager.receive(alert(), T0);

    expect(manager.sweep(T0 + 500)).toHaveLength(0);

    const closed = manager.sweep(T0 + 1500);
    expect(closed).toHaveLength(1);
    expect(closed[0]?.kind).toBe("closed");
    expect(manager.snapshot().openIncidents).toBe(0);
  });

  it("una alerta nueva reinicia el reloj de silencio", () => {
    const manager = new AlertManager({ quietPeriodMs: 1000 });
    manager.receive(alert(), T0);
    manager.receive(alert(), T0 + 900);

    expect(manager.sweep(T0 + 1500)).toHaveLength(0);
    expect(manager.sweep(T0 + 2000)).toHaveLength(1);
  });

  it("un sensor que vuelve a fallar tras cerrarse abre un incidente nuevo", () => {
    const manager = new AlertManager({ quietPeriodMs: 1000 });
    manager.receive(alert(), T0);
    manager.sweep(T0 + 2000);

    const reopened = manager.receive(alert(), T0 + 3000);
    expect(reopened?.kind).toBe("opened");
    expect(manager.snapshot().totalIncidents).toBe(2);
  });

  it("cierra varios incidentes a la vez", () => {
    const manager = new AlertManager({ quietPeriodMs: 1000 });
    manager.receive(alert({ sensorId: SENSOR_A }), T0);
    manager.receive(alert({ sensorId: SENSOR_B }), T0);

    expect(manager.sweep(T0 + 2000)).toHaveLength(2);
  });
});

describe("AlertManager: contadores", () => {
  it("cuenta las alertas por zona", () => {
    const manager = new AlertManager();
    manager.receive(alert({ location: "NORTE", sensorId: SENSOR_A }), T0);
    manager.receive(alert({ location: "SUR", sensorId: SENSOR_B }), T0);
    manager.receive(alert({ location: "SUR", sensorId: SENSOR_B }), T0 + 10);

    expect(manager.snapshot().alertsByZone).toEqual({ NORTE: 1, SUR: 2 });
  });

  it("cuenta los incidentes por severidad y los mueve al agravarse", () => {
    const manager = new AlertManager();
    manager.receive(alert({ severity: "WARNING" }), T0);
    expect(manager.snapshot().incidentsBySeverity.WARNING).toBe(1);

    manager.receive(alert({ severity: "CRITICAL" }), T0 + 100);
    const s = manager.snapshot();
    expect(s.incidentsBySeverity.WARNING).toBe(0);
    expect(s.incidentsBySeverity.CRITICAL).toBe(1);
  });

  it("arranca en ceros", () => {
    expect(new AlertManager().snapshot()).toEqual({
      openIncidents: 0,
      totalIncidents: 0,
      totalAlerts: 0,
      alertsByZone: {},
      incidentsBySeverity: { INFO: 0, WARNING: 0, CRITICAL: 0 },
      suppressedAlerts: 0,
    });
  });

  it("lista los incidentes activos del más antiguo al más reciente", () => {
    const manager = new AlertManager();
    manager.receive(alert({ sensorId: SENSOR_B }), T0 + 1000);
    manager.receive(alert({ sensorId: SENSOR_A }), T0);

    expect(manager.activeIncidents().map((i) => i.sensorId)).toEqual([
      SENSOR_A,
      SENSOR_B,
    ]);
  });
});

describe("formatDuration", () => {
  it("usa la unidad legible según la magnitud", () => {
    expect(formatDuration(500)).toBe("500 ms");
    expect(formatDuration(1500)).toBe("1.5 s");
    expect(formatDuration(90_000)).toBe("1 min 30 s");
  });
});

describe("describeEvent", () => {
  it("describe la apertura con la severidad y el mensaje", () => {
    const manager = new AlertManager();
    const event = manager.receive(alert(), T0)!;
    const text = describeEvent(event, T0);

    expect(text).toContain("INCIDENTE ABIERTO");
    expect(text).toContain("NORTE/TEMPERATURA");
    expect(text).toContain("Fuera de banda");
  });

  it("el cierre resume duración y número de alertas", () => {
    const manager = new AlertManager({ quietPeriodMs: 1000 });
    manager.receive(alert({ value: 45 }), T0);
    manager.receive(alert({ value: 52 }), T0 + 4000);
    const closed = manager.sweep(T0 + 6000)[0]!;

    const text = describeEvent(closed, T0 + 6000);
    expect(text).toContain("INCIDENTE CERRADO");
    expect(text).toContain("2 alertas");
    expect(text).toContain("45C → 52C");
  });
});
