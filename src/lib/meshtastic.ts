import { create, fromBinary, fromJson, toBinary, toJson } from "@bufbuild/protobuf";
import { MeshDevice, Protobuf, Types } from "@meshtastic/core";
import { TransportWebSerial } from "@meshtastic/transport-web-serial";
import { TransportWebBluetooth } from "@meshtastic/transport-web-bluetooth";
import { TransportHTTP } from "@meshtastic/transport-http";
import type { LoRaPresetDef } from "../presets/loraPresets";
import type { TelemetryPresetDef } from "../presets/telemetryPresets";

const { ConfigSchema, Config_LoRaConfigSchema } = Protobuf.Config;
const { ModuleConfigSchema, ModuleConfig_TelemetryConfigSchema } = Protobuf.ModuleConfig;
const { ChannelSchema, ChannelSettingsSchema, Channel_Role } = Protobuf.Channel;
const { UserSchema } = Protobuf.Mesh;
const { ChannelSetSchema } = Protobuf.AppOnly;
const { LocalConfigSchema, LocalModuleConfigSchema } = Protobuf.LocalOnly;
const { DeviceProfileSchema } = Protobuf.ClientOnly;
export type DeviceProfile = Protobuf.ClientOnly.DeviceProfile;

export interface ChannelPreset {
  name: string;
  /** Pre-shared key. Usa un solo byte 0x01-0x0A para las claves "simple1".."simple10", vacío para sin cifrar. */
  psk: Uint8Array;
}

export const noEncryptionPsk = new Uint8Array([]);
export const defaultSimplePsk = new Uint8Array([1]); // "simple1" — clave pública conocida, NO segura

/**
 * Decodifica una PSK en base64 (el formato en el que Meshtastic la muestra/comparte,
 * p.ej. en las URLs de canal `meshtastic.org/e/#...` o en la app oficial) a los bytes
 * crudos que espera el protobuf. Un error habitual es pegar esa clave como si fuera
 * texto plano — eso genera una clave completamente distinta (y de longitud inválida)
 * sin que el propio Bluetooth/USB dé ningún error: el nodo simplemente no puede hablar
 * con el resto de la malla porque tiene otra clave.
 *
 * @returns los bytes de la clave, o `null` si no es base64 válido o la longitud no es
 * una de las que acepta el firmware (0 = sin cifrar, 1 = clave pública "simpleN", 16 =
 * AES128, 32 = AES256).
 */
export function decodeCustomPsk(base64: string): Uint8Array | null {
  const trimmed = base64.trim();
  if (trimmed === "") return noEncryptionPsk;
  try {
    const binary = atob(trimmed);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    if (bytes.length === 0 || bytes.length === 1 || bytes.length === 16 || bytes.length === 32) {
      return bytes;
    }
    return null;
  } catch {
    return null;
  }
}

/** Codifica una PSK a base64, el formato en el que Meshtastic la muestra/comparte. */
export function encodePskBase64(psk: Uint8Array): string {
  return btoa(String.fromCharCode(...psk));
}

