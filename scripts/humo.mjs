#!/usr/bin/env node
/**
 * Prueba de humo de extremo a extremo.
 *
 * Levanta el sistema completo como procesos separados del sistema operativo —un
 * broker, cuatro ingestores, cuatro simuladores— los deja correr unos segundos y
 * verifica contra las bases de datos que:
 *
 *   1. Cada shard recibió lecturas.
 *   2. Ningún shard contiene lecturas de otra zona.
 *   3. Los identificadores de sensor son estables (una serie temporal por sensor,
 *      no un sensor nuevo en cada muestra).
 *   4. Los simuladores inyectan picos y el detector los convierte en alertas
 *      almacenadas, sin alertar sobre la mayoría normal de las lecturas.
 *
 * Es la comprobación que el sistema anterior no pasaba: las bases quedaban vacías
 * porque el broker hacía eco al emisor en vez de enrutar a los suscriptores.
 *
 *   node scripts/humo.mjs [--segundos 6] [--puerto 8099]
 */

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ZONES = ["NORTE", "SUR", "ESTE", "OESTE"];

const { values } = parseArgs({
  options: {
    segundos: { type: "string", short: "s" },
    puerto: { type: "string", short: "p" },
    conservar: { type: "boolean" },
  },
});

const SECONDS = Number(values.segundos ?? 6);
const PORT = String(values.puerto ?? 8099);

const shardsDir = mkdtempSync(join(tmpdir(), "humo-shards-"));
const processes = [];
let failures = 0;

const env = {
  ...process.env,
  SHARDS_DIR: shardsDir,
  DATA_DIR: shardsDir,
  BROKER_PORT: PORT,
  LOG_LEVEL: "warn",
  // node:sqlite es experimental y avisa una vez por proceso; con nueve procesos
  // eso son nueve avisos que no aportan nada a la salida de la prueba.
  NODE_NO_WARNINGS: "1",
};

function launch(name, script, args) {
  const child = spawn(process.execPath, [join(ROOT, script), ...args], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = [];
  child.stdout.on("data", (d) => output.push(d.toString()));
  child.stderr.on("data", (d) => output.push(d.toString()));
  child.on("exit", (code) => {
    if (code !== null && code !== 0) {
      console.error(`\n  ${name} terminó con código ${code}:`);
      console.error(output.join("").split("\n").map((l) => `    ${l}`).join("\n"));
    }
  });
  processes.push({ name, child, output });
  return child;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Espera a que el broker acepte conexiones antes de lanzar a los demás. */
async function waitForPort(port, timeoutMs = 5000) {
  const { createConnection } = await import("node:net");
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const open = await new Promise((resolve) => {
      const socket = createConnection({ host: "127.0.0.1", port: Number(port) });
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => resolve(false));
    });
    if (open) return;
    if (Date.now() > deadline) {
      throw new Error(`el broker no abrió el puerto ${port}`);
    }
    await wait(100);
  }
}

function check(description, condition, detail = "") {
  console.log(`  ${condition ? "✓" : "✗"} ${description}${detail ? ` — ${detail}` : ""}`);
  if (!condition) failures += 1;
}

async function main() {
  console.log(`\nPrueba de humo — puerto ${PORT}, ${SECONDS}s, shards en ${shardsDir}\n`);

  console.log("Levantando procesos…");
  launch("broker", "packages/broker/dist/index.js", ["--port", PORT]);
  await waitForPort(PORT);
  console.log(`  broker escuchando en ${PORT}`);

  for (const zone of ZONES) {
    launch(`ingestor-${zone}`, "packages/ingestor/dist/index.js", [
      "--location", zone, "--port", PORT,
    ]);
  }
  await wait(500);

  for (const zone of ZONES) {
    launch(`simulador-${zone}`, "packages/simulator/dist/index.js", [
      "--location", zone, "--sensors", "2", "--interval", "100", "--port", PORT,
      // Se inyectan picos para ejercitar el detector. Sin anomalías, la prueba sólo
      // demostraría que los datos llegan, no que el Módulo 2 hace algo.
      "--anomaly", "SPIKE", "--anomaly-rate", "0.06",
    ]);
  }
  console.log(`  ${processes.length} procesos activos (1 broker + 4 ingestores + 4 simuladores)`);

  console.log(`\nCorriendo ${SECONDS}s…`);
  await wait(SECONDS * 1000);

  // Se detienen los simuladores y se da un respiro para que los ingestores terminen
  // de escribir lo que ya tenían en vuelo.
  for (const p of processes) {
    if (p.name.startsWith("simulador")) p.child.kill("SIGTERM");
  }
  await wait(600);

  console.log("\nVerificando las bases de datos:\n");
  const { ShardRepository } = await import(
    join(ROOT, "packages/ingestor/dist/shard-repository.js")
  );

  let totalReadings = 0;
  let totalAlerts = 0;
  for (const zone of ZONES) {
    const repository = new ShardRepository(zone, {
      path: join(shardsDir, `${zone}.db`),
      readOnly: true,
    });
    const count = repository.countReadings();
    const alerts = repository.countAlerts();
    const zones = repository.zonesPresent();
    const sensors = new Set(
      repository.latestReadings({ limit: 100000 }).map((r) => r.sensorId),
    );
    totalReadings += count;
    totalAlerts += alerts;

    console.log(`  ${zone}`);
    check("recibió lecturas", count > 0, `${count} filas`);
    check(
      "no contiene otras zonas",
      zones.length === 1 && zones[0] === zone,
      `zonas presentes: ${zones.join(", ") || "ninguna"}`,
    );
    // 2 sensores por tipo × 3 tipos = 6 identificadores estables. Si el sensorId se
    // regenerara por muestra, aquí habría cientos.
    check(
      "los sensores tienen identificador estable",
      sensors.size === 6,
      `${sensors.size} sensores distintos (se esperan 6)`,
    );
    check("el detector levantó alertas", alerts > 0, `${alerts} alertas`);
    // Un detector que alerta sobre todo no detecta nada. La banda de control debe
    // dejar pasar la enorme mayoría de las lecturas normales.
    check(
      "no alerta indiscriminadamente",
      alerts < count * 0.35,
      `${((alerts / Math.max(count, 1)) * 100).toFixed(1)} % de las lecturas`,
    );
    repository.close();
    console.log();
  }

  console.log(
    `  Total: ${totalReadings} lecturas almacenadas, ${totalAlerts} alertas\n`,
  );
  check("el sistema movió datos de punta a punta", totalReadings > 0);
  check("el detector funciona en las cuatro zonas", totalAlerts > 0);
}

try {
  await main();
} catch (err) {
  console.error(`\nError: ${err.message}`);
  failures += 1;
} finally {
  for (const p of processes) p.child.kill("SIGKILL");
  if (!values.conservar) rmSync(shardsDir, { recursive: true, force: true });
  else console.log(`\nShards conservados en ${shardsDir}`);
}

console.log(
  failures === 0 ? "\nPRUEBA DE HUMO: OK\n" : `\nPRUEBA DE HUMO: ${failures} fallo(s)\n`,
);
process.exit(failures === 0 ? 0 : 1);
