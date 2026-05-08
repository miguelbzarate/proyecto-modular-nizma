#!/usr/bin/env node
/**
 * Demostración de tolerancia a fallos.
 *
 * Corresponde al criterio 3.1.5 del comité: un sistema tolerante a fallos con una
 * justificación del proceso. En vez de afirmarlo, este guion lo provoca y lo mide.
 *
 * Se atraviesan tres tipos de falla, que son distintos entre sí y se recuperan por
 * mecanismos distintos:
 *
 *   1. CAÍDA DE UN SENSOR. Se mata un simulador. El sistema operativo cierra su socket
 *      y el broker se entera de inmediato. El resto de las zonas ni se despeina.
 *
 *   2. CORTE SILENCIOSO. Se CONGELA un simulador con SIGSTOP: el proceso deja de
 *      enviar pero su socket sigue abierto, exactamente como un cable desconectado o
 *      una máquina que se quedó sin corriente. TCP no avisa de esto: el socket puede
 *      quedarse abierto para siempre. Sólo los latidos a nivel de aplicación lo
 *      detectan, y aquí se ve al broker cobrarlos.
 *
 *   3. CAÍDA DEL BROKER, la peor. Se mata el componente central. Los ingestores se
 *      quedan sin nadie con quien hablar y reintentan con retroceso exponencial. Al
 *      revivir el broker se reconectan SOLOS, sin que nadie los toque, y los datos
 *      vuelven a fluir.
 *
 *   node scripts/resiliencia.mjs
 */

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ZONES = ["NORTE", "SUR", "ESTE", "OESTE"];

const { values } = parseArgs({
  options: { puerto: { type: "string", short: "p" } },
});
const PORT = String(values.puerto ?? 8123);

const shardsDir = mkdtempSync(join(tmpdir(), "resiliencia-"));
const env = {
  ...process.env,
  SHARDS_DIR: shardsDir,
  DATA_DIR: shardsDir,
  BROKER_PORT: PORT,
  LOG_LEVEL: "info",
  // El invariante del protocolo es que el latido sea bastante menor que el tiempo de
  // inactividad del broker. En operación son 30 s contra 90 s; aquí se comprimen a
  // 1.5 s contra 6 s para que la demostración quepa en un minuto SIN romper la
  // proporción. Si no se comprimieran ambos, un cliente sano pero callado —el gestor
  // de alertas cuando no hay alertas— sería expulsado por silencioso, y la escena del
  // corte silencioso pasaría por la razón equivocada.
  HEARTBEAT_MS: "1500",
};

const running = new Map();
const journal = [];
let failures = 0;

function launch(name, script, args) {
  const child = spawn(process.execPath, [join(ROOT, script), ...args], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const absorb = (data) => {
    for (const line of data.toString().split("\n")) {
      if (line.trim() !== "") journal.push({ name, line: line.trim() });
    }
  };
  child.stdout.on("data", absorb);
  child.stderr.on("data", absorb);
  running.set(name, child);
  return child;
}

function stop(name, signal = "SIGKILL") {
  const child = running.get(name);
  if (child === undefined) return;
  child.kill(signal);
  if (signal === "SIGKILL" || signal === "SIGTERM") running.delete(name);
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Busca en la bitácora acumulada una línea que contenga el texto dado. */
function journalHas(fragment, sinceIndex = 0) {
  return journal.slice(sinceIndex).some((entry) => entry.line.includes(fragment));
}

/** Espera hasta que aparezca una línea, o se agote el tiempo. */
async function waitForLine(fragment, timeoutMs, sinceIndex = 0) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (journalHas(fragment, sinceIndex)) return true;
    await wait(120);
  }
  return false;
}

async function waitForPort(timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const open = await new Promise((resolve) => {
      const socket = createConnection({ host: "127.0.0.1", port: Number(PORT) });
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => resolve(false));
    });
    if (open) return true;
    await wait(120);
  }
  return false;
}