/** Base64 "url-safe" sin padding: el formato que usan las URLs de canal `meshtastic.org/e/#...`. */
function bytesToBase64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlToBytes(base64Url: string): Uint8Array {
  const padded = base64Url.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(base64Url.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

const KNOWN_ERROR_TRANSLATIONS: Array<[RegExp, string]> = [
  [/no port selected/i, "No se ha seleccionado ningún puerto."],
  [/no devices found/i, "No se ha encontrado ningún dispositivo."],
  [/user cancelled|user gesture/i, "Operación cancelada por el usuario."],
  [/security error|permission/i, "Permiso denegado por el navegador."],
  [/network error/i, "Error de conexión con el dispositivo."],
  [/gatt operation failed/i, "Fallo de comunicación Bluetooth con el dispositivo (GATT)."],
  [/failed to open/i, "No se ha podido abrir el puerto."],
  [/tiempo de espera agotado/i, "Tiempo de espera agotado esperando la configuración inicial del dispositivo."],
  [/failed to fetch/i, "No se ha podido contactar con el nodo por red. Comprueba la IP/host y que esté en la misma red."],
];

/** Traduce al español los mensajes de error habituales de Web Serial/Bluetooth y del SDK; si no reconoce el mensaje, lo deja tal cual. */
export function translateError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const match = KNOWN_ERROR_TRANSLATIONS.find(([pattern]) => pattern.test(message));
  return match ? match[1] : message;
}

export function isWebSerialSupported(): boolean {
  return typeof navigator !== "undefined" && "serial" in navigator;
}

export function isWebBluetoothSupported(): boolean {
  return typeof navigator !== "undefined" && "bluetooth" in navigator;
}

/**
 * @meshtastic/core bundles tslog's Node.js runtime code by mistake, and its
 * "pretty" log formatter and stack-position lookup call Node builtins
 * (`util.formatWithOptions`, `path.normalize`) that don't exist in browsers —
 * both crash with "is not a function" the moment the SDK logs anything during
 * connect/configure. We don't use this internal logger for anything (our own
 * UI has its own progress log), so silence it outright instead of chasing
 * every Node call tslog's browser build forgot to guard.
 */
function silenceDeviceLogger(device: MeshDevice): void {
  const settings = (
    device.log as unknown as { settings: { type: string; hideLogPositionForProduction: boolean } }
  ).settings;
  settings.type = "hidden";
  settings.hideLogPositionForProduction = true;
}

/**
 * Línea de progreso. `replace: true` sustituye la última línea en vez de añadir una
 * nueva (para contadores). `percent` es una estimación 0-100 del avance total, basada
 * en los pasos conocidos del proceso (no en bytes/tiempo real, que no podemos medir).
 */
export type ProgressFn = (line: string, opts?: { replace?: boolean; percent?: number }) => void;

// Reparto de la barra de progreso durante el handshake de conexión. La única fase sin
// duración conocible de antemano es la descarga del NodeDB (no hay forma de saber
// cuántos nodos tiene la malla hasta que se han recibido todos) — para esa fase se usa
// una curva que se acerca a CONFIGURING_END sin llegar nunca del todo, en vez de un
// contador lineal que se quedaría "parado" en el 100% mientras siguen llegando nodos.
const CONNECT_PERCENT = {
  connecting: 5,
  connected: 20,
  configuringStart: 30,
  myNodeInfo: 35,
  configuringEnd: 80,
  channelStep: 3,
  configured: 100,
};

function describeDeviceStatus(status: Types.DeviceStatusEnum): { message: string; percent: number } | null {
  switch (status) {
    case Types.DeviceStatusEnum.DeviceConnecting:
      return { message: "Abriendo la conexión con el nodo…", percent: CONNECT_PERCENT.connecting };
    case Types.DeviceStatusEnum.DeviceReconnecting:
      return { message: "Reconectando con el nodo…", percent: CONNECT_PERCENT.connecting };
    case Types.DeviceStatusEnum.DeviceConnected:
      return { message: "Conectado. Solicitando configuración del nodo…", percent: CONNECT_PERCENT.connected };
    case Types.DeviceStatusEnum.DeviceConfiguring:
      return {
        message: "Descargando configuración y nodos conocidos de la malla…",
        percent: CONNECT_PERCENT.configuringStart,
      };
    case Types.DeviceStatusEnum.DeviceConfigured:
      return { message: "Configuración del nodo recibida.", percent: CONNECT_PERCENT.configured };
    default:
      return null;
  }
}

/** Traduce los eventos internos del SDK durante el handshake de conexión a mensajes legibles y un % estimado. */
function trackConnectionProgress(device: MeshDevice, onProgress?: ProgressFn): () => void {
  if (!onProgress) return () => {};

  let nodeCount = 0;
  let channelCount = 0;
  const unsubs: Array<() => void> = [
    device.events.onDeviceStatus.subscribe((status) => {
      const step = describeDeviceStatus(status);
      if (step) onProgress(step.message, { percent: step.percent });
    }),
    device.events.onMyNodeInfo.subscribe((info) => {
      onProgress(`Nodo identificado (núm. ${info.myNodeNum}).`, { percent: CONNECT_PERCENT.myNodeInfo });
    }),
    device.events.onNodeInfoPacket.subscribe(() => {
      nodeCount += 1;
      // Se acerca asintóticamente a configuringEnd sin tocarlo nunca del todo, ya que
      // no sabemos cuántos nodos quedan por llegar.
      const span = CONNECT_PERCENT.configuringEnd - CONNECT_PERCENT.myNodeInfo;
      const percent = CONNECT_PERCENT.myNodeInfo + span * (1 - 1 / (1 + nodeCount / 8));
      onProgress(`Recibiendo nodos conocidos de la malla… (${nodeCount})`, {
        replace: nodeCount > 1,
        percent,
      });
    }),
    device.events.onChannelPacket.subscribe((channel) => {
      channelCount += 1;
      onProgress(`Canal recibido: ${channel.settings?.name || "(sin nombre)"} (índice ${channel.index}).`, {
        percent: Math.min(
          CONNECT_PERCENT.configuringEnd,
          CONNECT_PERCENT.myNodeInfo + channelCount * CONNECT_PERCENT.channelStep,
        ),
      });
    }),
  ];
  return () => unsubs.forEach((unsub) => unsub());
}

/**
 * `device.configure()` sends the `want_config_id` request and returns a promise tied
 * to the SDK's internal packet queue — but that specific packet type never gets a real
 * ack from the firmware, so the queue always waits out its own 60s timeout before
 * resolving it (see Queue.push in @meshtastic/core: wantConfigId/heartbeat packets
 * resolve on timeout instead of rejecting). That's unrelated to how long the actual
 * config handshake takes, which is what the DeviceConfigured status event already
 * tells us. Awaiting configure() before proceeding made every connection take a flat
 * 60 seconds even though the real handshake finished in a couple of seconds. Fire it
 * without waiting on it — this is also how @meshtastic/core's own reconnect logic
 * calls it internally — and rely solely on the status event via waitUntilConfigured.
 */
function requestConfigure(device: MeshDevice): void {
  device.configure().catch(() => {});
}

/** Resultado de conectar: el dispositivo, cómo dejar de escuchar su configuración (llamar al
 * desconectar), y cómo leer lo que se ha ido recogiendo de ella para exportarla. */
export interface ConnectResult {
  device: MeshDevice;
  stopSnapshotTracking: () => void;
  getDeviceProfileSource: () => DeviceProfileSource;
}

export async function connectSerial(onProgress?: ProgressFn, onSnapshot?: (snapshot: DeviceSnapshot) => void): Promise<ConnectResult> {
  const transport = await TransportWebSerial.create();
  const device = new MeshDevice(transport);
  silenceDeviceLogger(device);
  // La identidad/LoRa/canales/telemetría del nodo llegan como parte del propio
  // handshake de conexión (los mismos eventos que usa trackConnectionProgress) — hay
  // que escucharlos desde YA, no después de que `configured` resuelva, porque para
  // entonces ya han pasado y no se repiten.
  const tracking = subscribeDeviceSnapshot(device, onSnapshot);
  const stopTracking = trackConnectionProgress(device, onProgress);
  try {
    requestConfigure(device);
    await waitUntilConfigured(device);
  } finally {
    stopTracking();
  }
  return { device, stopSnapshotTracking: tracking.stop, getDeviceProfileSource: tracking.getRaw };
}

export async function connectBluetooth(onProgress?: ProgressFn, onSnapshot?: (snapshot: DeviceSnapshot) => void): Promise<ConnectResult> {
  const transport = await TransportWebBluetooth.create();
  const device = new MeshDevice(transport);
  silenceDeviceLogger(device);
  const tracking = subscribeDeviceSnapshot(device, onSnapshot);
  const stopTracking = trackConnectionProgress(device, onProgress);
  try {
    requestConfigure(device);
    await waitUntilConfigured(device);
  } finally {
    stopTracking();
  }
  return { device, stopSnapshotTracking: tracking.stop, getDeviceProfileSource: tracking.getRaw };
}

/**
 * Conecta por red (WiFi/Ethernet) hablando con la API HTTP del propio nodo
 * (`/api/v1/toradio` y `/api/v1/fromradio`), la misma que usa la app oficial para el
 * modo "cliente HTTP". `address` acepta host o IP, opcionalmente con puerto
 * (`192.168.1.50` o `192.168.1.50:80`); `tls` fuerza `https://` en vez de `http://` para
 * nodos con TLS habilitado en su interfaz web.
 */
export async function connectNetwork(
  address: string,
  tls: boolean,
  onProgress?: ProgressFn,
  onSnapshot?: (snapshot: DeviceSnapshot) => void,
): Promise<ConnectResult> {
  const transport = await TransportHTTP.create(address.trim(), tls);
  const device = new MeshDevice(transport);
  silenceDeviceLogger(device);
  const tracking = subscribeDeviceSnapshot(device, onSnapshot);
  const stopTracking = trackConnectionProgress(device, onProgress);
  try {
    requestConfigure(device);
    await waitUntilConfigured(device);
  } finally {
    stopTracking();
  }
  return { device, stopSnapshotTracking: tracking.stop, getDeviceProfileSource: tracking.getRaw };
}

/** Espera a que el dispositivo termine el handshake inicial (DeviceConfigured). */
function waitUntilConfigured(device: MeshDevice, timeoutMs = 20000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error("Tiempo de espera agotado esperando la configuración inicial del dispositivo"));
    }, timeoutMs);

    const unsubscribe = device.events.onDeviceStatus.subscribe((status) => {
      if (status === Types.DeviceStatusEnum.DeviceConfigured) {
        clearTimeout(timer);
        unsubscribe();
        resolve();
      }
    });
  });
}

