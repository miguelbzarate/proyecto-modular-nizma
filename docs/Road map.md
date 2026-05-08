# Sistema de Monitoreo Ambiental IoT con Detección de Anomalías y Alertas Distribuidas (Node.js/TypeScript)

## Alcance
Red de sensores simulados que miden parámetros ambientales (temperatura, humedad, calidad del aire) y envían los datos a un sistema distribuido que: 1) almacena las lecturas en una base de datos fragmentada por ubicación geográfica, 2) aplica modelos de detección de anomalías basados en aprendizaje automático para identificar lecturas fuera de lo esperado, y 3) genera alertas prioritarias mediante un sistema de mensajería ligero que notifica a usuarios mediante email o interfaz web. El proyecto simula los sensores y se enfoca en la arquitectura distribuida y el procesamiento inteligente en lugar de hardware físico. Implementado en Node.js con TypeScript para aprovechar el ecosistema de JavaScript moderno con seguridad de tipos.
## Justificación de los 3 módulos (Resumen técnico de nivel Staff Engineer)

### Módulo 1. Arquitectura y Programación de Sistemas
- **Lenguaje de programación:** Node.js v18.x con TypeScript 5.0 (modelo de concurrencia basado en eventos, I/O asíncrono, seguridad de tipos).
- **Base de datos y estructuras de datos:** better-sqlite3 con particionamiento por zona geográfica (norte.db, sur.db, este.db, oeste.db); estructuras tipo Deque y MinHeap implementadas manualmente.
- **Metodología de programación:** Arquitectura basada en eventos usando EventEmitter, streams y Worker Threads; módulos: sensorSimulator.ts, tcpBroker.ts, dataIngestor.ts, anomalyDetector.ts, alertManager.ts, dashboard.ts.
- **Elementos de Ingeniería de Software:** Git trunk-based, pruebas con Vitest + SuperTest, documentación JSDoc/TypeDoc, manejo de errores con dominios personalizados y circuit breakers (opossum), código con strict TypeScript (Airbnb ESLint + Prettier).
- **Modelado del sistema:** Diagramas C4 Model (contenedores y componentes) y secuencias en Mermaid.
### Módulo 2. Sistemas Inteligentes
- **Rama de IA seleccionada:** Detección de anomalías en series temporales.
- **Modelo matemático:** 
  * Banda de control con media móvil y desviación estándar incremental (Welford's algorithm).
  * Umbral adaptativo basado en mediana con QuickSelect.
- **Justificación del algoritmo:** Efectivo para patrones estacionales, actualización O(1) por lectura, interpretable, bajo costo computacional, evita sobreajuste con ventanas deslizantes adaptativas.
### Módulo 3. Sistemas Distribuidos
- **Recursos compartidos y descentralización:** 
  * El tcpBroker usa el pool de hilos de libuv de Node.js para manejar conexiones TCP sin bloquear el Event Loop.
  * Los anomalyDetectors se ejecutan en Worker Threads separados (uno por zona) que procesan su shard en paralelo mediante MessageChannel.
  * El alertManager corre en su propio Worker Thread para aislar I/O de red.
  * Particionamiento horizontal de SQLite3 por ubicación geográfica (sharding).
- **Algoritmo cliente-servidor/punto a punto:** Arquitectura pub/sub ligera con broker TCP implementado desde cero (net.createServer); componentes se comunican exclusivamente mediante TCP y MessageChannel.
- **Comunicación entre dispositivos:** TCP bidireccional entre sensores simulados y broker; comunicación entre procesos mediante MessageChannel de Worker Threads (cumple con al menos dos dispositivos de ejecución).
- **Justificación de protocolos:** Protocolo personalizado de líneas JSON terminadas en \n; campos: timestamp (ISO 8601), sensorId (UUID), ubicación (enum), tipoMedida (enum), valor (number con branded type por unidad), unidad (enum); heartbeats cada 30s para detección de desconexiones; TCP elegido por fiabilidad crítica.
## Consideraciones Críticas (Nivel Staff)

| Riesgo | Solución |
|--------|----------|
| Bloqueo del Event Loop por IA | Algoritmos de detección ejecutados exclusivamente en Worker Threads; monitorizar latencia del Event Loop con perf_hooks.eventLoopUtilization(). |
| Backpressure en streams TCP | Uso consciente de highWaterMark, pause()/resume(), cork()/uncork() en sockets; Transform streams con _flush() y manejo de error en pipeline(). |
| Conexiones SQLite3 en Workers | Cada Worker Thread crea su propia instancia de better-sqlite3; PRAGMA journal_mode=WAL para lecturas concurrentes sin bloqueo. |
| Fuga de memoria en Workers | Pruebas con --expose-gc, evitar closures que retengan buffers grandes, mediciones con clinic doctor. |
| Fallos de red parciales | Lógica de reconexión exponencial con jitter; heartbeats a nivel de aplicación para detectar cortes negros. |
| Sobrecarga de context switch | Número de Workers = availableParallelism() - 1; afinidad de CPU opcional mediante worker.getEnvironmentData().cpuAffinity (Linux). |
## Roadmap de Ejecución (Hitos para MVP Sólido)

### Fase 0: Fundación (1-2 días)
- [ ] Repo monorepo con turborepo o npm workspaces (tsconfig, eslint, vitest compartidos).
- [ ] tcpBroker mínimo: acepta conexiones TCP, eco de mensajes JSON línea por línea (probar con nc localhost 8080).
- [ ] SensorSimulator básico: genera lecturas aleatorias con timestamp y envía a broker (un solo tipo de sensor).
- **Salida:** Sistema que recibe y muestra en consola lecturas de un sensor simulado.
### Fase 1: Sharding y Workers (3-4 días)
- [ ] ShardDataAccess con better-sqlite3 (CREATE TABLE lecturas, INSERT simple).
- [ ] Un Worker Thread que se conecta a su shard .db, recibe lecturas mediante cliente TCP (dataIngestor) y almacena en su shard.
- [ ] Prueba: 2 sensores simulados → 2 shards diferentes → verificar aislación de datos.
- **Salida:** Lecturas almacenadas correctamente por shard geográfico (consultas directas a .db confirman partición).
### Fase 2: Detección de Anomalías (3 días)
- [ ] AnomalyDetector (Strategy) con Welford's algorithm incremental.
- [ ] Worker Thread ahora: almacena lectura, ejecuta detección en ventana deslizante (ej. últimos 50 puntos), envía alerta mediante MessageChannel al hilo principal si anomalía detectada.
- [ ] Prueba: inyectar valor atípico en simulador → alerta recibida en consola.
- **Salida:** Alertas generadas correctamente basado en desviación estadística por shard.
### Fase 3: Gestión de Alertas y Resiliencia (2-3 días)
- [ ] AlertManager: recibe mensajes de Workers, los muestra en consola + intenta enviar por nodemailer (fallback a archivo de log si SMTP falla).
- [ ] Heartbeats en protocolo broker (mensaje {type:'HEARTBEAT'} cada 30s); broker considera sensor desconectado tras 90s sin heartbeat ni datos.
- [ ] Simular fallo de red: cortar conexión de un sensor → broker detecta pérdida después de 90s → intenta reconexión con backoff exponencial.
- **Salida:** Sistema mantiene operación durante fallos transitorios; alertas persisten incluso si notificación falla.
### Fase 4: Dashboard y Observabilidad (2 días)
- [ ] dashboard.ts: servidor HTTP básico (http.createServer) que sirve HTML estático con gráfico en tiempo real (Chart.js) de lecturas por shard, muestra contador de alertas por zona, expone /metrics (Prometheus básico: lecturas/seg, alertas/seg, lag del Event Loop).
- [ ] Prueba de carga: 100 sensores simulados → verificar latencia < 100ms p99.
- **Salida:** MVP con visualización en tiempo real y métricas de salud del sistema.
## Checklist de luz verde para iniciar

- ✅ Todas las fases anteriores completadas con pruebas de integración.
- ✅ Uso de memoria estable (< 50MB aumento tras 1h de operación con carga simulada).
- ✅ Latencia del Event Loop < 10ms p99 bajo carga esperada (verificado con clinic flame).
- ✅ Documentación de API generada (TypeDoc) y vitest run con cobertura > 80%.
## Demo escrita: Funcionamiento paso a paso (Entrada → Procesamiento → Salida)

### 1. **Entrada del sensor (simulado)**
   - Un proceso Node.js llamado `sensorSimulator` crea un socket TCP y se conecta al broker en el puerto 8080.
   - Cada segundo genera un mensaje JSON como:
     ```json
     {
       "timestamp":"2026-05-05T12:34:56.789Z",
       "sensorId":"a1b2c3d4-e5f6-7890-g1h2-i3j4k5l6m7n8",
       "location":"NORTE",
       "type":"TEMPERATURA",
       "value":23.5,
       "unit":"C"
     }
     ```
   - El mensaje se envía como una línea de texto terminada en `\n` mediante `socket.write(JSON.stringify(msg)+'\n')`.
### 2. **Ingreso al broker (tcpBroker)**
   - El broker, implementado con `net.createServer`, acepta la conexión del sensor.
   - Cada chunk de datos recibido se acumula en un buffer interno; cuando detecta un `\n`, extrae la línea completa.
   - La línea se pasa a un middleware de validación que usa `Zod` para asegurar que el JSON cumple con el esquema definido (tipo de datos, unidades correctas, etc.).
   - Si el mensaje es válido, el broker lo reenvía (pub) a todos los suscriptores interesados en ese `location` y `type`. En esta versión simple, hay un suscriptor por shard geográfico (por ejemplo, un `dataIngestor` para el shard NORTE).
   - El reenvío se hace mediante `socket.write()` del suscriptor, manteniendo backpressure: si el suscriptor no puede leer rápido, el broker pausa la lectura del sensor usando `socket.pause()` hasta que el suscriptor indique que está listo (`socket.resume()`).
### 3. **Procesamiento en el shard (dataIngestor → Worker Thread)**
   - El `dataIngestor` para el shard NORTE es un cliente TCP que se conecta al broker y se suscribe a temas NORTE/TEMPERATURA, etc.
   - Al recibir cada mensaje, lo envía mediante un `MessageChannel` al Worker Thread dedicado al shard NORTE (este mensaje es una copia ligera del objeto JS).
   - El Worker Thread, al recibir el mensaje, lo pasa a su instancia de `ShardDataAccess` (wrapper de better-sqlite3) que ejecuta:
     ```sql
     INSERT INTO lecturas (timestamp, sensorId, type, value) VALUES (?,?,?,?);
     ```
   - Simultáneamente, el mensaje se agrega a una ventana deslizante interna (por ejemplo, un arreglo circular de los últimos 50 valores para ese sensorId y tipo).
   - La ventana se alimenta al algoritmo de detección de anomalías (Welford's algorithm):
     - Se actualizan incrementalemente la media y la varianza.
     - Se calculan límites: `media ± k * sqrt(varianza)` (k=2 por defecto).
     - Si el valor actual está fuera de esos límites, se marca como anomalía.
   - Si se detecta anomalía, el Worker Thread envía un mensaje de alerta por su propio `MessageChannel` al hilo principal (destinado al `AlertManager`). El mensaje de alerta contiene:
     ```json
     {
       "type":"ALERT",
       "shard":"NORTE",
       "sensorId":"a1b2c3d4...",
       "timestamp":"2026-05-05T12:34:56.789Z",
       "value":23.5,
       "limitSuperior":25.0,
       "limitInferior":15.0,
       "mensaje":"Temperatura fuera de rango esperado"
     }
     ```
### 4. **Salida de alerta (AlertManager)**
   - El hilo principal recibe el mensaje de alerta vía `MessageChannel`.
   - El `AlertManager` lo procesa:
     - Lo muestra en la consola con formato legible: `[ALERT] NORTE sensor a1b2c3d4... temp 23.5°C fuera de rango [15.0,25.0]`
     - Intenta enviar un correo electrónico usando `nodemailer` (si está configurado). Si el servicio de correo falla, el alert se guarda en un archivo `alerts.log` y se intenta de nuevo posteriormente con backoff exponencial.
   - Además, el `AlertManager` actualiza un contador interno de alertas por shard, que el dashboard lee periódicamente.
### 5. **Visualización y monitoreo (dashboard)**
   - El dashboard expone un servidor HTTP en el puerto 3000.
   - Al cargar la página, el cliente JavaScript se conecta a un endpoint `/lecturas?shard=NORTE&type=TEMPERATURA` que devuelve las últimas N lecturas desde la base de datos del shard (consulta SQL simple).
   - Con esos datos dibuja una línea de tiempo usando Chart.js, mostrando la temperatura actual y las bandas de límite superior/inferior calculadas en tiempo real (las mismas que usan los workers).
   - Otro endpoint `/alertas` devuelve el contador de alertas recientes por shard; el dashboard muestra un badge rojo si el conteo es mayor que cero.
   - El dashboard también expone `/metrics` (formato Prometheus) con:
     * `lecturas_recibidas_total`
     * `alertas_generadas_total`
     * `event_loop_latency_ms` (medido periódicamente)
     * `memoria_used_bytes`
   - Un operador puede usar `curl http://localhost:3000/metrics` o integrarlo con un sistema de monitoreo como Grafana.
### 6. **Ciclo continuo**
   - Los pasos 1-5 se repiten indefinidamente para cada sensor simulado.
   - Gracias al uso de Worker Threads, el Event Loop del proceso principal nunca se bloquea por los cálculos de detección, manteniendo una latencia de red baja (<10ms p99 incluso con cientos de sensores).
   - El particionamiento de la base de datos asegura que cada shard solo lea y escriba en su propio archivo `.db`, evitando contention y permitiendo escalar geográficamente simplemente agregando nuevos shards (nuevos archivos `.db` y nuevos Worker Threads).
## Resultado esperado para el usuario

Al ejecutar el sistema, verá en la terminal:
- Mensajes de conexión de sensores al broker.
- Lecturas siendo insertadas en las bases de datos shard.
- Alertas impresas en consola cuando un valor supere los límites estadísticos.
- En el navegador, una gráfica que muestra la temperatura en tiempo real con bandas de control y un indicador de alertas.
- En caso de fallo de red simulado (por ejemplo, matar el proceso de un sensor), el broker detectará la pérdida tras 90s sin heartbeat y intentará reconexión automáticamente, sin caer el sistema completo.

Esta demo describe claramente el flujo desde que un sensor envía una lectura hasta que se genera una alerta y se muestra en la interfaz, usando solo los componentes descritos en la justificación técnica y el roadmap.