async function readingsInShard(zone) {
  const { ShardRepository } = await import(
    join(ROOT, "packages/ingestor/dist/shard-repository.js")
  );
  const repository = new ShardRepository(zone, {
    path: join(shardsDir, `${zone}.db`),
    readOnly: true,
  });
  const count = repository.countReadings();
  repository.close();
  return count;
}

async function totalReadings() {
  let total = 0;
  for (const zone of ZONES) {
    try {
      total += await readingsInShard(zone);
    } catch {
      // El shard puede no existir todavía; cuenta como cero.
    }
  }
  return total;
}

function check(description, condition, detail = "") {
  console.log(`   ${condition ? "✓" : "✗"} ${description}${detail ? ` — ${detail}` : ""}`);
  if (!condition) failures += 1;
}

function act(text) {
  console.log(`\n▸ ${text}`);
}

function scene(number, title) {
  console.log(`\n${"═".repeat(72)}`);
  console.log(`ESCENA ${number} — ${title}`);
  console.log("═".repeat(72));
}

function startBroker() {
  // Tiempo de inactividad corto para poder demostrar la detección de cortes
  // silenciosos sin esperar los 90 s de la configuración operativa.
  return launch("broker", "packages/broker/dist/index.js", [
    "--port", PORT, "--idle-timeout", "6", "--sweep-interval", "2",
  ]);
}

function startSimulator(zone) {
  return launch(`simulador-${zone}`, "packages/simulator/dist/index.js", [
    "--location", zone, "--sensors", "1", "--interval", "150", "--port", PORT,
  ]);
}

