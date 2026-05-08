/**
 * Acceso a datos de un shard geográfico (patrón Repository).
 *
 * Cada zona tiene su propio archivo `.db`. Esto es el particionamiento horizontal que
 * pide el criterio 3.1.2: no es una base central con una columna `zona`, son bases
 * físicamente separadas que se pueden mover, respaldar o perder de forma independiente.
 *
 * Cada proceso ingestor abre exactamente una instancia. Las conexiones de SQLite no se
 * comparten entre procesos ni entre hilos.
 */

import Database from "better-sqlite3";
import {
  createLogger,
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
/** Una lectura tal como quedó en disco, con los veredictos de cada detector. */
export interface StoredReading extends Reading {
  flaggedWelford: number | null;
  flaggedTree: number | null;
}

export interface DetectorVerdicts {
  welford?: boolean;
  tree?: boolean;
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
  private readonly db: Database.Database;

  private readonly insertReadingStmt: Database.Statement;

  private readonly insertAlertStmt: Database.Statement;

  constructor(
    private readonly location: Location,
    options: RepositoryOptions = {},
  ) {
    if (!options.readOnly) ensureShardsDir();
    const path = options.path ?? shardPath(location);

    this.db = new Database(path, {
      readonly: options.readOnly ?? false,
      // El `verbose: console.log` de la versión anterior imprimía cada sentencia SQL.
      // Con cien sensores a una lectura por segundo eso inunda la terminal y arruina
      // la demostración, así que ahora es opcional.
      ...(process.env.SQL_VERBOSE === "1"
        ? {
            verbose: (message?: unknown): void => {
              createLogger(`SQL-${location}`).debug(String(message));
            },
          }
        : {}),
    });

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

  private initSchema(): void {
    // WAL permite que el dashboard lea mientras el ingestor escribe, sin bloquearse.
    this.db.pragma("journal_mode = WAL");
    // NORMAL no espera el fsync en cada commit. En una caída del sistema operativo se
    // pueden perder las últimas transacciones; para telemetría ambiental es un canje
    // razonable y multiplica la tasa de escritura.
    this.db.pragma("synchronous = NORMAL");

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

  /** Inserción por lotes en una sola transacción. La usa el generador de datasets. */
  insertBatch(readings: readonly Reading[]): void {
    const transaction = this.db.transaction((rows: readonly Reading[]) => {
      for (const row of rows) this.insert(row);
    });
    transaction(readings);
  }

  recordAlert(alert: Alert): void {
    this.insertAlertStmt.run(alert);
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
    const params: Record<string, unknown> = { limit: filter.limit ?? 100 };

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
      .all(params) as StoredReading[];
    return rows.reverse();
  }

  latestAlerts(limit = 50): Alert[] {
    return this.db
      .prepare("SELECT * FROM alerts ORDER BY timestamp DESC LIMIT ?")
      .all(limit) as Alert[];
  }

  close(): void {
    this.db.close();
  }
}
