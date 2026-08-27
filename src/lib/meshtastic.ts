import { create, fromBinary, fromJson, toBinary, toJson } from "@bufbuild/protobuf";
import { MeshDevice, Protobuf, Types } from "@meshtastic/core";
import { TransportWebSerial } from "@meshtastic/transport-web-serial";
import { TransportWebBluetooth } from "@meshtastic/transport-web-bluetooth";
import { TransportHTTP } from "@meshtastic/transport-http";
import type { LoRaPresetDef } from "../presets/loraPresets";
import type { TelemetryPresetDef } from "../presets/telemetryPresets";
import type { MessageKey } from "../i18n/locales/es";
import type { TFunction } from "../i18n";

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

const YEAR_SECONDS = 3600 * 24 * 365;

/** Formatea un intervalo en segundos (tal como lo maneja el firmware) en texto legible. */
export function formatInterval(seconds: number, t: TFunction): string {
  if (seconds === 0) return t("interval.disabled");
  if (seconds >= YEAR_SECONDS) return t("interval.years", { n: (seconds / YEAR_SECONDS).toFixed(0) });
  if (seconds % 3600 === 0) return t("interval.hours", { n: seconds / 3600 });
  if (seconds % 60 === 0) return t("interval.minutes", { n: seconds / 60 });
  return t("interval.seconds", { n: seconds });
}

const KNOWN_ERROR_TRANSLATIONS: Array<[RegExp, MessageKey]> = [
  [/no port selected/i, "error.noPortSelected"],
  [/no devices found/i, "error.noDevicesFound"],
  [/user cancelled|user gesture/i, "error.cancelledByUser"],
  [/security error|permission/i, "error.permissionDenied"],
  [/network error/i, "error.networkError"],
  [/gatt operation failed/i, "error.gattFailed"],
  [/failed to open/i, "error.failedToOpen"],
  [/^CONFIG_TIMEOUT$/, "error.configTimeout"],
  [/failed to fetch/i, "error.failedToFetch"],
];