async function main() {
  console.log("\nDEMOSTRACIÓN DE TOLERANCIA A FALLOS");
  console.log(`Puerto ${PORT}, datos en ${shardsDir}`);

  // ── Preparación ────────────────────────────────────────────────────────────────
  scene(0, "El sistema en operación normal");
  startBroker();
  check("el broker abrió el puerto", await waitForPort());

  launch("alertas", "packages/alert-manager/dist/index.js", [
    "--port", PORT, "--quiet-period", "5",
  ]);
  for (const zone of ZONES) {
    launch(`ingestor-${zone}`, "packages/ingestor/dist/index.js", [
      "--location", zone, "--port", PORT,
    ]);
  }
  await wait(700);
  for (const zone of ZONES) startSimulator(zone);

  await wait(2500);
  const baseline = await totalReadings();
  check("los datos fluyen", baseline > 0, `${baseline} lecturas almacenadas`);

  // ── Escena 1 ───────────────────────────────────────────────────────────────────
  scene(1, "Cae un sensor");
  act("Se mata el simulador de NORTE. Su socket se cierra y el broker lo nota.");
  const mark1 = journal.length;
  stop("simulador-NORTE");

  check(
    "el broker detectó la desconexión",
    await waitForLine("desconectado", 4000, mark1),
  );

  const beforeOthers = await totalReadings();
  await wait(1500);
  const afterOthers = await totalReadings();
  check(
    "las demás zonas siguen operando",
    afterOthers > beforeOthers,
    `+${afterOthers - beforeOthers} lecturas mientras NORTE estaba caído`,
  );

  act("Se vuelve a levantar el sensor de NORTE.");
  const northBefore = await readingsInShard("NORTE");
  startSimulator("NORTE");
  await wait(2000);
  check(
    "NORTE volvió a recibir datos",
    (await readingsInShard("NORTE")) > northBefore,
    `${northBefore} → ${await readingsInShard("NORTE")}`,
  );

  // ── Escena 2 ───────────────────────────────────────────────────────────────────
  scene(2, "Corte silencioso: el sensor deja de hablar sin cerrar la conexión");
  act(
    "Se CONGELA el simulador de SUR con SIGSTOP. El socket queda abierto, así que\n" +
      "  TCP no avisa de nada. Es lo que pasa con un cable desconectado.",
  );
  const mark2 = journal.length;
  stop("simulador-SUR", "SIGSTOP");

  // Se exige que el desconectado sea EL SIMULADOR DE SUR, no cualquier cliente. Sin
  // esta precisión, la prueba pasaría con que el broker expulsara a cualquier otro por
  // estar callado, que es un fenómeno distinto y no demuestra nada.
  const detected = await waitForLine("simulador-SUR", 15_000, mark2);
  const line = journal
    .slice(mark2)
    .find((e) => e.line.includes("simulador-SUR") && e.line.includes("sin señales"));

  check("los latidos detectaron el corte silencioso del sensor de SUR", line !== undefined);
  if (line !== undefined) console.log(`     ${line.line}`);

  check(
    "ningún cliente sano fue expulsado por estar callado",
    !journal
      .slice(mark2)
      .some((e) => e.line.includes("alert-manager sin señales")),
    "el gestor de alertas late aunque no tenga nada que reportar",
  );

  stop("simulador-SUR", "SIGCONT");
  stop("simulador-SUR", "SIGKILL");

  // ── Escena 3 ───────────────────────────────────────────────────────────────────
  scene(3, "Cae el broker, el componente central");
  const beforeOutage = await totalReadings();
  act("Se mata el broker. Todos los ingestores se quedan sin interlocutor.");
  const mark3 = journal.length;
  stop("broker");

  check(
    "los ingestores anuncian que reintentarán",
    await waitForLine("reintento en", 6000, mark3),
  );
  const retries = journal
    .slice(mark3)
    .filter((e) => e.line.includes("reintento en"))
    .slice(0, 4);
  for (const entry of retries) console.log(`     ${entry.line}`);
  check(
    "los reintentos usan retrocesos distintos (jitter)",
    new Set(retries.map((e) => e.line.match(/reintento en (\d+) ms/)?.[1])).size > 1,
    "sin jitter, todos reintentarían en el mismo instante",
  );

  act("El sistema queda a oscuras 4 segundos…");
  await wait(4000);

  act("Se revive el broker. NADIE toca a los ingestores.");
  const mark4 = journal.length;
  startBroker();
  check("el broker volvió a escuchar", await waitForPort());

  const reconnected = await waitForLine("suscrito a", 20_000, mark4);
  check("los ingestores se reconectaron solos", reconnected);

  await wait(2500);
  const afterRecovery = await totalReadings();
  check(
    "los datos volvieron a fluir tras la caída",
    afterRecovery > beforeOutage,
    `${beforeOutage} → ${afterRecovery} lecturas`,
  );

  // ── Cierre ─────────────────────────────────────────────────────────────────────
  scene(4, "Estado final");
  for (const zone of ZONES) {
    const count = await readingsInShard(zone).catch(() => 0);
    check(`${zone} conserva sus datos`, count > 0, `${count} lecturas`);
  }
  // Se comprueba el estado REAL del proceso, no que siga en la tabla interna: el
  // defecto que este guion destapó era justamente que los ingestores terminaban solos
  // y en silencio cuando el broker desaparecía.
  const alive = [...running.entries()].filter(
    ([name, child]) => name.startsWith("ingestor") && child.exitCode === null,
  ).length;
  check(
    "ningún ingestor murió por la caída del broker",
    alive === 4,
    `${alive}/4 ingestores siguen respirando`,
  );
}

try {
  await main();
} catch (err) {
  console.error(`\nError: ${err.message}`);
  failures += 1;
} finally {
  for (const [, child] of running) {
    child.kill("SIGCONT");
    child.kill("SIGKILL");
  }
  rmSync(shardsDir, { recursive: true, force: true });
}

console.log(
  failures === 0
    ? "\nTOLERANCIA A FALLOS: el sistema sobrevivió a las tres fallas\n"
    : `\nTOLERANCIA A FALLOS: ${failures} comprobación(es) fallida(s)\n`,
);
process.exit(failures === 0 ? 0 : 1);
