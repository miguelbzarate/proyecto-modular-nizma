/**
 * QuickSelect: k-ésimo menor elemento en O(n) promedio.
 *
 * La propuesta lo menciona por nombre para el umbral adaptativo basado en mediana.
 * La razón de usarlo en vez de `array.sort()` es que ordenar cuesta O(n log n) y aquí
 * sólo hace falta *un* elemento —el central—, no el orden completo.
 *
 * Es el mismo particionamiento de Quicksort, pero recursando en un solo lado: tras
 * particionar se sabe de qué mitad es el k-ésimo, y la otra se descarta entera.
 *
 * La elección del pivote es la mediana de tres (primero, central, último). Con pivote
 * fijo, una entrada ya ordenada degenera a O(n²), y las ventanas de sensores muy
 * frecuentemente llegan casi ordenadas.
 */

function swap(values: number[], i: number, j: number): void {
  const temp = values[i] as number;
  values[i] = values[j] as number;
  values[j] = temp;
}

/** Mediana de tres, para evitar el peor caso con entradas casi ordenadas. */
function choosePivotIndex(values: number[], left: number, right: number): number {
  const middle = left + ((right - left) >> 1);
  const a = values[left] as number;
  const b = values[middle] as number;
  const c = values[right] as number;

  if ((a <= b && b <= c) || (c <= b && b <= a)) return middle;
  if ((b <= a && a <= c) || (c <= a && a <= b)) return left;
  return right;
}

/** Partición de Lomuto. Devuelve la posición final del pivote. */
function partition(values: number[], left: number, right: number): number {
  const pivotIndex = choosePivotIndex(values, left, right);
  const pivot = values[pivotIndex] as number;
  swap(values, pivotIndex, right);

  let store = left;
  for (let i = left; i < right; i += 1) {
    if ((values[i] as number) < pivot) {
      swap(values, i, store);
      store += 1;
    }
  }
  swap(values, store, right);
  return store;
}

/**
 * Devuelve el k-ésimo menor valor (k basado en cero).
 *
 * ATENCIÓN: reordena `values` en el lugar. El que llama debe pasar una copia si le
 * importa conservar el orden original.
 */
export function quickSelect(values: number[], k: number): number {
  if (values.length === 0) throw new Error("quickSelect sobre un arreglo vacío");
  if (k < 0 || k >= values.length) {
    throw new Error(`k fuera de rango: ${k} para ${values.length} elementos`);
  }

  let left = 0;
  let right = values.length - 1;

  // Iterativo en vez de recursivo: la recursión de cola aquí no aporta claridad y sí
  // arriesga desbordar la pila con ventanas grandes.
  for (;;) {
    if (left === right) return values[left] as number;
    const pivotFinal = partition(values, left, right);
    if (k === pivotFinal) return values[k] as number;
    if (k < pivotFinal) right = pivotFinal - 1;
    else left = pivotFinal + 1;
  }
}

/**
 * Mediana de una muestra.
 *
 * Con un número par de elementos promedia los dos centrales, que es la definición
 * estadística; eso cuesta dos pasadas de QuickSelect en vez de una.
 *
 * Trabaja sobre una copia para no alterar la ventana del llamador.
 */
export function median(values: readonly number[]): number {
  if (values.length === 0) throw new Error("mediana de un arreglo vacío");
  const copy = [...values];
  const middle = copy.length >> 1;

  if (copy.length % 2 === 1) return quickSelect(copy, middle);

  const upper = quickSelect(copy, middle);
  const lower = quickSelect(copy, middle - 1);
  return (lower + upper) / 2;
}
