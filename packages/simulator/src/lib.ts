/**
 * Superficie del simulador como biblioteca.
 *
 * `index.ts` es el proceso: importarlo arrancaría sockets y temporizadores. El
 * generador de conjuntos de datos necesita el modelo de sensor sin nada de eso, así
 * que la biblioteca y el ejecutable son puntos de entrada distintos.
 *
 * Que el entrenamiento use exactamente el mismo `SimulatedSensor` que corre en
 * producción no es un detalle: si el conjunto de datos viniera de un generador
 * paralelo, el modelo se entrenaría sobre una distribución que nunca va a ver.
 */

export * from "./anomaly";
export * from "./sensor";
