export interface TelemetryPresetDef {
  id: string;
  label: string;
  description: string;
  values: {
    deviceUpdateInterval: number;
    environmentMeasurementEnabled: boolean;
    environmentUpdateInterval: number;
    /** Corriente/voltaje de placas externas (INA219/INA3221, paneles solares…). */
    powerMeasurementEnabled: boolean;
    powerUpdateInterval: number;
    /** Requiere un sensor de calidad de aire (CO2/VOC/partículas) conectado al nodo. */
    airQualityEnabled: boolean;
    airQualityInterval: number;
    /** Sensores biométricos (firmware reciente). */
    healthMeasurementEnabled: boolean;
    healthUpdateInterval: number;
  };
}

// Valores tomados literalmente de la guía "Buenas prácticas" de la Comunidad
// Meshtastic España (https://meshtastic.es/docs/buenas-practicas/), sección de
// configuración de telemetría. El artículo distingue el intervalo recomendado según
// el tipo de alimentación del nodo (enchufado / solar / infraestructura) para la
// telemetría de dispositivo, y pide desactivar (o subir por encima de 4h) el resto de
// métricas opcionales: entorno, eléctricas ("desactivar salvo que se necesiten
// específicamente")... Aplicamos el mismo criterio a calidad de aire y salud, que
// dependen de sensores que la inmensa mayoría de nodos no lleva y que el artículo no
// menciona explícitamente, pero para los que aplica el mismo principio general de
// minimizar tráfico innecesario en la malla.
export const TELEMETRY_PRESETS: TelemetryPresetDef[] = [
  {
    id: "ES_ENCHUFADO",
    label: "Nodo enchufado (casa)",
    description:
      "12 horas (43200 s), el valor recomendado por meshtastic.es para nodos enchufados: no dependen de batería, pero " +
      "conviene igualmente mantener un intervalo alto para no generar tráfico innecesario en la malla. Entorno, " +
      "potencia, calidad del aire y salud desactivadas.",
    values: {
      deviceUpdateInterval: 43200,
      environmentMeasurementEnabled: false,
      environmentUpdateInterval: 0,
      powerMeasurementEnabled: false,
      powerUpdateInterval: 0,
      airQualityEnabled: false,
      airQualityInterval: 0,
      healthMeasurementEnabled: false,
      healthUpdateInterval: 0,
    },
  },
  {
    id: "ES_SOLAR",
    label: "Nodo solar/con batería",
    description:
      "4 horas (14400 s): el mínimo que recomienda meshtastic.es para nodos alimentados por batería o placa solar, " +
      "suficiente para vigilar el nivel de batería sin saturar la malla. Entorno, potencia, calidad del aire y salud " +
      "desactivadas.",
    values: {
      deviceUpdateInterval: 14400,
      environmentMeasurementEnabled: false,
      environmentUpdateInterval: 0,
      powerMeasurementEnabled: false,
      powerUpdateInterval: 0,
      airQualityEnabled: false,
      airQualityInterval: 0,
      healthMeasurementEnabled: false,
      healthUpdateInterval: 0,
    },
  },
  {
    id: "ES_INFRAESTRUCTURA",
    label: "Infraestructura / backbone",
    description:
      "6 horas (21600 s): el mínimo que recomienda meshtastic.es para nodos de infraestructura (ROUTER/CLIENT_BASE en " +
      "ubicaciones estratégicas). Son los nodos por los que pasa más tráfico ajeno, así que conviene ser aún más " +
      "conservador con el suyo propio. Entorno, potencia, calidad del aire y salud desactivadas.",
    values: {
      deviceUpdateInterval: 21600,
      environmentMeasurementEnabled: false,
      environmentUpdateInterval: 0,
      powerMeasurementEnabled: false,
      powerUpdateInterval: 0,
      airQualityEnabled: false,
      airQualityInterval: 0,
      healthMeasurementEnabled: false,
      healthUpdateInterval: 0,
    },
  },
];
