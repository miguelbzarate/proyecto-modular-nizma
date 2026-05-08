/**
 * Resolución de rutas del repositorio.
 *
 * La versión anterior mezclaba dos criterios: `index.ts` creaba el directorio de shards
 * relativo a `__dirname` mientras que `db.ts` abría la base relativa al `cwd`. Con eso,
 * lanzar el proceso desde otro directorio creaba la carpeta en un lado y la base en
 * otro. Aquí se ancla todo a la raíz del repositorio, que se localiza buscando hacia
 * arriba el `pnpm-workspace.yaml`.
 */

import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Location } from "./types";

const ROOT_MARKER = "pnpm-workspace.yaml";

let cachedRoot: string | null = null;

export function repoRoot(from: string = __dirname): string {
  if (cachedRoot !== null) return cachedRoot;

  let current = resolve(from);
  for (;;) {
    if (existsSync(join(current, ROOT_MARKER))) {
      cachedRoot = current;
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      throw new Error(
        `No se encontró la raíz del repositorio (${ROOT_MARKER}) subiendo desde ${from}`,
      );
    }
    current = parent;
  }
}

/** Directorio donde viven los `.db` de cada zona. Configurable para pruebas. */
export function shardsDir(): string {
  return process.env.SHARDS_DIR
    ? resolve(process.env.SHARDS_DIR)
    : join(repoRoot(), "shards");
}

export function shardPath(location: Location): string {
  return join(shardsDir(), `${location}.db`);
}

/** Crea el directorio de shards si no existe. Idempotente. */
export function ensureShardsDir(): string {
  const dir = shardsDir();
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Directorio de artefactos generados: modelos entrenados, datasets, logs de alertas. */
export function dataDir(): string {
  const dir = process.env.DATA_DIR
    ? resolve(process.env.DATA_DIR)
    : join(repoRoot(), "data");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Acorta una ruta absoluta a una relativa a la raíz del repositorio.
 *
 * Los registros no deben imprimir la ruta completa de la máquina donde se compiló:
 * revela el nombre de usuario y la estructura de carpetas de quien la ejecutó, y para
 * quien lee el log no aporta nada. `data/modelo-NORTE.json` dice lo mismo que
 * `/Users/fulano/proyectos/lo-que-sea/data/modelo-NORTE.json` y es más legible.
 */
export function relativeToRepo(absolute: string): string {
  try {
    const root = repoRoot();
    return absolute.startsWith(root)
      ? absolute.slice(root.length).replace(/^\//, "")
      : absolute;
  } catch {
    return absolute;
  }
}
