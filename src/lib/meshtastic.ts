import { create, fromBinary, fromJson, toBinary, toJson } from "@bufbuild/protobuf";
import { MeshDevice, Protobuf, Types } from "@meshtastic/core";
import { TransportWebSerial } from "@meshtastic/transport-web-serial";
import { TransportWebBluetooth } from "@meshtastic/transport-web-bluetooth";
import { TransportHTTP } from "@meshtastic/transport-http";
import { ES_CUSTOM_PRESETS, type LoRaPresetDef } from "../presets/loraPresets";
import type { TelemetryPresetDef } from "../presets/telemetryPresets";
import type { MessageKey } from "../i18n/locales/es";
import type { TFunction } from "../i18n";

const {
  ConfigSchema,
  Config_LoRaConfigSchema,
  Config_DeviceConfigSchema,
  Config_DeviceConfig_Role,
  Config_DeviceConfig_BuzzerMode,
  Config_PositionConfigSchema,
  Config_PositionConfig_GpsMode,
  Config_DisplayConfigSchema,
  Config_DisplayConfig_DisplayUnits,
  Config_BluetoothConfigSchema,
  Config_BluetoothConfig_PairingMode,
  Config_PowerConfigSchema,
  Config_NetworkConfigSchema,
} = Protobuf.Config;
const {
  ModuleConfigSchema,
  ModuleConfig_TelemetryConfigSchema,
  ModuleConfig_MQTTConfigSchema,
  ModuleConfig_SerialConfigSchema,
} = Protobuf.ModuleConfig;
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
  [/^BLUETOOTH_GATT_TIMEOUT$/, "error.bluetoothGattTimeout"],
  [/failed to fetch/i, "error.failedToFetch"],
  [/^APPLY_TIMEOUT$/, "error.applyTimeout"],
  [/^DEVICE_DISCONNECTED$/, "error.applyTimeout"],
  [/packet does not exist/i, "error.gattFailed"],
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
 * En Android, si la pantalla del móvil se bloquea por inactividad mientras se conecta o se
 * aplican cambios por Bluetooth (típico: el usuario pulsa "Aplicar" y no vuelve a tocar la
 * pantalla durante los siguientes segundos), Chrome pasa la pestaña a segundo plano y
 * suspende/ralentiza sus temporizadores — la operación GATT en curso se queda "congelada"
 * sin ningún evento ni error hasta que se desbloquea el teléfono, dando la sensación de que
 * la app se ha quedado colgada. Un Wake Lock de pantalla evita que se bloquee mientras dura
 * la operación. Si la API no existe (navegador de escritorio, Safari/iOS) o el permiso se
 * deniega, seguimos igual sin bloquear nada.
 */
async function withScreenAwake<T>(run: () => Promise<T>): Promise<T> {
  const wakeLock = await navigator.wakeLock?.request("screen").catch(() => null);
  try {
    return await run();
  } finally {
    wakeLock?.release().catch(() => {});
  }
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
 * desconectar), y cómo leer lo que se ha ido recogiendo de ella para exportarla.
 * `reconnect`, solo presente para Bluetooth, reconecta al mismo `BluetoothDevice` ya
 * emparejado (sin volver a mostrar el selector) — lo usa la UI para reintentar `applyPreset`
 * automáticamente si la conexión GATT se cae a mitad de aplicar cambios, algo frecuente en
 * Android. */
