#!/usr/bin/env node
/**
 * Lanzador del sistema completo para demostración manual.
 *
 * Arranca el broker, un ingestor por zona y un simulador por zona como procesos
 * independientes, y multiplexa su salida en una sola terminal con prefijo de color.
 * Ctrl-C los detiene a todos ordenadamente.
 *
 *   node scripts/sistema.mjs [--sensors 2] [--interval 1000] [--port 8080]
 *
 * Para la demostración del criterio 3.3 en dos equipos, este script se sustituye por
 * lanzamientos manuales apuntando `--host` a la máquina del broker.
 */

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ZONES = ["NORTE", "SUR", "ESTE", "OESTE"];

const { values } = parseArgs({
  options: {
    sensors: { type: "string", short: "n" },
    interval: { type: "string", short: "i" },
    port: { type: "string", short: "p" },
    "dashboard-port": { type: "string" },
    anomaly: { type: "string", short: "a" },
    detector: { type: "string", short: "d" },
    "anomaly-duration": { type: "string" },
    "anomaly-rate": { type: "string" },
  },
});

const PORT = String(values.port ?? 8080);
const DASHBOARD_PORT = String(values["dashboard-port"] ?? 3000);
const SENSORS = String(values.sensors ?? 2);
const INTERVAL = String(values.interval ?? 1000);

// 36 cian, 32 verde, 33 amarillo, 35 magenta, 34 azul, y sus variantes brillantes.
const COLORS = [36, 32, 33, 35, 34, 92, 93, 95, 94];
const processes = [];

function launch(name, script, args, color) {
  const child = spawn(process.execPath, [join(ROOT, script), ...args], {
    env: { ...process.env, BROKER_PORT: PORT, NODE_NO_WARNINGS: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const prefix = `[${color}m${name.padEnd(16)}[0m│`;
  const forward = (stream, sink) => {
    let rest = "";
    stream.on("data", (chunk) => {
      const lines = (rest + chunk.toString()).split("\n");
      rest = lines.pop() ?? "";
      for (const line of lines) sink.write(`${prefix} ${line}\n`);
    });
  };
  forward(child.stdout, process.stdout);
  forward(child.stderr, process.stderr);

  child.on("exit", (code, signal) => {
    if (signal === "SIGTERM" || signal === "SIGINT") return;
    process.stderr.write(`${prefix} terminó (código ${code})\n`);
  });

  processes.push(child);
  return child;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Comprueba que un puerto esté libre antes de arrancar.
 *
 * Sin esto, si quedó un sistema anterior corriendo —muy fácil tras un Ctrl-C a medias—
 * el broker y el tablero mueren con EADDRINUSE mientras los demás procesos arrancan
 * normalmente. El resultado es un sistema a medias que no dice por qué no funciona: el
 * tablero no responde y las bases no crecen, sin ningún error visible.
 */
async function portInUse(port) {
  const { createConnection } = await import("node:net");
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port: Number(port) });
    socket.setTimeout(700);
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("timeout", () => { socket.destroy(); resolve(false); });
    socket.once("error", () => resolve(false));
  });
}

const busy = [];
for (const [port, who] of [[PORT, "el broker"], [DASHBOARD_PORT, "el tablero"]]) {
  if (await portInUse(port)) busy.push(`  puerto ${port} (${who})`);
}

if (busy.length > 0) {
  console.error("\nNo se puede arrancar: ya hay algo escuchando en\n");
  console.error(busy.join("\n"));
  console.error("\nSeguramente quedó un sistema anterior corriendo. Para cerrarlo:\n");
  console.error("  pnpm detener\n");
  process.exit(1);
}


console.log(`\nSistema de Monitoreo Ambiental IoT — puerto ${PORT}`);
console.log(`${2 + ZONES.length * 2} procesos independientes. Ctrl-C para detener.\n`);

launch("broker", "packages/broker/dist/index.js", ["--port", PORT], COLORS[0]);
await wait(700);

launch(
  "alertas",
  "packages/alert-manager/dist/index.js",
  ["--port", PORT, "--quiet-period", "20"],
  91,
);

launch(
  "tablero",
  "packages/dashboard/dist/index.js",
  ["--port", DASHBOARD_PORT],
  96,
);

ZONES.forEach((zone, i) => {
  launch(
    `ingestor-${zone}`,
    "packages/ingestor/dist/index.js",
    [
      "--location", zone, "--port", PORT,
      ...(values.detector ? ["--detector", values.detector] : []),
    ],
    COLORS[(i + 1) % COLORS.length],
  );
});
await wait(500);

ZONES.forEach((zone, i) => {
  launch(
    `simulador-${zone}`,
    "packages/simulator/dist/index.js",
    [
      "--location", zone, "--sensors", SENSORS, "--interval", INTERVAL, "--port", PORT,
      ...(values.anomaly
        ? [
            "--anomaly", values.anomaly,
            "--anomaly-rate", String(values["anomaly-rate"] ?? 0.05),
            "--anomaly-duration", String(values["anomaly-duration"] ?? 20),
          ]
        : []),
    ],
    COLORS[(i + 5) % COLORS.length],
  );
});

console.log(`\nTablero en http://localhost:${DASHBOARD_PORT}\n`);

let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  console.log("\nDeteniendo el sistema…");
  // Orden inverso al arranque: primero los sensores dejan de producir, después los
  // ingestores terminan de escribir y al final se cierra el broker.
  for (const child of [...processes].reverse()) child.kill("SIGTERM");
  setTimeout(() => {
    for (const child of processes) child.kill("SIGKILL");
    process.exit(0);
  }, 1500);
}

process.on("SIGINT", stop);
process.on("SIGTERM", stop);
