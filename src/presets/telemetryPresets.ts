export interface TelemetryPresetDef {
  id: string;
  label: string;
  description: string;
  values: {
    deviceUpdateInterval: number;
    environmentMeasurementEnabled: boolean;
    environmentUpdateInterval: number;
  };
}

// Valores tomados literalmente de la guía "Buenas prácticas" de la Comunidad
// Meshtastic España (https://meshtastic.es/docs/buenas-practicas/), sección
// "Intervalos de broadcast automáticos". La telemetría es, según ese artículo,
// más del 90% del tráfico total en mallas grandes — los intervalos recomendados
// son MÍNIMOS: en zonas con mucha densidad de nodos conviene subirlos aún más.
export const TELEMETRY_PRESETS: TelemetryPresetDef[] = [
  {
    id: "ES_RECOMENDADO",
    label: "Recomendado (Meshtastic España)",
    description:
      "Métricas del dispositivo cada 12 h (43200 s), como recomienda meshtastic.es. Métricas de entorno desactivadas: son " +
      "\"información chula pero poco importante para la malla\" y la mayoría de nodos ni siquiera tienen esos sensores.",
    values: {
      deviceUpdateInterval: 43200,
      environmentMeasurementEnabled: false,
      environmentUpdateInterval: 0,
    },
  },
  {
    id: "ES_MALLA_DENSA",
    label: "Malla muy densa (24 h)",
    description:
      "Para zonas con muchos nodos: el propio artículo indica que 43200 s es un mínimo y se puede subir más para mejorar " +
      "el rendimiento de la malla.",
    values: {
      deviceUpdateInterval: 86400,
      environmentMeasurementEnabled: false,
      environmentUpdateInterval: 0,
    },
  },
  {
    id: "MIN_POSIBLE",
    label: "Mínima posible",
    description:
      "El firmware que entiende esta versión del configurador no permite apagar del todo la telemetría de dispositivo " +
      "(ese interruptor no existe en la versión de protobuf que trae empaquetada, aunque el firmware más reciente sí lo " +
      "tiene). Este preset deja el intervalo en el máximo técnico (~136 años) para acercarse todo lo posible a \"apagada\".",
    values: {
      deviceUpdateInterval: 4294967295,
      environmentMeasurementEnabled: false,
      environmentUpdateInterval: 0,
    },
  },
];