export interface DeviceSnapshotChannel {
  index: number;
  name: string;
  role: string;
  encrypted: boolean;
}

export interface DeviceSnapshotLora {
  region: string;
  usePreset: boolean;
  modemPreset: string;
  bandwidth: number;
  spreadFactor: number;
  codingRate: number;
  channelNum: number;
  overrideFrequency: number;
  txPower: number;
  hopLimit: number;
}

export interface DeviceSnapshotTelemetry {
  deviceUpdateInterval: number;
  environmentMeasurementEnabled: boolean;
  environmentUpdateInterval: number;
}

/** Configuración real leída del nodo tras conectar (no lo que se va a aplicar, sino lo que ya tiene). */
export interface DeviceSnapshot {
  nodeNum: number | null;
  longName: string | null;
  shortName: string | null;
  hwModel: string | null;
  lora: DeviceSnapshotLora | null;
  channels: DeviceSnapshotChannel[];
  telemetry: DeviceSnapshotTelemetry | null;
}

const EMPTY_SNAPSHOT: DeviceSnapshot = {
  nodeNum: null,
  longName: null,
  shortName: null,
  hwModel: null,
  lora: null,
  channels: [],
  telemetry: null,
};

/**
 * Configuración cruda (mensajes protobuf tal cual los manda el nodo, no la versión
 * traducida a texto de `DeviceSnapshot`) que necesitamos guardar para poder exportarla
 * como perfil de dispositivo compatible con el formato JSON propio de Meshtastic. `config`
 * y `moduleConfig` se van rellenando sección a sección (device, position, power, network,
 * display, lora, bluetooth, security / mqtt, serial, telemetry, etc.) según van llegando
 * durante el handshake de conexión — el propio nodo manda todas las secciones sin que
 * haga falta pedirlas una a una.
 */
