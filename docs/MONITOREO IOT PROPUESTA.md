ANÁLISIS TÉCNICO ESTRUCTURADO - STAFF ENGINEER (NODE.JS/TYPESCRIPT)  
Para: Sistema de Monitoreo Ambiental IoT (Pivoteado de Python a Node.js/TS)
---
1. ARQUITECTURA Y CONCURRENCIA EN NODE.JS  
Reemplazo de multiprocessing/threading de Python
Enfoque elegido: Worker Threads + Async I/O nativo (NO child_process)  
Justificación a nivel Staff:  
- ¿Por qué Worker Threads?  
  - El Event Loop de Node.js es single-threaded para I/O, pero las tareas de CPU (como detección de anomalías con Welford's algorithm o QuickSelect) lo bloquean.  
  - worker_threads permite ejecutar cargas pesadas de CPU en hilos separados sin el overhead de child_process (no hay serialización/deserialización de mensajes complejos; se usa MessageChannel con transferencia de ArrayBuffer para datos binarios si fuera necesario).  
  - Cada shard geográfico (NORTE, SUR, etc.) tiene su propio Worker Thread dedicado a:  
    * Lectura/escritura en su shard SQLite3 (better-sqlite3 es thread-safe por instancia)  
    * Ejecución del algoritmo de detección de anomalías  
    * Envío de alertas al alertManager mediante MessageChannel  
- ¿Por qué NO child_process?  
  - Overhead alto de serialización JSON para cada mensaje de sensor (miles por segundo).  
  - Pérdida de compartición de memoria eficiente (necesitaríamos pasar grandes buffers de históricos de sensores).  
  - Complejidad en manejo de vida de procesos (re-spawns, señales).  
- Manejo del Event Loop y Sockets TCP:  
  - El tcpBroker (implementado con net.createServer) usa el pool de hilos de libuv interno de Node.js para aceptar conexiones — no bloquea el Event Loop incluso con miles de sensores simulados.  
  - Cada conexión de sensor se maneja como un flujo (net.Socket) con backpressure nativo (usando socket.pause()/socket.resume() basado en highWaterMark).  
  - Los dataIngestors (que se suscriben al broker) son simples clientes TCP que re-emiten eventos internos (EventEmitter) — cero riesgo de bloquear el Event Loop ya que son I/O-bound, no CPU-bound.  
- Sharding y paralelismo real:  
  - 4 Worker Threads (uno por shard geográfico) + 1 Worker Thread para alertManager (aisla I/O de red de alertas) + 1 hilo principal (Event Loop + tcpBroker).  
  - Uso de worker.getEnvironmentData() para pasar configuración de shard (ruta a .db, zona geográfica) al iniciar Workers.  
---
2. DEFINICIÓN DE CLASES E INTERFACES (TYPE-SAFETY Y PATRONES)  
Estructura clave a nivel de abstracción
Interfaces centrales (TypeScript branded types para seguridad):  
// Evita mezclar unidades accidentalmente (ej. °C vs %)
type Celsius = number & { __brand: 'Celsius' };
type Percentage = number & { __brand: 'Percentage' };
type Ppm = number & { __brand: 'Ppm' };
interface SensorReading {
  timestamp: string; // ISO 8601 (validado por Zod)
  sensorId: string; // UUID v4
  location: 'NORTE' | 'SUR' | 'ESTE' | 'OESTE';
  type: 'TEMPERATURA' | 'HUMEDAD' | 'CALIDAD_AIRE';
  value: // Tipo discriminado por 'type'
    | { __type: 'TEMPERATURA'; value: Celsius }
    | { __type: 'HUMEDAD'; value: Percentage }
    | { __type: 'CALIDAD_AIRE'; value: Ppm };
  unit: // Derivado de 'type' (evita estados imposibles)
    | { __type: 'TEMPERATURA'; unit: 'C' }
    | { __type: 'HUMEDAD'; unit: '%' }
    | { __type: 'CALIDAD_AIRE'; unit: 'PPM' };
}
// Mensaje del broker (línea JSON terminada en \n)
interface BrokerMessage extends SensorReading { }
Clases principales y patrones de diseño:  
Componente	Patrón de Diseño	Justificación (Nivel Staff)
TcpBroker	Reactor + Middleware	Maneja conexiones TCP como eventos; permite insertar lógica de validación/parsing como middleware separado (testeable en aislamiento).
ShardDataAccess	Repository	Abstrae acceso a better-sqlite3; cada Worker Thread tiene su instancia (evita compartir DB connections entre threads — crítico para seguridad).
AnomalyDetector	Strategy	Permite swap entre algoritmo estadístico (Welford) y basado en mediana (QuickSelect) en tiempo de ejecución por shard (útil para pruebas A/B de sensibilidad).
AlertManager	Observer + Circuit Breaker	Sensores de alertas se suscriben a eventos; opossum evita cascadas fallidas si el servicio de email/WebSocket está down.
SensorSimulator	Factory Method	Crea tipos de sensor (temperatura/humedad/etc.) con rangos y patrones realistas por ubicación geográfica.
Type-Safety críticas aplicadas:  
- Discriminated Unions en SensorReading.value/unit impide estados imposibles (ej. temperatura con unidad '%').  
- Branded Types para unidades evita sumar °C + % por accidente (error detectado en compile-time).  
- Zod runtime validation en el broker para mensajes entrantes (defensa en profundidad: TypeScript no protege contra datos de red maliciosos o buggy).  
- Strict null checks y never en exhaustividad de switch sobre type/location (evita default: silencioso que ignora nuevos tipos de sensor).  
---
3. CONSIDERACIONES CRÍTICAS (NIVEL STAFF)  
Riesgos específicos del stack y soluciones probadas
Riesgo	Solución a Nivel Staff
Bloqueo del Event Loop por IA	- Algoritmos de detección ejecutados exclusivamente en Worker Threads.<br>- Medición de latencia del Event Loop con require('perf_hooks').eventLoopUtilization() en pruebas de carga.
Backpressure en streams TCP	- En tcpBroker: Uso consciente de socket.readable.highWaterMark y socket.writable.cork()/uncork().<br>- En dataIngestors: Implementación de Transform stream con _flush() y manejo de error en pipeline().
Conexiones SQLite3 en Workers	- Cada Worker Thread crea su propia instancia de better-sqlite3 (no se comparten).<br>- Uso de PRAGMA journal_mode=WAL para lecturas concurrentes sin bloqueo en cada .db shard.
Fuga de memoria en Workers	- Uso de --expose-gc en dev para pruebas de memoria.<br>- Evitar closures que capturen referencias a grandes buffers en handlers de eventos (usar WeakRef o limpiar explícitamente).<br>- Medición con clinic doctor en flujo de trabajo de CI.
Fallos de red parciales	- Lógica de reconexión exponencial con jitter en sensores simulados y dataIngestors.<br>- Heartbeats a nivel de aplicación (no solo TCP keepalive) para detectar cortes negros.
Sobrecarga de context switch	- Número de Worker Threads = require('os').availableParallelism() - 1 (dejando 1 core para Event Loop y I/O de red).<br>- Afinidad de CPU mediante worker thread.isMainThread ? null : worker.getEnvironmentData().cpuAffinity (Linuxのみ, opcional para fase avanzada).
---
### **4. ROADMAP DE EJECUCIÓN (HITOS PARA MVP SÓLIDO)**  
*Enfoque "vertical slice" + riesgo decreciente*
**Fase 0: Fundación (1-2 días)**  
- [ ] Repo monorepo con `turbo` o `npm workspaces` (shared `tsconfig`, `eslint`, `jest` config).  
- [ ] `tcpBroker` mínimo: Acepta conexiones TCP, eco de mensajes JSON línea por línea (prueba con `nc localhost 8080`).  
- [ ] `SensorSimulator` básico: Genera lecturas aleatorias con timestamp y envía a broker (un solo tipo de sensor).  
- **Salida:** Sistema que recibe y muestra en consola lecturas de un sensor simulado.  
**Fase 1: Sharding y Workers (3-4 días)**  
- [ ] Implementar `ShardDataAccess` con `better-sqlite3` (CREATE TABLE lecturas, INSERT simple).  
- [ ] Un Worker Thread que:  
  * Se conecta a su shard `.db`  
  * Recibe lecturas del broker mediante cliente TCP (`dataIngestor`)  
  * Almacena en su shard  
- [ ] Prueba: 2 sensores simulados → 2 shards diferentes → ver aislación de datos.  
- **Salida:** Lecturas almacenadas correctamente por shard geográfico (consultas directas a `.db` confirman partición).  
**Fase 2: Detección de Anomalías (3 días)**  
- [ ] Implementar `AnomalyDetector` (Strategy pattern) con Welford's algorithm incremental.  
- [ ] Worker Thread ahora:  
  * Almacena lectura  
  * Ejecuta detección en ventana deslizante (ej. últimos 50 puntos)  
  * Envía alerta mediante `MessageChannel` al hilo principal si anomalía detectada  
- [ ] Prueba: Inyectar valor atípico en simulador → alerta recibida en consola.  
- **Salida:** Alertas generadas correctamente basado en desviación estadística por shard.  
**Fase 3: Gestión de Alertas y Resiliencia (2-3 días)**  
- [ ] `AlertManager`: Recibe mensajes de Workers, los muestra en consola + intenta enviar por `nodemailer` (fallback a archivo de log si SMTP falla).  
- [ ] Implementar heartbeats en protocolo broker (mensaje `{type: 'HEARTBEAT'}` cada 30s).  
- [ ] Simular fallo de red: Cortar conexión de un sensor → broker detecta pérdida después de 90s → intenta reconexión.  
- **Salida:** Sistema mantiene operación durante fallos transitorios; alertas persisten incluso si notificación falla.  
**Fase 4: Dashboard y Observabilidad (2 días)**  
- [ ] `dashboard.ts`: Servidor HTTP básico (`http.createServer`) que:  
  * Sirve HTML estático con gráfico en tiempo real (Chart.js) de lecturas por shard  
  * Muestra contador de alertas por zona  
  * Expone `/metrics` (Prometheus básico: lecturas/seg, alertas/seg, lag del Event Loop)  
- [ ] Prueba de carga: 100 sensores simulados → verificar latencia < 100ms p99.  
- **Salida:** MVP con visualización en tiempo real y métricas de salud del sistema.  
**Checklist de luz verde para iniciar:**  
✅ Todas las fases anteriores completadas con pruebas de integración (no solo unitarias).  
✅ Medición de uso de memoria estable (< 50MB aumento tras 1h de operación con carga simulada).  
✅ Event Loop latency < 10ms p99 bajo carga esperada (verificado con `clinic flame`).  
✅ Documentación de API generada (TypeDoc) y ejecutando `vitest run` con cobertura > 80%.  
---
OPINIÓN SOBRE VIABILIDAD:  
ALTAMENTE VIABLE para un proyecto de licenciatura individual si se sigue este roadmap. El stack Node.js/TypeScript elegido:  
- Elimina la fricción de tipos en tiempo de ejecución (crítico para corregir errores de lógica de detección de anomalías rápidamente).  
- Aprovecha el modelo de eventos de Node.js para la capa de distribución (mucho más simple que gestionar procesos explícitos en Python para I/O-bound).  
- Mantiene el espíritu de "desarrollado a mano" — el core (broker, detección algorítmica, sharding) se construye con primitivas de Node.js y TypeScript, sin depender de frameworks de alto nivel que oculten la concurrencia.