/** Traduce los mensajes de error habituales de Web Serial/Bluetooth y del SDK al idioma activo; si no reconoce el mensaje, lo deja tal cual. */
export function translateError(err: unknown, t: TFunction): string {
  const message = err instanceof Error ? err.message : String(err);
  const match = KNOWN_ERROR_TRANSLATIONS.find(([pattern]) => pattern.test(message));
  return match ? t(match[1]) : message;
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

function describeDeviceStatus(status: Types.DeviceStatusEnum, t: TFunction): { message: string; percent: number } | null {
  switch (status) {
    case Types.DeviceStatusEnum.DeviceConnecting:
      return { message: t("progress.openingConnection"), percent: CONNECT_PERCENT.connecting };
    case Types.DeviceStatusEnum.DeviceReconnecting:
      return { message: t("progress.reconnecting"), percent: CONNECT_PERCENT.connecting };
    case Types.DeviceStatusEnum.DeviceConnected:
      return { message: t("progress.connectedRequesting"), percent: CONNECT_PERCENT.connected };
    case Types.DeviceStatusEnum.DeviceConfiguring:
      return {
        message: t("progress.downloadingConfig"),
        percent: CONNECT_PERCENT.configuringStart,
      };
    case Types.DeviceStatusEnum.DeviceConfigured:
      return { message: t("progress.configReceived"), percent: CONNECT_PERCENT.configured };
    default:
      return null;
  }
}

/** Traduce los eventos internos del SDK durante el handshake de conexión a mensajes legibles y un % estimado. */
function trackConnectionProgress(device: MeshDevice, t: TFunction, onProgress?: ProgressFn): () => void {
  if (!onProgress) return () => {};

  let nodeCount = 0;
  let channelCount = 0;
  const unsubs: Array<() => void> = [
    device.events.onDeviceStatus.subscribe((status) => {
      const step = describeDeviceStatus(status, t);
      if (step) onProgress(step.message, { percent: step.percent });
    }),
    device.events.onMyNodeInfo.subscribe((info) => {
      onProgress(t("progress.nodeIdentified", { num: info.myNodeNum }), { percent: CONNECT_PERCENT.myNodeInfo });
    }),
    device.events.onNodeInfoPacket.subscribe(() => {
      nodeCount += 1;
      // Se acerca asintóticamente a configuringEnd sin tocarlo nunca del todo, ya que
      // no sabemos cuántos nodos quedan por llegar.
      const span = CONNECT_PERCENT.configuringEnd - CONNECT_PERCENT.myNodeInfo;
      const percent = CONNECT_PERCENT.myNodeInfo + span * (1 - 1 / (1 + nodeCount / 8));
      onProgress(t("progress.receivingNodes", { count: nodeCount }), {
        replace: nodeCount > 1,
        percent,
      });
    }),
    device.events.onChannelPacket.subscribe((channel) => {
      channelCount += 1;
      onProgress(
        t("progress.channelReceived", {
          name: channel.settings?.name || t("confirmApply.unnamed"),
          index: channel.index,
        }),
        {
          percent: Math.min(
            CONNECT_PERCENT.configuringEnd,
            CONNECT_PERCENT.myNodeInfo + channelCount * CONNECT_PERCENT.channelStep,
          ),
        },
      );
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

export async function connectSerial(
  t: TFunction,
  onProgress?: ProgressFn,
  onSnapshot?: (snapshot: DeviceSnapshot) => void,
  onDeviceCreated?: (device: MeshDevice) => void,
): Promise<ConnectResult> {
  const transport = await TransportWebSerial.create();
  const device = new MeshDevice(transport);
  onDeviceCreated?.(device);
  silenceDeviceLogger(device);
  // La identidad/LoRa/canales/telemetría del nodo llegan como parte del propio
  // handshake de conexión (los mismos eventos que usa trackConnectionProgress) — hay
  // que escucharlos desde YA, no después de que `configured` resuelva, porque para
  // entonces ya han pasado y no se repiten.
  const tracking = subscribeDeviceSnapshot(device, t, onSnapshot);
  const stopTracking = trackConnectionProgress(device, t, onProgress);
  try {
    requestConfigure(device);
    await waitUntilConfigured(device);
  } finally {
    stopTracking();
  }
  return { device, stopSnapshotTracking: tracking.stop, getDeviceProfileSource: tracking.getRaw };
}

export async function connectBluetooth(
  t: TFunction,
  onProgress?: ProgressFn,
  onSnapshot?: (snapshot: DeviceSnapshot) => void,
  onDeviceCreated?: (device: MeshDevice) => void,
): Promise<ConnectResult> {
  const transport = await TransportWebBluetooth.create();
  const device = new MeshDevice(transport);
  onDeviceCreated?.(device);
  silenceDeviceLogger(device);
  const tracking = subscribeDeviceSnapshot(device, t, onSnapshot);
  const stopTracking = trackConnectionProgress(device, t, onProgress);
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
  t: TFunction,
  onProgress?: ProgressFn,
  onSnapshot?: (snapshot: DeviceSnapshot) => void,
  onDeviceCreated?: (device: MeshDevice) => void,
): Promise<ConnectResult> {
  const transport = await TransportHTTP.create(address.trim(), tls);
  const device = new MeshDevice(transport);
  onDeviceCreated?.(device);
  silenceDeviceLogger(device);
  const tracking = subscribeDeviceSnapshot(device, t, onSnapshot);
  const stopTracking = trackConnectionProgress(device, t, onProgress);
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
      // Marcador estable (no localizado) para que translateError lo reconozca en
      // cualquier idioma vía KNOWN_ERROR_TRANSLATIONS.
      reject(new Error("CONFIG_TIMEOUT"));
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
  t: TFunction,
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
        name: channel.settings?.name || t("confirmApply.unnamed"),
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
export async function applyPreset(device: MeshDevice, t: TFunction, opts: ApplyPresetOptions): Promise<void> {
  const { region, onProgress } = opts;

  onProgress?.(t("progress.sendingLora"), { percent: 5 });
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

  onProgress?.(t("progress.sendingPrimaryChannel"), { percent: 30 });
  const channelSettings = create(ChannelSettingsSchema, {
    name: opts.channel.name,
    psk: opts.channel.psk,
  });
  await device.setChannel(
    create(ChannelSchema, { index: 0, role: Channel_Role.PRIMARY, settings: channelSettings }),
  );

  if (opts.secondaryChannel) {
    onProgress?.(t("progress.sendingSecondaryChannel"), { percent: 45 });
    const secondarySettings = create(ChannelSettingsSchema, {
      name: opts.secondaryChannel.name,
      psk: opts.secondaryChannel.psk,
    });
    await device.setChannel(
      create(ChannelSchema, { index: 1, role: Channel_Role.SECONDARY, settings: secondarySettings }),
    );
  }

  onProgress?.(t("progress.sendingTelemetry"), { percent: 55 });
  const telemetryConfig = create(ModuleConfig_TelemetryConfigSchema, {
    deviceUpdateInterval: opts.telemetry.values.deviceUpdateInterval,
    environmentUpdateInterval: opts.telemetry.values.environmentUpdateInterval,
    environmentMeasurementEnabled: opts.telemetry.values.environmentMeasurementEnabled,
  });
  await device.setModuleConfig(
    create(ModuleConfigSchema, { payloadVariant: { case: "telemetry", value: telemetryConfig } }),
  );

  onProgress?.(t("progress.rebooting"), { percent: 80 });
  await device.reboot(2);
  onProgress?.(t("progress.applied"), { percent: 100 });
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
const CONFIG_SECTION_LABELS: Record<string, MessageKey> = {
  device: "configSection.device",
  position: "configSection.position",
  power: "configSection.power",
  network: "configSection.network",
  display: "configSection.display",
  lora: "configSection.lora",
  bluetooth: "configSection.bluetooth",
  security: "configSection.security",
};
const MODULE_CONFIG_SECTION_LABELS: Record<string, MessageKey> = {
  mqtt: "moduleSection.mqtt",
  serial: "moduleSection.serial",
  externalNotification: "moduleSection.externalNotification",
  storeForward: "moduleSection.storeForward",
  rangeTest: "moduleSection.rangeTest",
  telemetry: "moduleSection.telemetry",
  cannedMessage: "moduleSection.cannedMessage",
  audio: "moduleSection.audio",
  remoteHardware: "moduleSection.remoteHardware",
  neighborInfo: "moduleSection.neighborInfo",
  ambientLighting: "moduleSection.ambientLighting",
  detectionSensor: "moduleSection.detectionSensor",
  paxcounter: "moduleSection.paxcounter",
  statusmessage: "moduleSection.statusmessage",
  trafficManagement: "moduleSection.trafficManagement",
  tak: "moduleSection.tak",
};

function presentSections(labels: Record<string, MessageKey>, obj: Record<string, unknown> | undefined): string[] {
  if (!obj) return [];
  return Object.keys(labels).filter((key) => obj[key] !== undefined);
}

// Traducciones para los pocos valores de enum que se muestran a un usuario final; el
// resto de valores (menos frecuentes) caen al nombre del enum tal cual, que ya es
// razonablemente legible (p.ej. "ROUTER_CLIENT").
const REGION_LABELS: Record<number, MessageKey> = {
  1: "region.us915",
  2: "region.eu433",
  3: "region.eu868",
  4: "region.cn",
  5: "region.jp",
  6: "region.anz",
  9: "region.uk",
};
const DEVICE_ROLE_LABELS: Record<number, MessageKey> = {
  0: "deviceRole.client",
  1: "deviceRole.clientMute",
  2: "deviceRole.router",
  5: "deviceRole.tracker",
  6: "deviceRole.sensor",
  7: "deviceRole.tak",
  8: "deviceRole.clientHidden",
};
const GPS_MODE_LABELS: Record<number, MessageKey> = { 0: "gpsMode.disabled", 1: "gpsMode.enabled", 2: "gpsMode.notAvailable" };
const BLUETOOTH_PAIRING_LABELS: Record<number, MessageKey> = { 0: "bluetoothPairing.randomPin", 1: "bluetoothPairing.fixedPin", 2: "bluetoothPairing.noPin" };

// Módulos que no tienen una traducción propia más abajo: se listan solo por nombre, sin
// entrar en sus campos técnicos.
const OTHER_MODULE_LABELS: Record<string, MessageKey> = {
  storeForward: "otherModule.storeForward",
  rangeTest: "otherModule.rangeTest",
  audio: "otherModule.audio",
  remoteHardware: "otherModule.remoteHardware",
  neighborInfo: "otherModule.neighborInfo",
  ambientLighting: "otherModule.ambientLighting",
  detectionSensor: "otherModule.detectionSensor",
  paxcounter: "otherModule.paxcounter",
  statusmessage: "otherModule.statusmessage",
  trafficManagement: "otherModule.trafficManagement",
  tak: "otherModule.tak",
};

export interface ProfileSummaryRow {
  label: string;
  value: string;
}

export interface ProfileSummarySection {
  title: string;
  rows: ProfileSummaryRow[];
}

/**
 * Traduce un `DeviceProfile` importado a una lista de secciones con etiquetas y valores
 * en español, listos para mostrar a un usuario final sin que tenga que interpretar
 * nombres de campos ni enums del protobuf. Solo incluye las secciones presentes en el
 * perfil; nunca muestra secretos (claves, contraseñas de WiFi/MQTT).
 */
export function describeDeviceProfile(profile: DeviceProfile, t: TFunction): ProfileSummarySection[] {
  const sections: ProfileSummarySection[] = [];
  const yesNo = (v: boolean) => (v ? t("profile.yes") : t("profile.no"));

  if (profile.longName || profile.shortName) {
    sections.push({
      title: t("profile.identity.title"),
      rows: [
        ...(profile.longName ? [{ label: t("profile.identity.name"), value: profile.longName }] : []),
        ...(profile.shortName ? [{ label: t("profile.identity.shortName"), value: profile.shortName }] : []),
      ],
    });
  }

  if (profile.channelUrl) {
    const channelSet = parseChannelUrl(profile.channelUrl);
    if (channelSet.settings.length > 0) {
      sections.push({
        title: t("profile.channels.title"),
        rows: channelSet.settings.map((s: Protobuf.Channel.ChannelSettings, i: number) => ({
          label: i === 0 ? t("profile.channels.primary") : t("profile.channels.secondary", { n: i }),
          value: `${s.name || t("confirmApply.unnamed")} · ${(s.psk?.length ?? 0) > 0 ? t("profile.channels.encrypted") : t("profile.channels.unencrypted")}`,
        })),
      });
    }
  }

  const cfg = profile.config;

  if (cfg?.lora) {
    const l = cfg.lora;
    sections.push({
      title: t("profile.lora.title"),
      rows: [
        { label: t("profile.lora.region"), value: (l.region in REGION_LABELS ? t(REGION_LABELS[l.region]) : Protobuf.Config.Config_LoRaConfig_RegionCode[l.region]) ?? String(l.region) },
        {
          label: t("profile.lora.mode"),
          value: l.usePreset
            ? Protobuf.Config.Config_LoRaConfig_ModemPreset[l.modemPreset] ?? String(l.modemPreset)
            : t("profile.lora.manual", { bw: l.bandwidth, sf: l.spreadFactor, cr: l.codingRate }),
        },
        ...(l.overrideFrequency ? [{ label: t("profile.lora.fixedFreq"), value: `${l.overrideFrequency.toFixed(3)} MHz` }] : []),
        { label: t("profile.lora.power"), value: l.txPower === 0 ? t("profile.lora.powerAuto") : `${l.txPower} dBm` },
        { label: t("profile.lora.hopLimit"), value: String(l.hopLimit) },
        { label: t("profile.lora.mqttUplink"), value: yesNo(l.configOkToMqtt) },
      ],
    });
  }

  if (cfg?.device) {
    const d = cfg.device;
    sections.push({
      title: t("profile.device.title"),
      rows: [
        { label: t("profile.device.role"), value: (d.role in DEVICE_ROLE_LABELS ? t(DEVICE_ROLE_LABELS[d.role]) : Protobuf.Config.Config_DeviceConfig_Role[d.role]) ?? String(d.role) },
        { label: t("profile.device.broadcastInterval"), value: formatInterval(d.nodeInfoBroadcastSecs, t) },
      ],
    });
  }

  if (cfg?.position) {
    const p = cfg.position;
    sections.push({
      title: t("profile.position.title"),
      rows: [
        { label: t("profile.position.gps"), value: p.gpsMode in GPS_MODE_LABELS ? t(GPS_MODE_LABELS[p.gpsMode]) : String(p.gpsMode) },
        { label: t("profile.position.broadcastInterval"), value: formatInterval(p.positionBroadcastSecs, t) },
        ...(p.fixedPosition ? [{ label: t("profile.position.fixed"), value: t("profile.position.fixedValue") }] : []),
      ],
    });
  }

  if (cfg?.power) {
    const pw = cfg.power;
    sections.push({
      title: t("profile.power.title"),
      rows: [
        { label: t("profile.power.saving"), value: pw.isPowerSaving ? t("profile.activated") : t("profile.deactivated") },
        ...(pw.onBatteryShutdownAfterSecs > 0
          ? [{ label: t("profile.power.shutdownAfter"), value: formatInterval(pw.onBatteryShutdownAfterSecs, t) }]
          : []),
      ],
    });
  }

  if (cfg?.display) {
    const disp = cfg.display;
    sections.push({
      title: t("profile.display.title"),
      rows: [
        { label: t("profile.display.offAfter"), value: disp.screenOnSecs === 0 ? t("profile.display.alwaysOn") : formatInterval(disp.screenOnSecs, t) },
        { label: t("profile.display.units"), value: disp.units === Protobuf.Config.Config_DisplayConfig_DisplayUnits.IMPERIAL ? t("profile.display.imperial") : t("profile.display.metric") },
        { label: t("profile.display.clockFormat"), value: disp.use12hClock ? t("profile.display.clock12") : t("profile.display.clock24") },
      ],
    });
  }

  if (cfg?.bluetooth) {
    const bt = cfg.bluetooth;
    sections.push({
      title: t("profile.bluetooth.title"),
      rows: [
        { label: t("profile.bluetooth.enabled"), value: yesNo(bt.enabled) },
        ...(bt.enabled ? [{ label: t("profile.bluetooth.pairing"), value: bt.mode in BLUETOOTH_PAIRING_LABELS ? t(BLUETOOTH_PAIRING_LABELS[bt.mode]) : String(bt.mode) }] : []),
      ],
    });
  }

  if (cfg?.network) {
    const net = cfg.network;
    const rows: ProfileSummaryRow[] = [];
    if (net.wifiEnabled) rows.push({ label: t("profile.network.wifi"), value: net.wifiSsid ? t("profile.network.wifiOnNamed", { ssid: net.wifiSsid }) : t("profile.network.wifiOn") });
    if (net.ethEnabled) rows.push({ label: t("profile.network.ethernet"), value: t("profile.network.ethernetOn") });
    if (!net.wifiEnabled && !net.ethEnabled) rows.push({ label: t("profile.network.title"), value: t("profile.network.disabled") });
    sections.push({ title: t("profile.network.title"), rows });
  }

  if (cfg?.security) {
    const sec = cfg.security;
    sections.push({
      title: t("profile.security.title"),
      rows: [
        { label: t("profile.security.serialConsole"), value: sec.serialEnabled ? t("profile.activated") : t("profile.deactivated") },
        { label: t("profile.security.managed"), value: yesNo(sec.isManaged) },
      ],
    });
  }

  const mod = profile.moduleConfig;

  if (mod?.telemetry) {
    const tel = mod.telemetry;
    sections.push({
      title: t("profile.telemetry.title"),
      rows: [
        { label: t("profile.telemetry.device"), value: tel.deviceUpdateInterval === 0 ? t("profile.telemetry.deviceDefault") : formatInterval(tel.deviceUpdateInterval, t) },
        { label: t("profile.telemetry.environment"), value: tel.environmentMeasurementEnabled ? formatInterval(tel.environmentUpdateInterval, t) : t("profile.deactivated") },
        ...(tel.powerMeasurementEnabled ? [{ label: t("profile.telemetry.power"), value: formatInterval(tel.powerUpdateInterval, t) }] : []),
      ],
    });
  }

  if (mod?.mqtt) {
    const m = mod.mqtt;
    sections.push({
      title: t("profile.mqtt.title"),
      rows: [
        { label: t("profile.mqtt.enabled"), value: yesNo(m.enabled) },
        ...(m.enabled && m.address ? [{ label: t("profile.mqtt.server"), value: m.address }] : []),
        ...(m.enabled ? [{ label: t("profile.mqtt.encryption"), value: yesNo(m.encryptionEnabled) }] : []),
      ],
    });
  }

  if (mod?.externalNotification) {
    sections.push({
      title: t("profile.externalNotification.title"),
      rows: [{ label: t("profile.externalNotification.enabled"), value: yesNo(mod.externalNotification.enabled) }],
    });
  }

  if (mod?.cannedMessage) {
    sections.push({
      title: t("profile.cannedMessage.title"),
      rows: [{ label: t("profile.cannedMessage.enabled"), value: yesNo(mod.cannedMessage.enabled) }],
    });
  }

  const otherModules = Object.entries(OTHER_MODULE_LABELS).filter(
    ([key]) => (mod as unknown as Record<string, unknown> | undefined)?.[key] !== undefined,
  );
  if (otherModules.length > 0) {
    sections.push({
      title: t("profile.otherModules.title"),
      rows: otherModules.map(([, key]) => ({ label: t(key), value: t("otherModule.included") })),
    });
  }

  return sections;
}

/**
 * Aplica un `DeviceProfile` importado a un nodo ya conectado: nombre, todas las
 * secciones de Config y ModuleConfig presentes en el perfil, y canales (decodificados
 * de `channelUrl`, primero PRIMARY y el resto SECONDARY). Reinicia el nodo al terminar,
 * igual que `applyPreset`.
 */
export async function applyDeviceProfile(device: MeshDevice, profile: DeviceProfile, t: TFunction, onProgress?: ProgressFn): Promise<void> {
  if (profile.longName || profile.shortName) {
    onProgress?.(t("progress.sendingNodeName"), { percent: 5 });
    await device.setOwner(
      create(UserSchema, { longName: profile.longName ?? "", shortName: profile.shortName ?? "" }),
    );
  }

  const configSections = presentSections(CONFIG_SECTION_LABELS, profile.config as unknown as Record<string, unknown>);
  for (const [i, kind] of configSections.entries()) {
    onProgress?.(t("progress.sendingConfigSection", { section: t(CONFIG_SECTION_LABELS[kind]) }), {
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
      onProgress?.(
        t("progress.sendingChannel", {
          which: index === 0 ? t("progress.channelPrimary") : t("progress.channelSecondary"),
          name: settings.name || t("progress.unnamed"),
        }),
        { percent: 35 + index * 5 },
      );
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
    onProgress?.(t("progress.sendingModuleConfigSection", { section: t(MODULE_CONFIG_SECTION_LABELS[kind]) }), {
      percent: 60 + (i / moduleConfigSections.length) * 25,
    });
    const value = (profile.moduleConfig as unknown as Record<string, unknown>)[kind];
    await device.setModuleConfig(
      create(ModuleConfigSchema, { payloadVariant: { case: kind, value } as Protobuf.ModuleConfig.ModuleConfig["payloadVariant"] }),
    );
  }

  onProgress?.(t("progress.rebooting"), { percent: 90 });
  await device.reboot(2);
  onProgress?.(t("progress.applied"), { percent: 100 });
}
