/**
 * Inyección de anomalías con verdad de terreno.
 *
 * El simulador sabe exactamente cuándo corrompió una lectura, y esa etiqueta es lo
 * que permite medir al detector: sin ella sólo se puede decir "salieron alertas", no
 * "acertó el 94 % y se le escapó el 6 %".
 *
 * La etiqueta NUNCA viaja por el cable. Si el ingestor pudiera leerla, la evaluación
 * sería una farsa. Se emite por un canal aparte y sólo la consume el generador de
 * conjuntos de datos de la Fase D.
 *
 * Los cuatro modos corresponden a fallas reales de instrumentación distintas:
 *
 * - SPIKE  — pico instantáneo. Interferencia eléctrica, un paquete corrupto.
 * - DRIFT  — deriva lenta y sostenida. Sensor descalibrándose, suciedad acumulada.
 * - STUCK  — el sensor se congela en su último valor. Cable suelto, firmware colgado.
 * - NOISE  — la varianza se dispara sin cambiar la media. Contacto intermitente.
 *
 * SPIKE es el único que una banda de control detecta bien. Los otros tres existen
 * porque son la prueba de fuego del árbol de decisión: se entrena con picos y se
 * evalúa contra los demás, de modo que las métricas midan generalización y no
 * memorización de la regla de inyección.
 */

export const ANOMALY_MODES = ["SPIKE", "DRIFT", "STUCK", "NOISE"] as const;
export type AnomalyMode = (typeof ANOMALY_MODES)[number];

/** Etiqueta de verdad de terreno de una muestra. */
export type AnomalyLabel = "NORMAL" | AnomalyMode;

export interface AnomalyConfig {
  mode: AnomalyMode;
  /**
   * Probabilidad de que arranque un episodio en una lectura dada, entre 0 y 1.
   * Un valor de 0.01 produce en promedio un episodio cada cien lecturas.
   */
  rate: number;
  /**
   * Duración del episodio en lecturas. SPIKE dura una por definición; DRIFT, STUCK y
   * NOISE se sostienen para que se parezcan a una falla real y no a un dato suelto.
   */
  durationSamples: number;
  /** Intensidad, en desviaciones estándar del ruido propio del sensor. */
  magnitude: number;
}

export const DEFAULT_ANOMALY: Omit<AnomalyConfig, "mode"> = {
  rate: 0.02,
  durationSamples: 20,
  magnitude: 12,
};

export interface Corruption {
  value: number;
  label: AnomalyLabel;
}

/**
 * Máquina de estados que corrompe una serie limpia.
 *
 * Se mantiene fuera de `SimulatedSensor` a propósito: el sensor modela el fenómeno
 * físico y el inyector modela la falla del instrumento. Separarlos deja claro en el
 * código —y en la defensa— que la anomalía no es parte del proceso natural.
 */
export class AnomalyInjector {
  private remaining = 0;

  /** Desplazamiento acumulado de la deriva en curso. */
  private driftOffset = 0;

  /** Valor en el que se congeló el sensor. */
  private frozenValue: number | null = null;

  constructor(
    private readonly config: AnomalyConfig,
    private readonly noiseScale: number,
    private readonly random: () => number = Math.random,
  ) {}

  get active(): boolean {
    return this.remaining > 0;
  }

  /**
   * Aplica la falla, si toca, al valor limpio del sensor.
   *
   * @param cleanValue valor que el sensor habría reportado sin falla.
   */
  apply(cleanValue: number): Corruption {
    if (this.remaining === 0 && this.random() < this.config.rate) {
      this.startEpisode(cleanValue);
    }

    if (this.remaining === 0) {
      return { value: cleanValue, label: "NORMAL" };
    }

    this.remaining -= 1;
    const amplitude = this.noiseScale * this.config.magnitude;

    switch (this.config.mode) {
      case "SPIKE": {
        // Signo aleatorio: los picos hacia abajo son tan reales como los de arriba.
        const sign = this.random() < 0.5 ? -1 : 1;
        return { value: cleanValue + sign * amplitude, label: "SPIKE" };
      }

      case "DRIFT": {
        // El desplazamiento se acumula, así que el primer punto del episodio es casi
        // indistinguible del normal y el último está muy lejos. Ésa es justamente la
        // razón de que una banda de control no lo vea: la ventana se mueve con él.
        const step = amplitude / this.config.durationSamples;
        this.driftOffset += step;
        return { value: cleanValue + this.driftOffset, label: "DRIFT" };
      }

      case "STUCK": {
        this.frozenValue ??= cleanValue;
        return { value: this.frozenValue, label: "STUCK" };
      }

      case "NOISE": {
        // La media se conserva; lo que se dispara es la dispersión.
        const jitter = (this.random() * 2 - 1) * amplitude;
        return { value: cleanValue + jitter, label: "NOISE" };
      }

      default: {
        const _exhaustive: never = this.config.mode;
        throw new Error(`Modo de anomalía no manejado: ${String(_exhaustive)}`);
      }
    }
  }

  private startEpisode(cleanValue: number): void {
    this.remaining =
      this.config.mode === "SPIKE" ? 1 : this.config.durationSamples;
    this.driftOffset = 0;
    this.frozenValue = this.config.mode === "STUCK" ? cleanValue : null;
  }
}
