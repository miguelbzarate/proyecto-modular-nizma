/**
 * Registro con prefijo por componente.
 *
 * Con siete u ocho procesos en pantalla durante la demostración, saber de un vistazo
 * quién habla importa más que cualquier característica sofisticada de logging. El
 * nivel se controla con la variable de entorno `LOG_LEVEL` (debug|info|warn|error).
 *
 * Los mensajes que emiten los componentes se redactan en español: son la salida que ve
 * el operador durante la defensa del proyecto.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function currentLevel(): LogLevel {
  const raw = (process.env.LOG_LEVEL ?? "info").toLowerCase();
  return raw in ORDER ? (raw as LogLevel) : "info";
}

export interface Logger {
  debug(message: string, ...extra: unknown[]): void;
  info(message: string, ...extra: unknown[]): void;
  warn(message: string, ...extra: unknown[]): void;
  error(message: string, ...extra: unknown[]): void;
}

export function createLogger(component: string): Logger {
  const threshold = ORDER[currentLevel()];
  const prefix = `[${component}]`;

  const emit =
    (level: LogLevel, sink: (...args: unknown[]) => void) =>
    (message: string, ...extra: unknown[]): void => {
      if (ORDER[level] < threshold) return;
      const time = new Date().toISOString().slice(11, 23);
      sink(`${time} ${prefix} ${message}`, ...extra);
    };

  return {
    debug: emit("debug", console.debug.bind(console)),
    info: emit("info", console.info.bind(console)),
    warn: emit("warn", console.warn.bind(console)),
    error: emit("error", console.error.bind(console)),
  };
}
