import { Protobuf } from "@meshtastic/core";

const { Config_LoRaConfig_ModemPreset: ModemPreset, Config_LoRaConfig_RegionCode: RegionCode } = Protobuf.Config;

export type LoRaRegion = "EU_868" | "LORA_24";

export const LORA_REGION_CODES: Record<LoRaRegion, Protobuf.Config.Config_LoRaConfig_RegionCode> = {
  EU_868: RegionCode.EU_868,
  LORA_24: RegionCode.LORA_24,
};

export interface LoRaPresetDef {
  id: string;
  label: string;
  description: string;
  /** meshtastic.es "Frequency Slot" within EU_868 (channel_num), when not using the hash-derived default */
  channelNum?: number;
  /** Región a la que está restringido este preset. Sin valor: válido en cualquier región (presets oficiales del firmware). */
  region?: LoRaRegion;
  /** Nombre de canal estándar recomendado para este preset (se usa para derivar la frecuencia/salto igual que en el resto de la malla). */
  defaultChannelName: string;
  values: {
    usePreset: boolean;
    modemPreset?: Protobuf.Config.Config_LoRaConfig_ModemPreset;
    bandwidth?: number;
    spreadFactor?: number;
    codingRate?: number;
    /** MHz. Ignora el cálculo de canal por hash y usa esta frecuencia directamente (`override_frequency` del protobuf). */
    overrideFrequency?: number;
  };
}

// Los 9 modem presets oficiales de Meshtastic (firmware actual), válidos en cualquier
// región/banda. De más rápido/corto alcance a más lento/largo alcance.
export const OFFICIAL_MODEM_PRESETS: LoRaPresetDef[] = [
  {
    id: "SHORT_TURBO",
    label: "Short Turbo",
    description: "Máximo ancho de banda, mínimo alcance. Uso muy local (mismo edificio/urbanización).",
    defaultChannelName: "ShortTurbo",
    values: { usePreset: true, modemPreset: ModemPreset.SHORT_TURBO },
  },
  {
    id: "SHORT_FAST",
    label: "Short Fast",
    description: "Rápido, alcance corto. Bueno para grupos densos y urbanos.",
    defaultChannelName: "ShortFast",
    values: { usePreset: true, modemPreset: ModemPreset.SHORT_FAST },
  },
  {
    id: "SHORT_SLOW",
    label: "Short Slow",
    values: { usePreset: true, modemPreset: ModemPreset.SHORT_SLOW },
    description: "Alcance corto-medio, algo más de sensibilidad que Short Fast.",
    defaultChannelName: "ShortSlow",
  },
  {
    id: "MEDIUM_FAST",
    label: "Medium Fast",
    description: "Equilibrio velocidad/alcance para uso urbano-periurbano.",
    defaultChannelName: "MediumFast",
    values: { usePreset: true, modemPreset: ModemPreset.MEDIUM_FAST },
  },
  {
    id: "MEDIUM_SLOW",
    label: "Medium Slow",
    description: "Más alcance que Medium Fast a costa de velocidad.",
    defaultChannelName: "MediumSlow",
    values: { usePreset: true, modemPreset: ModemPreset.MEDIUM_SLOW },
  },
  {
    id: "LONG_FAST",
    label: "Long Fast (por defecto de Meshtastic)",
    description: "Preset por defecto del firmware. Buen equilibrio general, el más usado a nivel mundial.",
    defaultChannelName: "LongFast",
    values: { usePreset: true, modemPreset: ModemPreset.LONG_FAST },
  },
  {
    id: "LONG_MODERATE",
    label: "Long Moderate",
    description: "Más alcance que Long Fast, algo más lento.",
    defaultChannelName: "LongModerate",
    values: { usePreset: true, modemPreset: ModemPreset.LONG_MODERATE },
  },
  {
    id: "LONG_SLOW",
    label: "Long Slow",
    description: "Alcance muy alto, red poco cargada de tráfico. Preset heredado (deprecated en firmware).",
    defaultChannelName: "LongSlow",
    values: { usePreset: true, modemPreset: ModemPreset.LONG_SLOW },
  },
  {
    id: "VERY_LONG_SLOW",
    label: "Very Long Slow",
    description: "Alcance máximo, tiempo de aire máximo. Preset heredado (deprecated en firmware).",
    defaultChannelName: "VeryLongSlow",
    values: { usePreset: true, modemPreset: ModemPreset.VERY_LONG_SLOW },
  },
];

