# Guía del proyecto

**Sistema de Monitoreo Ambiental IoT con Detección de Anomalías y Alertas Distribuidas**

Este documento es para entender el proyecto desde cero: qué hace, cómo está armado, qué
algoritmos usa y por qué se tomó cada decisión. Está escrito para alguien que no ha visto
el código antes.

---

## Índice

1. [Qué es esto, en dos minutos](#1-qué-es-esto-en-dos-minutos)
2. [Qué hace: el viaje de una lectura](#2-qué-hace-el-viaje-de-una-lectura)
3. [Cómo correrlo](#3-cómo-correrlo)
4. [El stack: qué tecnologías y por qué](#4-el-stack-qué-tecnologías-y-por-qué)
5. [Mapa del código](#5-mapa-del-código)
6. [La base de datos](#6-la-base-de-datos)
7. [Los algoritmos, explicados](#7-los-algoritmos-explicados)
8. [Qué respalda cada módulo del dictamen](#8-qué-respalda-cada-módulo-del-dictamen)
9. [Decisiones de diseño y por qué](#9-decisiones-de-diseño-y-por-qué)
10. [Cómo se prueba](#10-cómo-se-prueba)
11. [Glosario](#11-glosario)
12. [Preguntas probables en la defensa](#12-preguntas-probables-en-la-defensa)

---

## 1. Qué es esto, en dos minutos

Imagina una red de sensores repartidos por una ciudad, midiendo temperatura, humedad y
calidad del aire. Son cientos, mandan datos todo el tiempo, y alguien tiene que:

1. **Recibirlos todos** sin ahogarse.
2. **Guardarlos** de forma organizada.
3. **Darse cuenta cuando algo anda mal** — un incendio, una fuga, un sensor descompuesto.
4. **Avisar** a quien tenga que actuar.

Eso es exactamente lo que hace este sistema. Los sensores están simulados por software
(el proyecto es de arquitectura, no de electrónica), pero **todo lo demás es real**: la
red, las bases de datos, los algoritmos de detección y el tablero.

### La idea clave: no es un solo programa

Un principiante escribiría esto como un programa que hace todo. Aquí son **once
programas independientes** que se hablan por red:

```
   4 simuladores  ──┐
                    │
                    ▼
                ┌────────┐
                │ BROKER │ ◄── el intermediario: recibe todo y reparte
                └────────┘
                    │
      ┌─────────────┼─────────────┬──────────────┐
      ▼             ▼             ▼              ▼
  ingestor      ingestor      ingestor       ingestor      ← uno por zona
   NORTE          SUR          ESTE           OESTE
      │             │             │              │
      ▼             ▼             ▼              ▼
   NORTE.db      SUR.db       ESTE.db       OESTE.db       ← bases separadas
      │
      └──► gestor de alertas ──► bitácora + avisos
      └──► tablero web ──────► http://localhost:3000
```

Cada uno puede caerse sin llevarse a los demás. Cada uno podría correr en una
computadora distinta sin cambiar una línea de código. **Eso es lo que hace que esto sea
un sistema distribuido y no un programa grande.**

### En números

| | |
|---|---|
| Programas independientes al correr | 11 |
| Paquetes de código | 8 |
| Líneas de código | 5 761 |
| Líneas de pruebas | 2 825 |
| Pruebas automáticas | 212 |
| Dependencias externas en tiempo de ejecución | 2 (SQLite y Zod) |

Esa última fila importa: casi todo está construido a mano sobre las herramientas básicas
del lenguaje. No hay frameworks que escondan cómo funcionan las cosas.

---

## 2. Qué hace: el viaje de una lectura

Sigamos **un solo dato** desde que nace hasta que se ve en pantalla.

### Paso 1 — Un sensor mide

Un simulador genera una lectura. No es un número al azar: imita cómo se comporta una
variable ambiental de verdad.

```
valor = base_de_la_zona + ciclo_diario + deriva_lenta + ruido
```

- **ciclo diario**: hace más calor a las 3 de la tarde que a las 4 de la mañana.
- **deriva lenta**: el clima cambia durante horas, no de golpe.
- **ruido**: todo sensor real tiene error de medición.

Esto importa: si los datos fueran aleatorios puros, **no habría ningún patrón normal del
cual desviarse**, y detectar anomalías sería imposible por definición.

El resultado es un mensaje de texto, una línea:

```json
{"kind":"LECTURA","timestamp":"2026-05-05T12:34:56.789Z","sensorId":"a1b2...",
 "location":"NORTE","type":"TEMPERATURA","value":23.5,"unit":"C"}
```

### Paso 2 — El broker lo recibe y lo reparte

El broker escucha en el puerto 8080. Recibe la línea, **la valida** (¿el UUID es válido?
¿la temperatura viene en °C y no en %? ¿el valor es físicamente posible?) y la manda a
quien esté suscrito a la zona NORTE.

Si el mensaje viene mal, lo cuenta, responde un error y **sigue adelante**: un sensor con
un bug no debe poder desconectarse a sí mismo del sistema.

### Paso 3 — El ingestor de NORTE la guarda

El ingestor de esa zona la recibe y hace dos cosas, **en este orden**:

1. **La guarda en `NORTE.db`.** Primero a salvo en disco.
2. **La analiza.** Aunque el análisis fallara, el dato ya está guardado.

### Paso 4 — El detector decide si es anómala

Aquí está el corazón del proyecto. El ingestor mantiene una **ventana deslizante** de las
últimas 50 lecturas de ese sensor, y con ella calcula seis características:

| Característica | Qué mide |
|---|---|
| `zScore` | Cuántas desviaciones estándar se aleja del promedio |
| `delta` | Cuánto cambió respecto de la lectura anterior |
| `rateOfChange` | Ese cambio por segundo |
| `medianDeviation` | Distancia a la mediana (resistente a valores extremos) |
| `trend` | Si la serie viene subiendo o bajando de forma sostenida |
| `hourOfDay` | La hora, para conocer el ciclo diario |

Con esas seis, el detector dice **anómala o normal**. Hay dos detectores intercambiables
(sección 7).

### Paso 5 — Si es anómala, se levanta una alerta

La alerta se guarda en la misma base y se publica al canal `ALERTS` del broker:

```
[CRITICAL] TEMPERATURA por encima de la banda de control:
           26.59C fuera de [23.40, 24.84] (10.4σ sobre 50 muestras)
```

### Paso 6 — El gestor de alertas la agrupa

Un sensor descompuesto no falla una vez: **falla en cada lectura**. Un sensor congelado
produce una alerta por segundo, para siempre.

Por eso el gestor no muestra alertas sueltas, sino **incidentes**: agrupa las alertas
consecutivas del mismo sensor y avisa tres veces (se abrió, se agravó, se cerró) en lugar
de cientos. Todas las alertas crudas se siguen guardando en `data/alertas.log` para poder
auditarlas.

> **Por qué esto importa:** una avalancha de alertas y ningún aviso son, en la práctica,
> lo mismo. Si el operador tiene que ignorar la pantalla para trabajar, el sistema de
> alertas ya falló.

### Paso 7 — El tablero lo muestra

El tablero lee las bases **en modo sólo lectura** y dibuja la gráfica con su banda de
control, marcando en rojo los puntos que el detector marcó como anómalos.

---

## 3. Cómo correrlo

### Preparación (una sola vez)

```bash
pnpm install
pnpm build
```

### Ver el sistema funcionando

```bash
pnpm sistema
```

Levanta los once programas con la salida coloreada por componente. Abre
**http://localhost:3000** para ver el tablero. `Ctrl-C` detiene todo.

Variantes útiles:

```bash
# más lento y con un solo sensor, para poder leer lo que pasa
pnpm sistema --sensors 1 --interval 3000

# inyectando fallas a propósito, para ver alertas
pnpm sistema --anomaly SPIKE
```

### Entrenar y evaluar la inteligencia artificial

```bash
pnpm entrenar    # entrena un modelo por zona, en paralelo
pnpm evaluar     # examen comparativo con métricas
```

### Verificar que todo funciona

```bash
pnpm test          # 212 pruebas automáticas
pnpm humo          # prueba de extremo a extremo con procesos reales
pnpm resiliencia   # provoca tres fallas y comprueba la recuperación
```

---

## 4. El stack: qué tecnologías y por qué

| Tecnología | Versión | Para qué | Por qué ésta |
|---|---|---|---|
| **Node.js** | 24.15 LTS | Motor de ejecución | Su modelo de eventos maneja miles de conexiones de red sin un hilo por cada una |
| **TypeScript** | 6.0.3 | Lenguaje | JavaScript con tipos: los errores salen al compilar, no en la demostración |
| **SQLite** (better-sqlite3) | 13.0.3 | Base de datos | Sin servidor: la base es un archivo. Ideal para repartir una por zona |
| **Zod** | 3.25.76 | Validación | Verifica los datos que llegan por red, donde TypeScript ya no protege |
| **Vitest** | 1.6.1 | Pruebas | Rápido y sin configuración |
| **Turborepo** | 2.9.9 | Construcción | Compila los 8 paquetes en el orden correcto |
| **pnpm** | 10.33 | Dependencias | Maneja el monorepo con enlaces en lugar de copias |

### Lo que deliberadamente NO se usó

Esto es tan importante como lo que sí, y es donde está la originalidad del proyecto:

| No se usó | Se hizo a mano | Por qué |
|---|---|---|
| MQTT, Kafka, Redis | El broker completo | El dictamen prohíbe usar un servicio cliente/servidor ya hecho (criterio 3.2) |
| Express, Fastify | El servidor HTTP | Seis rutas caben en un `switch` |
| Chart.js, D3 | La gráfica en SVG | Una CDN significa que sin internet no hay gráfica el día de la defensa |
| scikit-learn, TensorFlow | El árbol de decisión | Es el módulo que se está evaluando; usar una biblioteca sería entregar el trabajo de otro |
| Bibliotecas de estructuras | Deque, QuickSelect | El criterio 1.2 pide emplear estructuras de datos |

---

## 5. Mapa del código

Todo vive en `packages/`. Cada carpeta es una pieza independiente.

```
packages/
├── shared/          El idioma común: tipos, protocolo, cliente de red
├── broker/          La central que recibe y reparte mensajes
├── ingestor/        El archivista de cada zona
├── simulator/       Los sensores simulados
├── detector/        ★ El cerebro: algoritmos de detección
├── trainer/         Entrena y evalúa el modelo de IA
├── alert-manager/   Agrupa alertas en incidentes
└── dashboard/       La interfaz web
```

Dentro de cada uno, el código está en `src/`. **Los archivos `.test.ts` son pruebas**, no
código de producción.

### Qué hay en cada paquete

#### `shared/` — el idioma común (773 líneas)

Todo lo que los demás necesitan compartir. Si esto está mal, todo está mal.

| Archivo | Qué hace |
|---|---|
| `types.ts` | Qué es una lectura, una alerta, una zona, una unidad |
| `schemas.ts` | Las reglas de validación (una temperatura no puede venir en `%`) |
| `protocol.ts` | El formato de los mensajes que viajan por la red |
| `line-decoder.ts` | Rearma mensajes partidos por la red |
| `broker-client.ts` | El cliente de red con reconexión automática |
| `backoff.ts` | Cuánto esperar antes de reintentar una conexión |
| `paths.ts`, `logger.ts` | Rutas de archivos y registro con prefijo |

#### `broker/` — la central (425 líneas)

`broker.ts` es el corazón: acepta conexiones, valida mensajes, los enruta por zona,
maneja la contrapresión y detecta clientes caídos.

#### `ingestor/` — el archivista (453 líneas)

`shard-repository.ts` es el acceso a la base de datos. `index.ts` es el proceso que se
suscribe a su zona, guarda y analiza.

#### `simulator/` — los sensores (551 líneas)

`sensor.ts` genera las mediciones realistas. `anomaly.ts` inyecta fallas a propósito, con
etiqueta de verdad para poder medir al detector.

#### `detector/` — el cerebro (1 500 líneas) ★

El paquete más importante del proyecto.

| Archivo | Qué es |
|---|---|
| `deque.ts` | La ventana deslizante (estructura de datos a mano) |
| `quickselect.ts` | Encuentra la mediana rápido (algoritmo a mano) |
| `welford.ts` | Promedio y desviación estándar que se actualizan sin recalcular |
| `sliding-window.ts` | Junta lo anterior y extrae las seis características |
| `welford-detector.ts` | Detector 1: banda de control estadística |
| `cart.ts` | **El árbol de decisión** (el algoritmo de IA) |
| `decision-tree-detector.ts` | Detector 2: usa el árbol entrenado |
| `metrics.ts` | Precisión, exhaustividad, F1, matriz de confusión |

#### `trainer/` — el entrenamiento (716 líneas)

Genera los datos de entrenamiento, entrena los cuatro modelos **en paralelo** y produce
el reporte comparativo.

#### `alert-manager/` — las alertas (378 líneas)

Agrupa alertas en incidentes con apertura, agravamiento y cierre.

#### `dashboard/` — la interfaz (965 líneas)

| Archivo | Qué hace |
|---|---|
| `page.ts` | **Toda la interfaz gráfica**: HTML, CSS y la gráfica SVG |
| `server.ts` | Atiende las peticiones HTTP |
| `queries.ts` | Lee las bases en sólo lectura |
| `prometheus.ts` | Las métricas del sistema |

### Los guiones de demostración

En `scripts/`:

| Guion | Qué hace |
|---|---|
| `sistema.mjs` | Levanta el sistema completo |
| `humo.mjs` | Verifica de extremo a extremo que los datos fluyen y no se cruzan |
| `resiliencia.mjs` | Provoca tres fallas distintas y comprueba la recuperación |

---

## 6. La base de datos

### La decisión central: cuatro bases, no una

El sistema **no tiene una base de datos con una columna "zona"**. Tiene **cuatro archivos
físicamente separados**:

```
shards/
├── NORTE.db
├── SUR.db
├── ESTE.db
└── OESTE.db
```

Esto se llama **particionamiento horizontal** o *sharding*. Cada zona es dueña de su
archivo y ningún otro proceso lo escribe.

**Por qué:**

| Ventaja | Explicación |
|---|---|
| Aislamiento de fallos | Si `SUR.db` se corrompe, las otras tres zonas siguen operando |
| Escala | Agregar una zona nueva es crear un archivo y lanzar un proceso; sin migración |
| Sin contención | Cuatro procesos escribiendo en cuatro archivos no se estorban |
| Portabilidad | Cada zona se puede respaldar o mover por separado |

Y es lo que satisface el criterio 3.1.2 del dictamen: *dividir la base de datos entre
diferentes arquitecturas de manera justificada*.

### El esquema

Cada archivo `.db` tiene exactamente dos tablas:

```sql
CREATE TABLE readings (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp  TEXT NOT NULL,   -- ISO 8601
  sensorId   TEXT NOT NULL,   -- UUID del sensor
  location   TEXT NOT NULL,   -- NORTE | SUR | ESTE | OESTE
  type       TEXT NOT NULL,   -- TEMPERATURA | HUMEDAD | CALIDAD_AIRE
  value      REAL NOT NULL,
  unit       TEXT NOT NULL    -- C | % | PPM
);

CREATE TABLE alerts (
  alertId    TEXT PRIMARY KEY,
  timestamp  TEXT NOT NULL,
  sensorId   TEXT NOT NULL,
  location   TEXT NOT NULL,
  type       TEXT NOT NULL,
  value      REAL NOT NULL,
  unit       TEXT NOT NULL,
  detector   TEXT NOT NULL,   -- WELFORD | DECISION_TREE
  severity   TEXT NOT NULL,   -- INFO | WARNING | CRITICAL
  score      REAL NOT NULL,
  lowerLimit REAL,            -- límites de la banda; nulos si no aplican
  upperLimit REAL,
  message    TEXT NOT NULL
);
```

### Los índices

```sql
CREATE INDEX idx_readings_sensor_type_time ON readings (sensorId, type, timestamp);
CREATE INDEX idx_readings_time             ON readings (timestamp);
CREATE INDEX idx_alerts_time               ON alerts (timestamp);
```

El primero es el importante. El tablero y la ventana deslizante siempre preguntan
*"dame las últimas N lecturas de este sensor y este tipo"*. **Sin ese índice, cada
consulta recorrería la tabla completa.**

### Dos configuraciones que vale la pena saber defender

```sql
PRAGMA journal_mode = WAL;      -- Write-Ahead Logging
PRAGMA synchronous  = NORMAL;
```

- **WAL** permite que el tablero **lea mientras el ingestor escribe**, sin que se
  bloqueen. Sin esto, abrir el tablero podría frenar la ingesta.
- **synchronous = NORMAL** no espera a que el disco confirme cada escritura. En una caída
  del sistema operativo se podrían perder las últimas transacciones; a cambio, la
  velocidad de escritura se multiplica. Para telemetría ambiental es un canje razonable:
  perder tres segundos de mediciones no es grave.

### Una defensa que quizá te pregunten

El ingestor verifica que cada lectura pertenezca a su zona **antes** de insertarla, y
lanza un error si no. El broker ya enruta bien, así que en teoría nunca pasa — pero si un
día hubiera un error de enrutamiento, es preferible que explote ahí a que contamine los
datos en silencio y rompa el particionamiento sin que nadie se entere.

---

## 7. Los algoritmos, explicados

### 7.1 Deque — la ventana deslizante

**Problema:** hay que recordar las últimas 50 lecturas de cada sensor. Cuando llega la 51,
hay que olvidar la más vieja.

**Lo obvio en JavaScript:** `array.push(nuevo)` y `array.shift()` para quitar el primero.

**Por qué está mal:** `shift()` es O(n) — reindexa el arreglo completo cada vez. Con
cientos de sensores, es trabajo desperdiciado en el camino más caliente del sistema.

**La solución:** un **arreglo circular**. La memoria se reserva una sola vez y un índice
va dando vueltas, sobrescribiendo la celda más vieja. Ambas operaciones son **O(1)**.

📄 `packages/detector/src/deque.ts`

---

### 7.2 QuickSelect — la mediana rápida

**Problema:** de 50 números, hallar el del medio (la mediana).

**Lo obvio:** ordenar y tomar el central. Cuesta **O(n log n)**.

**Por qué está mal:** ordenar los 50 para usar sólo 1 es trabajo de más.

**La solución:** QuickSelect. Usa el mismo particionamiento de Quicksort, pero después de
partir sabe **en qué mitad está el que busca y descarta la otra entera**. Costo promedio
**O(n)**.

Un detalle fino: el pivote se elige como **mediana de tres** (primero, central, último).
Con pivote fijo, una entrada ya ordenada degenera a O(n²) — y las ventanas de sensores
llegan casi ordenadas muy seguido, así que ése sería el caso común, no el raro.

📄 `packages/detector/src/quickselect.ts`

---

### 7.3 Welford — promedio y desviación sin recalcular

**Problema:** mantener el promedio y la desviación estándar de la ventana, actualizándolos
con cada lectura nueva.

**Lo obvio:** guardar la suma de los valores (Σx) y la suma de sus cuadrados (Σx²), y
calcular la varianza como:

```
varianza = Σx²/n − (Σx/n)²
```

**Por qué está mal — y esto es lo bonito del argumento:** con lecturas de calidad del aire
alrededor de **450 ppm** y una varianza real de unas pocas unidades, esos dos términos son
números grandes y **casi iguales**. Al restarlos se pierden casi todas las cifras
significativas. Se llama **cancelación catastrófica**, y en casos reales llega a producir
**varianzas negativas**, que son matemáticamente imposibles.

**La solución:** el algoritmo de Welford, que actualiza la media y la suma de desviaciones
cuadradas sin construir nunca esos números grandes:

```
n'  = n + 1
μ'  = μ + (x − μ) / n'
M2' = M2 + (x − μ)(x − μ')
s²  = M2' / (n' − 1)
```

Además se implementó la **operación inversa** (quitar un valor), que es lo que permite que
la ventana deslice en **O(1)** en lugar de recalcular los 50 puntos cada vez.

> Hay una prueba que corre 2 000 pasos comparando este cálculo contra recalcular desde
> cero, para demostrar que la optimización no se paga con resultados equivocados.

📄 `packages/detector/src/welford.ts`

---

### 7.4 Detector 1 — Banda de control (Welford)

Es el método clásico del control estadístico de procesos, la **carta de Shewhart**.

> Una lectura es anómala si cae fuera de **μ ± k·σ**, con la media y la desviación
> calculadas sobre la ventana del propio sensor.

Con **k = 3** y bajo normalidad, la banda cubre el 99.73 % de las observaciones: se espera
aproximadamente **una falsa alarma cada 370 lecturas**.

#### Su limitación, que es el motivo de todo el Módulo 2

Este detector **mira una sola característica**, el z-score. Por eso es
**estructuralmente incapaz** de ver dos fallas muy reales:

| Falla | Por qué no la ve |
|---|---|
| **Sensor congelado** | Repite el mismo valor. Su σ tiende a cero y la lectura coincide con la media: **parece el sensor más sano del sistema** |
| **Deriva lenta** | La ventana se desplaza junto con ella y adopta el valor desviado como la nueva normalidad |

Esto **no está escondido**: hay dos pruebas automáticas que lo verifican explícitamente.

```
✓ NO detecta una deriva lenta: la ventana la adopta como normalidad
✓ NO detecta un sensor atorado, que parece el más sano del sistema
```

📄 `packages/detector/src/welford-detector.ts`

---

### 7.5 Detector 2 — Árbol de decisión CART ★ (el algoritmo de IA)

**Éste es el que respalda el Módulo 2.** El criterio 2.1.9 del dictamen nombra
literalmente *"árboles de decisión"*.

#### Qué es un árbol de decisión

Un juego de "¿adivina quién?": preguntas de sí o no hasta llegar a una respuesta.

```
¿medianDeviation ≤ 2.2386?
├─ sí → ¿zScore ≤ -2.5207?
│        ├─ sí → ANOMALÍA (73 % de las muestras aquí eran anómalas)
│        └─ no → normal
└─ no → ¿medianDeviation ≤ 2.7620?
         ├─ sí → ...
         └─ no → ANOMALÍA (81 %)
```

El árbol **no se programa: se aprende** a partir de miles de ejemplos etiquetados. Eso es
lo que lo convierte en aprendizaje automático y no en un montón de `if`.

#### El modelo matemático (criterio 2.2)

**Impureza de Gini** de un conjunto S:

```
G(S) = 1 − Σ pᵢ²        pᵢ = proporción de la clase i
```

Es la probabilidad de equivocarse si se etiqueta un elemento al azar según la
distribución de S. Vale **0** cuando el conjunto es puro y **0.5** cuando está mitad y
mitad.

Un corte parte S en dos según `x_f ≤ t`. Su impureza ponderada es:

```
G(corte) = (|S_izq|/|S|)·G(S_izq) + (|S_der|/|S|)·G(S_der)
```

Y la **ganancia** es lo que el corte mejora:

```
ΔG = G(S) − G(corte)
```

En cada nodo se elige el par (característica, umbral) que **maximiza ΔG**. El algoritmo es
voraz: no busca el árbol globalmente óptimo — ese problema es NP-completo — sino el mejor
corte local en cada paso.

#### El problema del desbalance, y cómo se resolvió

Sólo el **4 %** de las lecturas son anómalas. Un árbol que optimice Gini sin corregir eso
aprende que **responder siempre "normal" acierta el 96 %** de las veces, y no detecta
nada.

La solución son **pesos de clase** inversos a la frecuencia: `w_c = N / (2·N_c)`, de modo
que ambas clases aporten la misma masa al cálculo de la impureza.

Pero hay un matiz que costó descubrir y que vale la pena saber explicar:

> **Los pesos gobiernan la estructura del árbol, pero NO la estimación de las hojas.**
>
> Si se ponderan también las hojas, una hoja con 3 anomalías y 97 normales reportaría
> ~50 % de probabilidad en vez de 3 %. Con eso el umbral del detector deja de significar
> nada y moverlo no cambia el punto de operación. Por eso el árbol **se aprende ponderado
> pero reporta frecuencias empíricas crudas**.

#### La poda

Un árbol sin límites memoriza el ruido del conjunto de entrenamiento y llega a hojas de un
solo elemento. Se poda por: profundidad máxima (6), mínimo de muestras para partir (40),
mínimo por hoja (15) y ganancia mínima.

📄 `packages/detector/src/cart.ts`

---

### 7.6 La evidencia: por qué el árbol y no sólo estadística (criterio 2.3)

Aquí está el argumento central del proyecto, y **no es una opinión: son mediciones**.

Se generan 48 000 muestras con 4 % de anomalías de cuatro tipos distintos, se entrena con
una semilla y **se evalúa con otra** — es decir, sobre series que el modelo nunca vio.

#### Resultado global

| Detector | Precisión | Exhaustividad | F1 | Falsa alarma |
|---|---|---|---|---|
| Welford (k=3) | 73.3 % | 39.6 % | 0.515 | 0.6 % |
| **Árbol de decisión** | 60.7 % | **56.8 %** | **0.587** | 1.6 % |

#### Pero el número que de verdad importa es éste

| Tipo de falla | Welford | Árbol |
|---|---|---|
| **SPIKE** (pico instantáneo) | 93.2 % | 92.5 % |
| **DRIFT** (descalibración lenta) | 32.7 % | **59.2 %** |
| **STUCK** (sensor congelado) | **0.0 %** | **43.6 %** |
| **NOISE** (contacto intermitente) | 25.0 % | 29.2 % |

**La banda de control no detecta jamás un sensor congelado.** Ni una sola vez en 360
muestras. El árbol lo detecta en el 43.6 %.

> Un sistema de monitoreo que nunca nota un sensor muerto es peor que uno que a veces se
> equivoca. Ése es el argumento, y está respaldado por una tabla reproducible.

#### El experimento que desarma la objeción obvia

Un sinodal puede decir: *"tu modelo sólo memorizó la regla con la que inyectaste las
anomalías"*.

Por eso se corre un **segundo experimento**: entrenar el árbol viendo **únicamente picos**
y evaluarlo contra los cuatro tipos.

| Tipo | Árbol entrenado sólo con picos |
|---|---|
| SPIKE | 99.2 % |
| DRIFT | 38.7 % |
| STUCK | **0.0 %** |
| NOISE | 34.0 % |

El resultado es **honesto y se reporta tal cual**: entrenado sólo con picos, el árbol
tampoco detecta sensores congelados. Esto demuestra dos cosas a la vez:

1. **No memorizó una regla mágica** — si así fuera, detectaría todo.
2. **El aprendizaje supervisado no transfiere entre fallas estructuralmente distintas**,
   que es exactamente la razón de entrenar el modelo de producción con los cuatro tipos.

#### Control de sobreajuste

| | F1 |
|---|---|
| Sobre sus propios datos de entrenamiento | 0.628 |
| Sobre datos nunca vistos | 0.587 |

La brecha es pequeña. Si el modelo estuviera memorizando, la primera cifra sería mucho más
alta que la segunda.

#### El punto de operación se puede ajustar

| Umbral | Precisión | Exhaustividad | F1 | Falsa alarma |
|---|---|---|---|---|
| 0.05 | 28.8 % | 74.6 % | 0.416 | 7.8 % |
| 0.2 | 48.3 % | 66.8 % | 0.561 | 3.0 % |
| **0.3** | **60.7 %** | **56.8 %** | **0.587** | 1.6 % |
| 0.4 | 78.3 % | 46.7 % | 0.585 | **0.5 %** |
| 0.7 | 86.3 % | 34.3 % | 0.491 | 0.2 % |

No hay un valor correcto universal: depende de qué cuesta más, una falsa alarma o una
anomalía no vista. **A umbral 0.4 el árbol iguala la tasa de falsa alarma de Welford
(0.5 %) con más exhaustividad** y detectando fallas que Welford no ve.

#### Dos hallazgos que se reportan aunque no favorezcan

**Importancia de las características** (cómo se reparte la ganancia de Gini):

```
delta              46.6 %  ███████████████████
zScore             21.2 %  ████████
medianDeviation    18.4 %  ███████
hourOfDay          12.6 %  █████
trend               1.2 %
rateOfChange        0.0 %
```

1. **`rateOfChange` tiene 0 % de importancia.** Con un intervalo de muestreo fijo es un
   múltiplo constante de `delta`, o sea **redundante**. Se conserva porque en operación
   real los intervalos varían.
2. **`trend`, que se agregó específicamente para detectar la deriva, sólo aporta 1.2 %.**
   El árbol detecta la deriva por otras vías.

> Reportar esto en lugar de esconderlo es lo que distingue un trabajo honesto de uno que
> sólo busca quedar bien.

📄 `packages/trainer/src/evaluate.ts` — se reproduce con `pnpm evaluar`

---

## 8. Qué respalda cada módulo del dictamen

### Módulo 1 — Arquitectura y Programación de Sistemas

| Criterio | Qué lo respalda |
|---|---|
| **1.1** Decidir el uso de lenguajes | Node.js 24 + TypeScript 6 en modo estricto. Justificado por el modelo de eventos para I/O de red y por la seguridad de tipos |
| **1.2** Bases de datos y/o estructuras de datos | SQLite particionado en cuatro shards **y** Deque, QuickSelect y Welford implementados a mano |
| **1.3** Metodología de programación | Arquitectura basada en eventos, procesos independientes, patrones Repository, Strategy y Factory Method |
| **1.4** Elementos de ingeniería de software | 212 pruebas automáticas, ESLint, TypeScript estricto, control de versiones con historia por fases, manejo explícito de errores |
| **1.5** Modelado del sistema | Diagramas de contenedores y de secuencia (pendientes de agregar al documento formal) |

### Módulo 2 — Sistemas Inteligentes

| Criterio | Qué lo respalda |
|---|---|
| **2.1** Rama de IA | **2.1.9 Árboles de decisión** — CART implementado desde cero, sin bibliotecas |
| **2.2** Modelo matemático | Impureza de Gini, ganancia de información y pesos de clase, formulados en la sección 7.5 |
| **2.3** Justificación de los algoritmos | Comparación medida contra la banda de control: tabla por tipo de falla, matriz de confusión, control de sobreajuste y barrido del punto de operación |

### Módulo 3 — Sistemas Distribuidos

| Criterio | Qué lo respalda |
|---|---|
| **3.1.1** Componentes concurrentes | Once procesos independientes del sistema operativo |
| **3.1.2** Dividir la base de datos | Cuatro archivos SQLite separados, uno por zona geográfica |
| **3.1.4** Distribuir el procesamiento de cálculos | Entrenamiento de los cuatro modelos en Worker Threads paralelos: **388 ms contra 1 277 ms secuencial, 3.3× medido** |
| **3.1.5** Sistema tolerante a fallos | `pnpm resiliencia` provoca tres fallas distintas y comprueba la recuperación |
| **3.1.6** Tiempo real por sockets | Todo el sistema se comunica por TCP |
| **3.2** Algoritmo cliente-servidor propio | El broker publicador/suscriptor **escrito desde cero** sobre `net.createServer`. La nota del dictamen prohíbe usar un servicio ya creado |
| **3.3** Comunicación entre al menos dos dispositivos | Procesos independientes que sólo se hablan por TCP. Basta cambiar `--host` para repartirlos entre dos máquinas |
| **3.4** Justificar los protocolos | Protocolo de líneas JSON sobre TCP, con validación, latidos y contrapresión (sección 9) |

---

## 9. Decisiones de diseño y por qué

Éstas son las que más probablemente te pregunten.

### ¿Por qué TCP y no UDP?

UDP es más rápido pero no garantiza entrega ni orden. Para telemetría ambiental que
alimenta un detector de anomalías, **perder lecturas en silencio corrompería la ventana
deslizante** y el detector empezaría a calcular sobre datos incompletos sin saberlo. La
fiabilidad vale más que la latencia aquí.

### ¿Por qué JSON por líneas y no un formato binario?

Un formato binario sería más compacto. Pero un mensaje JSON terminado en salto de línea
**se puede inspeccionar con `nc localhost 8080` durante la defensa**, y el costo de
parseo es irrelevante a esta escala. Se optó por la depurabilidad.

### ¿Por qué procesos separados y no hilos?

El criterio 3.3 pide comunicación entre al menos dos dispositivos, y el dictamen advierte
que varias interfaces contra un sistema centralizado **no cuentan** como distribuido.
Procesos independientes que sólo se hablan por TCP satisfacen el criterio aun corriendo en
la misma máquina, y permiten repartirlos entre equipos distintos sin cambiar código.

### Entonces, ¿dónde se usan los Worker Threads?

En el **entrenamiento** del árbol, que sí es intensivo en CPU y bloquearía el bucle de
eventos durante segundos. Los cuatro modelos son independientes, así que se entrenan
simultáneamente:

```
Paralelo:    tiempo de pared 388 ms  ·  trabajo total de CPU 1 440 ms
Secuencial:  tiempo de pared 1 277 ms
```

Es decir **3.3× más rápido de punta a punta**. Se reproduce comparando `pnpm entrenar`
contra `pnpm entrenar --sequential`.

La **inferencia** se queda en el hilo principal: recorrer un árbol ya construido son una
decena de comparaciones, del orden de microsegundos. Montar un hilo para eso sería
paralelismo de adorno.

### ¿Qué es la contrapresión y por qué importa?

Si un consumidor va más lento que el productor, los datos se acumulan en memoria hasta
tumbar el proceso. Cuando el búfer hacia un suscriptor se llena, el broker **pausa la
lectura de todas las conexiones** hasta que drene. Es reconocer que no se puede aceptar
trabajo más rápido de lo que se puede procesar.

### ¿Por qué latidos si TCP ya detecta desconexiones?

**TCP no detecta un cable desconectado.** Si la máquina del otro lado se apaga o pierde la
red, el socket puede quedarse abierto para siempre esperando datos que nunca llegan. Sólo
un latido a nivel de aplicación revela ese "corte silencioso".

La demostración lo prueba congelando un proceso con `SIGSTOP`: el socket queda abierto, y
sólo los latidos revelan que el sensor dejó de existir.

### ¿Por qué la gráfica no usa Chart.js?

Chart.js se carga desde una CDN, o sea que **la gráfica sólo existe si hay internet**. El
día de la defensa, en un aula con la red caída, el tablero se vería en blanco y no habría
forma de arreglarlo en el momento. Los ~100 renglones de SVG a mano funcionan con la
máquina desconectada. Hay una prueba que falla si alguien reintroduce una referencia
externa.

---

## 10. Cómo se prueba

### Tres niveles

| Nivel | Qué verifica | Cómo correrlo |
|---|---|---|
| **Unitario** | Cada pieza por separado: 212 pruebas | `pnpm test` |
| **Humo** | Que el sistema completo mueve datos de punta a punta | `pnpm humo` |
| **Resiliencia** | Que sobrevive a fallas reales | `pnpm resiliencia` |

### Qué comprueba la prueba de humo

Levanta los nueve procesos, los deja correr y verifica **contra las bases de datos**:

```
NORTE  ✓ 408 filas  ✓ sin otras zonas  ✓ 6 sensores estables  ✓ 20 alertas  ✓ 4.9 %
SUR    ✓ 408 filas  ✓ sin otras zonas  ✓ 6 sensores estables  ✓ 11 alertas  ✓ 2.7 %
```

Ese último número también importa: **un detector que alerta sobre todo no detecta nada**.

### Qué comprueba la de resiliencia

```
ESCENA 1 — Cae un sensor
   ✓ las demás zonas siguen operando (+90 lecturas mientras NORTE estaba caído)

ESCENA 2 — Corte silencioso (SIGSTOP: el socket queda abierto, TCP no avisa)
   ✓ simulador-SUR sin señales por 7s; desconectando

ESCENA 3 — Cae el broker
   ✓ reintento en 231 ms / 172 ms / 288 ms   ← el jitter, visible
   ✓ los ingestores se reconectaron solos
   ✓ 4/4 ingestores siguen respirando
```

### Un ejemplo de rigor que vale la pena mencionar

Algunas pruebas verifican **lo que el sistema NO hace**, y eso también es información:

```
✓ NO detecta una deriva lenta: la ventana la adopta como normalidad
✓ NO detecta un sensor atorado, que parece el más sano del sistema
✓ la página no depende de ninguna red externa
✓ el tablero no modifica el shard al consultarlo
```

---

## 11. Glosario

| Término | Qué significa aquí |
|---|---|
| **Broker** | El intermediario que recibe mensajes y los reparte a quien se suscribió |
| **Publicador / suscriptor** | Modelo donde el emisor no sabe quién lo escucha; el broker enruta por tema |
| **Shard** | Fragmento de la base de datos. Aquí, un archivo `.db` por zona |
| **Ventana deslizante** | Las últimas N lecturas de un sensor; al llegar la N+1 se olvida la más vieja |
| **z-score** | Cuántas desviaciones estándar se aleja un valor de su promedio |
| **Banda de control** | El rango μ ± k·σ considerado normal |
| **Precisión** | De las alertas emitidas, cuántas eran reales |
| **Exhaustividad** (*recall*) | De las anomalías reales, cuántas se detectaron |
| **F1** | Media armónica de las dos anteriores; castiga el desequilibrio |
| **Gini** | Medida de qué tan mezcladas están las clases en un conjunto |
| **Contrapresión** | Frenar al productor cuando el consumidor no da abasto |
| **Latido** (*heartbeat*) | Mensaje periódico que dice "sigo vivo" |
| **Jitter** | Aleatoriedad en los reintentos para que no coincidan todos |
| **WAL** | Modo de SQLite que permite leer y escribir a la vez |
| **Worker Thread** | Hilo de ejecución paralelo dentro de un proceso de Node.js |

---

## 12. Preguntas probables en la defensa

**«¿Por qué esto es inteligencia artificial y no un montón de `if`?»**
Porque el árbol **no se programó: se aprendió** de 48 000 ejemplos etiquetados. Nadie
escribió el umbral 2.2386 — salió de maximizar la ganancia de Gini sobre los datos. Si se
cambian los datos, el árbol cambia solo.

**«¿Por qué un árbol de decisión y no una red neuronal?»**
Tres razones: es **interpretable** (se puede imprimir y explicar cada decisión, cosa
imposible con una red), su **modelo matemático cabe en media cuartilla** y **no necesita
GPU ni miles de épocas** de entrenamiento. Para un problema con seis características y
clases desbalanceadas, una red neuronal sería complejidad sin beneficio.

**«¿Cómo sé que no memorizó los datos?»**
Se evalúa con una semilla distinta a la de entrenamiento. La brecha entre F1 de
entrenamiento (0.628) y de prueba (0.587) es pequeña. Y el experimento de entrenar sólo
con picos demuestra que **no hay una regla mágica memorizada**.

**«Si ya tenías estadística, ¿para qué la IA?»**
Por la fila de STUCK: la banda de control detecta **0 %** de los sensores congelados. El
árbol, 43.6 %. Un sistema que nunca nota un sensor muerto no sirve para monitorear.

**«¿Esto es distribuido de verdad o son ventanas del mismo programa?»**
Son once procesos independientes del sistema operativo, con su propio PID, que se
comunican **exclusivamente por TCP**. Se puede matar cualquiera y los demás siguen. Y
basta cambiar `--host` para repartirlos entre dos computadoras.

**«¿Por qué no usaste MQTT, que ya existe?»**
Porque el dictamen lo prohíbe explícitamente: el criterio 3.2 pide *desarrollar* un
algoritmo cliente-servidor, con la nota de que no es válido usar un servicio ya creado.
El broker está escrito sobre `net.createServer`, con su propio enrutamiento, validación,
contrapresión y detección de caídas.

**«¿Qué pasa si se cae el broker?»**
Los ingestores lo detectan, reintentan con retroceso exponencial y jitter, y **se
reconectan solos** cuando vuelve. Los datos ya guardados no se pierden. Está demostrado
en `pnpm resiliencia`.

**«¿Por qué cuatro bases y no una?»**
Aislamiento de fallos, escalabilidad sin migración y ausencia de contención entre
escritores. Es el criterio 3.1.2, y es lo que hace que el sistema crezca agregando zonas
en lugar de agrandando una sola base.

---

## Para empezar a leer el código

Si vas a estudiarlo, este orden minimiza la confusión:

1. **`packages/shared/src/types.ts`** — qué es una lectura. Todo lo demás se construye
   sobre esto.
2. **`packages/shared/src/protocol.ts`** — cómo viajan los mensajes.
3. **`packages/broker/src/broker.ts`** — cómo se reparten.
4. **`packages/ingestor/src/index.ts`** — qué pasa cuando llega una lectura.
5. **`packages/detector/src/welford-detector.ts`** — el detector simple.
6. **`packages/detector/src/cart.ts`** — el árbol de decisión.
7. **`packages/dashboard/src/page.ts`** — la interfaz.

El código está comentado en español y **los comentarios explican el porqué**, no el qué.
Donde hay una decisión no obvia, está escrito el razonamiento y qué alternativa se
descartó.