export interface DeviceProfileSource {
  longName: string | null;
  shortName: string | null;
  config: Protobuf.LocalOnly.LocalConfig;
  moduleConfig: Protobuf.LocalOnly.LocalModuleConfig;
  /** Canales activos (sin los slots DISABLED), en orden de índice; el [0] es siempre el primario. */
  channels: Protobuf.Channel.Channel[];
}

/**
 * Se suscribe a los eventos del dispositivo para ir montando (y mantener al día,
 * mientras dure la conexión) una foto de la configuración que el nodo ya tiene:
 * identidad, LoRa, canales y telemetría (para el panel de la UI, que solo muestra eso), y
 * en paralelo la configuración completa cruda del nodo (todas las secciones, para poder
 * exportarla). Llama a `onUpdate` (si se da) con una copia nueva del resumen para la UI
 * cada vez que llega un dato relevante — normalmente varias veces durante el handshake
 * inicial, y de nuevo si el propio nodo cambia algo de configuración más adelante.
 * `getRaw` devuelve en cualquier momento la configuración cruda recogida hasta ahora.
 */
export function subscribeDeviceSnapshot(
  device: MeshDevice,
  onUpdate?: (snapshot: DeviceSnapshot) => void,
): { stop: () => void; getRaw: () => DeviceProfileSource } {
  let snapshot: DeviceSnapshot = { ...EMPTY_SNAPSHOT, channels: [] };
  let myNodeNum: number | null = null;
  let longName: string | null = null;
  let shortName: string | null = null;
  const rawConfig = create(LocalConfigSchema, {}) as Record<string, unknown>;
  const rawModuleConfig = create(LocalModuleConfigSchema, {}) as Record<string, unknown>;
  let rawChannels: Protobuf.Channel.Channel[] = [];

  function emit() {
    onUpdate?.({ ...snapshot, channels: [...snapshot.channels] });
  }

  const unsubs: Array<() => void> = [
    device.events.onMyNodeInfo.subscribe((info) => {
      myNodeNum = info.myNodeNum;
      snapshot = { ...snapshot, nodeNum: info.myNodeNum };
      emit();
    }),
    device.events.onNodeInfoPacket.subscribe((nodeInfo) => {
      if (myNodeNum === null || nodeInfo.num !== myNodeNum || !nodeInfo.user) return;
      longName = nodeInfo.user.longName || null;
      shortName = nodeInfo.user.shortName || null;
      snapshot = {
        ...snapshot,
        longName,
        shortName,
        hwModel: Protobuf.Mesh.HardwareModel[nodeInfo.user.hwModel] ?? null,
      };
      emit();
    }),
    // El handshake manda una sección de Config por paquete (device, position, power,
    // network, display, lora, bluetooth, security…) — las guardamos todas para poder
    // exportar la configuración completa, aunque el panel de la UI solo muestre LoRa.
    device.events.onConfigPacket.subscribe((config) => {
      const { case: kind, value } = config.payloadVariant;
      if (!kind || kind === "sessionkey") return;
      rawConfig[kind] = value;

      if (kind === "lora") {
        const l = value;
        snapshot = {
          ...snapshot,
          lora: {
            region: Protobuf.Config.Config_LoRaConfig_RegionCode[l.region] ?? String(l.region),
            usePreset: l.usePreset,
            modemPreset: Protobuf.Config.Config_LoRaConfig_ModemPreset[l.modemPreset] ?? String(l.modemPreset),
            bandwidth: l.bandwidth,
            spreadFactor: l.spreadFactor,
            codingRate: l.codingRate,
            channelNum: l.channelNum,
            overrideFrequency: l.overrideFrequency,
            txPower: l.txPower,
            hopLimit: l.hopLimit,
          },
        };
      }
      emit();
    }),
    // Igual que con Config: una sección de ModuleConfig por paquete (mqtt, serial,
    // telemetry, cannedMessage, etc.), todas se guardan para la exportación completa.
    device.events.onModuleConfigPacket.subscribe((moduleConfig) => {
      const { case: kind, value } = moduleConfig.payloadVariant;
      if (!kind) return;
      rawModuleConfig[kind] = value;

      if (kind === "telemetry") {
        const t = value;
        snapshot = {
          ...snapshot,
          telemetry: {
            deviceUpdateInterval: t.deviceUpdateInterval,
            environmentMeasurementEnabled: t.environmentMeasurementEnabled,
            environmentUpdateInterval: t.environmentUpdateInterval,
          },
        };
      }
      emit();
    }),
    device.events.onChannelPacket.subscribe((channel) => {
      // Los slots de canal sin usar (role DISABLED) también generan un paquete; no
      // aportan nada en la foto de "lo que tiene configurado el nodo".
      if (channel.role === Channel_Role.DISABLED) return;
      const entry: DeviceSnapshotChannel = {
        index: channel.index,
        name: channel.settings?.name || "(sin nombre)",
        role: Channel_Role[channel.role] ?? String(channel.role),
        encrypted: (channel.settings?.psk?.length ?? 0) > 0,
      };
      const channels = snapshot.channels.filter((c) => c.index !== entry.index);
      channels.push(entry);
      channels.sort((a, b) => a.index - b.index);
      snapshot = { ...snapshot, channels };

      rawChannels = rawChannels.filter((c) => c.index !== channel.index);
      rawChannels.push(channel);
      rawChannels.sort((a, b) => a.index - b.index);
      emit();
    }),
  ];
  return {
    stop: () => unsubs.forEach((unsub) => unsub()),
    getRaw: () => ({
      longName,
      shortName,
      config: { ...rawConfig } as Protobuf.LocalOnly.LocalConfig,
      moduleConfig: { ...rawModuleConfig } as Protobuf.LocalOnly.LocalModuleConfig,
      channels: [...rawChannels],
    }),
  };
}