export interface ConnectResult {
  device: MeshDevice;
  stopSnapshotTracking: () => void;
  getDeviceProfileSource: () => DeviceProfileSource;
  reconnect?: () => Promise<ConnectResult>;
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

/**
 * En Android, `BluetoothRemoteGATTServer.connect()` se queda colgado indefinidamente
 * con cierta frecuencia (el nodo ya está conectado a la app oficial u otra pestaña, el
 * dispositivo salió de rango justo tras el emparejamiento, etc.), sin lanzar ningún
 * error ni disparar ningún evento — a diferencia de `waitUntilConfigured`, esta promesa
 * no tiene timeout propio. Como esto ocurre antes de que exista un `MeshDevice`
 * (`onDeviceCreated` aún no se ha llamado), el botón "Desconectar" tampoco puede
 * cancelarlo, así que sin este límite de tiempo la conexión se queda parada al
 * principio sin ningún mensaje ni forma de salir salvo recargar la página.
 */
async function connectBluetoothDevice(device: BluetoothDevice, timeoutMs = 15000): Promise<TransportWebBluetooth> {
  return Promise.race([
    TransportWebBluetooth.createFromDevice(device),
    new Promise<TransportWebBluetooth>((_, reject) =>
      setTimeout(() => reject(new Error("BLUETOOTH_GATT_TIMEOUT")), timeoutMs),
    ),
  ]);
}

/**
 * En Android, el primer intento de conexión GATT justo después de emparejar (elegir el
 * dispositivo por primera vez en el selector del navegador) falla con frecuencia mientras
 * el sistema todavía está terminando de negociar el vínculo Bluetooth a nivel de SO; un
 * segundo intento inmediato contra el mismo `BluetoothDevice` normalmente ya funciona. Sin
 * este reintento automático, el usuario tenía que cancelar y pulsar "Conectar" otra vez
 * desde cero (reabriendo el selector) para que la segunda vez sí cargara.
 */
async function connectBluetoothDeviceWithRetry(
  device: BluetoothDevice,
  t: TFunction,
  onProgress?: ProgressFn,
): Promise<TransportWebBluetooth> {
  try {
    return await connectBluetoothDevice(device);
  } catch {
    onProgress?.(t("progress.bluetoothRetryingConnect"), { percent: 0 });
    return await connectBluetoothDevice(device);
  }
}

async function connectToBleDevice(
  bleDevice: BluetoothDevice,
  t: TFunction,
  onProgress?: ProgressFn,
  onSnapshot?: (snapshot: DeviceSnapshot) => void,
  onDeviceCreated?: (device: MeshDevice) => void,
): Promise<ConnectResult> {
  return withScreenAwake(async () => {
    const transport = await connectBluetoothDeviceWithRetry(bleDevice, t, onProgress);
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
    return {
      device,
      stopSnapshotTracking: tracking.stop,
      getDeviceProfileSource: tracking.getRaw,
      reconnect: () => connectToBleDevice(bleDevice, t, onProgress, onSnapshot, onDeviceCreated),
    };
  });
}

export async function connectBluetooth(
  t: TFunction,
  onProgress?: ProgressFn,
  onSnapshot?: (snapshot: DeviceSnapshot) => void,
  onDeviceCreated?: (device: MeshDevice) => void,
): Promise<ConnectResult> {
  const bleDevice = await navigator.bluetooth.requestDevice({
    filters: [{ services: [TransportWebBluetooth.ServiceUuid] }],
  });
  return connectToBleDevice(bleDevice, t, onProgress, onSnapshot, onDeviceCreated);
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

/**
 * Desconecta el dispositivo con un límite de tiempo: `device.disconnect()` cierra los
 * streams del transporte (serial/BLE/red) y en la práctica a veces se queda colgado
 * (p.ej. un `close()` de un WritableStream que no resuelve), dejando el botón
 * "Desconectar" sin efecto visible. Pasado el timeout se asume desconectado igualmente,
 * ya que a la UI solo le importa volver a "disconnected" cuanto antes.
 */
export async function disconnectDevice(device: MeshDevice, timeoutMs = 3000): Promise<void> {
  await Promise.race([
    device.disconnect().catch(() => {}),
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}

/**
 * Confirma (persiste) los `setConfig`/`setModuleConfig` enviados desde el último
 * `beginEditSettings`. La promesa de `commitEditSettings()` espera un ack real del nodo
 * igual que cualquier paquete de la cola interna del SDK (hasta 60s de timeout) — por
 * Bluetooth ese ack se pierde a menudo aunque el nodo ya haya aplicado el cambio, dejando
 * la UI de progreso clavada en el último paso sin motivo. Igual que con
 * `disconnectDevice`, se le da un margen corto y se continúa aunque no llegue confirmación.
 */
async function commitEditSettings(device: MeshDevice, timeoutMs = 5000): Promise<void> {
  await Promise.race([
    device.commitEditSettings().catch(() => {}),
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}

/**
 * Igual que `commitEditSettings`: `device.reboot()` también espera un ack real del nodo,
 * pero aquí ese ack no puede llegar nunca — el nodo se desconecta en cuanto reinicia, así
 * que esperar su promesa deja la UI clavada en "Reiniciando…" para siempre. Se le da un
 * margen corto (tiempo de sobra para que el paquete salga por el transporte) y se sigue.
 */
async function rebootDevice(device: MeshDevice, delaySeconds = 2, timeoutMs = 5000): Promise<void> {
  await Promise.race([
    device.reboot(delaySeconds).catch(() => {}),
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}

/**
 * A diferencia de `commitEditSettings`/`rebootDevice` (best-effort, siguen adelante si no
 * hay ack), aquí SÍ nos interesa que falle rápido: si el transporte se cae a mitad de
 * aplicar varios `setConfig`/`setModuleConfig` seguidos (típico al perderse la conexión GATT
 * por Bluetooth), la promesa del SDK se queda colgada para siempre en vez de rechazar,
 * dejando la barra de progreso clavada sin ningún error visible.
 *
 * Dos salvavidas en paralelo con `run()`:
 * - Un límite de tiempo total (`APPLY_TIMEOUT`) por si el paso colgado nunca llega a
 *   rechazar ni el transporte a notificar la desconexión.
 * - Una escucha de `device.events.onDeviceStatus`: en cuanto el transporte marca
 *   `DeviceDisconnected` (p.ej. `gattserverdisconnected` de Web Bluetooth), abortamos con
 *   "DEVICE_DISCONNECTED" al momento — normalmente segundos antes de que el timeout fijo
 *   salte — en vez de esperar a que expire el margen completo. El único `DeviceDisconnected`
 *   que NO es un fallo es el que provoca nuestro propio `reboot()` al final de un apply
 *   satisfactorio: `run()` avisa de que ha llegado a ese punto llamando a `markRebooting()`,
 *   y a partir de ahí se ignoran los cambios de estado.
 */
async function withApplyTimeout<T>(
  device: MeshDevice,
  run: (markRebooting: () => void) => Promise<T>,
  timeoutMs = 45000,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  let rebooting = false;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("APPLY_TIMEOUT")), timeoutMs);
  });
  let disconnectReject!: (err: Error) => void;
  const disconnected = new Promise<never>((_, reject) => {
    disconnectReject = reject;
  });
  const unsubscribe = device.events.onDeviceStatus.subscribe((status) => {
    if (rebooting) return;
    if (status === Types.DeviceStatusEnum.DeviceDisconnected) {
      disconnectReject(new Error("DEVICE_DISCONNECTED"));
    }
  });
  try {
    return await Promise.race([run(() => (rebooting = true)), timeout, disconnected]);
  } finally {
    clearTimeout(timer!);
    unsubscribe();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Pausa entre pasos consecutivos de `setConfig`/`setModuleConfig` al aplicar varios seguidos
 * (presets, "Más configuración", perfiles importados). Sin esta pausa, "Más configuración"
 * llega a mandar hasta 9-10 escrituras GATT por Bluetooth una detrás de otra sin ningún
 * margen; eso es justo el patrón que más desestabiliza CoreBluetooth (macOS) y hace que la
 * conexión se caiga a mitad de aplicar aunque el nodo esté a un metro — no es un problema de
 * alcance, es de ráfaga. 600ms le da al radio/pila Bluetooth un margen bastante más holgado
 * para respirar entre paquetes; sigue sin notarse en la duración total salvo cuando de verdad
 * hay muchos pasos que enviar.
 */
const APPLY_STEP_DELAY_MS = 600;

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
  powerMeasurementEnabled: boolean;
  powerUpdateInterval: number;
  airQualityEnabled: boolean;
  airQualityInterval: number;
  healthMeasurementEnabled: boolean;
  healthUpdateInterval: number;
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
  /**
   * Posición fija que ya tenga el propio nodo (en grados, no en el entero *1e7 del
   * protobuf), si en algún momento del handshake ha llegado un paquete Position suyo con
   * coordenadas. `null` si el nodo no tiene posición fija o si su paquete Position (que solo
   * se manda si el firmware ya la tiene guardada) no ha llegado a tiempo.
   */
  fixedLat: number | null;
  fixedLon: number | null;
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
  let fixedLat: number | null = null;
  let fixedLon: number | null = null;

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
            powerMeasurementEnabled: t.powerMeasurementEnabled,
            powerUpdateInterval: t.powerUpdateInterval,
            airQualityEnabled: t.airQualityEnabled,
            airQualityInterval: t.airQualityInterval,
            healthMeasurementEnabled: t.healthMeasurementEnabled,
            healthUpdateInterval: t.healthUpdateInterval,
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
    // Solo llega si el nodo ya tiene una posición fija guardada en firmware; no forma parte
    // de ninguna sección de Config, así que sin esto "Más configuración" siempre mostraba
    // las coordenadas vacías aunque el nodo ya tuviera una fijada.
    device.events.onPositionPacket.subscribe((packet) => {
      if (myNodeNum === null || packet.from !== myNodeNum) return;
      const { latitudeI, longitudeI } = packet.data;
      if (!latitudeI || !longitudeI) return;
      fixedLat = latitudeI * 1e-7;
      fixedLon = longitudeI * 1e-7;
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
      fixedLat,
      fixedLon,
    }),
  };
}

/** Rol/GPS/posición recomendados para un tipo de nodo (ver presets/nodeTypePresets.ts); se fusionan en `MoreConfigValues` al elegir el tipo de nodo. */
export interface NodeTypeMoreConfig {
  role: Protobuf.Config.Config_DeviceConfig_Role;
  gpsMode: Protobuf.Config.Config_PositionConfig_GpsMode;
  positionBroadcastSecs: number;
  fixedPosition: boolean;
}

export interface ApplyPresetOptions {
  lora: LoRaPresetDef;
  channel: ChannelPreset;
  /** Canales adicionales (índices 1, 2, 3…), p.ej. el canal provincial de la comunidad. Cualquier canal que el nodo ya tuviera en un índice > 0 que no aparezca aquí se borra (se manda como DISABLED). */
  additionalChannels?: ChannelPreset[];
  telemetry: TelemetryPresetDef;
  region: Protobuf.Config.Config_LoRaConfig_RegionCode;
  /**
   * Perfil crudo actual del nodo. Se usa para preservar el hop limit LoRa (que si no se
   * reenvía se resetearía a 0) y, si hay `moreConfig`, el resto de secciones ("Más
   * configuración"/pestaña Avanzado).
   */
  source?: DeviceProfileSource;
  /**
   * Valores actuales (editados) de "Más configuración" — rol, GPS/posición, pantalla, MQTT,
   * Bluetooth, red, telemetría detallada... El botón grande de aplicar es el único punto de
   * entrada para todos los cambios del nodo, así que siempre que hay conexión se envían junto
   * con LoRa/canal/telemetría en la misma tanda y con un único reinicio.
   */
  moreConfig?: MoreConfigValues;
  /** Valores de `moreConfig` tal como estaban en el nodo al conectar, para saber qué ha editado el usuario (p.ej. si ha tocado la potencia LoRa a mano). */
  moreConfigBaseline?: MoreConfigValues;
  onProgress?: ProgressFn;
}

/**
 * Aplica LoRa + canal primario/secundario + intervalos de telemetría, y si se pasa
 * `moreConfig`, también el resto de secciones ("Más configuración"/pestaña Avanzado) que
 * el usuario haya editado. Es el único punto de entrada de "Aplicar" de la app: todo se
 * envía en una sola tanda con un único reinicio al final.
 */
export async function applyPreset(device: MeshDevice, t: TFunction, opts: ApplyPresetOptions): Promise<void> {
  await withScreenAwake(() =>
    withApplyTimeout(device, (markRebooting) => applyPresetInner(device, t, opts, markRebooting)),
  );
}

async function applyPresetInner(
  device: MeshDevice,
  t: TFunction,
  opts: ApplyPresetOptions,
  markRebooting: () => void,
): Promise<void> {
  const { region, onProgress } = opts;

  onProgress?.(t("progress.sendingLora"), { percent: 5 });
  // Potencia de transmisión: 0 = automático (el firmware calcula el máximo permitido por
  // región). En 868 MHz predeterminamos a 23 dBm (máximo habitual permitido en la banda
  // ISM europea); en 2.4 GHz dejamos el automático del firmware (10 dBm), que ya es el
  // límite recomendado para esa banda y no debe subirse. Si el usuario ha tocado a mano la
  // potencia en "Más configuración" (pestaña Avanzado), esa edición manda sobre el valor por
  // región.
  const computedTxPower = region === Protobuf.Config.Config_LoRaConfig_RegionCode.EU_868 ? 23 : 0;
  const txPowerEdited =
    opts.moreConfig !== undefined && opts.moreConfigBaseline !== undefined && opts.moreConfig.txPower !== opts.moreConfigBaseline.txPower;
  const txPower = txPowerEdited ? opts.moreConfig!.txPower : computedTxPower;
  // setConfig reemplaza toda la sección LoRa: partimos del resto de campos que ya tenía el
  // nodo (ignoreMqtt/configOkToMqtt, femLnaMode...) para no resetearlos a su valor por
  // defecto, y solo sobrescribimos los que controla el preset. El hop limit se toma de "Más
  // configuración" si está disponible (se inicializa con el valor real del nodo, así que
  // reenviarlo sin más no lo resetea) y si no, se preserva vía el spread de arriba.
  const loraConfig = create(Config_LoRaConfigSchema, {
    ...opts.source?.config.lora,
    usePreset: opts.lora.values.usePreset,
    modemPreset: opts.lora.values.modemPreset,
    bandwidth: opts.lora.values.bandwidth ?? 0,
    spreadFactor: opts.lora.values.spreadFactor ?? 0,
    codingRate: opts.lora.values.codingRate ?? 0,
    channelNum: opts.lora.channelNum ?? 0,
    overrideFrequency: opts.lora.values.overrideFrequency ?? 0,
    region,
    txPower,
    ...(opts.moreConfig ? { hopLimit: opts.moreConfig.hopLimit } : {}),
    txEnabled: true,
  });
  await device.setConfig(
    create(ConfigSchema, { payloadVariant: { case: "lora", value: loraConfig } }),
  );

  // setChannel reemplaza toda la sección de canal: partimos de la que ya tenía el nodo en ese
  // índice para no resetear moduleSettings (precisión de posición, silenciado) a sus valores
  // por defecto. El canal primario siempre lleva uplink/downlink MQTT activados.
  const existingPrimary = opts.source?.channels.find((c) => c.index === 0)?.settings;
  await sleep(APPLY_STEP_DELAY_MS);
  onProgress?.(t("progress.sendingPrimaryChannel"), { percent: 30 });
  const channelSettings = create(ChannelSettingsSchema, {
    ...existingPrimary,
    name: opts.channel.name,
    psk: opts.channel.psk,
    uplinkEnabled: true,
    downlinkEnabled: true,
  });
  await device.setChannel(
    create(ChannelSchema, { index: 0, role: Channel_Role.PRIMARY, settings: channelSettings }),
  );

  const additionalChannels = opts.additionalChannels ?? [];
  for (const [i, additional] of additionalChannels.entries()) {
    const index = i + 1;
    const existingChannel = opts.source?.channels.find((c) => c.index === index)?.settings;
    await sleep(APPLY_STEP_DELAY_MS);
    onProgress?.(t("progress.sendingSecondaryChannel"), { percent: 45 + i * 3 });
    const additionalSettings = create(ChannelSettingsSchema, {
      ...existingChannel,
      name: additional.name,
      psk: additional.psk,
    });
    await device.setChannel(
      create(ChannelSchema, { index, role: Channel_Role.SECONDARY, settings: additionalSettings }),
    );
  }
  // Cualquier canal (índice > 0) que el nodo ya tuviera y ya no esté en additionalChannels
  // lo ha borrado el usuario: hay que mandarlo como DISABLED explícitamente, si no
  // setChannel de los demás índices no lo tocaría y seguiría activo en el nodo.
  const keptIndices = new Set(additionalChannels.map((_, i) => i + 1));
  const removedChannels = (opts.source?.channels ?? []).filter((c) => c.index > 0 && !keptIndices.has(c.index));
  for (const removed of removedChannels) {
    await sleep(APPLY_STEP_DELAY_MS);
    await device.setChannel(
      create(ChannelSchema, { index: removed.index, role: Channel_Role.DISABLED, settings: create(ChannelSettingsSchema, {}) }),
    );
  }

  await sleep(APPLY_STEP_DELAY_MS);
  onProgress?.(t("progress.sendingTelemetry"), { percent: 55 });
  // setModuleConfig reemplaza toda la sección de telemetría: sin este spread, campos que no
  // gestiona el preset (sobre todo `deviceTelemetryEnabled`, que controla si se envía
  // telemetría de dispositivo a la malla) se reseteaban a `false` en cada aplicación.
  const telemetryConfig = create(ModuleConfig_TelemetryConfigSchema, {
    ...opts.source?.moduleConfig.telemetry,
    deviceUpdateInterval: opts.telemetry.values.deviceUpdateInterval,
    environmentUpdateInterval: opts.telemetry.values.environmentUpdateInterval,
    environmentMeasurementEnabled: opts.telemetry.values.environmentMeasurementEnabled,
    powerUpdateInterval: opts.telemetry.values.powerUpdateInterval,
    powerMeasurementEnabled: opts.telemetry.values.powerMeasurementEnabled,
    airQualityInterval: opts.telemetry.values.airQualityInterval,
    airQualityEnabled: opts.telemetry.values.airQualityEnabled,
    healthUpdateInterval: opts.telemetry.values.healthUpdateInterval,
    healthMeasurementEnabled: opts.telemetry.values.healthMeasurementEnabled,
  });
  await device.setModuleConfig(
    create(ModuleConfigSchema, { payloadVariant: { case: "telemetry", value: telemetryConfig } }),
  );

  if (opts.moreConfig && opts.source) {
    await sendMoreConfigExtraSections(
      device,
      t,
      opts.source,
      opts.moreConfig,
      opts.moreConfigBaseline ?? readMoreConfigValues(opts.source),
      onProgress,
    );
  }

  await sleep(APPLY_STEP_DELAY_MS);
  markRebooting();
  await commitEditSettings(device);
  onProgress?.(t("progress.rebooting"), { percent: 96 });
  await rebootDevice(device);
  onProgress?.(t("progress.applied"), { percent: 100 });
}

export type DeviceRole = Protobuf.Config.Config_DeviceConfig_Role;
export type GpsMode = Protobuf.Config.Config_PositionConfig_GpsMode;
export type DisplayUnits = Protobuf.Config.Config_DisplayConfig_DisplayUnits;
export type BluetoothPairingMode = Protobuf.Config.Config_BluetoothConfig_PairingMode;

// Reexportados (en vez de los enums del protobuf directamente) para que otros módulos
// (p.ej. presets/nodeTypePresets.ts) puedan construir valores de MoreConfigValues sin
// importar @meshtastic/core.
export const DeviceRoleValue = Config_DeviceConfig_Role;
export const GpsModeValue = Config_PositionConfig_GpsMode;
export const BluetoothPairingModeValue = Config_BluetoothConfig_PairingMode;

// Roles no obsoletos del firmware; se omiten ROUTER_CLIENT y REPEATER (deprecated).
// CLIENT_BASE (rol 12 en firmware reciente) no existe todavía en el enum que trae
// empaquetado @meshtastic/core 2.6.7 (se queda en 0-11) aunque sus tipos lo declaren:
// usarlo aquí produciría un valor `undefined` en tiempo de ejecución.
export const DEVICE_ROLE_OPTIONS: { value: DeviceRole; labelKey: MessageKey }[] = [
  { value: Config_DeviceConfig_Role.CLIENT, labelKey: "moreConfig.role.client" },
  { value: Config_DeviceConfig_Role.CLIENT_MUTE, labelKey: "moreConfig.role.clientMute" },
  { value: Config_DeviceConfig_Role.CLIENT_HIDDEN, labelKey: "moreConfig.role.clientHidden" },
  { value: Config_DeviceConfig_Role.ROUTER, labelKey: "moreConfig.role.router" },
  { value: Config_DeviceConfig_Role.ROUTER_LATE, labelKey: "moreConfig.role.routerLate" },
  { value: Config_DeviceConfig_Role.TRACKER, labelKey: "moreConfig.role.tracker" },
  { value: Config_DeviceConfig_Role.SENSOR, labelKey: "moreConfig.role.sensor" },
  { value: Config_DeviceConfig_Role.LOST_AND_FOUND, labelKey: "moreConfig.role.lostAndFound" },
  { value: Config_DeviceConfig_Role.TAK, labelKey: "moreConfig.role.tak" },
  { value: Config_DeviceConfig_Role.TAK_TRACKER, labelKey: "moreConfig.role.takTracker" },
];

export const GPS_MODE_OPTIONS: { value: GpsMode; labelKey: MessageKey }[] = [
  { value: Config_PositionConfig_GpsMode.ENABLED, labelKey: "moreConfig.gpsMode.enabled" },
  { value: Config_PositionConfig_GpsMode.DISABLED, labelKey: "moreConfig.gpsMode.disabled" },
  { value: Config_PositionConfig_GpsMode.NOT_PRESENT, labelKey: "moreConfig.gpsMode.notPresent" },
];

export const DISPLAY_UNITS_OPTIONS: { value: DisplayUnits; labelKey: MessageKey }[] = [
  { value: Config_DisplayConfig_DisplayUnits.METRIC, labelKey: "moreConfig.displayUnits.metric" },
  { value: Config_DisplayConfig_DisplayUnits.IMPERIAL, labelKey: "moreConfig.displayUnits.imperial" },
];

export const BLUETOOTH_PAIRING_MODE_OPTIONS: { value: BluetoothPairingMode; labelKey: MessageKey }[] = [
  { value: Config_BluetoothConfig_PairingMode.RANDOM_PIN, labelKey: "moreConfig.bluetoothMode.randomPin" },
  { value: Config_BluetoothConfig_PairingMode.FIXED_PIN, labelKey: "moreConfig.bluetoothMode.fixedPin" },
  { value: Config_BluetoothConfig_PairingMode.NO_PIN, labelKey: "moreConfig.bluetoothMode.noPin" },
];

export type BuzzerMode = Protobuf.Config.Config_DeviceConfig_BuzzerMode;
export const BuzzerModeValue = Config_DeviceConfig_BuzzerMode;

export const BUZZER_MODE_OPTIONS: { value: BuzzerMode; labelKey: MessageKey }[] = [
  { value: Config_DeviceConfig_BuzzerMode.ALL_ENABLED, labelKey: "moreConfig.buzzerMode.allEnabled" },
  { value: Config_DeviceConfig_BuzzerMode.NOTIFICATIONS_ONLY, labelKey: "moreConfig.buzzerMode.notificationsOnly" },
  { value: Config_DeviceConfig_BuzzerMode.SYSTEM_ONLY, labelKey: "moreConfig.buzzerMode.systemOnly" },
  { value: Config_DeviceConfig_BuzzerMode.DISABLED, labelKey: "moreConfig.buzzerMode.disabled" },
];

export interface MoreConfigValues {
  role: DeviceRole;
  txPower: number;
  hopLimit: number;
  gpsMode: GpsMode;
  positionBroadcastSecs: number;
  fixedPosition: boolean;
  /** Coordenadas a fijar cuando `fixedPosition` está activo (elegidas a mano o en el mapa); `null` si aún no se han fijado desde el configurador. */
  fixedLat: number | null;
  fixedLon: number | null;
  displayUnits: DisplayUnits;
  screenOnSecs: number;
  flipScreen: boolean;
  mqttEnabled: boolean;
  mqttAddress: string;
  mqttUsername: string;
  mqttPassword: string;
  mqttEncryptionEnabled: boolean;
  mqttTlsEnabled: boolean;
  mqttRoot: string;
  bluetoothEnabled: boolean;
  bluetoothMode: BluetoothPairingMode;
  bluetoothFixedPin: number;
  powerSavingEnabled: boolean;
  onBatteryShutdownAfterSecs: number;
  tzdef: string;
  buzzerMode: BuzzerMode;
  ledHeartbeatDisabled: boolean;
  networkWifiEnabled: boolean;
  networkWifiSsid: string;
  networkWifiPsk: string;
  networkEthEnabled: boolean;
  serialEnabled: boolean;
  telemetryDeviceUpdateInterval: number;
  telemetryEnvironmentMeasurementEnabled: boolean;
  telemetryEnvironmentUpdateInterval: number;
  telemetryEnvironmentScreenEnabled: boolean;
  telemetryEnvironmentDisplayFahrenheit: boolean;
  telemetryAirQualityEnabled: boolean;
  telemetryAirQualityInterval: number;
  telemetryPowerMeasurementEnabled: boolean;
  telemetryPowerUpdateInterval: number;
  telemetryPowerScreenEnabled: boolean;
  telemetryHealthMeasurementEnabled: boolean;
  telemetryHealthUpdateInterval: number;
  telemetryHealthScreenEnabled: boolean;
}

/** Lee los valores actuales de las secciones cubiertas por "Más configuración" desde el perfil crudo del nodo. */
export function readMoreConfigValues(source: DeviceProfileSource): MoreConfigValues {
  const { device, position, display, lora, bluetooth, power, network } = source.config;
  const { mqtt, serial, telemetry } = source.moduleConfig;
  return {
    role: device?.role ?? Config_DeviceConfig_Role.CLIENT,
    txPower: lora?.txPower ?? 0,
    hopLimit: lora?.hopLimit ?? 3,
    gpsMode: position?.gpsMode ?? Config_PositionConfig_GpsMode.NOT_PRESENT,
    positionBroadcastSecs: position?.positionBroadcastSecs ?? 900,
    fixedPosition: position?.fixedPosition ?? false,
    // Config_PositionConfig no trae latitud/longitud (viven en el mensaje Position, que solo
    // llega si el nodo ya tiene una posición fija guardada — ver el onPositionPacket de
    // subscribeDeviceSnapshot). Si no ha llegado ninguno, se queda en null y el usuario
    // simplemente no ve coordenadas previas hasta que fije unas nuevas.
    fixedLat: source.fixedLat,
    fixedLon: source.fixedLon,
    displayUnits: display?.units ?? Config_DisplayConfig_DisplayUnits.METRIC,
    screenOnSecs: display?.screenOnSecs ?? 0,
    flipScreen: display?.flipScreen ?? false,
    mqttEnabled: mqtt?.enabled ?? false,
    mqttAddress: mqtt?.address ?? "",
    mqttUsername: mqtt?.username ?? "",
    mqttPassword: mqtt?.password ?? "",
    mqttEncryptionEnabled: mqtt?.encryptionEnabled ?? true,
    mqttTlsEnabled: mqtt?.tlsEnabled ?? false,
    mqttRoot: mqtt?.root ?? "",
    bluetoothEnabled: bluetooth?.enabled ?? true,
    bluetoothMode: bluetooth?.mode ?? Config_BluetoothConfig_PairingMode.RANDOM_PIN,
    bluetoothFixedPin: bluetooth?.fixedPin ?? 123456,
    powerSavingEnabled: power?.isPowerSaving ?? false,
    onBatteryShutdownAfterSecs: power?.onBatteryShutdownAfterSecs ?? 0,
    tzdef: device?.tzdef ?? "",
    buzzerMode: device?.buzzerMode ?? Config_DeviceConfig_BuzzerMode.ALL_ENABLED,
    ledHeartbeatDisabled: device?.ledHeartbeatDisabled ?? false,
    networkWifiEnabled: network?.wifiEnabled ?? false,
    networkWifiSsid: network?.wifiSsid ?? "",
    networkWifiPsk: network?.wifiPsk ?? "",
    networkEthEnabled: network?.ethEnabled ?? false,
    serialEnabled: serial?.enabled ?? false,
    telemetryDeviceUpdateInterval: telemetry?.deviceUpdateInterval ?? 0,
    telemetryEnvironmentMeasurementEnabled: telemetry?.environmentMeasurementEnabled ?? false,
    telemetryEnvironmentUpdateInterval: telemetry?.environmentUpdateInterval ?? 0,
    telemetryEnvironmentScreenEnabled: telemetry?.environmentScreenEnabled ?? false,
    telemetryEnvironmentDisplayFahrenheit: telemetry?.environmentDisplayFahrenheit ?? false,
    telemetryAirQualityEnabled: telemetry?.airQualityEnabled ?? false,
    telemetryAirQualityInterval: telemetry?.airQualityInterval ?? 0,
    telemetryPowerMeasurementEnabled: telemetry?.powerMeasurementEnabled ?? false,
    telemetryPowerUpdateInterval: telemetry?.powerUpdateInterval ?? 0,
    telemetryPowerScreenEnabled: telemetry?.powerScreenEnabled ?? false,
    telemetryHealthMeasurementEnabled: telemetry?.healthMeasurementEnabled ?? false,
    telemetryHealthUpdateInterval: telemetry?.healthUpdateInterval ?? 0,
    telemetryHealthScreenEnabled: telemetry?.healthScreenEnabled ?? false,
  };
}

function moreConfigSectionChanged<K extends keyof MoreConfigValues>(
  values: MoreConfigValues,
  baseline: MoreConfigValues,
  keys: readonly K[],
): boolean {
  return keys.some((key) => values[key] !== baseline[key]);
}

/**
 * Envía el resto de secciones de "Más configuración" (todo lo que no sea LoRa/canal/
 * telemetría del preset, que ya gestiona `applyPresetInner`): rol del nodo, posición/GPS,
 * pantalla, MQTT, Bluetooth, energía, red, serie y telemetría detallada. `values` siempre
 * trae los 40+ campos del formulario, pero eso no significa que el usuario haya tocado
 * todos: reenviar una sección entera sin cambios (p.ej. MQTT, con 4 campos de texto) es una
 * escritura GATT innecesaria más — y por Bluetooth cada escritura de más es una oportunidad
 * más para que la conexión se caiga a mitad de aplicar. Comparando contra `baseline` (los
 * valores tal como se leyeron del nodo al conectar) nos saltamos por completo cualquier
 * sección idéntica.
 */
async function sendMoreConfigExtraSections(
  device: MeshDevice,
  t: TFunction,
  source: DeviceProfileSource,
  values: MoreConfigValues,
  baseline: MoreConfigValues,
  onProgress: ProgressFn | undefined,
): Promise<void> {
  const paced = async (run: () => Promise<void>) => {
    await sleep(APPLY_STEP_DELAY_MS);
    await run();
  };

  if (moreConfigSectionChanged(values, baseline, ["role", "tzdef", "buzzerMode", "ledHeartbeatDisabled"])) {
    await paced(async () => {
      onProgress?.(t("progress.sendingConfigSection", { section: t("configSection.device") }), { percent: 60 });
      await device.setConfig(
        create(ConfigSchema, {
          payloadVariant: {
            case: "device",
            value: create(Config_DeviceConfigSchema, {
              ...source.config.device,
              role: values.role,
              tzdef: values.tzdef,
              buzzerMode: values.buzzerMode,
              ledHeartbeatDisabled: values.ledHeartbeatDisabled,
            }),
          },
        }),
      );
    });
  }

  if (moreConfigSectionChanged(values, baseline, ["gpsMode", "positionBroadcastSecs", "fixedPosition"])) {
    await paced(async () => {
      onProgress?.(t("progress.sendingConfigSection", { section: t("configSection.position") }), { percent: 64 });
      await device.setConfig(
        create(ConfigSchema, {
          payloadVariant: {
            case: "position",
            value: create(Config_PositionConfigSchema, {
              ...source.config.position,
              gpsMode: values.gpsMode,
              positionBroadcastSecs: values.positionBroadcastSecs,
              fixedPosition: values.fixedPosition,
            }),
          },
        }),
      );
    });
  }

  // fixedPosition (arriba) solo dice "esta posición no se mueve"; las coordenadas en sí se
  // fijan aparte con un mensaje admin (setFixedPosition), no forman parte de Config. Solo se
  // toca si el usuario ha marcado coordenadas nuevas, o si estaba fija y ha dejado de estarlo.
  if (values.fixedPosition && values.fixedLat !== null && values.fixedLon !== null) {
    await paced(async () => {
      onProgress?.(t("progress.sendingFixedPosition"), { percent: 67 });
      await device.setFixedPosition(values.fixedLat!, values.fixedLon!);
    });
  } else if (!values.fixedPosition && baseline.fixedPosition) {
    await paced(async () => {
      await device.removeFixedPosition();
    });
  }

  if (moreConfigSectionChanged(values, baseline, ["displayUnits", "screenOnSecs", "flipScreen"])) {
    await paced(async () => {
      onProgress?.(t("progress.sendingConfigSection", { section: t("configSection.display") }), { percent: 70 });
      await device.setConfig(
        create(ConfigSchema, {
          payloadVariant: {
            case: "display",
            value: create(Config_DisplayConfigSchema, {
              ...source.config.display,
              units: values.displayUnits,
              screenOnSecs: values.screenOnSecs,
              flipScreen: values.flipScreen,
            }),
          },
        }),
      );
    });
  }

  if (
    moreConfigSectionChanged(values, baseline, [
      "mqttEnabled",
      "mqttAddress",
      "mqttUsername",
      "mqttPassword",
      "mqttEncryptionEnabled",
      "mqttTlsEnabled",
      "mqttRoot",
    ])
  ) {
    await paced(async () => {
      onProgress?.(t("progress.sendingModuleConfigSection", { section: t("moduleSection.mqtt") }), { percent: 74 });
      await device.setModuleConfig(
        create(ModuleConfigSchema, {
          payloadVariant: {
            case: "mqtt",
            value: create(ModuleConfig_MQTTConfigSchema, {
              ...source.moduleConfig.mqtt,
              enabled: values.mqttEnabled,
              address: values.mqttAddress,
              username: values.mqttUsername,
              password: values.mqttPassword,
              encryptionEnabled: values.mqttEncryptionEnabled,
              tlsEnabled: values.mqttTlsEnabled,
              root: values.mqttRoot,
            }),
          },
        }),
      );
    });
  }

  if (moreConfigSectionChanged(values, baseline, ["bluetoothEnabled", "bluetoothMode", "bluetoothFixedPin"])) {
    await paced(async () => {
      onProgress?.(t("progress.sendingConfigSection", { section: t("configSection.bluetooth") }), { percent: 78 });
      await device.setConfig(
        create(ConfigSchema, {
          payloadVariant: {
            case: "bluetooth",
            value: create(Config_BluetoothConfigSchema, {
              ...source.config.bluetooth,
              enabled: values.bluetoothEnabled,
              mode: values.bluetoothMode,
              fixedPin: values.bluetoothFixedPin,
            }),
          },
        }),
      );
    });
  }

  if (moreConfigSectionChanged(values, baseline, ["powerSavingEnabled", "onBatteryShutdownAfterSecs"])) {
    await paced(async () => {
      onProgress?.(t("progress.sendingConfigSection", { section: t("configSection.power") }), { percent: 82 });
      await device.setConfig(
        create(ConfigSchema, {
          payloadVariant: {
            case: "power",
            value: create(Config_PowerConfigSchema, {
              ...source.config.power,
              isPowerSaving: values.powerSavingEnabled,
              onBatteryShutdownAfterSecs: values.onBatteryShutdownAfterSecs,
            }),
          },
        }),
      );
    });
  }

  if (
    moreConfigSectionChanged(values, baseline, ["networkWifiEnabled", "networkWifiSsid", "networkWifiPsk", "networkEthEnabled"])
  ) {
    await paced(async () => {
      onProgress?.(t("progress.sendingConfigSection", { section: t("configSection.network") }), { percent: 85 });
      await device.setConfig(
        create(ConfigSchema, {
          payloadVariant: {
            case: "network",
            value: create(Config_NetworkConfigSchema, {
              ...source.config.network,
              wifiEnabled: values.networkWifiEnabled,
              wifiSsid: values.networkWifiSsid,
              wifiPsk: values.networkWifiPsk,
              ethEnabled: values.networkEthEnabled,
            }),
          },
        }),
      );
    });
  }

  if (moreConfigSectionChanged(values, baseline, ["serialEnabled"])) {
    await paced(async () => {
      onProgress?.(t("progress.sendingModuleConfigSection", { section: t("moduleSection.serial") }), { percent: 88 });
      await device.setModuleConfig(
        create(ModuleConfigSchema, {
          payloadVariant: {
            case: "serial",
            value: create(ModuleConfig_SerialConfigSchema, { ...source.moduleConfig.serial, enabled: values.serialEnabled }),
          },
        }),
      );
    });
  }

  if (
    moreConfigSectionChanged(values, baseline, [
      "telemetryDeviceUpdateInterval",
      "telemetryEnvironmentMeasurementEnabled",
      "telemetryEnvironmentUpdateInterval",
      "telemetryEnvironmentScreenEnabled",
      "telemetryEnvironmentDisplayFahrenheit",
      "telemetryAirQualityEnabled",
      "telemetryAirQualityInterval",
      "telemetryPowerMeasurementEnabled",
      "telemetryPowerUpdateInterval",
      "telemetryPowerScreenEnabled",
      "telemetryHealthMeasurementEnabled",
      "telemetryHealthUpdateInterval",
      "telemetryHealthScreenEnabled",
    ])
  ) {
    await paced(async () => {
      onProgress?.(t("progress.sendingModuleConfigSection", { section: t("moduleSection.telemetry") }), { percent: 92 });
      await device.setModuleConfig(
        create(ModuleConfigSchema, {
          payloadVariant: {
            case: "telemetry",
            value: create(ModuleConfig_TelemetryConfigSchema, {
              ...source.moduleConfig.telemetry,
              deviceUpdateInterval: values.telemetryDeviceUpdateInterval,
              environmentMeasurementEnabled: values.telemetryEnvironmentMeasurementEnabled,
              environmentUpdateInterval: values.telemetryEnvironmentUpdateInterval,
              environmentScreenEnabled: values.telemetryEnvironmentScreenEnabled,
              environmentDisplayFahrenheit: values.telemetryEnvironmentDisplayFahrenheit,
              airQualityEnabled: values.telemetryAirQualityEnabled,
              airQualityInterval: values.telemetryAirQualityInterval,
              powerMeasurementEnabled: values.telemetryPowerMeasurementEnabled,
              powerUpdateInterval: values.telemetryPowerUpdateInterval,
              powerScreenEnabled: values.telemetryPowerScreenEnabled,
              healthMeasurementEnabled: values.telemetryHealthMeasurementEnabled,
              healthUpdateInterval: values.telemetryHealthUpdateInterval,
              healthScreenEnabled: values.telemetryHealthScreenEnabled,
            }),
          },
        }),
      );
    });
  }
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
 * Construye el `DeviceProfile` (mismo formato que "Exportar configuración"/"Importar
 * configuración") a partir de la foto cruda del nodo conectado. La clave privada
 * (Config.security.private_key) nunca sale de él: es el secreto que le da su identidad
 * criptográfica en la malla. Si se filtra en un fichero y se reimporta en otro nodo,
 * ambos acabarían compartiendo identidad. La app oficial hace lo mismo al exportar.
 */
function buildDeviceProfile(source: DeviceProfileSource): DeviceProfile {
  const config = source.config.security
    ? { ...source.config, security: { ...source.config.security, privateKey: new Uint8Array() } }
    : source.config;

  return create(DeviceProfileSchema, {
    longName: source.longName ?? undefined,
    shortName: source.shortName ?? undefined,
    channelUrl: source.channels.length > 0 ? buildChannelUrl(source.channels, source.config.lora ?? null) : undefined,
    config: create(LocalConfigSchema, config),
    moduleConfig: create(LocalModuleConfigSchema, source.moduleConfig),
  });
}

/**
 * Exporta toda la configuración que ya conocemos del nodo conectado (identidad y todas
 * las secciones de Config/ModuleConfig recibidas durante el handshake, más los canales)
 * como un `DeviceProfile` en JSON — el mismo formato que usan "Exportar
 * configuración"/"Importar configuración" en la app oficial de Meshtastic.
 */
export function exportDeviceProfileJson(source: DeviceProfileSource): string {
  const profile = buildDeviceProfile(source);
  // alwaysEmitImplicit: sin esto, protobuf-JSON omite los campos que están en su valor
  // por defecto (false, 0, "") — p.ej. "usePreset": false desaparecería del todo del
  // fichero en vez de aparecer explícito, aunque el nodo sí lo tenga así.
  return JSON.stringify(toJson(DeviceProfileSchema, profile, { alwaysEmitImplicit: true }), null, 2);
}

/**
 * Traduce la configuración actual de un nodo ya conectado a las mismas secciones legibles
 * que se usan para revisar un perfil importado (`describeDeviceProfile`), para mostrarlas
 * en el panel "Configuración actual del nodo". Añade además las coordenadas de posición
 * fija si se conocen: no forman parte de ninguna sección de Config (viven en un paquete
 * Position aparte, ver `fixedLat`/`fixedLon` en `DeviceProfileSource`), así que
 * `describeDeviceProfile` no las incluye por sí solo.
 */
// Secciones que describeDeviceProfile sí incluye (tienen sentido al revisar un fichero
// antes de importarlo) pero que aquí solo añaden ruido: energía/pantalla son ajustes
// menores de comodidad, y "otros módulos" solo indica qué secciones mandó el firmware en
// el handshake, no si el módulo está realmente activo, así que sistemáticamente confunde
// más de lo que informa.
const CURRENT_PROFILE_HIDDEN_SECTION_KEYS: MessageKey[] = [
  "profile.power.title",
  "profile.display.title",
  "profile.externalNotification.title",
  "profile.cannedMessage.title",
  "profile.otherModules.title",
];

export function describeCurrentDeviceProfile(source: DeviceProfileSource, t: TFunction): ProfileSummarySection[] {
  const sections = describeDeviceProfile(buildDeviceProfile(source), t);
  if (source.fixedLat !== null && source.fixedLon !== null) {
    const positionSection = sections.find((s) => s.title === t("profile.position.title"));
    positionSection?.rows.push({
      label: t("profile.position.coords"),
      value: `${source.fixedLat.toFixed(6)}, ${source.fixedLon.toFixed(6)}`,
    });
  }
  const hiddenTitles = new Set(CURRENT_PROFILE_HIDDEN_SECTION_KEYS.map((key) => t(key)));
  return sections.filter((s) => !hiddenTitles.has(s.title));
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
 * Si una config LoRa manual (usePreset=false) coincide con un preset propio de la
 * comunidad (BW/SF/CR, ver `presets/loraPresets.ts`), devuelve su nombre ("SFNarrow"...) en
 * vez de que el resumen muestre los números crudos, que no dicen nada al usuario.
 */
function customLoraPresetName(l: { bandwidth: number; spreadFactor: number; codingRate: number }): string | null {
  const match = ES_CUSTOM_PRESETS.find(
    (p) => p.values.bandwidth === l.bandwidth && p.values.spreadFactor === l.spreadFactor && p.values.codingRate === l.codingRate,
  );
  return match?.defaultChannelName ?? null;
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
            : (customLoraPresetName(l) ?? t("profile.lora.manual", { bw: l.bandwidth, sf: l.spreadFactor, cr: l.codingRate })),
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
        ...(tel.airQualityEnabled ? [{ label: t("profile.telemetry.airQuality"), value: formatInterval(tel.airQualityInterval, t) }] : []),
        ...(tel.healthMeasurementEnabled ? [{ label: t("profile.telemetry.health"), value: formatInterval(tel.healthUpdateInterval, t) }] : []),
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
  await withScreenAwake(() =>
    withApplyTimeout(device, (markRebooting) => applyDeviceProfileInner(device, profile, t, onProgress, markRebooting)),
  );
}

async function applyDeviceProfileInner(
  device: MeshDevice,
  profile: DeviceProfile,
  t: TFunction,
  onProgress: ProgressFn | undefined,
  markRebooting: () => void,
): Promise<void> {
  if (profile.longName || profile.shortName) {
    onProgress?.(t("progress.sendingNodeName"), { percent: 5 });
    await device.setOwner(
      create(UserSchema, { longName: profile.longName ?? "", shortName: profile.shortName ?? "" }),
    );
  }

  const configSections = presentSections(CONFIG_SECTION_LABELS, profile.config as unknown as Record<string, unknown>);
  for (const [i, kind] of configSections.entries()) {
    if (i > 0) await sleep(APPLY_STEP_DELAY_MS);
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
      await sleep(APPLY_STEP_DELAY_MS);
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
    await sleep(APPLY_STEP_DELAY_MS);
    onProgress?.(t("progress.sendingModuleConfigSection", { section: t(MODULE_CONFIG_SECTION_LABELS[kind]) }), {
      percent: 60 + (i / moduleConfigSections.length) * 25,
    });
    const value = (profile.moduleConfig as unknown as Record<string, unknown>)[kind];
    await device.setModuleConfig(
      create(ModuleConfigSchema, { payloadVariant: { case: kind, value } as Protobuf.ModuleConfig.ModuleConfig["payloadVariant"] }),
    );
  }

  await sleep(APPLY_STEP_DELAY_MS);
  markRebooting();
  await commitEditSettings(device);
  onProgress?.(t("progress.rebooting"), { percent: 90 });
  await rebootDevice(device);
  onProgress?.(t("progress.applied"), { percent: 100 });
}
