# Cómo correr el sistema

Guía rápida. Para entender qué hace y por qué, ver [GUIA-DEL-PROYECTO.md](GUIA-DEL-PROYECTO.md).

---

## Preparación (una sola vez)

Hace falta **Node.js 22 o superior** y **pnpm**. Nada más: el proyecto no tiene
dependencias que haya que compilar, así que no se necesitan herramientas de C++ ni en
Windows ni en Mac.

```bash
pnpm install
pnpm build
pnpm entrenar
```

- `install` baja las librerías
- `build` traduce el código
- `entrenar` crea los 4 modelos de inteligencia artificial

---

## El comando principal

```bash
pnpm sistema --sensors 1 --interval 250 --anomaly STUCK --anomaly-duration 50 --anomaly-rate 0.006
```

Levanta **11 programas independientes**: 4 sensores simulados, el servidor central,
4 procesadores (uno por zona), el gestor de alertas y el tablero web.

Abrir en el navegador: **http://localhost:3000**

Para detener: **`Ctrl + C`**

> Deja correr **un minuto antes de grabar**, para que haya datos suficientes y las
> gráficas se vean llenas.

---

## Qué significa cada parte del comando

| Parte | Qué hace |
|---|---|
| `--sensors 1` | Un sensor por tipo de medida (3 por zona) |
| `--interval 250` | Una lectura cada 250 milisegundos |
| `--anomaly STUCK` | Simula sensores que se congelan |
| `--anomaly-duration 50` | Cada congelamiento dura 50 lecturas |
| `--anomaly-rate 0.006` | Qué tan seguido ocurre |

---

## Qué enseñar en el video

### 1. Las bases de datos

En otra terminal, con el sistema corriendo:

```bash
for z in NORTE SUR ESTE OESTE; do echo "$z: $(sqlite3 shards/$z.db 'SELECT COUNT(*) FROM readings') lecturas"; done
```

Y para demostrar que cada zona guarda **sólo lo suyo**:

```bash
for z in NORTE SUR ESTE OESTE; do echo "$z contiene: $(sqlite3 shards/$z.db 'SELECT DISTINCT location FROM readings')"; done
```

### 2. El tablero — las tres pestañas

| Pestaña | Qué mostrar |
|---|---|
| **Estadística** | Buscar un sensor con **línea plana**: el sensor está congelado y no hay puntos rojos |
| **Inteligencia Artificial** | Misma gráfica, mismos datos. Ahora la línea plana **se llena de rojo** |
| **Comparación** | El marcador: cuántas lecturas de sensor muerto detectó cada uno |

> Para encontrar un tramo plano, cambiar de zona y de medida con los dos
> selectores hasta dar con uno.

### 3. La tolerancia a fallos

```bash
pnpm resiliencia
```

Provoca tres fallas a propósito y comprueba que el sistema se recupera solo.

---

## Si algo falla

**El tablero no carga o se ve vacío**

```bash
pnpm detener
```

Luego volver a arrancar. Casi siempre son procesos de una corrida anterior
ocupando los puertos.

**Se ve la versión vieja de la página**

`Cmd + Shift + R` en el navegador. Es caché.

**Dice "No existe el modelo"**

Falta entrenar:

```bash
pnpm entrenar
```

**Empezar desde cero**

```bash
pnpm detener && rm -rf shards
```

---

## Todos los comandos

| Comando | Qué hace |
|---|---|
| `pnpm sistema` | Levanta el sistema completo |
| `pnpm detener` | Detiene todo lo que haya quedado corriendo |
| `pnpm entrenar` | Entrena los modelos de IA |
| `pnpm evaluar` | Examen comparativo de los detectores, con métricas |
| `pnpm resiliencia` | Demostración de tolerancia a fallos |
| `pnpm humo` | Verificación de extremo a extremo |
| `pnpm test` | Las 212 pruebas automáticas |