export interface ApplyPresetOptions {
  lora: LoRaPresetDef;
  channel: ChannelPreset;
  /** Canal secundario opcional (índice 1), p.ej. el canal provincial de la comunidad. */
  secondaryChannel?: ChannelPreset;
  telemetry: TelemetryPresetDef;
  region: Protobuf.Config.Config_LoRaConfig_RegionCode;
  onProgress?: ProgressFn;
}

/** Aplica LoRa + canal primario + intervalos de telemetría a un nodo ya conectado, y reinicia. */
export async function applyPreset(device: MeshDevice, opts: ApplyPresetOptions): Promise<void> {
  const { region, onProgress } = opts;

  onProgress?.("Enviando configuración LoRa…", { percent: 5 });
  const loraConfig = create(Config_LoRaConfigSchema, {
    usePreset: opts.lora.values.usePreset,
    modemPreset: opts.lora.values.modemPreset,
    bandwidth: opts.lora.values.bandwidth ?? 0,
    spreadFactor: opts.lora.values.spreadFactor ?? 0,
    codingRate: opts.lora.values.codingRate ?? 0,
    channelNum: opts.lora.channelNum ?? 0,
    overrideFrequency: opts.lora.values.overrideFrequency ?? 0,
    region,
    txEnabled: true,
  });
  await device.setConfig(
    create(ConfigSchema, { payloadVariant: { case: "lora", value: loraConfig } }),
  );

  onProgress?.("Enviando canal primario…", { percent: 30 });
  const channelSettings = create(ChannelSettingsSchema, {
    name: opts.channel.name,
    psk: opts.channel.psk,
  });
  await device.setChannel(
    create(ChannelSchema, { index: 0, role: Channel_Role.PRIMARY, settings: channelSettings }),
  );

  if (opts.secondaryChannel) {
    onProgress?.("Enviando canal secundario…", { percent: 45 });
    const secondarySettings = create(ChannelSettingsSchema, {
      name: opts.secondaryChannel.name,
      psk: opts.secondaryChannel.psk,
    });
    await device.setChannel(
      create(ChannelSchema, { index: 1, role: Channel_Role.SECONDARY, settings: secondarySettings }),
    );
  }

  onProgress?.("Enviando intervalos de telemetría…", { percent: 55 });
  const telemetryConfig = create(ModuleConfig_TelemetryConfigSchema, {
    deviceUpdateInterval: opts.telemetry.values.deviceUpdateInterval,
    environmentUpdateInterval: opts.telemetry.values.environmentUpdateInterval,
    environmentMeasurementEnabled: opts.telemetry.values.environmentMeasurementEnabled,
  });
  await device.setModuleConfig(
    create(ModuleConfigSchema, { payloadVariant: { case: "telemetry", value: telemetryConfig } }),
  );

  onProgress?.("Reiniciando el nodo para aplicar los cambios…", { percent: 80 });
  await device.reboot(2);
  onProgress?.("Configuración aplicada. El nodo se está reiniciando.", { percent: 100 });
}

