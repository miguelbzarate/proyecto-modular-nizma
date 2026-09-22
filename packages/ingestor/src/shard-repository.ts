/**
 * Acceso a datos de un shard geográfico (patrón Repository).
 *
 * Cada zona tiene su propio archivo `.db`. Esto es el particionamiento horizontal que
 * pide el criterio 3.1.2: no es una base central con una columna `zona`, son bases
 * físicamente separadas que se pueden mover, respaldar o perder de forma independiente.
 *
 * Cada proceso ingestor abre exactamente una instancia. Las conexiones de SQLite no se
 * comparten entre procesos ni entre hilos.
 *
 * SOBRE EL MOTOR: se usa `node:sqlite`, el SQLite que Node trae incorporado desde la
 * versión 22, en lugar de la biblioteca `better-sqlite3`.
 *
 * El motivo es de portabilidad, y salió de un problema real: `better-sqlite3` a partir
 * de la versión 13 dejó de publicar binarios precompilados, así que instalarlo obliga a
 * compilar código C++ en la máquina de destino. En macOS suele funcionar porque las
 * herramientas de Xcode ya están; en Windows exige instalar Visual Studio con la carga
 * de trabajo de C++, unos seis gigabytes, y falla con errores de `node-gyp` difíciles
 * de interpretar para quien sólo quiere ejecutar el proyecto.
 *
 * `node:sqlite` es el mismo motor SQLite, ya compilado dentro de Node. El proyecto
 * queda sin una sola dependencia nativa y `pnpm install` funciona en cualquier sistema
 * operativo sin herramientas de compilación.
 */

import { DatabaseSync, type StatementSync } from "node:sqlite";
import {
  ensureShardsDir,
  shardPath,
  type Alert,
  type Location,
  type Reading,
  type SensorType,
} from "@monitoreo/shared";

export interface RepositoryOptions {
  /** Ruta explícita al `.db`. Por defecto, la del shard en el directorio del repo. */
  path?: string;
  /** Abre en sólo lectura. Lo usa el dashboard, que jamás debe escribir. */
  readOnly?: boolean;
}

/**
 * Qué dijo cada detector sobre una lectura. `undefined` significa que ese detector no
 * estaba corriendo, y se distingue de `false`, que significa que sí corrió y la dejó pasar.
 */
export interface DetectorVerdicts {
  welford?: boolean;
  tree?: boolean;
}

/** Una lectura tal como quedó en disco, con los veredictos de cada detector. */
export interface StoredReading extends Reading {
  flaggedWelford: number | null;
  flaggedTree: number | null;
}

function toFlag(verdict: boolean | undefined): number | null {
  return verdict === undefined ? null : verdict ? 1 : 0;
}

export interface ReadingFilter {
  sensorId?: string;
  type?: SensorType;
  limit?: number;
}

export class ShardRepository {
  private readonly db: DatabaseSync;

  private readonly insertReadingStmt: StatementSync;

  private readonly insertAlertStmt: StatementSync;

  constructor(
    private readonly location: Location,
    options: RepositoryOptions = {},
  ) {
    if (!options.readOnly) ensureShardsDir();
    const path = options.path ?? shardPath(location);

    this.db = new DatabaseSync(path, { readOnly: options.readOnly ?? false });

    if (!options.readOnly) {
      this.initSchema();
      this.migrate();
    }

    this.insertReadingStmt = this.db.prepare(`
      INSERT INTO readings
        (timestamp, sensorId, location, type, value, unit, flaggedWelford, flaggedTree)
      VALUES
        (@timestamp, @sensorId, @location, @type, @value, @unit,
         @flaggedWelford, @flaggedTree)
    `);

    this.insertAlertStmt = this.db.prepare(`
      INSERT OR IGNORE INTO alerts
        (alertId, timestamp, sensorId, location, type, value, unit,
         detector, severity, score, lowerLimit, upperLimit, message)
      VALUES
        (@alertId, @timestamp, @sensorId, @location, @type, @value, @unit,
         @detector, @severity, @score, @lowerLimit, @upperLimit, @message)
    `);
  }

