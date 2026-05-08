#!/usr/bin/env node
/**
 * Detiene cualquier proceso del sistema que haya quedado corriendo.
 *
 * Existe porque un Ctrl-C a destiempo, una terminal cerrada de golpe o un guion
 * interrumpido dejan procesos huérfanos acaparando los puertos 8080 y 3000. El
 * siguiente arranque falla con EADDRINUSE y el sistema queda a medias sin decir por qué.
 *
 *   node scripts/detener.mjs
 */

import { execSync } from "node:child_process";

function run(command) {
  try {
    return execSync(command, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    // Que no haya nada que matar no es un error: es el caso bueno.
    return "";
  }
}

const patterns = ["scripts/sistema.mjs", "packages/.*/dist/index.js"];
let killed = 0;

for (const pattern of patterns) {
  const pids = run(`pgrep -f "${pattern}"`).split("\n").filter(Boolean);
  for (const pid of pids) {
    // SIGCONT primero, por si el proceso quedó congelado por la demostración de
    // resiliencia: un proceso detenido con SIGSTOP no atiende SIGTERM.
    run(`kill -CONT ${pid}`);
    run(`kill -9 ${pid}`);
    killed += 1;
  }
}

// Red de seguridad: cualquier cosa que siga ocupando los puertos del sistema.
for (const port of [8080, 3000]) {
  const pids = run(`lsof -ti:${port}`).split("\n").filter(Boolean);
  for (const pid of pids) {
    run(`kill -9 ${pid}`);
    killed += 1;
  }
}

console.log(
  killed === 0
    ? "No había nada corriendo."
    : `Detenidos ${killed} procesos. Puertos 8080 y 3000 libres.`,
);