const CHANNEL_URL_PREFIX = "https://meshtastic.org/e/#";

/**
 * Construye la URL de canales (`https://meshtastic.org/e/#...`) que usan la app oficial
 * y las URLs de invitación de Meshtastic: un `ChannelSet` (canales + config LoRa)
 * serializado en protobuf binario y codificado en base64 "url-safe".
 */
function buildChannelUrl(channels: Protobuf.Channel.Channel[], lora: Protobuf.Config.Config_LoRaConfig | null): string {
  const channelSet = create(ChannelSetSchema, {
    settings: channels
      .filter((c) => c.settings)
      .map((c) => create(ChannelSettingsSchema, { name: c.settings?.name, psk: c.settings?.psk })),
    loraConfig: lora ?? undefined,
  });
  const bytes = toBinary(ChannelSetSchema, channelSet);
  return CHANNEL_URL_PREFIX + bytesToBase64Url(bytes);
}

/** Decodifica una URL de canales de Meshtastic (o solo su parte en base64) a un `ChannelSet`. */
function parseChannelUrl(channelUrl: string): Protobuf.AppOnly.ChannelSet {
  const encoded = channelUrl.includes("#") ? channelUrl.slice(channelUrl.lastIndexOf("#") + 1) : channelUrl;
  return fromBinary(ChannelSetSchema, base64UrlToBytes(encoded.trim()));
}

