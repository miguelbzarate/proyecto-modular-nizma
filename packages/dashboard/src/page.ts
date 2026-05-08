/**
 * Página del tablero.
 *
 * SIN DEPENDENCIAS EXTERNAS, y es una decisión, no una omisión.
 *
 * La propuesta original mencionaba Chart.js desde una CDN. Eso significa que la
 * gráfica sólo existe si hay internet: el día de la defensa, en un aula con la red
 * caída o restringida, el tablero se vería en blanco y no habría forma de arreglarlo
 * en el momento. La gráfica de aquí son unos cien renglones de SVG generado a mano,
 * que funcionan con la máquina desconectada.
 *
 * De paso es coherente con el resto del proyecto: si el broker se construyó sobre
 * primitivas de red en lugar de usar MQTT, la gráfica se dibuja con primitivas de SVG
 * en lugar de usar una biblioteca.
 */

export function renderPage(): string {
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Monitoreo Ambiental IoT</title>
<style>
  :root {
    --fondo: #0f1419;
    --panel: #1a2028;
    --borde: #2a3441;
    --texto: #e6edf3;
    --tenue: #8b98a5;
    --acento: #4a9eff;
    --alerta: #ff6b6b;
    --critico: #ff3b3b;
    --ok: #3fb950;
    --banda: rgba(74, 158, 255, 0.13);
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 24px;
    background: var(--fondo); color: var(--texto);
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  }
  h1 { font-size: 20px; margin: 0 0 4px; font-weight: 600; }
  .sub { color: var(--tenue); font-size: 13px; margin-bottom: 20px; }
  .zonas { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 12px; margin-bottom: 20px; }
  .zona {
    background: var(--panel); border: 1px solid var(--borde);
    border-radius: 8px; padding: 14px; position: relative;
  }
  .zona.caida { opacity: 0.45; }
  .zona h2 { margin: 0 0 10px; font-size: 13px; letter-spacing: 0.08em; color: var(--tenue); font-weight: 600; }
  .cifra { font-size: 26px; font-weight: 650; font-variant-numeric: tabular-nums; }
  .cifra small { font-size: 12px; color: var(--tenue); font-weight: 400; margin-left: 5px; }
  .detalle { color: var(--tenue); font-size: 12px; margin-top: 6px; font-variant-numeric: tabular-nums; }
  .insignia {
    position: absolute; top: 12px; right: 12px;
    background: var(--alerta); color: #1a0000;
    border-radius: 11px; padding: 2px 9px; font-size: 12px; font-weight: 700;
  }
  .panel { background: var(--panel); border: 1px solid var(--borde); border-radius: 8px; padding: 16px; margin-bottom: 16px; }
  .pestanas { display: flex; gap: 8px; margin-bottom: 16px; }
  .pestana {
    background: var(--panel); color: var(--tenue);
    border: 1px solid var(--borde); border-radius: 8px;
    padding: 10px 18px; font: inherit; font-weight: 600; cursor: pointer;
    transition: all 0.12s;
  }
  .pestana:hover { color: var(--texto); border-color: #3a4655; }
  .pestana.activa { background: var(--acento); color: #06121f; border-color: var(--acento); }
  .barra-fila { display: grid; grid-template-columns: 150px 1fr 110px; gap: 14px; align-items: center; margin-bottom: 10px; }
  .barra-pista { background: var(--fondo); border-radius: 5px; height: 26px; overflow: hidden; border: 1px solid var(--borde); }
  .barra-relleno { height: 100%; border-radius: 4px 0 0 4px; transition: width 0.4s; }
  .barra-valor { font-variant-numeric: tabular-nums; font-weight: 650; font-size: 15px; }
  .nota { color: var(--tenue); font-size: 13px; line-height: 1.6; margin: 14px 0 0; }
  .titulo-seccion { margin: 0 0 14px; font-size: 13px; letter-spacing: 0.08em; color: var(--tenue); font-weight: 600; }
  .grande { font-size: 30px; font-weight: 700; font-variant-numeric: tabular-nums; }
  .controles { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-bottom: 14px; }
  select {
    background: var(--fondo); color: var(--texto);
    border: 1px solid var(--borde); border-radius: 6px; padding: 6px 10px; font: inherit;
  }
  .leyenda { margin-left: auto; color: var(--tenue); font-size: 12px; display: flex; gap: 14px; align-items: center; }
  .muestra { display: inline-block; width: 11px; height: 11px; border-radius: 2px; vertical-align: -1px; margin-right: 5px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { text-align: left; color: var(--tenue); font-weight: 600; padding: 6px 8px; border-bottom: 1px solid var(--borde); font-size: 12px; }
  td { padding: 6px 8px; border-bottom: 1px solid rgba(42,52,65,0.5); font-variant-numeric: tabular-nums; }
  tr:last-child td { border-bottom: none; }
  .sev-CRITICAL { color: var(--critico); font-weight: 650; }
  .sev-WARNING { color: var(--alerta); }
  .vacio { color: var(--tenue); padding: 18px 8px; text-align: center; }
  .pie { color: var(--tenue); font-size: 12px; margin-top: 18px; }
  .pie a { color: var(--acento); }
  .punto { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--ok); margin-right: 6px; vertical-align: 0; }
  .punto.mal { background: var(--alerta); }
</style>
</head>
<body>

<h1>Sistema de Monitoreo Ambiental IoT</h1>
<div class="sub"><span id="estado"><span class="punto"></span>conectando…</span></div>

<div class="zonas" id="zonas"></div>

<div class="pestanas">
  <button class="pestana activa" data-vista="estadistica">Estadística</button>
  <button class="pestana" data-vista="ia">Inteligencia Artificial</button>
  <button class="pestana" data-vista="comparacion">Comparación</button>
</div>

<div class="panel" id="panel-grafica">
  <div class="controles">
    <select id="zona"></select>
    <select id="tipo"></select>
    <div class="leyenda">
      <span><span class="muestra" style="background:var(--acento)"></span>lectura</span>
      <span><span class="muestra" style="background:var(--banda)"></span>banda de control (media ± 3σ)</span>
      <span><span class="muestra" style="background:var(--alerta)"></span>fuera de banda</span>
    </div>
  </div>
  <div id="grafica"></div>
</div>

<div class="panel" id="panel-comparacion" style="display:none">
  <h2 class="titulo-seccion">LOS DOS DETECTORES SOBRE LAS MISMAS LECTURAS</h2>
  <div id="comparacion"></div>
</div>

<div class="panel" id="panel-alertas">
  <h2 class="titulo-seccion">ALERTAS RECIENTES</h2>
  <div id="alertas"></div>
</div>

<div class="pie">
  Métricas para Prometheus en <a href="/metrics">/metrics</a> ·
  Datos en <a href="/api/resumen">/api/resumen</a> ·
  Actualización cada 2 s
</div>

<script>
var ZONAS = [], TIPOS = [], seleccion = { zona: null, tipo: null }, fallos = 0;
var VISTA = "estadistica";

function $(id) { return document.getElementById(id); }
function texto(valor) { return String(valor).replace(/[<>&]/g, function (c) {
  return { "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c];
}); }

function hora(iso) {
  var d = new Date(iso);
  return isNaN(d) ? "—" : d.toLocaleTimeString("es-MX", { hour12: false });
}

/**
 * Gráfica de líneas en SVG.
 *
 * La banda se dibuja como un polígono cerrado: se recorren los límites superiores de
 * izquierda a derecha y los inferiores de vuelta. Los puntos que el detector marcó
 * fuera de banda se resaltan, de modo que la gráfica y las alertas cuenten la misma
 * historia.
 */
function dibujar(serie) {
  var puntos = serie.points || [];
  if (puntos.length < 2) {
    return '<div class="vacio">Aún no hay suficientes lecturas para graficar.</div>';
  }

  var W = 900, H = 300, ML = 58, MR = 14, MT = 14, MB = 26;
  var ancho = W - ML - MR, alto = H - MT - MB;

  var todos = [];
  for (var i = 0; i < puntos.length; i++) {
    todos.push(puntos[i].value);
    if (puntos[i].lower !== null) { todos.push(puntos[i].lower); todos.push(puntos[i].upper); }
  }
  var min = Math.min.apply(null, todos), max = Math.max.apply(null, todos);
  var margen = (max - min) * 0.12 || 1;
  min -= margen; max += margen;

  function x(i) { return ML + (i / (puntos.length - 1)) * ancho; }
  function y(v) { return MT + alto - ((v - min) / (max - min)) * alto; }

  var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" style="width:100%;height:auto;display:block">';

  // Rejilla horizontal con sus etiquetas.
  for (var g = 0; g <= 4; g++) {
    var valor = min + ((max - min) * g) / 4, yy = y(valor);
    svg += '<line x1="' + ML + '" y1="' + yy + '" x2="' + (W - MR) + '" y2="' + yy +
           '" stroke="#2a3441" stroke-width="1"/>';
    svg += '<text x="' + (ML - 8) + '" y="' + (yy + 4) + '" fill="#8b98a5" font-size="11" text-anchor="end">' +
           valor.toFixed(1) + '</text>';
  }

  // Banda de control: ida por arriba, vuelta por abajo.
  var arriba = "", abajo = [];
  for (var j = 0; j < puntos.length; j++) {
    if (puntos[j].upper === null) continue;
    arriba += (arriba === "" ? "M" : "L") + x(j) + " " + y(puntos[j].upper);
    abajo.push("L" + x(j) + " " + y(puntos[j].lower));
  }
  if (arriba !== "") {
    svg += '<path d="' + arriba + abajo.reverse().join("") + 'Z" fill="' +
           "rgba(74,158,255,0.13)" + '"/>';
  }

  // Media.
  var media = "";
  for (var m = 0; m < puntos.length; m++) {
    if (puntos[m].mean === null) continue;
    media += (media === "" ? "M" : "L") + x(m) + " " + y(puntos[m].mean);
  }
  if (media !== "") {
    svg += '<path d="' + media + '" fill="none" stroke="#4a9eff" stroke-width="1" ' +
           'stroke-dasharray="4 4" opacity="0.55"/>';
  }

  // Serie observada.
  var linea = "";
  for (var k = 0; k < puntos.length; k++) {
    linea += (k === 0 ? "M" : "L") + x(k) + " " + y(puntos[k].value);
  }
  svg += '<path d="' + linea + '" fill="none" stroke="#4a9eff" stroke-width="1.8" ' +
         'stroke-linejoin="round"/>';

  // Puntos marcados por el detector de la vista activa. Es el MISMO conjunto de
  // lecturas en ambas vistas: lo único que cambia es qué veredicto se pinta.
  var campo = VISTA === "ia" ? "tree" : "welford";
  var marcados = 0;
  for (var p = 0; p < puntos.length; p++) {
    if (puntos[p][campo] !== true) continue;
    marcados++;
    svg += '<circle cx="' + x(p) + '" cy="' + y(puntos[p].value) + '" r="3.5" fill="#ff6b6b"/>';
  }

  svg += '<text x="' + ML + '" y="' + (H - 6) + '" fill="#8b98a5" font-size="11">' +
         hora(puntos[0].timestamp) + '</text>';
  svg += '<text x="' + (W - MR) + '" y="' + (H - 6) + '" fill="#8b98a5" font-size="11" text-anchor="end">' +
         hora(puntos[puntos.length - 1].timestamp) + '</text>';
  svg += "</svg>";

  var ultimo = puntos[puntos.length - 1];
  var quien = VISTA === "ia" ? "árbol de decisión" : "banda de control";
  var sinDatos = VISTA === "ia" && puntos[puntos.length - 1].tree === null;
  svg += '<div class="detalle">Sensor ' + texto((serie.sensorId || "").slice(0, 8)) +
         ' · último valor ' + ultimo.value + texto(serie.unit) +
         ' · ' + puntos.length + ' lecturas · ' +
         (sinDatos
            ? 'sin modelo entrenado: corre <code>pnpm entrenar</code>'
            : marcados + ' marcadas por ' + quien) +
         '</div>';
  return svg;
}

function pintarZonas(zonas) {
  var html = "";
  for (var i = 0; i < zonas.length; i++) {
    var z = zonas[i];
    html += '<div class="zona' + (z.online ? "" : " caida") + '">';
    if (z.alerts > 0) html += '<span class="insignia">' + z.alerts + "</span>";
    html += "<h2>" + texto(z.location) + "</h2>";
    html += '<div class="cifra">' + z.readings.toLocaleString("es-MX") + "<small>lecturas</small></div>";
    html += '<div class="detalle">' + z.sensors + " sensores · " +
            (z.lastReadingAt ? "última " + hora(z.lastReadingAt) : "sin datos") + "</div>";
    html += "</div>";
  }
  $("zonas").innerHTML = html;
}

function pintarAlertas(alertas) {
  if (!alertas.length) {
    $("alertas").innerHTML = '<div class="vacio">Sin alertas registradas.</div>';
    return;
  }
  var html = "<table><tr><th>Hora</th><th>Zona</th><th>Medida</th><th>Valor</th>" +
             "<th>Severidad</th><th>Detector</th><th>Descripción</th></tr>";
  for (var i = 0; i < alertas.length; i++) {
    var a = alertas[i];
    html += "<tr><td>" + hora(a.timestamp) + "</td><td>" + texto(a.location) +
            "</td><td>" + texto(a.type) + "</td><td>" + a.value + texto(a.unit) +
            '</td><td class="sev-' + texto(a.severity) + '">' + texto(a.severity) +
            "</td><td>" + texto(a.detector) + "</td><td>" + texto(a.message) + "</td></tr>";
  }
  $("alertas").innerHTML = html + "</table>";
}

function barra(etiqueta, valor, total, color) {
  var pct = total === 0 ? 0 : (valor / total) * 100;
  return '<div class="barra-fila">' +
    '<div>' + texto(etiqueta) + "</div>" +
    '<div class="barra-pista"><div class="barra-relleno" style="width:' + pct.toFixed(1) +
      "%;background:" + color + '"></div></div>' +
    '<div class="barra-valor">' + valor.toLocaleString("es-MX") +
      ' <span style="color:var(--tenue);font-weight:400;font-size:12px">(' +
      pct.toFixed(1) + " %)</span></div>" +
    "</div>";
}

function pintarComparacion(c) {
  if (c.totalReadings === 0) {
    $("comparacion").innerHTML = '<div class="vacio">Aún no hay lecturas.</div>';
    return;
  }
  if (c.tree === null) {
    $("comparacion").innerHTML =
      '<div class="vacio">El árbol de decisión no está cargado.<br>' +
      "Corre <code>pnpm entrenar</code> y reinicia el sistema.</div>";
    return;
  }

  var normales = c.totalReadings - c.frozenReadings;
  var html = "";

  html += '<p class="nota" style="margin-top:0">Sobre <b>' +
    c.totalReadings.toLocaleString("es-MX") + " lecturas</b>, de las cuales <b>" +
    c.frozenReadings.toLocaleString("es-MX") +
    "</b> repetían exactamente el valor anterior del mismo sensor, es decir, el sensor " +
    "había dejado de variar.</p>";

  html += '<h3 class="titulo-seccion" style="margin-top:22px">' +
    "LECTURAS DE SENSOR CONGELADO QUE CADA UNO DETECTÓ</h3>";
  html += barra("Banda de control", c.welford.onFrozen, c.frozenReadings, "#5a6b7d");
  html += barra("Árbol de decisión", c.tree.onFrozen, c.frozenReadings, "#4a9eff");

  html += '<h3 class="titulo-seccion" style="margin-top:26px">' +
    "ALERTAS SOBRE LECTURAS QUE SÍ VARIABAN</h3>";
  html += barra("Banda de control", c.welford.onNormal, normales, "#5a6b7d");
  html += barra("Árbol de decisión", c.tree.onNormal, normales, "#4a9eff");

  var ventaja = c.tree.onFrozen - c.welford.onFrozen;
  html += '<p class="nota">La banda de control mira una sola cosa: si el número se ' +
    "salió del rango. Un sensor congelado repite su valor, así que coincide con su " +
    "propio promedio y le parece perfectamente sano.<br><br>" +
    "El árbol de decisión mira además <b>cuánto cambió respecto de la lectura " +
    "anterior</b>. Un cambio de exactamente cero, repetido, es la firma de un aparato " +
    "que dejó de medir.";
  if (ventaja > 0) {
    html += "<br><br><span class='grande' style='color:var(--acento)'>+" +
      ventaja.toLocaleString("es-MX") + "</span> lecturas de sensor muerto que la " +
      "estadística dejó pasar y la inteligencia artificial sí detectó.";
  }
  html += "</p>";

  $("comparacion").innerHTML = html;
}

function cambiarVista(vista) {
  VISTA = vista;
  var botones = document.querySelectorAll(".pestana");
  for (var i = 0; i < botones.length; i++) {
    botones[i].className =
      botones[i].getAttribute("data-vista") === vista ? "pestana activa" : "pestana";
  }
  var comparando = vista === "comparacion";
  $("panel-grafica").style.display = comparando ? "none" : "block";
  $("panel-alertas").style.display = comparando ? "none" : "block";
  $("panel-comparacion").style.display = comparando ? "block" : "none";
  refrescar();
}

function pedir(url) {
  return fetch(url).then(function (r) {
    if (!r.ok) throw new Error(r.status);
    return r.json();
  });
}

function refrescar() {
  return pedir("/api/resumen")
    .then(function (datos) {
      ZONAS = datos.zones;
      TIPOS = datos.types;
      if (!seleccion.zona) {
        seleccion.zona = ZONAS[0] ? ZONAS[0].location : null;
        seleccion.tipo = TIPOS[0];
        llenarSelectores();
      }
      pintarZonas(ZONAS);
      pintarAlertas(datos.alerts);
      fallos = 0;
      $("estado").innerHTML = '<span class="punto"></span>en línea · ' +
        datos.zones.reduce(function (a, z) { return a + z.readings; }, 0).toLocaleString("es-MX") +
        " lecturas totales";
      if (VISTA === "comparacion") return pedir("/api/comparacion").then(function (c) {
        pintarComparacion(c);
        return null;
      });
      if (!seleccion.zona) return null;
      return pedir("/api/serie?zona=" + seleccion.zona + "&tipo=" + seleccion.tipo);
    })
    .then(function (serie) { if (serie) $("grafica").innerHTML = dibujar(serie); })
    .catch(function () {
      fallos++;
      $("estado").innerHTML = '<span class="punto mal"></span>sin respuesta del servidor (' + fallos + ")";
    });
}

function llenarSelectores() {
  var z = "";
  for (var i = 0; i < ZONAS.length; i++) {
    z += '<option value="' + ZONAS[i].location + '">' + ZONAS[i].location + "</option>";
  }
  $("zona").innerHTML = z;
  var t = "";
  for (var j = 0; j < TIPOS.length; j++) {
    t += '<option value="' + TIPOS[j] + '">' + TIPOS[j] + "</option>";
  }
  $("tipo").innerHTML = t;
  $("zona").value = seleccion.zona;
  $("tipo").value = seleccion.tipo;
  $("zona").onchange = function () { seleccion.zona = this.value; refrescar(); };
  $("tipo").onchange = function () { seleccion.tipo = this.value; refrescar(); };
}

var botones = document.querySelectorAll(".pestana");
for (var b = 0; b < botones.length; b++) {
  botones[b].onclick = function () { cambiarVista(this.getAttribute("data-vista")); };
}

refrescar();
setInterval(refrescar, 2000);
</script>
</body>
</html>`;
}
