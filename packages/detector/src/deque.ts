/**
 * Deque de capacidad fija sobre un arreglo circular.
 *
 * Implementado a mano porque el criterio 1.2 pide emplear estructuras de datos, y
 * porque la alternativa natural en JavaScript —`array.push()` con `array.shift()`—
 * es O(n) en cada desalojo: `shift` reindexa el arreglo completo. Con una ventana de
 * 50 puntos y cientos de sensores eso es trabajo desperdiciado en el camino caliente.
 *
 * Aquí las dos operaciones son O(1): se avanza un índice en módulo de la capacidad y
 * se sobrescribe la celda más vieja. La memoria queda fija desde el constructor, lo
 * que además evita que el recolector de basura trabaje durante la ingesta.
 */

export class Deque<T> {
  private readonly items: (T | undefined)[];

  /** Índice de la celda donde se escribirá el próximo elemento. */
  private head = 0;

  private count = 0;

  constructor(readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error(`La capacidad debe ser un entero positivo, se recibió ${capacity}`);
    }
    this.items = new Array<T | undefined>(capacity);
  }

  get size(): number {
    return this.count;
  }

  get isFull(): boolean {
    return this.count === this.capacity;
  }

  /**
   * Agrega un elemento al final.
   *
   * @returns el elemento desalojado si la ventana estaba llena, o `undefined`.
   * Devolverlo es lo que permite a Welford restar exactamente el valor que salió.
   */
  push(item: T): T | undefined {
    const evicted = this.isFull ? this.items[this.head] : undefined;
    this.items[this.head] = item;
    this.head = (this.head + 1) % this.capacity;
    if (!this.isFull) this.count += 1;
    return evicted;
  }

  /** Elemento más reciente. */
  get newest(): T | undefined {
    if (this.count === 0) return undefined;
    return this.items[(this.head - 1 + this.capacity) % this.capacity];
  }

  /** Elemento más antiguo todavía en la ventana. */
  get oldest(): T | undefined {
    if (this.count === 0) return undefined;
    return this.items[(this.head - this.count + this.capacity) % this.capacity];
  }

  /** Copia en orden cronológico, del más viejo al más reciente. */
  toArray(): T[] {
    const out: T[] = [];
    const start = (this.head - this.count + this.capacity) % this.capacity;
    for (let i = 0; i < this.count; i += 1) {
      out.push(this.items[(start + i) % this.capacity] as T);
    }
    return out;
  }

  clear(): void {
    this.items.fill(undefined);
    this.head = 0;
    this.count = 0;
  }
}