// Presets personalizados de la Comunidad Meshtastic España (meshtastic.es), pensados
// para reducir interferencia entre mallas próximas usando sub-bandas dedicadas dentro
// de EU_868 en vez del hueco por defecto que usa LONG_FAST/MEDIUM_FAST.
//
// ShortPlus / ShortProMax: parámetros tomados del generador de configuración de
// meshtastic.es (BW/SF/CR + frecuencia 869.525 MHz). El channel_num/slot exacto usado
// por la comunidad no está confirmado en la documentación consultada — antes de
// aplicarlos en nodos de producción, verifica el "Frequency Slot" en
// https://meshtastic.es/docs/generador-configuracion/ y ajusta `channelNum` aquí.
export const ES_CUSTOM_PRESETS: LoRaPresetDef[] = [
  {
    id: "SFNARROW",
    label: "SFNarrow (Meshtastic España)",
    description:
      "Preset personalizado de la comunidad para reducir interferencia en la Zona Centro/Levante. BW 62kHz, SF7, CR 4/5, frecuencia fija 869.618 MHz (override_frequency, no por slot/hash).",
    region: "EU_868",
    defaultChannelName: "SFNarrow",
    values: { usePreset: false, bandwidth: 62, spreadFactor: 7, codingRate: 5, overrideFrequency: 869.618 },
  },
  {
    id: "SFNARROW_SF6",
    label: "SFNarrow — prueba SF6",
    description:
      "Variante experimental de SFNarrow con SF6 (más rápida, algo menos de alcance/sensibilidad). Frecuencia fija 869.618 MHz.",
    region: "EU_868",
    defaultChannelName: "SFNarrow",
    values: { usePreset: false, bandwidth: 62, spreadFactor: 6, codingRate: 5, overrideFrequency: 869.618 },
  },
  {
    id: "SHORT_PLUS",
    label: "ShortPlus (Meshtastic España) — verificar slot",
    description: "BW 250kHz, SF6, CR 4/5 (~869.525 MHz). Slot/channel_num pendiente de confirmar con la comunidad.",
    region: "EU_868",
    defaultChannelName: "ShortPlus",
    values: { usePreset: false, bandwidth: 250, spreadFactor: 6, codingRate: 5 },
  },
  {
    id: "SHORT_PROMAX",
    label: "ShortProMax (Meshtastic España) — verificar slot",
    description: "BW 250kHz, SF5, CR 4/5 (~869.525 MHz). Slot/channel_num pendiente de confirmar con la comunidad.",
    region: "EU_868",
    defaultChannelName: "ShortProMax",
    values: { usePreset: false, bandwidth: 250, spreadFactor: 5, codingRate: 5 },
  },
];

export const ALL_LORA_PRESETS = [...ES_CUSTOM_PRESETS, ...OFFICIAL_MODEM_PRESETS];

/** Presets válidos para una región dada: los oficiales (sin `region`, válidos en cualquiera) + los específicos de esa región. */
export function getPresetsForRegion(region: LoRaRegion): LoRaPresetDef[] {
  return ALL_LORA_PRESETS.filter((p) => !p.region || p.region === region);
}

/**
 * Nombre de canal estándar recomendado para una combinación preset+región. En 2.4GHz
 * la comunidad usa un único canal compartido ("Medium24") independientemente del
 * modem preset elegido; en el resto de casos se usa el nombre propio del preset.
 */
export function getDefaultChannelName(preset: LoRaPresetDef, region: LoRaRegion): string {
  if (region === "LORA_24") return "Medium24";
  return preset.defaultChannelName;
}
