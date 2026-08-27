import { DeviceRoleValue, GpsModeValue, type NodeTypeMoreConfig } from "../lib/meshtastic";

export interface NodeTypePresetDef {
  id: "PORTABLE_GPS" | "PORTABLE_NO_GPS" | "SOLAR_FIXED" | "PLUGGED_FIXED";
  label: string;
  description: string;
  /** id de un preset en presets/telemetryPresets.ts */
  telemetryPresetId: string;
  moreConfig: NodeTypeMoreConfig;
}

// Combinaciones de rol/GPS/posición/telemetría recomendadas por la guía "Buenas
// prácticas" de la Comunidad Meshtastic España (https://meshtastic.es/docs/buenas-practicas/)
// según el tipo de nodo. Seleccionar uno de estos rellena el preset de telemetría y fusiona
// `moreConfig` (rol, GPS, posición) directamente en el estado de "Más configuración"
// (ver `handleSelectNodeType` en App.tsx), así que se envía junto con LoRa/canal al pulsar
// el único botón de "Aplicar" — y el usuario ve los mismos valores precargados en la
// pestaña Avanzado.
export const NODE_TYPE_PRESETS: NodeTypePresetDef[] = [
  {
    id: "PORTABLE_GPS",
    label: "Nodo portátil con GPS",
    description:
      "Nodo que llevas encima con el GPS activo. Rol CLIENT_MUTE (recomendado para la mayoría de nodos " +
      "personales/móviles: no retransmite tráfico ajeno), posición cada hora (mínimo recomendado en nodos móviles) y " +
      "telemetría de batería cada 4 h.",
    telemetryPresetId: "ES_SOLAR",
    moreConfig: {
      role: DeviceRoleValue.CLIENT_MUTE,
      gpsMode: GpsModeValue.ENABLED,
      positionBroadcastSecs: 3600,
      fixedPosition: false,
    },
  },
  {
    id: "PORTABLE_NO_GPS",
    label: "Nodo portátil sin GPS",
    description:
      "Nodo móvil con GPS desactivado (para ahorrar batería). Mismo rol y telemetría que el portátil con GPS, pero sin " +
      "posición que enviar: el GPS se pone en \"Presente pero desactivado\" y el intervalo de posición a 0 (desactivado).",
    telemetryPresetId: "ES_SOLAR",
    moreConfig: {
      role: DeviceRoleValue.CLIENT_MUTE,
      gpsMode: GpsModeValue.DISABLED,
      positionBroadcastSecs: 0,
      fixedPosition: false,
    },
  },
  {
    id: "SOLAR_FIXED",
    label: "Nodo solar fijo",
    description:
      "Nodo fijo en exterior alimentado por batería/placa solar. Rol Cliente (retransmite, recomendado para exteriores " +
      "bien ubicados), posición fija cada 72 h y telemetría de batería cada 4 h.",
    telemetryPresetId: "ES_SOLAR",
    moreConfig: {
      role: DeviceRoleValue.CLIENT,
      gpsMode: GpsModeValue.NOT_PRESENT,
      positionBroadcastSecs: 259200,
      fixedPosition: true,
    },
  },
  {
    id: "PLUGGED_FIXED",
    label: "Nodo fijo enchufado",
    description:
      "Nodo fijo enchufado a la corriente (casa, azotea con toma eléctrica). Rol Cliente, posición fija cada 72 h y " +
      "telemetría de dispositivo cada 12 h.",
    telemetryPresetId: "ES_ENCHUFADO",
    moreConfig: {
      role: DeviceRoleValue.CLIENT,
      gpsMode: GpsModeValue.NOT_PRESENT,
      positionBroadcastSecs: 259200,
      fixedPosition: true,
    },
  },
];
