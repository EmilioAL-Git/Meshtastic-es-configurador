// Canales secundarios por provincia del generador de configuración de meshtastic.es
// (https://meshtastic.es/docs/generador-configuracion/). Salvo Valencia, todas usan la
// misma PSK pública "simple1" (byte 0x01, "AQ==" en base64); Valencia usa una PSK propia
// (byte 0x54, "VA==").

export interface ProvinceChannelDef {
  id: string;
  /** Nombre para mostrar en el desplegable, con tilde/ñ. */
  label: string;
  /** Nombre de canal tal como lo genera meshtastic.es (sin tildes/espacios). */
  channelName: string;
  psk: Uint8Array;
}

const DEFAULT_PROVINCE_PSK = new Uint8Array([1]); // AQ==

const RAW_PROVINCE_CHANNELS: Array<[label: string, channelName: string, psk?: Uint8Array]> = [
  ["Álava", "Alava"],
  ["Albacete", "Albacete"],
  ["Alicante", "Alicante"],
  ["Almería", "Almeria"],
  ["Ávila", "Avila"],
  ["Badajoz", "Badajoz"],
  ["Baleares", "Baleares"],
  ["Barcelona", "Barcelona"],
  ["Burgos", "Burgos"],
  ["Cáceres", "Caceres"],
  ["Cádiz", "Cadiz"],
  ["Castellón", "Castellon"],
  ["Ciudad Real", "CiudadReal"],
  ["Córdoba", "Cordoba"],
  ["A Coruña", "ACoruña"],
  ["Cuenca", "Cuenca"],
  ["Girona", "Girona"],
  ["Granada", "Granada"],
  ["Guadalajara", "Guadalajara"],
  ["Gipuzkoa", "Gipuzkoa"],
  ["Huelva", "Huelva"],
  ["Huesca", "Huesca"],
  ["Jaén", "Jaen"],
  ["Islas Canarias", "Canarias"],
  ["León", "Leon"],
  ["Lleida", "Lleida"],
  ["La Rioja", "LaRioja"],
  ["Lugo", "Lugo"],
  ["Madrid", "Madrid"],
  ["Málaga", "Malaga"],
  ["Murcia", "Murcia"],
  ["Navarra", "Navarra"],
  ["Ourense", "Ourense"],
  ["Asturias", "Asturias"],
  ["Palencia", "Palencia"],
  ["Pontevedra", "Pontevedra"],
  ["Salamanca", "Salamanca"],
  ["Cantabria", "Cantabria"],
  ["Segovia", "Segovia"],
  ["Sevilla", "Sevilla"],
  ["Soria", "Soria"],
  ["Tarragona", "Tarragona"],
  ["Teruel", "Teruel"],
  ["Toledo", "Toledo"],
  ["Valencia", "Valencia", new Uint8Array([84])],
  ["Valladolid", "Valladolid"],
  ["Bizkaia", "Bizkaia"],
  ["Zamora", "Zamora"],
  ["Zaragoza", "Zaragoza"],
  ["Ceuta", "Ceuta"],
  ["Melilla", "Melilla"],
];

export const PROVINCE_CHANNELS: ProvinceChannelDef[] = RAW_PROVINCE_CHANNELS.map(([label, channelName, psk]) => ({
  id: channelName,
  label,
  channelName,
  psk: psk ?? DEFAULT_PROVINCE_PSK,
})).sort((a, b) => a.label.localeCompare(b.label, "es"));