/**
 * Exporta toda la configuración que ya conocemos del nodo conectado (identidad y todas
 * las secciones de Config/ModuleConfig recibidas durante el handshake, más los canales)
 * como un `DeviceProfile` en JSON — el mismo formato que usan "Exportar
 * configuración"/"Importar configuración" en la app oficial de Meshtastic.
 */
export function exportDeviceProfileJson(source: DeviceProfileSource): string {
  // La clave privada del nodo (Config.security.private_key) nunca debe salir de él: es
  // el secreto que le da su identidad criptográfica en la malla. Si se filtra en un
  // fichero y se reimporta en otro nodo, ambos acabarían compartiendo identidad. La app
  // oficial hace lo mismo al exportar.
  const config = source.config.security
    ? { ...source.config, security: { ...source.config.security, privateKey: new Uint8Array() } }
    : source.config;

  const profile = create(DeviceProfileSchema, {
    longName: source.longName ?? undefined,
    shortName: source.shortName ?? undefined,
    channelUrl: source.channels.length > 0 ? buildChannelUrl(source.channels, source.config.lora ?? null) : undefined,
    config: create(LocalConfigSchema, config),
    moduleConfig: create(LocalModuleConfigSchema, source.moduleConfig),
  });
  // alwaysEmitImplicit: sin esto, protobuf-JSON omite los campos que están en su valor
  // por defecto (false, 0, "") — p.ej. "usePreset": false desaparecería del todo del
  // fichero en vez de aparecer explícito, aunque el nodo sí lo tenga así.
  return JSON.stringify(toJson(DeviceProfileSchema, profile, { alwaysEmitImplicit: true }), null, 2);
}

/** Descarga `content` como fichero en el navegador (usado para guardar el JSON exportado). */
export function downloadTextFile(filename: string, content: string, mimeType = "application/json"): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

/**
 * Interpreta un fichero de perfil de dispositivo Meshtastic (el JSON que exportan la
 * app oficial, el CLI o este mismo configurador). Lanza si el texto no es JSON válido o
 * no tiene la forma de un `DeviceProfile`.
 */
export function parseDeviceProfileJson(jsonText: string): DeviceProfile {
  const parsed = JSON.parse(jsonText);
  return fromJson(DeviceProfileSchema, parsed);
}

// Nombre de cada sección para los mensajes de progreso al aplicar un perfil importado.
const CONFIG_SECTION_LABELS: Record<string, string> = {
  device: "dispositivo",
  position: "posición",
  power: "energía",
  network: "red",
  display: "pantalla",
  lora: "LoRa",
  bluetooth: "bluetooth",
  security: "seguridad",
};
const MODULE_CONFIG_SECTION_LABELS: Record<string, string> = {
  mqtt: "MQTT",
  serial: "módulo serie",
  externalNotification: "notificaciones externas",
  storeForward: "store & forward",
  rangeTest: "prueba de alcance",
  telemetry: "telemetría",
  cannedMessage: "mensajes predefinidos",
  audio: "audio",
  remoteHardware: "hardware remoto",
  neighborInfo: "info. de vecinos",
  ambientLighting: "iluminación ambiental",
  detectionSensor: "sensor de detección",
  paxcounter: "contador de personas",
  statusmessage: "mensaje de estado",
  trafficManagement: "gestión de tráfico",
  tak: "TAK",
};

function presentSections(labels: Record<string, string>, obj: Record<string, unknown> | undefined): string[] {
  if (!obj) return [];
  return Object.keys(labels).filter((key) => obj[key] !== undefined);
}