  private initSchema(): void {
    // WAL permite que el dashboard lea mientras el ingestor escribe, sin bloquearse.
    this.db.exec("PRAGMA journal_mode = WAL");
    // NORMAL no espera el fsync en cada commit. En una caída del sistema operativo se
    // pueden perder las últimas transacciones; para telemetría ambiental es un canje
    // razonable y multiplica la tasa de escritura.
    this.db.exec("PRAGMA synchronous = NORMAL");

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS readings (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp  TEXT NOT NULL,
        sensorId   TEXT NOT NULL,
        location   TEXT NOT NULL,
        type       TEXT NOT NULL,
        value      REAL NOT NULL,
        unit       TEXT NOT NULL,
        -- Veredicto de CADA detector sobre esta misma lectura, para poder compararlos
        -- sobre datos idénticos. 1 = la marcó anómala, 0 = la dejó pasar,
        -- NULL = ese detector no estaba disponible.
        flaggedWelford INTEGER,
        flaggedTree    INTEGER
      );

      -- El dashboard y la ventana deslizante consultan por sensor y tipo ordenando por
      -- tiempo. Sin este índice cada consulta recorre la tabla completa.
      CREATE INDEX IF NOT EXISTS idx_readings_sensor_type_time
        ON readings (sensorId, type, timestamp);

      CREATE INDEX IF NOT EXISTS idx_readings_time
        ON readings (timestamp);

      CREATE TABLE IF NOT EXISTS alerts (
        alertId    TEXT PRIMARY KEY,
        timestamp  TEXT NOT NULL,
        sensorId   TEXT NOT NULL,
        location   TEXT NOT NULL,
        type       TEXT NOT NULL,
        value      REAL NOT NULL,
        unit       TEXT NOT NULL,
        detector   TEXT NOT NULL,
        severity   TEXT NOT NULL,
        score      REAL NOT NULL,
        lowerLimit REAL,
        upperLimit REAL,
        message    TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_alerts_time ON alerts (timestamp);
    `);
  }

  /**
   * Agrega columnas que no existían en versiones anteriores del esquema.
   *
   * `CREATE TABLE IF NOT EXISTS` no modifica una tabla ya creada, así que un shard de
   * antes quedaría sin las columnas nuevas y toda consulta fallaría. Se comprueba y se
   * agregan, en vez de obligar a borrar los datos.
   */
  private migrate(): void {
    const columns = new Set(
      (this.db.prepare("PRAGMA table_info(readings)").all() as { name: string }[]).map(
        (c) => c.name,
      ),
    );
    for (const column of ["flaggedWelford", "flaggedTree"]) {
      if (!columns.has(column)) {
        this.db.exec(`ALTER TABLE readings ADD COLUMN ${column} INTEGER`);
      }
    }
  }

  /**
   * Inserta una lectura.
   *
   * @throws si la lectura no pertenece a este shard. Es defensa en profundidad: el
   * broker ya enruta por zona, pero un error de enrutamiento debe explotar aquí en vez
   * de contaminar los datos en silencio y romper el particionamiento.
   */
  insert(reading: Reading, verdicts: DetectorVerdicts = {}): void {
    if (reading.location !== this.location) {
      throw new Error(
        `Lectura de la zona ${reading.location} no pertenece al shard ${this.location}`,
      );
    }
    this.insertReadingStmt.run({
      ...reading,
      flaggedWelford: toFlag(verdicts.welford),
      flaggedTree: toFlag(verdicts.tree),
    });
  }

  /**
   * Inserción por lotes en una sola transacción.
   *
   * `node:sqlite` no trae el envoltorio `transaction()` de better-sqlite3, así que el
   * control es explícito. Si algo falla a medias se deshace todo: un lote a medio
   * insertar es peor que un lote no insertado, porque deja la serie con huecos
   * silenciosos.
   */
  insertBatch(readings: readonly Reading[]): void {
    this.db.exec("BEGIN");
    try {
      for (const row of readings) this.insert(row);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  recordAlert(alert: Alert): void {
    this.insertAlertStmt.run({ ...alert });
  }

  countReadings(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM readings").get() as {
      n: number;
    };
    return row.n;
  }

  countAlerts(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM alerts").get() as {
      n: number;
    };
    return row.n;
  }

  /** Zonas distintas presentes en la tabla. En un shard sano siempre devuelve una. */
  zonesPresent(): string[] {
    const rows = this.db
      .prepare("SELECT DISTINCT location FROM readings")
      .all() as { location: string }[];
    return rows.map((r) => r.location);
  }

  /** Últimas lecturas en orden cronológico ascendente (listas para graficar). */
  latestReadings(filter: ReadingFilter = {}): StoredReading[] {
    const conditions: string[] = [];
    // El tipo de node:sqlite sólo admite valores que SQLite entienda, no `unknown`.
    const params: Record<string, string | number> = { limit: filter.limit ?? 100 };

    if (filter.sensorId !== undefined) {
      conditions.push("sensorId = @sensorId");
      params.sensorId = filter.sensorId;
    }
    if (filter.type !== undefined) {
      conditions.push("type = @type");
      params.type = filter.type;
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    // Se toman las N más recientes y luego se invierte, para no ordenar la tabla
    // entera de forma ascendente sólo para quedarse con la cola.
    const rows = this.db
      .prepare(
        `SELECT timestamp, sensorId, location, type, value, unit,
                flaggedWelford, flaggedTree
           FROM readings ${where}
          ORDER BY id DESC
          LIMIT @limit`,
      )
      .all(params) as unknown as StoredReading[];
    return rows.reverse();
  }

  latestAlerts(limit = 50): Alert[] {
    return this.db
      .prepare("SELECT * FROM alerts ORDER BY timestamp DESC LIMIT @limit")
      .all({ limit }) as unknown as Alert[];
  }

  close(): void {
    this.db.close();
  }
}
