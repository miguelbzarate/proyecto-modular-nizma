/**
 * Ventana deslizante por sensor, y extracción de características.
 *
 * Decisión de diseño importante: las características de una lectura se calculan con
 * el estado de la ventana ANTES de incorporarla ("predecir, luego actualizar").
 *
 * Si se agregara primero, el valor anómalo entraría en su propia media y en su propia
 * desviación estándar. Con una ventana de 50 puntos, un pico se diluye pero también
 * infla la desviación, y el `zScore` que produce es sistemáticamente menor que el
 * real: el detector se sabotea a sí mismo. Peor todavía con ventanas cortas.
 *
 * Por eso `observe()` devuelve el vector calculado contra el pasado, y sólo entonces
 * incorpora la lectura para las siguientes.
 */

import type { Reading } from "@monitoreo/shared";
import { Deque } from "./deque";
import { median } from "./quickselect";
import { Welford } from "./welford";
import type { FeatureVector } from "./features";

/** Tamaño por defecto de la ventana, en muestras. */
export const DEFAULT_WINDOW_SIZE = 50;

interface Sample {
  value: number;
  timeMs: number;
}

/**
 * Piso de la desviación estándar.
 *
 * Un sensor atorado repite el mismo valor y su desviación tiende a cero; sin piso,
 * cualquier diferencia mínima produce un z-score infinito y una avalancha de alertas
 * falsas. El piso convierte esa división en algo acotado.
 */
const MIN_STD_DEV = 1e-6;

export class SensorWindow {
  private readonly samples: Deque<Sample>;

  private readonly stats = new Welford();

  constructor(readonly capacity: number = DEFAULT_WINDOW_SIZE) {
    this.samples = new Deque<Sample>(capacity);
  }

  get size(): number {
    return this.samples.size;
  }

  /**
   * Calcula las características de la lectura contra el historial previo y la
   * incorpora a la ventana.
   */
  observe(reading: Reading): FeatureVector {
    const timeMs = Date.parse(reading.timestamp);
    const previous = this.samples.newest;
    const sampleCount = this.samples.size;

    const mean = this.stats.mean;
    const stdDev = this.stats.stdDev;
    const safeStdDev = Math.max(stdDev, MIN_STD_DEV);
    const history = this.samples.toArray();
    const windowMedian =
      sampleCount > 0 ? median(history.map((s) => s.value)) : reading.value;
    const trend = computeTrend(history, safeStdDev);

    const delta = previous === undefined ? 0 : reading.value - previous.value;
    const elapsedSeconds =
      previous === undefined ? 0 : (timeMs - previous.timeMs) / 1000;
    // Dos lecturas con el mismo sello de tiempo darían una tasa infinita. Se reporta
    // cero: sin transcurso de tiempo no hay tasa de cambio observable.
    const rateOfChange =
      elapsedSeconds > 0 ? delta / elapsedSeconds : 0;

    const features: FeatureVector = {
      value: reading.value,
      zScore: sampleCount > 0 ? (reading.value - mean) / safeStdDev : 0,
      delta,
      rateOfChange,
      medianDeviation:
        sampleCount > 0 ? (reading.value - windowMedian) / safeStdDev : 0,
      trend,
      hourOfDay: hourOfDayFrom(timeMs),
      sampleCount,
      mean,
      stdDev,
      median: windowMedian,
    };

    this.push(reading.value, timeMs);
    return features;
  }

  private push(value: number, timeMs: number): void {
    const evicted = this.samples.push({ value, timeMs });
    // El deque devuelve lo que desalojó, y eso es justo lo que Welford necesita restar
    // para que la ventana sea deslizante sin recalcular los 50 puntos.
    if (evicted !== undefined) this.stats.remove(evicted.value);
    this.stats.add(value);
  }

  reset(): void {
    this.samples.clear();
    this.stats.reset();
  }
}

function hourOfDayFrom(timeMs: number): number {
  const date = new Date(timeMs);
  return date.getHours() + date.getMinutes() / 60;
}

/**
 * Desplazamiento entre las dos mitades de la ventana, en desviaciones estándar.
 *
 * Es un estadístico de dos muestras: si la serie sólo tiene ruido, ambas mitades
 * estiman la misma media y el resultado ronda cero. Si hay una deriva en curso, la
 * mitad reciente está sistemáticamente por encima (o por debajo) de la antigua.
 *
 * Se exige un mínimo de cuatro muestras porque con menos las dos mitades tienen uno o
 * dos puntos y el estadístico es puro ruido.
 */
function computeTrend(
  history: readonly { value: number }[],
  safeStdDev: number,
): number {
  if (history.length < 4) return 0;

  const half = history.length >> 1;
  let olderSum = 0;
  let recentSum = 0;
  for (let i = 0; i < half; i += 1) olderSum += history[i]!.value;
  for (let i = history.length - half; i < history.length; i += 1) {
    recentSum += history[i]!.value;
  }

  return (recentSum / half - olderSum / half) / safeStdDev;
}

/**
 * Colección de ventanas, una por combinación de sensor y tipo de medida.
 *
 * La clave incluye el tipo porque un mismo dispositivo puede reportar temperatura y
 * humedad: mezclarlas en una sola serie produciría una media sin significado físico.
 */
export class WindowRegistry {
  private readonly windows = new Map<string, SensorWindow>();

  constructor(private readonly capacity: number = DEFAULT_WINDOW_SIZE) {}

  get size(): number {
    return this.windows.size;
  }

  observe(reading: Reading): FeatureVector {
    const key = `${reading.sensorId}|${reading.type}`;
    let window = this.windows.get(key);
    if (window === undefined) {
      window = new SensorWindow(this.capacity);
      this.windows.set(key, window);
    }
    return window.observe(reading);
  }

  clear(): void {
    this.windows.clear();
  }
}