/** Resumen legible de un perfil ya interpretado, para mostrar antes de aplicarlo. */
export interface DeviceProfileSummary {
  longName: string | null;
  shortName: string | null;
  channelCount: number;
  /** Etiquetas legibles de las secciones de Config presentes en el perfil (LoRa, red, seguridad…). */
  configSections: string[];
  /** Etiquetas legibles de las secciones de ModuleConfig presentes (telemetría, MQTT…). */
  moduleConfigSections: string[];
}

export function summarizeDeviceProfile(profile: DeviceProfile): DeviceProfileSummary {
  const channelSet = profile.channelUrl ? parseChannelUrl(profile.channelUrl) : null;
  return {
    longName: profile.longName ?? null,
    shortName: profile.shortName ?? null,
    channelCount: channelSet?.settings.length ?? 0,
    configSections: presentSections(CONFIG_SECTION_LABELS, profile.config as unknown as Record<string, unknown>).map(
      (key) => CONFIG_SECTION_LABELS[key],
    ),
    moduleConfigSections: presentSections(
      MODULE_CONFIG_SECTION_LABELS,
      profile.moduleConfig as unknown as Record<string, unknown>,
    ).map((key) => MODULE_CONFIG_SECTION_LABELS[key]),
  };
}

/**
 * Aplica un `DeviceProfile` importado a un nodo ya conectado: nombre, todas las
 * secciones de Config y ModuleConfig presentes en el perfil, y canales (decodificados
 * de `channelUrl`, primero PRIMARY y el resto SECONDARY). Reinicia el nodo al terminar,
 * igual que `applyPreset`.
 */
export async function applyDeviceProfile(device: MeshDevice, profile: DeviceProfile, onProgress?: ProgressFn): Promise<void> {
  if (profile.longName || profile.shortName) {
    onProgress?.("Enviando nombre del nodo…", { percent: 5 });
    await device.setOwner(
      create(UserSchema, { longName: profile.longName ?? "", shortName: profile.shortName ?? "" }),
    );
  }

  const configSections = presentSections(CONFIG_SECTION_LABELS, profile.config as unknown as Record<string, unknown>);
  for (const [i, kind] of configSections.entries()) {
    onProgress?.(`Enviando configuración: ${CONFIG_SECTION_LABELS[kind]}…`, {
      percent: 10 + (i / configSections.length) * 25,
    });
    const value = (profile.config as unknown as Record<string, unknown>)[kind];
    await device.setConfig(
      create(ConfigSchema, { payloadVariant: { case: kind, value } as Protobuf.Config.Config["payloadVariant"] }),
    );
  }

  if (profile.channelUrl) {
    const channelSet = parseChannelUrl(profile.channelUrl);
    for (const [index, settings] of channelSet.settings.entries()) {
      onProgress?.(`Enviando canal ${index === 0 ? "primario" : "secundario"} (${settings.name || "sin nombre"})…`, {
        percent: 35 + index * 5,
      });
      await device.setChannel(
        create(ChannelSchema, {
          index,
          role: index === 0 ? Channel_Role.PRIMARY : Channel_Role.SECONDARY,
          settings,
        }),
      );
    }
  }

  const moduleConfigSections = presentSections(
    MODULE_CONFIG_SECTION_LABELS,
    profile.moduleConfig as unknown as Record<string, unknown>,
  );
  for (const [i, kind] of moduleConfigSections.entries()) {
    onProgress?.(`Enviando configuración: ${MODULE_CONFIG_SECTION_LABELS[kind]}…`, {
      percent: 60 + (i / moduleConfigSections.length) * 25,
    });
    const value = (profile.moduleConfig as unknown as Record<string, unknown>)[kind];
    await device.setModuleConfig(
      create(ModuleConfigSchema, { payloadVariant: { case: kind, value } as Protobuf.ModuleConfig.ModuleConfig["payloadVariant"] }),
    );
  }

  onProgress?.("Reiniciando el nodo para aplicar los cambios…", { percent: 90 });
  await device.reboot(2);
  onProgress?.("Configuración aplicada. El nodo se está reiniciando.", { percent: 100 });
}
