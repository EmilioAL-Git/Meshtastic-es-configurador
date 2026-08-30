import { useEffect, useRef, useState, type ChangeEvent } from "react";
import type { MeshDevice } from "@meshtastic/core";
import "./App.css";
import {
  applyDeviceProfile,
  applyPreset,
  BLUETOOTH_PAIRING_MODE_OPTIONS,
  BluetoothPairingModeValue,
  BUZZER_MODE_OPTIONS,
  connectBluetooth,
  connectNetwork,
  connectSerial,
  decodeCustomPsk,
  defaultSimplePsk,
  describeCurrentDeviceProfile,
  describeDeviceProfile,
  disconnectDevice,
  downloadTextFile,
  DEVICE_ROLE_OPTIONS,
  DISPLAY_UNITS_OPTIONS,
  encodePskBase64,
  exportDeviceProfileJson,
  formatInterval,
  GPS_MODE_OPTIONS,
  isWebBluetoothSupported,
  isWebSerialSupported,
  parseDeviceProfileJson,
  readMoreConfigValues,
  translateError,
  type ChannelPreset,
  type ConnectResult,
  type DeviceProfile,
  type DeviceProfileSource,
  type DeviceSnapshot,
  type MoreConfigValues,
  type ProfileSummarySection,
} from "./lib/meshtastic";
import {
  ES_CUSTOM_PRESETS,
  getDefaultChannelName,
  getPresetsForRegion,
  LORA_REGION_CODES,
  type LoRaPresetDef,
  type LoRaRegion,
} from "./presets/loraPresets";
import { PROVINCE_CHANNELS } from "./presets/provinceChannels";
import { TELEMETRY_PRESETS, type TelemetryPresetDef } from "./presets/telemetryPresets";
import { NODE_TYPE_PRESETS, type NodeTypePresetDef } from "./presets/nodeTypePresets";
import { useI18n } from "./i18n";
import type { MessageKey } from "./i18n/locales/es";
import { LanguageSwitcher } from "./components/LanguageSwitcher";
import { MapPickerModal } from "./components/MapPickerModal";

type ConnectionVia = "usb" | "bluetooth" | "network";

type ConnectionState =
  | { status: "disconnected" }
  | { status: "connecting"; via: ConnectionVia }
  | { status: "connected"; via: ConnectionVia; device: MeshDevice }
  | { status: "error"; message: string };

const VIA_LABEL_KEYS: Record<ConnectionVia, MessageKey> = { usb: "via.usb", bluetooth: "via.bluetooth", network: "via.network" };

type ChannelNameMode = "standard" | "custom";
type SecondarySelection = "custom" | string;
type ConfigTab = "simple" | "advanced";

/** Meshtastic admite 8 canales en total (índices 0-7); el 0 es siempre el primario. */
const MAX_ADDITIONAL_CHANNELS = 7;

interface AdditionalChannelState {
  id: string;
  selection: SecondarySelection;
  name: string;
  pskText: string;
}

function makeChannelId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : Math.random().toString(36).slice(2);
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** iPadOS se identifica como "MacIntel" en el user agent (para que las webs no lo traten
 * como móvil), pero se distingue de un Mac real porque sí tiene pantalla táctil. */
function isIOSDevice(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  return /iPhone|iPod|iPad/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

/** Combina el user agent (para tablets/Android que no incluyan "Mobile") con el tamaño
 * físico de pantalla (`screen`, no `innerWidth`, para no confundir una ventana de
 * escritorio estrecha con un móvil). */
function isMobileDevice(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  const mobileUa = /iPhone|iPod|iPad|Android.*Mobile|Windows Phone/i.test(ua);
  const narrowScreen = typeof window !== "undefined" && Math.min(window.screen.width, window.screen.height) < 640;
  return mobileUa || narrowScreen;
}
type AdvancedTab = "lora" | "channels" | "node" | "position" | "connectivity" | "telemetry";

const ADVANCED_TABS: { id: AdvancedTab; labelKey: MessageKey }[] = [
  { id: "lora", labelKey: "advanced.tab.lora" },
  { id: "channels", labelKey: "advanced.tab.channels" },
  { id: "node", labelKey: "advanced.tab.node" },
  { id: "position", labelKey: "advanced.tab.position" },
  { id: "connectivity", labelKey: "advanced.tab.connectivity" },
  { id: "telemetry", labelKey: "advanced.tab.telemetry" },
];

function moreConfigNumberField(value: number): string {
  return Number.isNaN(value) ? "" : String(value);
}

function moreConfigParseNumber(raw: string, fallback: number): number {
  const n = parseInt(raw, 10);
  return Number.isNaN(n) ? fallback : n;
}

/** Horas predefinidas para los desplegables de intervalos de telemetría; "personalizado" cae en un campo numérico en horas. */
const INTERVAL_HOUR_PRESETS = [1, 2, 4, 8, 12, 24, 36, 48, 72];

/** Campo de intervalo (almacenado en segundos) con desplegable de horas predefinidas y opción "Personalizado" que revela un input numérico también en horas. */
function IntervalHoursField({
  id,
  label,
  hint,
  value,
  onChange,
}: {
  id: string;
  label: string;
  hint?: string;
  value: number;
  onChange: (seconds: number) => void;
}) {
  const { t } = useI18n();
  const matchedHours = value > 0 && value % 3600 === 0 ? value / 3600 : null;
  const isPreset = matchedHours !== null && INTERVAL_HOUR_PRESETS.includes(matchedHours);
  const [forceCustom, setForceCustom] = useState(!isPreset);
  const showCustomInput = forceCustom || !isPreset;
  const selectValue = showCustomInput ? "custom" : String(matchedHours);

  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <select
        id={id}
        value={selectValue}
        onChange={(e) => {
          if (e.target.value === "custom") {
            setForceCustom(true);
          } else {
            setForceCustom(false);
            onChange(Number(e.target.value) * 3600);
          }
        }}
      >
        {INTERVAL_HOUR_PRESETS.map((h) => (
          <option key={h} value={h}>
            {t("interval.hours", { n: h })}
          </option>
        ))}
        <option value="custom">{t("interval.custom")}</option>
      </select>
      {showCustomInput && (
        <div className="interval-custom-row">
          <input
            id={`${id}-custom`}
            type="number"
            min={0}
            step="any"
            value={value > 0 ? String(value / 3600) : ""}
            onChange={(e) => {
              const hours = e.target.value === "" ? 0 : Number(e.target.value);
              onChange(Number.isNaN(hours) ? 0 : Math.round(hours * 3600));
            }}
          />
          <span className="hint">{t("interval.hoursUnit")}</span>
        </div>
      )}
      {hint && <span className="hint">{hint}</span>}
    </div>
  );
}

const SIMPLE_PRESETS: { presetId: string; labelKey: MessageKey; hintKey: MessageKey }[] = [
  { presetId: "SFNARROW", labelKey: "simple.preset.sfnarrow.label", hintKey: "simple.preset.sfnarrow.hint" },
  { presetId: "MEDIUM_FAST", labelKey: "simple.preset.mediumfast.label", hintKey: "simple.preset.mediumfast.hint" },
  { presetId: "LONG_FAST", labelKey: "simple.preset.longfast.label", hintKey: "simple.preset.longfast.hint" },
];
const PRESET_MAP_URL = "https://meshtastic.es/docs/mapas#mapa-presets";

function App() {
  const { t } = useI18n();
  const [conn, setConn] = useState<ConnectionState>({ status: "disconnected" });
  const [configTab, setConfigTab] = useState<ConfigTab>("simple");
  const [region, setRegion] = useState<LoRaRegion>("EU_868");
  const loraPresets = getPresetsForRegion(region);
  const [loraPresetId, setLoraPresetId] = useState(loraPresets[0].id);
  const selectedLora = loraPresets.find((p) => p.id === loraPresetId) ?? loraPresets[0];
  const defaultChannelName = getDefaultChannelName(selectedLora, region);
  const [telemetryPresetId, setTelemetryPresetId] = useState(TELEMETRY_PRESETS[0].id);
  const selectedTelemetry = TELEMETRY_PRESETS.find((p) => p.id === telemetryPresetId) ?? TELEMETRY_PRESETS[0];
  const [nodeTypeId, setNodeTypeId] = useState<NodeTypePresetDef["id"] | null>(null);
  const nodeTypeIdRef = useRef(nodeTypeId);
  useEffect(() => {
    nodeTypeIdRef.current = nodeTypeId;
  }, [nodeTypeId]);
  const [channelNameMode, setChannelNameMode] = useState<ChannelNameMode>("standard");
  const [customChannelName, setCustomChannelName] = useState("");
  const channelName = channelNameMode === "custom" ? customChannelName.trim() : defaultChannelName;
  const [primaryPskText, setPrimaryPskText] = useState(encodePskBase64(defaultSimplePsk));
  const primaryPskBytes = channelNameMode === "standard" ? defaultSimplePsk : decodeCustomPsk(primaryPskText);
  const primaryPskInvalid = channelNameMode === "custom" && primaryPskBytes === null;

  const [additionalChannels, setAdditionalChannels] = useState<AdditionalChannelState[]>([]);
  const additionalChannelsResolved = additionalChannels.map((c) => ({ ...c, pskBytes: decodeCustomPsk(c.pskText) }));

  const [confirmApplyOpen, setConfirmApplyOpen] = useState(false);

  const [log, setLog] = useState<string[]>([]);
  const [progress, setProgress] = useState<number | null>(null);
  const [applying, setApplying] = useState(false);
  const [progressModalOpen, setProgressModalOpen] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [applyLogStart, setApplyLogStart] = useState(0);
  const [deviceSnapshot, setDeviceSnapshot] = useState<DeviceSnapshot | null>(null);
  const stopSnapshotTrackingRef = useRef<(() => void) | null>(null);
  const getDeviceProfileSourceRef = useRef<(() => DeviceProfileSource) | null>(null);
  /** Solo se rellena tras conectar por Bluetooth: permite reconectar al mismo
   * `BluetoothDevice` (sin volver a mostrar el selector) para reintentar "Aplicar" si la
   * conexión GATT se cae a mitad de aplicar cambios — algo frecuente en Android. */
  const reconnectBluetoothRef = useRef<(() => Promise<ConnectResult>) | null>(null);
  const connectingDeviceRef = useRef<MeshDevice | null>(null);
  const connectSeqRef = useRef(0);
  const importFileInputRef = useRef<HTMLInputElement | null>(null);
  const [importPending, setImportPending] = useState<{ profile: DeviceProfile; sections: ProfileSummarySection[] } | null>(null);
  const [moreConfigValues, setMoreConfigValues] = useState<MoreConfigValues | null>(null);
  /** Valores tal como estaban en el nodo al abrir "Más configuración", antes de cualquier edición: la base contra la que se compara en la pantalla de revisión. */
  const [moreConfigBaseline, setMoreConfigBaseline] = useState<MoreConfigValues | null>(null);
  const [mapPickerOpen, setMapPickerOpen] = useState(false);
  const [advancedTab, setAdvancedTab] = useState<AdvancedTab>("lora");

  const serialSupported = isWebSerialSupported();
  const bluetoothSupported = isWebBluetoothSupported();
  /**
   * En iPhone/iPad no hay nada que hacer: Safari (y cualquier navegador en iOS, obligado a
   * usar su motor WebKit) no implementa Web Bluetooth ni Web Serial y Apple no tiene
   * intención de añadirlo, así que los botones de conectar ya salen deshabilitados por su
   * cuenta — el aviso es solo para explicar por qué, sin ofrecer ningún "continuar" porque
   * de verdad no hay vía posible desde este navegador (la única es la app de terceros
   * Bluefy, que sí implementa Bluetooth). En el resto de móviles si hay Bluetooth, pero tan
   * poco fiable (ver el resto de esta sesión) que avisamos igual, dejando "continuar" para
   * quien quiera insistir bajo su responsabilidad.
   */
  const [mobileWarningDismissed, setMobileWarningDismissed] = useState(false);
  const mobileWarningVariant: "ios" | "mobile" | null = isIOSDevice() ? "ios" : isMobileDevice() ? "mobile" : null;
  const [networkAddress, setNetworkAddress] = useState("");
  const [networkPort, setNetworkPort] = useState("4403");
  const [networkTls, setNetworkTls] = useState(false);
  const [networkModalOpen, setNetworkModalOpen] = useState(false);
  const networkHostPort = networkPort.trim() ? `${networkAddress.trim()}:${networkPort.trim()}` : networkAddress.trim();

  function appendLog(line: string, opts?: { replace?: boolean; percent?: number }) {
    setLog((prev) => (opts?.replace && prev.length > 0 ? [...prev.slice(0, -1), line] : [...prev, line]));
    if (opts?.percent !== undefined) setProgress(opts.percent);
  }

  function beginApplyProgress() {
    setApplyLogStart(log.length);
    setApplyError(null);
    setProgressModalOpen(true);
    setApplying(true);
    setProgress(0);
  }

  function handleCloseProgressModal() {
    setProgressModalOpen(false);
  }

  /**
   * En móvil no hay forma práctica de abrir la consola del navegador para ver qué falla
   * realmente (requiere depuración remota por USB desde un ordenador). Volcar aquí
   * cualquier error/rechazo no capturado al propio registro en pantalla es la única vía
   * para diagnosticar fallos como una promesa del SDK que se queda colgada sin que ningún
   * `catch` de la app llegue a intervenir.
   */
  useEffect(() => {
    function handleWindowError(e: ErrorEvent) {
      appendLog(`⚠️ Error no controlado: ${e.message}`);
    }
    function handleRejection(e: PromiseRejectionEvent) {
      const reason = e.reason instanceof Error ? e.reason.message : String(e.reason);
      appendLog(`⚠️ Promesa rechazada sin capturar: ${reason}`);
    }
    window.addEventListener("error", handleWindowError);
    window.addEventListener("unhandledrejection", handleRejection);
    return () => {
      window.removeEventListener("error", handleWindowError);
      window.removeEventListener("unhandledrejection", handleRejection);
    };
  }, []);

  async function handleConnect(via: ConnectionVia) {
    if (via === "network" && networkAddress.trim() === "") return;
    stopSnapshotTrackingRef.current?.();
    stopSnapshotTrackingRef.current = null;
    const seq = ++connectSeqRef.current;
    connectingDeviceRef.current = null;
    setConn({ status: "connecting", via });
    setLog([]);
    setProgress(0);
    setDeviceSnapshot(null);
    const onDeviceCreated = (device: MeshDevice) => {
      // Guarda el dispositivo en cuanto existe (antes de que termine el handshake) para
      // poder cancelarlo desde "Desconectar" mientras todavía está conectando.
      if (connectSeqRef.current === seq) connectingDeviceRef.current = device;
    };
    try {
      // La identidad/LoRa/canales/telemetría llegan durante el propio handshake, así
      // que hay que empezar a escucharlos desde ya (dentro de connectSerial/
      // connectBluetooth/connectNetwork) — si nos suscribiéramos después de
      // "Conectado", ya habrían pasado y el panel se quedaría esperando para siempre.
      const { device, stopSnapshotTracking, getDeviceProfileSource, reconnect } =
        via === "usb"
          ? await connectSerial(t, appendLog, setDeviceSnapshot, onDeviceCreated)
          : via === "bluetooth"
            ? await connectBluetooth(t, appendLog, setDeviceSnapshot, onDeviceCreated)
            : await connectNetwork(networkHostPort, networkTls, t, appendLog, setDeviceSnapshot, onDeviceCreated);
      if (connectSeqRef.current !== seq) {
        // Se canceló (botón "Desconectar") mientras conectaba: descarta esta conexión.
        stopSnapshotTracking();
        device.disconnect().catch(() => {});
        return;
      }
      connectingDeviceRef.current = null;
      stopSnapshotTrackingRef.current = stopSnapshotTracking;
      getDeviceProfileSourceRef.current = getDeviceProfileSource;
      reconnectBluetoothRef.current = reconnect ?? null;
      setConn({ status: "connected", via, device });
      appendLog(t("connect.connectedLog", { via: t(VIA_LABEL_KEYS[via]) }));
    } catch (err) {
      if (connectSeqRef.current !== seq) return;
      setConn({ status: "error", message: translateError(err, t) });
    }
  }

  function handleOpenNetworkModal() {
    setNetworkModalOpen(true);
  }

  function handleCancelNetworkModal() {
    setNetworkModalOpen(false);
  }

  function handleConfirmNetworkModal() {
    if (networkAddress.trim() === "") return;
    setNetworkModalOpen(false);
    handleConnect("network");
  }

  async function handleDisconnect() {
    connectSeqRef.current++; // invalida cualquier connectSerial/Bluetooth/Network en curso
    const wasConnecting = conn.status === "connecting";
    stopSnapshotTrackingRef.current?.();
    stopSnapshotTrackingRef.current = null;
    getDeviceProfileSourceRef.current = null;
    reconnectBluetoothRef.current = null;
    if (conn.status === "connected") {
      await disconnectDevice(conn.device);
    } else if (connectingDeviceRef.current) {
      await disconnectDevice(connectingDeviceRef.current);
    }
    connectingDeviceRef.current = null;
    setConn({ status: "disconnected" });
    setDeviceSnapshot(null);
    if (wasConnecting) appendLog(t("connect.cancelled"));
  }

  function handleChannelNameModeChange(next: ChannelNameMode) {
    setChannelNameMode(next);
    if (next === "standard") {
      setPrimaryPskText(encodePskBase64(defaultSimplePsk));
    }
  }

  function handleRegionChange(next: LoRaRegion) {
    setRegion(next);
    const stillValid = getPresetsForRegion(next).some((p) => p.id === loraPresetId);
    if (!stillValid) {
      setLoraPresetId(getPresetsForRegion(next)[0].id);
    }
  }

  // Carga en el estado de edición el canal primario y todos los adicionales (índices > 0)
  // que el nodo ya tenga, para poder modificarlos/borrarlos en vez de partir de cero.
  // `expectedDefault` es el nombre/PSK estándar contra el que comparar para decidir si el
  // canal primario del nodo cuenta como "Estándar" (sin aviso) o "Personalizado": por
  // defecto el del preset LoRa actualmente seleccionado en la UI.
  function loadChannelsFromSource(
    source: DeviceProfileSource | undefined,
    expectedDefault: { name: string; psk: Uint8Array } | null = { name: defaultChannelName, psk: defaultSimplePsk },
  ) {
    if (!source) return;
    const primary = source.channels.find((c) => c.index === 0);
    if (primary?.settings) {
      const isStandard =
        expectedDefault !== null &&
        primary.settings.name === expectedDefault.name &&
        bytesEqual(primary.settings.psk, expectedDefault.psk);
      if (isStandard) {
        setChannelNameMode("standard");
        setPrimaryPskText(encodePskBase64(defaultSimplePsk));
      } else {
        setChannelNameMode("custom");
        setCustomChannelName(primary.settings.name);
        setPrimaryPskText(encodePskBase64(primary.settings.psk));
      }
    }
    const others = source.channels.filter((c) => c.index > 0 && c.settings).sort((a, b) => a.index - b.index);
    setAdditionalChannels(
      others.map((c) => ({
        id: makeChannelId(),
        selection: "custom" as SecondarySelection,
        name: c.settings!.name,
        pskText: encodePskBase64(c.settings!.psk),
      })),
    );
  }

  function handleSimplePresetSelect(presetId: string) {
    setRegion("EU_868");
    setLoraPresetId(presetId);
    setTelemetryPresetId(TELEMETRY_PRESETS[0].id);

    // Al aplicar, applyPreset siempre reenvía el canal primario (y los adicionales, si los
    // hay): en el modo sencillo el usuario solo quiere cambiar el preset LoRa, así que
    // aquí clonamos los canales ya presentes en el nodo para que ese reenvío sea un no-op
    // (mismo nombre/PSK) en vez de renombrar el canal al nombre estándar del preset. Se
    // fuerza "Personalizado" (expectedDefault: null) en vez de comparar contra el nuevo
    // preset recién elegido, que con el cierre de este render aún no se refleja en
    // `defaultChannelName`.
    loadChannelsFromSource(getDeviceProfileSourceRef.current?.(), null);
  }

  function handleAddAdditionalChannel() {
    setAdditionalChannels((prev) =>
      prev.length >= MAX_ADDITIONAL_CHANNELS ? prev : [...prev, { id: makeChannelId(), selection: "custom", name: "", pskText: "" }],
    );
  }

  function handleRemoveAdditionalChannel(id: string) {
    setAdditionalChannels((prev) => prev.filter((c) => c.id !== id));
  }

  function handleAdditionalChannelSelectionChange(id: string, next: SecondarySelection) {
    setAdditionalChannels((prev) =>
      prev.map((c) => {
        if (c.id !== id) return c;
        if (next === "custom") return { ...c, selection: next, name: "", pskText: "" };
        const province = PROVINCE_CHANNELS.find((p) => p.id === next);
        if (!province) return c;
        return { ...c, selection: next, name: province.channelName, pskText: encodePskBase64(province.psk) };
      }),
    );
  }

  function handleAdditionalChannelNameChange(id: string, name: string) {
    setAdditionalChannels((prev) => prev.map((c) => (c.id === id ? { ...c, name } : c)));
  }

  function handleAdditionalChannelPskChange(id: string, pskText: string) {
    setAdditionalChannels((prev) => prev.map((c) => (c.id === id ? { ...c, pskText } : c)));
  }

  const additionalChannelsReady = additionalChannelsResolved.every(
    (c) => c.pskBytes !== null && (c.selection !== "custom" || c.name.trim() !== ""),
  );

  function handleRequestApply() {
    if (conn.status !== "connected" || primaryPskInvalid || !additionalChannelsReady) return;
    setConfirmApplyOpen(true);
  }

  function handleCancelApply() {
    setConfirmApplyOpen(false);
  }

  /**
   * Todas las funciones de aplicar (`applyPreset`, `applyDeviceProfile`)
   * terminan reiniciando el nodo, lo que corta la conexión (sobre todo por Bluetooth: el
   * propio nodo cierra la sesión GATT). Si al terminar seguimos marcando `conn` como
   * "connected", la UI ofrece botones (Guardar, Subir, Más configuración...) que operan
   * sobre un `device` ya inservible. Al llegar aquí sin excepción, el reinicio se ha
   * disparado, así que reflejamos la desconexión real.
   */
  function handleApplySucceeded() {
    stopSnapshotTrackingRef.current?.();
    stopSnapshotTrackingRef.current = null;
    getDeviceProfileSourceRef.current = null;
    reconnectBluetoothRef.current = null;
    setConn({ status: "disconnected" });
    setDeviceSnapshot(null);
    appendLog(t("applyLog.disconnected"));
  }

  /**
   * Por Bluetooth es habitual (sobre todo en Android) que la conexión GATT se caiga a
   * mitad de aplicar cambios sin motivo aparente — un problema de la propia pila
   * Bluetooth del teléfono, no del nodo ni de la configuración enviada. Con un único
   * reintento a veces no basta (la pila puede tardar varios intentos en estabilizarse), así
   * que probamos hasta `maxAttempts` veces en total, reconectando cada vez al mismo
   * `BluetoothDevice` (sin volver a mostrar el selector) y dando un respiro breve para que
   * el radio Bluetooth del teléfono se asiente antes de volver a escribir.
   */
  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function runApplyWithReconnect(
    device: MeshDevice,
    run: (device: MeshDevice) => Promise<void>,
    maxAttempts = 3,
  ): Promise<void> {
    let current = device;
    for (let attempt = 1; ; attempt++) {
      try {
        await run(current);
        return;
      } catch (err) {
        const canRetry = attempt < maxAttempts && err instanceof Error && err.message === "DEVICE_DISCONNECTED" && reconnectBluetoothRef.current;
        if (!canRetry) throw err;
        appendLog(attempt === 1 ? t("applyLog.reconnecting") : t("applyLog.reconnectingAgain", { attempt, maxAttempts }));
        await sleep(1500);
        const fresh = await reconnectBluetoothRef.current!();
        stopSnapshotTrackingRef.current = fresh.stopSnapshotTracking;
        getDeviceProfileSourceRef.current = fresh.getDeviceProfileSource;
        reconnectBluetoothRef.current = fresh.reconnect ?? null;
        setConn({ status: "connected", via: "bluetooth", device: fresh.device });
        appendLog(t("applyLog.retrying"));
        current = fresh.device;
      }
    }
  }

  async function handleApply() {
    setConfirmApplyOpen(false);
    if (conn.status !== "connected") return;
    const lora = loraPresets.find((p) => p.id === loraPresetId);
    const telemetry = TELEMETRY_PRESETS.find((p) => p.id === telemetryPresetId);
    if (!lora || !telemetry || !additionalChannelsReady || primaryPskBytes === null) return;

    const channel: ChannelPreset = { name: channelName.trim(), psk: primaryPskBytes };
    const additionalChannelPresets: ChannelPreset[] = additionalChannelsResolved.map((c) => ({
      name: c.name.trim(),
      psk: c.pskBytes!,
    }));

    const source = getDeviceProfileSourceRef.current?.();

    beginApplyProgress();
    try {
      await runApplyWithReconnect(conn.device, (device) =>
        applyPreset(device, t, {
          lora,
          channel,
          additionalChannels: additionalChannelPresets,
          telemetry,
          region: LORA_REGION_CODES[region],
          source,
          moreConfig: moreConfigValues ?? undefined,
          moreConfigBaseline: moreConfigBaseline ?? undefined,
          onProgress: appendLog,
        }),
      );
      handleApplySucceeded();
    } catch (err) {
      const message = translateError(err, t);
      appendLog(t("applyLog.error", { message }));
      setApplyError(message);
    } finally {
      setApplying(false);
    }
  }

  function handleSaveConfig() {
    if (conn.status !== "connected" || !getDeviceProfileSourceRef.current) return;
    const source = getDeviceProfileSourceRef.current();
    const json = exportDeviceProfileJson(source);
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    downloadTextFile(`meshtastic-config-${stamp}.json`, json);
    appendLog(t("sidebar.savedLog"));
  }

  function handleUploadConfigClick() {
    importFileInputRef.current?.click();
  }

  async function handleUploadConfigFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      const text = await file.text();
      const profile = parseDeviceProfileJson(text);
      setImportPending({ profile, sections: describeDeviceProfile(profile, t) });
    } catch (err) {
      appendLog(t("sidebar.uploadErrorLog", { message: translateError(err, t) }));
    }
  }

  function handleCancelImport() {
    setImportPending(null);
  }

  async function handleConfirmImport() {
    if (conn.status !== "connected" || !importPending) return;
    const { profile } = importPending;
    setImportPending(null);
    beginApplyProgress();
    try {
      await runApplyWithReconnect(conn.device, (device) => applyDeviceProfile(device, profile, t, appendLog));
      handleApplySucceeded();
    } catch (err) {
      const message = translateError(err, t);
      appendLog(t("applyLog.error", { message }));
      setApplyError(message);
    } finally {
      setApplying(false);
    }
  }

  function handleSelectNodeType(id: NodeTypePresetDef["id"]) {
    const preset = NODE_TYPE_PRESETS.find((p) => p.id === id);
    if (!preset) return;
    setNodeTypeId(id);
    setTelemetryPresetId(preset.telemetryPresetId);
    // "Más configuración" está siempre cargado mientras hay conexión (ver el useEffect
    // de más abajo), así que el rol/GPS/posición del tipo de nodo se refleja ahí también
    // en cuanto se elige.
    setMoreConfigValues((prev) => (prev ? { ...prev, ...preset.moreConfig } : prev));
  }

  // "Más configuración" ya no es un panel que el usuario tenga que abrir: se carga solo en
  // cuanto hay conexión, para que sus campos estén siempre visibles en la pestaña Avanzado.
  useEffect(() => {
    if (conn.status !== "connected" || !getDeviceProfileSourceRef.current) {
      setMoreConfigValues(null);
      setMoreConfigBaseline(null);
      return;
    }
    const source = getDeviceProfileSourceRef.current();
    const base = readMoreConfigValues(source);
    const currentNodeTypeId = nodeTypeIdRef.current;
    const nodeTypePreset = currentNodeTypeId ? NODE_TYPE_PRESETS.find((p) => p.id === currentNodeTypeId) : undefined;
    setMoreConfigBaseline(base);
    setMoreConfigValues(nodeTypePreset ? { ...base, ...nodeTypePreset.moreConfig } : base);
    loadChannelsFromSource(source);
    // Solo se recarga al cambiar el estado de conexión (conectar/desconectar): no queremos
    // releer el nodo cada vez que cambia nodeTypeId, porque handleSelectNodeType ya aplica
    // ese cambio directamente sobre moreConfigValues (se lee vía ref para no tener que
    // declarar nodeTypeId como dependencia).
  }, [conn.status]);

  function handleChangeMoreConfig(patch: Partial<MoreConfigValues>) {
    setMoreConfigValues((prev) => (prev ? { ...prev, ...patch } : prev));
  }

  const nodeTypeSelector = (
    <div className="field">
      <label htmlFor="node-type-select">{t("nodeType.label")}</label>
      <select
        id="node-type-select"
        value={nodeTypeId ?? ""}
        onChange={(e) => handleSelectNodeType(e.target.value as NodeTypePresetDef["id"])}
      >
        <option value="" disabled>
          {t("nodeType.placeholder")}
        </option>
        {NODE_TYPE_PRESETS.map((p) => (
          <option key={p.id} value={p.id}>
            {p.label}
          </option>
        ))}
      </select>
      <span className="hint">
        {nodeTypeId ? NODE_TYPE_PRESETS.find((p) => p.id === nodeTypeId)?.description : t("nodeType.hint")}
      </span>
    </div>
  );

  return (
    <div className="shell">
      <header className="app-header">
        <div className="logo">
          <MeshNodeIcon />
          <span>
            MESHTASTIC ESPAÑA <em>/ Configurador</em>
          </span>
        </div>
        <div className="header-right">
          <span className="tagline">{t("header.tagline")}</span>
          <LanguageSwitcher />
        </div>
      </header>

      <main className="app-main">
        {!serialSupported && !bluetoothSupported && (
          <div className="browser-warning">{t("browserWarning")}</div>
        )}

        {mobileWarningVariant && !mobileWarningDismissed && (
          <div className="browser-warning">
            <p>{t(mobileWarningVariant === "ios" ? "mobileWarning.iosBody" : "mobileWarning.androidBody")}</p>
            {mobileWarningVariant === "mobile" && (
              <button type="button" className="btn" onClick={() => setMobileWarningDismissed(true)}>
                {t("mobileWarning.continueAnyway")}
              </button>
            )}
          </div>
        )}

        <div className={`layout${conn.status === "connected" || conn.status === "connecting" ? " has-sidebar" : ""}`}>
        <div className="main-column">
        <section className="panel">
          <h2>
            <span className="step">1</span> {t("connect.step")}
          </h2>
          <div className="connect-buttons">
            <button
              type="button"
              className="btn"
              disabled={!serialSupported || conn.status === "connecting" || conn.status === "connected"}
              onClick={() => handleConnect("usb")}
            >
              {t("connect.usb")}
            </button>
            <button
              type="button"
              className="btn"
              disabled={!bluetoothSupported || conn.status === "connecting" || conn.status === "connected"}
              onClick={() => handleConnect("bluetooth")}
            >
              {t("connect.bluetooth")}
            </button>
            <button
              type="button"
              className="btn"
              disabled={conn.status === "connecting" || conn.status === "connected"}
              onClick={handleOpenNetworkModal}
            >
              {t("connect.network")}
            </button>
            {(conn.status === "connected" || conn.status === "connecting") && (
              <button type="button" className="btn" onClick={handleDisconnect}>
                {conn.status === "connecting" ? t("connect.cancel") : t("connect.disconnect")}
              </button>
            )}
          </div>

          {conn.status === "connecting" && <p className="status-line">{t("connect.connecting")}</p>}
          {conn.status === "connected" && <p className="status-line ok">{t("connect.connected", { via: t(VIA_LABEL_KEYS[conn.via]) })}</p>}
          {conn.status === "error" && <p className="status-line error">{t("connect.error", { message: conn.message })}</p>}

          {conn.status === "connecting" && progress !== null && (
            <div className="progress-bar" role="progressbar" aria-valuenow={Math.round(progress)} aria-valuemin={0} aria-valuemax={100}>
              <div className="progress-bar-fill" style={{ width: `${Math.min(100, Math.max(0, progress))}%` }} />
              <span className="progress-bar-label">{Math.round(progress)}%</span>
            </div>
          )}

          {conn.status === "connecting" && log.length > 0 && <div className="log">{log[log.length - 1]}</div>}
        </section>

        <section className="panel">
          <h2>
            <span className="step">2</span> {t("config.step")}
          </h2>

          <div className="tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={configTab === "simple"}
              className={`tab-button${configTab === "simple" ? " active" : ""}`}
              onClick={() => setConfigTab("simple")}
            >
              {t("config.tab.simple")}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={configTab === "advanced"}
              className={`tab-button${configTab === "advanced" ? " active" : ""}`}
              onClick={() => setConfigTab("advanced")}
            >
              {t("config.tab.advanced")}
            </button>
          </div>

          {configTab === "simple" ? (
            <>
              <div className="field">
                <label>{t("simple.presetLabel")}</label>
                <div className="simple-preset-buttons">
                  {SIMPLE_PRESETS.map((p) => (
                    <button
                      key={p.presetId}
                      type="button"
                      className={`btn simple-preset-button${loraPresetId === p.presetId && region === "EU_868" ? " active" : ""}`}
                      onClick={() => handleSimplePresetSelect(p.presetId)}
                    >
                      <span className="simple-preset-label">{t(p.labelKey)}</span>
                      <span className="simple-preset-hint">{t(p.hintKey)}</span>
                    </button>
                  ))}
                </div>
                <span className="hint">
                  {t("simple.hintPrefix")}{" "}
                  <a href={PRESET_MAP_URL} target="_blank" rel="noopener noreferrer">
                    {t("simple.hintLink")}
                  </a>
                  .
                </span>
              </div>
              {nodeTypeSelector}
            </>
          ) : (
            <>
          <div className="tabs" role="tablist">
            {ADVANCED_TABS.map((tab) => (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={advancedTab === tab.id}
                className={`tab-button${advancedTab === tab.id ? " active" : ""}`}
                onClick={() => setAdvancedTab(tab.id)}
              >
                {t(tab.labelKey)}
              </button>
            ))}
          </div>

          {advancedTab === "lora" && (
            <>
              <div className="field">
                <label htmlFor="lora-region">{t("advanced.region.label")}</label>
                <select
                  id="lora-region"
                  value={region}
                  onChange={(e) => handleRegionChange(e.target.value as LoRaRegion)}
                >
                  <option value="EU_868">{t("advanced.region.868")}</option>
                  <option value="LORA_24">{t("advanced.region.24")}</option>
                </select>
                <span className="hint">
                  {region === "LORA_24" ? t("advanced.region.hint24") : t("advanced.region.hint868")}
                </span>
              </div>

              <div className="field">
                <label htmlFor="lora-preset">{t("advanced.loraPreset.label")}</label>
                <select id="lora-preset" value={loraPresetId} onChange={(e) => setLoraPresetId(e.target.value)}>
                  {loraPresets.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </select>
                <span className="hint">{loraPresets.find((p) => p.id === loraPresetId)?.description}</span>
              </div>
            </>
          )}

          {advancedTab === "channels" && (
            <>
              <div className="field">
                <label htmlFor="channel-name-mode">{t("advanced.channelNameMode.label")}</label>
                <select
                  id="channel-name-mode"
                  value={channelNameMode}
                  onChange={(e) => handleChannelNameModeChange(e.target.value as ChannelNameMode)}
                >
                  <option value="standard">{t("advanced.channelNameMode.standard", { name: defaultChannelName })}</option>
                  <option value="custom">{t("advanced.channelNameMode.custom")}</option>
                </select>
                {channelNameMode === "custom" ? (
                  <>
                    <input
                      value={customChannelName}
                      onChange={(e) => setCustomChannelName(e.target.value)}
                      placeholder={t("advanced.channelNameMode.customPlaceholder")}
                      maxLength={11}
                    />
                    <span className="hint warning">
                      {t("advanced.channelNameMode.customWarning", { name: defaultChannelName })}
                    </span>
                  </>
                ) : (
                  <span className="hint">{t("advanced.channelNameMode.standardHint")}</span>
                )}
              </div>

              {channelNameMode === "custom" && (
                <div className="field">
                  <label htmlFor="primary-psk">{t("advanced.primaryPsk.label")}</label>
                  <input
                    id="primary-psk"
                    value={primaryPskText}
                    onChange={(e) => setPrimaryPskText(e.target.value)}
                    placeholder={t("advanced.primaryPsk.placeholder")}
                  />
                  {primaryPskInvalid ? (
                    <span className="hint warning">{t("advanced.primaryPsk.invalid")}</span>
                  ) : (
                    <span className="hint">{t("advanced.primaryPsk.hint")}</span>
                  )}
                </div>
              )}

              {additionalChannelsResolved.map((c, i) => (
                <div className="field channel-card" key={c.id}>
                  <label htmlFor={`additional-channel-${c.id}`}>{t("secondary.label", { n: i + 2 })}</label>
                  <select
                    id={`additional-channel-${c.id}`}
                    value={c.selection}
                    onChange={(e) => handleAdditionalChannelSelectionChange(c.id, e.target.value)}
                  >
                    <option value="custom">{t("secondary.custom")}</option>
                    {PROVINCE_CHANNELS.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                  {c.selection === "custom" && (
                    <input
                      value={c.name}
                      onChange={(e) => handleAdditionalChannelNameChange(c.id, e.target.value)}
                      placeholder={t("secondary.namePlaceholder")}
                      maxLength={11}
                    />
                  )}
                  <input
                    value={c.pskText}
                    onChange={(e) => handleAdditionalChannelPskChange(c.id, e.target.value)}
                    placeholder={c.selection === "custom" ? t("secondary.pskPlaceholderCustom") : t("secondary.pskPlaceholderProvince")}
                  />
                  {c.pskBytes === null ? (
                    <span className="hint warning">{t("secondary.pskInvalid")}</span>
                  ) : (
                    <span className="hint">{c.selection === "custom" ? t("secondary.hintCustom") : t("secondary.hintProvince")}</span>
                  )}
                  <button type="button" className="link-button" onClick={() => handleRemoveAdditionalChannel(c.id)}>
                    {t("secondary.remove")}
                  </button>
                </div>
              ))}

              {additionalChannels.length < MAX_ADDITIONAL_CHANNELS && (
                <div className="field">
                  <button type="button" className="btn" onClick={handleAddAdditionalChannel}>
                    {t("secondary.add")}
                  </button>
                </div>
              )}
            </>
          )}

          {advancedTab === "node" && (
            <>
              {nodeTypeSelector}
              {!moreConfigValues ? (
                <p className="hint">{t("moreConfig.disabledTooltip")}</p>
              ) : (
                <>
                  <h4 className="modal-section-title">{t("moreConfig.section.role")}</h4>
                  <div className="field">
                    <label htmlFor="more-config-role">{t("moreConfig.role.label")}</label>
                    <select
                      id="more-config-role"
                      value={moreConfigValues.role}
                      onChange={(e) => handleChangeMoreConfig({ role: Number(e.target.value) as MoreConfigValues["role"] })}
                    >
                      {DEVICE_ROLE_OPTIONS.map((opt) => (
                        <option key={opt.value} value={opt.value}>
                          {t(opt.labelKey)}
                        </option>
                      ))}
                    </select>
                    <span className="hint">{t("moreConfig.role.hint")}</span>
                  </div>

                  <h4 className="modal-section-title">{t("moreConfig.section.deviceExtra")}</h4>
                  <div className="field">
                    <label htmlFor="more-config-tzdef">{t("moreConfig.tzdef.label")}</label>
                    <input
                      id="more-config-tzdef"
                      value={moreConfigValues.tzdef}
                      onChange={(e) => handleChangeMoreConfig({ tzdef: e.target.value })}
                      placeholder={t("moreConfig.tzdef.placeholder")}
                    />
                    <span className="hint">{t("moreConfig.tzdef.hint")}</span>
                  </div>
                  <div className="field">
                    <label htmlFor="more-config-buzzer-mode">{t("moreConfig.buzzerMode.label")}</label>
                    <select
                      id="more-config-buzzer-mode"
                      value={moreConfigValues.buzzerMode}
                      onChange={(e) => handleChangeMoreConfig({ buzzerMode: Number(e.target.value) as MoreConfigValues["buzzerMode"] })}
                    >
                      {BUZZER_MODE_OPTIONS.map((opt) => (
                        <option key={opt.value} value={opt.value}>
                          {t(opt.labelKey)}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="field">
                    <label className="checkbox-field">
                      <input
                        type="checkbox"
                        checked={moreConfigValues.ledHeartbeatDisabled}
                        onChange={(e) => handleChangeMoreConfig({ ledHeartbeatDisabled: e.target.checked })}
                      />
                      {t("moreConfig.ledHeartbeatDisabled.label")}
                    </label>
                  </div>

                  <h4 className="modal-section-title">{t("moreConfig.section.display")}</h4>
                  <div className="field">
                    <label htmlFor="more-config-display-units">{t("moreConfig.displayUnits.label")}</label>
                    <select
                      id="more-config-display-units"
                      value={moreConfigValues.displayUnits}
                      onChange={(e) => handleChangeMoreConfig({ displayUnits: Number(e.target.value) as MoreConfigValues["displayUnits"] })}
                    >
                      {DISPLAY_UNITS_OPTIONS.map((opt) => (
                        <option key={opt.value} value={opt.value}>
                          {t(opt.labelKey)}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="field">
                    <label htmlFor="more-config-screen-on">{t("moreConfig.screenOnSecs.label")}</label>
                    <input
                      id="more-config-screen-on"
                      type="number"
                      min={0}
                      value={moreConfigNumberField(moreConfigValues.screenOnSecs)}
                      onChange={(e) => handleChangeMoreConfig({ screenOnSecs: moreConfigParseNumber(e.target.value, 0) })}
                    />
                    <span className="hint">{t("moreConfig.screenOnSecs.hint")}</span>
                  </div>
                  <div className="field">
                    <label className="checkbox-field">
                      <input
                        type="checkbox"
                        checked={moreConfigValues.flipScreen}
                        onChange={(e) => handleChangeMoreConfig({ flipScreen: e.target.checked })}
                      />
                      {t("moreConfig.flipScreen.label")}
                    </label>
                  </div>

                  <h4 className="modal-section-title">{t("moreConfig.section.power")}</h4>
                  <div className="field">
                    <label className="checkbox-field">
                      <input
                        type="checkbox"
                        checked={moreConfigValues.powerSavingEnabled}
                        onChange={(e) => handleChangeMoreConfig({ powerSavingEnabled: e.target.checked })}
                      />
                      {t("moreConfig.powerSavingEnabled.label")}
                    </label>
                    <span className="hint">{t("moreConfig.powerSavingEnabled.hint")}</span>
                  </div>
                  <div className="field">
                    <label htmlFor="more-config-battery-shutdown">{t("moreConfig.onBatteryShutdownAfterSecs.label")}</label>
                    <input
                      id="more-config-battery-shutdown"
                      type="number"
                      min={0}
                      value={moreConfigNumberField(moreConfigValues.onBatteryShutdownAfterSecs)}
                      onChange={(e) => handleChangeMoreConfig({ onBatteryShutdownAfterSecs: moreConfigParseNumber(e.target.value, 0) })}
                    />
                    <span className="hint">{t("moreConfig.onBatteryShutdownAfterSecs.hint")}</span>
                  </div>
                </>
              )}
            </>
          )}

          {advancedTab === "position" && (
            <>
              {!moreConfigValues ? (
                <p className="hint">{t("moreConfig.disabledTooltip")}</p>
              ) : (
                <>
                  <h4 className="modal-section-title">{t("moreConfig.section.lora")}</h4>
                  <div className="field">
                    <label htmlFor="more-config-tx-power">{t("moreConfig.txPower.label")}</label>
                    <input
                      id="more-config-tx-power"
                      type="number"
                      value={moreConfigNumberField(moreConfigValues.txPower)}
                      onChange={(e) => handleChangeMoreConfig({ txPower: moreConfigParseNumber(e.target.value, 0) })}
                    />
                    <span className="hint">{t("moreConfig.txPower.hint")}</span>
                  </div>
                  <div className="field">
                    <label htmlFor="more-config-hop-limit">{t("moreConfig.hopLimit.label")}</label>
                    <input
                      id="more-config-hop-limit"
                      type="number"
                      min={0}
                      max={7}
                      value={moreConfigNumberField(moreConfigValues.hopLimit)}
                      onChange={(e) => handleChangeMoreConfig({ hopLimit: moreConfigParseNumber(e.target.value, 3) })}
                    />
                    <span className="hint">{t("moreConfig.hopLimit.hint")}</span>
                  </div>

                  <h4 className="modal-section-title">{t("moreConfig.section.position")}</h4>
                  <div className="field">
                    <label htmlFor="more-config-gps-mode">{t("moreConfig.gpsMode.label")}</label>
                    <select
                      id="more-config-gps-mode"
                      value={moreConfigValues.gpsMode}
                      onChange={(e) => handleChangeMoreConfig({ gpsMode: Number(e.target.value) as MoreConfigValues["gpsMode"] })}
                    >
                      {GPS_MODE_OPTIONS.map((opt) => (
                        <option key={opt.value} value={opt.value}>
                          {t(opt.labelKey)}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="field">
                    <label htmlFor="more-config-position-interval">{t("moreConfig.positionBroadcastSecs.label")}</label>
                    <input
                      id="more-config-position-interval"
                      type="number"
                      min={0}
                      value={moreConfigNumberField(moreConfigValues.positionBroadcastSecs)}
                      onChange={(e) => handleChangeMoreConfig({ positionBroadcastSecs: moreConfigParseNumber(e.target.value, 900) })}
                    />
                    <span className="hint">{t("moreConfig.positionBroadcastSecs.hint")}</span>
                  </div>
                  <div className="field">
                    <label className="checkbox-field">
                      <input
                        type="checkbox"
                        checked={moreConfigValues.fixedPosition}
                        onChange={(e) => handleChangeMoreConfig({ fixedPosition: e.target.checked })}
                      />
                      {t("moreConfig.fixedPosition.label")}
                    </label>
                    <span className="hint">{t("moreConfig.fixedPosition.hint")}</span>
                  </div>
                  {moreConfigValues.fixedPosition && (
                    <div className="field">
                      <label htmlFor="more-config-fixed-lat">{t("moreConfig.fixedCoords.label")}</label>
                      <div className="coords-row">
                        <input
                          id="more-config-fixed-lat"
                          type="number"
                          step="any"
                          placeholder={t("moreConfig.fixedLat.placeholder")}
                          value={moreConfigValues.fixedLat ?? ""}
                          onChange={(e) => handleChangeMoreConfig({ fixedLat: e.target.value === "" ? null : Number(e.target.value) })}
                        />
                        <input
                          id="more-config-fixed-lon"
                          type="number"
                          step="any"
                          placeholder={t("moreConfig.fixedLon.placeholder")}
                          value={moreConfigValues.fixedLon ?? ""}
                          onChange={(e) => handleChangeMoreConfig({ fixedLon: e.target.value === "" ? null : Number(e.target.value) })}
                        />
                        <button type="button" className="btn" onClick={() => setMapPickerOpen(true)}>
                          {t("moreConfig.mapButton")}
                        </button>
                      </div>
                      <span className="hint">{t("moreConfig.fixedCoords.hint")}</span>
                    </div>
                  )}

                  {mapPickerOpen && (
                    <MapPickerModal
                      lat={moreConfigValues.fixedLat}
                      lon={moreConfigValues.fixedLon}
                      onConfirm={(lat, lon) => {
                        handleChangeMoreConfig({ fixedLat: lat, fixedLon: lon });
                        setMapPickerOpen(false);
                      }}
                      onCancel={() => setMapPickerOpen(false)}
                    />
                  )}
                </>
              )}
            </>
          )}

          {advancedTab === "connectivity" && (
            <>
              {!moreConfigValues ? (
                <p className="hint">{t("moreConfig.disabledTooltip")}</p>
              ) : (
                <>
                  <h4 className="modal-section-title">{t("moreConfig.section.mqtt")}</h4>
                  <div className="field">
                    <label className="checkbox-field">
                      <input
                        type="checkbox"
                        checked={moreConfigValues.mqttEnabled}
                        onChange={(e) => handleChangeMoreConfig({ mqttEnabled: e.target.checked })}
                      />
                      {t("moreConfig.mqttEnabled.label")}
                    </label>
                  </div>
                  <div className="field">
                    <label htmlFor="more-config-mqtt-address">{t("moreConfig.mqttAddress.label")}</label>
                    <input
                      id="more-config-mqtt-address"
                      value={moreConfigValues.mqttAddress}
                      onChange={(e) => handleChangeMoreConfig({ mqttAddress: e.target.value })}
                      placeholder={t("moreConfig.mqttAddress.placeholder")}
                    />
                    <span className="hint">{t("moreConfig.mqttAddress.hint")}</span>
                  </div>
                  <div className="field">
                    <label htmlFor="more-config-mqtt-username">{t("moreConfig.mqttUsername.label")}</label>
                    <input
                      id="more-config-mqtt-username"
                      value={moreConfigValues.mqttUsername}
                      onChange={(e) => handleChangeMoreConfig({ mqttUsername: e.target.value })}
                    />
                  </div>
                  <div className="field">
                    <label htmlFor="more-config-mqtt-password">{t("moreConfig.mqttPassword.label")}</label>
                    <input
                      id="more-config-mqtt-password"
                      type="password"
                      value={moreConfigValues.mqttPassword}
                      onChange={(e) => handleChangeMoreConfig({ mqttPassword: e.target.value })}
                    />
                  </div>
                  <div className="field">
                    <label className="checkbox-field">
                      <input
                        type="checkbox"
                        checked={moreConfigValues.mqttEncryptionEnabled}
                        onChange={(e) => handleChangeMoreConfig({ mqttEncryptionEnabled: e.target.checked })}
                      />
                      {t("moreConfig.mqttEncryptionEnabled.label")}
                    </label>
                  </div>
                  <div className="field">
                    <label className="checkbox-field">
                      <input
                        type="checkbox"
                        checked={moreConfigValues.mqttTlsEnabled}
                        onChange={(e) => handleChangeMoreConfig({ mqttTlsEnabled: e.target.checked })}
                      />
                      {t("moreConfig.mqttTlsEnabled.label")}
                    </label>
                  </div>
                  <div className="field">
                    <label htmlFor="more-config-mqtt-root">{t("moreConfig.mqttRoot.label")}</label>
                    <input
                      id="more-config-mqtt-root"
                      value={moreConfigValues.mqttRoot}
                      onChange={(e) => handleChangeMoreConfig({ mqttRoot: e.target.value })}
                      placeholder={t("moreConfig.mqttRoot.placeholder")}
                    />
                  </div>

                  <h4 className="modal-section-title">{t("moreConfig.section.bluetooth")}</h4>
                  <div className="field">
                    <label className="checkbox-field">
                      <input
                        type="checkbox"
                        checked={moreConfigValues.bluetoothEnabled}
                        onChange={(e) => handleChangeMoreConfig({ bluetoothEnabled: e.target.checked })}
                      />
                      {t("moreConfig.bluetoothEnabled.label")}
                    </label>
                  </div>
                  <div className="field">
                    <label htmlFor="more-config-bluetooth-mode">{t("moreConfig.bluetoothMode.label")}</label>
                    <select
                      id="more-config-bluetooth-mode"
                      value={moreConfigValues.bluetoothMode}
                      onChange={(e) => handleChangeMoreConfig({ bluetoothMode: Number(e.target.value) as MoreConfigValues["bluetoothMode"] })}
                    >
                      {BLUETOOTH_PAIRING_MODE_OPTIONS.map((opt) => (
                        <option key={opt.value} value={opt.value}>
                          {t(opt.labelKey)}
                        </option>
                      ))}
                    </select>
                  </div>
                  {moreConfigValues.bluetoothMode === BluetoothPairingModeValue.FIXED_PIN && (
                    <div className="field">
                      <label htmlFor="more-config-bluetooth-pin">{t("moreConfig.bluetoothFixedPin.label")}</label>
                      <input
                        id="more-config-bluetooth-pin"
                        type="number"
                        min={0}
                        max={999999}
                        value={moreConfigNumberField(moreConfigValues.bluetoothFixedPin)}
                        onChange={(e) => handleChangeMoreConfig({ bluetoothFixedPin: moreConfigParseNumber(e.target.value, 123456) })}
                      />
                    </div>
                  )}

                  <h4 className="modal-section-title">{t("moreConfig.section.network")}</h4>
                  <div className="field">
                    <label className="checkbox-field">
                      <input
                        type="checkbox"
                        checked={moreConfigValues.networkWifiEnabled}
                        onChange={(e) => handleChangeMoreConfig({ networkWifiEnabled: e.target.checked })}
                      />
                      {t("moreConfig.networkWifiEnabled.label")}
                    </label>
                  </div>
                  <div className="field">
                    <label htmlFor="more-config-wifi-ssid">{t("moreConfig.networkWifiSsid.label")}</label>
                    <input
                      id="more-config-wifi-ssid"
                      value={moreConfigValues.networkWifiSsid}
                      onChange={(e) => handleChangeMoreConfig({ networkWifiSsid: e.target.value })}
                    />
                  </div>
                  <div className="field">
                    <label htmlFor="more-config-wifi-psk">{t("moreConfig.networkWifiPsk.label")}</label>
                    <input
                      id="more-config-wifi-psk"
                      type="password"
                      value={moreConfigValues.networkWifiPsk}
                      onChange={(e) => handleChangeMoreConfig({ networkWifiPsk: e.target.value })}
                    />
                  </div>
                  <div className="field">
                    <label className="checkbox-field">
                      <input
                        type="checkbox"
                        checked={moreConfigValues.networkEthEnabled}
                        onChange={(e) => handleChangeMoreConfig({ networkEthEnabled: e.target.checked })}
                      />
                      {t("moreConfig.networkEthEnabled.label")}
                    </label>
                  </div>

                  <h4 className="modal-section-title">{t("moreConfig.section.serial")}</h4>
                  <div className="field">
                    <label className="checkbox-field">
                      <input
                        type="checkbox"
                        checked={moreConfigValues.serialEnabled}
                        onChange={(e) => handleChangeMoreConfig({ serialEnabled: e.target.checked })}
                      />
                      {t("moreConfig.serialEnabled.label")}
                    </label>
                  </div>
                </>
              )}
            </>
          )}

          {advancedTab === "telemetry" && (
            <>
              <div className="field">
                <label htmlFor="telemetry-preset">{t("telemetry.label")}</label>
                <select
                  id="telemetry-preset"
                  value={telemetryPresetId}
                  onChange={(e) => setTelemetryPresetId(e.target.value)}
                >
                  {TELEMETRY_PRESETS.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </select>
                <span className="hint">
                  {TELEMETRY_PRESETS.find((p) => p.id === telemetryPresetId)?.description}{" "}
                  <a href="https://meshtastic.es/docs/buenas-practicas" target="_blank" rel="noopener noreferrer">
                    {t("telemetry.hintLink")}
                  </a>
                  .
                </span>
              </div>

              {!moreConfigValues ? (
                <p className="hint">{t("moreConfig.disabledTooltip")}</p>
              ) : (
                <>
                  <h4 className="modal-section-title">{t("moreConfig.section.telemetryDevice")}</h4>
                  <IntervalHoursField
                    id="more-config-telemetry-device-interval"
                    label={t("moreConfig.telemetryDeviceUpdateInterval.label")}
                    value={moreConfigValues.telemetryDeviceUpdateInterval}
                    onChange={(seconds) => handleChangeMoreConfig({ telemetryDeviceUpdateInterval: seconds })}
                  />

                  <h4 className="modal-section-title">{t("moreConfig.section.telemetryEnvironment")}</h4>
                  <div className="field">
                    <label className="checkbox-field">
                      <input
                        type="checkbox"
                        checked={moreConfigValues.telemetryEnvironmentMeasurementEnabled}
                        onChange={(e) => handleChangeMoreConfig({ telemetryEnvironmentMeasurementEnabled: e.target.checked })}
                      />
                      {t("moreConfig.telemetryEnvironmentMeasurementEnabled.label")}
                    </label>
                  </div>
                  <IntervalHoursField
                    id="more-config-telemetry-environment-interval"
                    label={t("moreConfig.telemetryEnvironmentUpdateInterval.label")}
                    value={moreConfigValues.telemetryEnvironmentUpdateInterval}
                    onChange={(seconds) => handleChangeMoreConfig({ telemetryEnvironmentUpdateInterval: seconds })}
                  />
                  <div className="field">
                    <label className="checkbox-field">
                      <input
                        type="checkbox"
                        checked={moreConfigValues.telemetryEnvironmentScreenEnabled}
                        onChange={(e) => handleChangeMoreConfig({ telemetryEnvironmentScreenEnabled: e.target.checked })}
                      />
                      {t("moreConfig.telemetryEnvironmentScreenEnabled.label")}
                    </label>
                  </div>
                  <div className="field">
                    <label className="checkbox-field">
                      <input
                        type="checkbox"
                        checked={moreConfigValues.telemetryEnvironmentDisplayFahrenheit}
                        onChange={(e) => handleChangeMoreConfig({ telemetryEnvironmentDisplayFahrenheit: e.target.checked })}
                      />
                      {t("moreConfig.telemetryEnvironmentDisplayFahrenheit.label")}
                    </label>
                  </div>

                  <h4 className="modal-section-title">{t("moreConfig.section.telemetryAirQuality")}</h4>
                  <div className="field">
                    <label className="checkbox-field">
                      <input
                        type="checkbox"
                        checked={moreConfigValues.telemetryAirQualityEnabled}
                        onChange={(e) => handleChangeMoreConfig({ telemetryAirQualityEnabled: e.target.checked })}
                      />
                      {t("moreConfig.telemetryAirQualityEnabled.label")}
                    </label>
                  </div>
                  <IntervalHoursField
                    id="more-config-telemetry-air-quality-interval"
                    label={t("moreConfig.telemetryAirQualityInterval.label")}
                    value={moreConfigValues.telemetryAirQualityInterval}
                    onChange={(seconds) => handleChangeMoreConfig({ telemetryAirQualityInterval: seconds })}
                  />

                  <h4 className="modal-section-title">{t("moreConfig.section.telemetryPower")}</h4>
                  <div className="field">
                    <label className="checkbox-field">
                      <input
                        type="checkbox"
                        checked={moreConfigValues.telemetryPowerMeasurementEnabled}
                        onChange={(e) => handleChangeMoreConfig({ telemetryPowerMeasurementEnabled: e.target.checked })}
                      />
                      {t("moreConfig.telemetryPowerMeasurementEnabled.label")}
                    </label>
                  </div>
                  <IntervalHoursField
                    id="more-config-telemetry-power-interval"
                    label={t("moreConfig.telemetryPowerUpdateInterval.label")}
                    value={moreConfigValues.telemetryPowerUpdateInterval}
                    onChange={(seconds) => handleChangeMoreConfig({ telemetryPowerUpdateInterval: seconds })}
                  />
                  <div className="field">
                    <label className="checkbox-field">
                      <input
                        type="checkbox"
                        checked={moreConfigValues.telemetryPowerScreenEnabled}
                        onChange={(e) => handleChangeMoreConfig({ telemetryPowerScreenEnabled: e.target.checked })}
                      />
                      {t("moreConfig.telemetryPowerScreenEnabled.label")}
                    </label>
                  </div>

                  <h4 className="modal-section-title">{t("moreConfig.section.telemetryHealth")}</h4>
                  <div className="field">
                    <label className="checkbox-field">
                      <input
                        type="checkbox"
                        checked={moreConfigValues.telemetryHealthMeasurementEnabled}
                        onChange={(e) => handleChangeMoreConfig({ telemetryHealthMeasurementEnabled: e.target.checked })}
                      />
                      {t("moreConfig.telemetryHealthMeasurementEnabled.label")}
                    </label>
                  </div>
                  <IntervalHoursField
                    id="more-config-telemetry-health-interval"
                    label={t("moreConfig.telemetryHealthUpdateInterval.label")}
                    value={moreConfigValues.telemetryHealthUpdateInterval}
                    onChange={(seconds) => handleChangeMoreConfig({ telemetryHealthUpdateInterval: seconds })}
                  />
                  <div className="field">
                    <label className="checkbox-field">
                      <input
                        type="checkbox"
                        checked={moreConfigValues.telemetryHealthScreenEnabled}
                        onChange={(e) => handleChangeMoreConfig({ telemetryHealthScreenEnabled: e.target.checked })}
                      />
                      {t("moreConfig.telemetryHealthScreenEnabled.label")}
                    </label>
                  </div>
                </>
              )}
            </>
          )}

            </>
          )}

          <button
            type="button"
            className="apply-button"
            disabled={
              conn.status !== "connected" ||
              applying ||
              channelName.trim() === "" ||
              primaryPskInvalid ||
              !additionalChannelsReady
            }
            onClick={handleRequestApply}
          >
            {applying ? t("apply.buttonBusy") : t("apply.button")}
          </button>
        </section>
        </div>

        {(conn.status === "connected" || conn.status === "connecting") && (
          <aside className="panel side-panel">
            <h2>{t("sidebar.title")}</h2>
            <DeviceInfoPanel snapshot={deviceSnapshot} sourceRef={getDeviceProfileSourceRef} connected={conn.status === "connected"} />

            {conn.status === "connected" && (
              <>
                <div className="connect-buttons">
                  <button type="button" className="btn" onClick={handleSaveConfig}>
                    {t("sidebar.save")}
                  </button>
                  <button type="button" className="btn" disabled={applying} onClick={handleUploadConfigClick}>
                    {t("sidebar.upload")}
                  </button>
                  <input
                    ref={importFileInputRef}
                    type="file"
                    accept="application/json,.json"
                    className="visually-hidden"
                    onChange={handleUploadConfigFile}
                  />
                </div>
                <span className="hint">{t("sidebar.hint")}</span>
              </>
            )}
          </aside>
        )}
        </div>
      </main>

      {confirmApplyOpen && conn.status === "connected" && primaryPskBytes !== null && (
        <ConfirmApplyModal
          snapshot={deviceSnapshot}
          region={region}
          lora={selectedLora}
          channelName={channelName}
          primaryPsk={primaryPskBytes}
          additionalChannels={additionalChannelsResolved.map((c) => ({ name: c.name.trim(), psk: c.pskBytes }))}
          telemetry={selectedTelemetry}
          moreConfigValues={moreConfigValues}
          moreConfigBaseline={moreConfigBaseline}
          onConfirm={handleApply}
          onCancel={handleCancelApply}
        />
      )}

      {networkModalOpen && (
        <NetworkConnectModal
          address={networkAddress}
          onAddressChange={setNetworkAddress}
          port={networkPort}
          onPortChange={setNetworkPort}
          tls={networkTls}
          onTlsChange={setNetworkTls}
          onConfirm={handleConfirmNetworkModal}
          onCancel={handleCancelNetworkModal}
        />
      )}

      {importPending && conn.status === "connected" && (
        <ImportConfirmModal sections={importPending.sections} onConfirm={handleConfirmImport} onCancel={handleCancelImport} />
      )}

      {progressModalOpen && (
        <ApplyProgressModal
          applying={applying}
          progress={progress}
          log={log.slice(applyLogStart)}
          error={applyError}
          onClose={handleCloseProgressModal}
        />
      )}

      <footer className="app-footer">
        <span>{t("footer.unofficial")}</span>
        <span>
          <a href="https://meshtastic.es" target="_blank" rel="noopener noreferrer">
            meshtastic.es
          </a>
          {" · "}
          <a href="https://mapa.meshtastic.es" target="_blank" rel="noopener noreferrer">
            {t("footer.mapa")}
          </a>
        </span>
      </footer>
    </div>
  );
}

/**
 * Panel "Configuración actual del nodo": muestra TODAS las secciones que ya conocemos del
 * nodo conectado (identidad, LoRa, canales, rol, posición/GPS —incluidas las coordenadas
 * fijas si se conocen—, energía, pantalla, bluetooth, red, seguridad, telemetría, MQTT y
 * demás módulos activos), reusando exactamente las mismas etiquetas que
 * "Revisar antes de importar" vía `describeCurrentDeviceProfile`. `snapshot` solo se usa
 * como señal de "ya ha llegado algo del handshake"; el contenido real sale de `sourceRef`
 * (el perfil crudo, que se relee en un efecto para no leer un ref durante el render).
 */
function DeviceInfoPanel({
  snapshot,
  sourceRef,
  connected,
}: {
  snapshot: DeviceSnapshot | null;
  sourceRef: React.RefObject<(() => DeviceProfileSource) | null>;
  /**
   * `sourceRef.current` no se rellena hasta que `connectSerial`/`connectBluetooth`/
   * `connectNetwork` terminan TODO el handshake, pero `snapshot` ya cambia varias veces
   * antes de eso (se llena progresivamente durante la propia conexión) — si el efecto
   * solo dependiera de `snapshot`, se quedaría con 0 secciones calculadas la primera vez
   * que corre (ref aún null) y nunca volvería a recalcular tras terminar de conectar. Este
   * flag fuerza un recálculo justo cuando `sourceRef` ya tiene función que devuelve datos.
   */
  connected: boolean;
}) {
  const { t } = useI18n();
  const [sections, setSections] = useState<ProfileSummarySection[]>([]);

  useEffect(() => {
    const getSource = sourceRef.current;
    setSections(getSource ? describeCurrentDeviceProfile(getSource(), t) : []);
    // sourceRef es un ref (identidad estable): basta con recalcular cada vez que llega un
    // snapshot nuevo o que cambia `connected` (ver comentario del prop más arriba).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot, connected, t]);

  if (!snapshot || sections.length === 0) {
    return <p className="hint">{t("deviceInfo.waiting")}</p>;
  }

  return (
    <div className="device-info">
      {sections.map((section) => (
        <div className="device-info-group" key={section.title}>
          <h3>{section.title}</h3>
          <dl>
            {section.rows.map((row) => (
              <div key={row.label}>
                <dt>{row.label}</dt>
                <dd>{row.value}</dd>
              </div>
            ))}
          </dl>
        </div>
      ))}
    </div>
  );
}

const REGION_LABEL_KEYS: Record<string, MessageKey> = { EU_868: "region.868", LORA_24: "region.24" };

function customLoraPresetLabel(lora: { bandwidth: number; spreadFactor: number; codingRate: number }): string | null {
  const match = ES_CUSTOM_PRESETS.find(
    (p) =>
      p.values.bandwidth === lora.bandwidth &&
      p.values.spreadFactor === lora.spreadFactor &&
      p.values.codingRate === lora.codingRate,
  );
  return match?.defaultChannelName ?? null;
}

function loraSummary(lora: {
  usePreset: boolean;
  modemPreset: string;
  bandwidth: number;
  spreadFactor: number;
  codingRate: number;
  overrideFrequency?: number;
}): string {
  const base = lora.usePreset
    ? lora.modemPreset
    : (customLoraPresetLabel(lora) ??
      `BW ${lora.bandwidth}kHz · SF${lora.spreadFactor} · CR4/${lora.codingRate}`);
  return lora.overrideFrequency ? `${base} · ${lora.overrideFrequency.toFixed(3)} MHz` : base;
}

interface CompareRow {
  label: string;
  before: string;
  after: string;
}

// Campos de MoreConfigValues cuya etiqueta se muestra en la pantalla de revisión de "Más
// configuración" (todos menos fixedLat/fixedLon, que se combinan en una única fila de
// coordenadas más abajo). Cada clave usa la misma i18n key que ya rotula su campo en el
// formulario ("moreConfig.<clave>.label"), así que no hace falta duplicar etiquetas.
const MORE_CONFIG_REVIEW_FIELDS: (keyof MoreConfigValues)[] = [
  "role",
  "txPower",
  "hopLimit",
  "gpsMode",
  "positionBroadcastSecs",
  "fixedPosition",
  "displayUnits",
  "screenOnSecs",
  "flipScreen",
  "mqttEnabled",
  "mqttAddress",
  "mqttUsername",
  "mqttPassword",
  "mqttEncryptionEnabled",
  "mqttTlsEnabled",
  "mqttRoot",
  "bluetoothEnabled",
  "bluetoothMode",
  "bluetoothFixedPin",
  "powerSavingEnabled",
  "onBatteryShutdownAfterSecs",
  "tzdef",
  "buzzerMode",
  "ledHeartbeatDisabled",
  "networkWifiEnabled",
  "networkWifiSsid",
  "networkWifiPsk",
  "networkEthEnabled",
  "serialEnabled",
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
];

const MORE_CONFIG_INTERVAL_FIELDS: ReadonlySet<keyof MoreConfigValues> = new Set([
  "positionBroadcastSecs",
  "screenOnSecs",
  "onBatteryShutdownAfterSecs",
  "telemetryDeviceUpdateInterval",
  "telemetryEnvironmentUpdateInterval",
  "telemetryAirQualityInterval",
  "telemetryPowerUpdateInterval",
  "telemetryHealthUpdateInterval",
]);

const MORE_CONFIG_SECRET_FIELDS: ReadonlySet<keyof MoreConfigValues> = new Set(["mqttPassword", "networkWifiPsk"]);

function moreConfigOptionLabel<V extends number>(
  options: { value: V; labelKey: MessageKey }[],
  value: V,
  t: (key: MessageKey, vars?: Record<string, string | number>) => string,
): string {
  return t(options.find((o) => o.value === value)?.labelKey ?? "confirmApply.unknownM");
}

function formatMoreConfigFieldValue(
  key: keyof MoreConfigValues,
  value: MoreConfigValues[keyof MoreConfigValues],
  t: (key: MessageKey, vars?: Record<string, string | number>) => string,
): string {
  if (key === "role") return moreConfigOptionLabel(DEVICE_ROLE_OPTIONS, value as MoreConfigValues["role"], t);
  if (key === "gpsMode") return moreConfigOptionLabel(GPS_MODE_OPTIONS, value as MoreConfigValues["gpsMode"], t);
  if (key === "displayUnits") return moreConfigOptionLabel(DISPLAY_UNITS_OPTIONS, value as MoreConfigValues["displayUnits"], t);
  if (key === "bluetoothMode")
    return moreConfigOptionLabel(BLUETOOTH_PAIRING_MODE_OPTIONS, value as MoreConfigValues["bluetoothMode"], t);
  if (key === "buzzerMode") return moreConfigOptionLabel(BUZZER_MODE_OPTIONS, value as MoreConfigValues["buzzerMode"], t);
  if (key === "txPower") return value === 0 ? t("deviceInfo.lora.powerAuto") : `${value as number} dBm`;
  if (MORE_CONFIG_INTERVAL_FIELDS.has(key)) return formatInterval(value as number, t);
  if (MORE_CONFIG_SECRET_FIELDS.has(key)) return value ? "••••••" : t("confirmApply.none");
  if (typeof value === "boolean") return value ? t("confirmApply.yes") : t("confirmApply.no");
  if (value === "") return t("confirmApply.unnamed");
  return String(value);
}

/** Filas antes/después para la revisión de "Más configuración": solo los campos que de verdad han cambiado respecto al nodo. */
function buildMoreConfigChangeRows(
  values: MoreConfigValues,
  baseline: MoreConfigValues,
  t: (key: MessageKey, vars?: Record<string, string | number>) => string,
  excludeKeys: readonly (keyof MoreConfigValues)[] = [],
): CompareRow[] {
  const rows: CompareRow[] = [];
  for (const key of MORE_CONFIG_REVIEW_FIELDS) {
    if (excludeKeys.includes(key)) continue;
    if (values[key] === baseline[key]) continue;
    rows.push({
      label: t(`moreConfig.${key}.label` as MessageKey),
      before: formatMoreConfigFieldValue(key, baseline[key], t),
      after: formatMoreConfigFieldValue(key, values[key], t),
    });
  }
  if (values.fixedLat !== baseline.fixedLat || values.fixedLon !== baseline.fixedLon) {
    const fmt = (lat: number | null, lon: number | null) =>
      lat !== null && lon !== null ? `${lat.toFixed(5)}, ${lon.toFixed(5)}` : t("confirmApply.none");
    rows.push({
      label: t("moreConfig.fixedCoords.label"),
      before: fmt(baseline.fixedLat, baseline.fixedLon),
      after: fmt(values.fixedLat, values.fixedLon),
    });
  }
  return rows;
}

function ConfirmApplyModal({
  snapshot,
  region,
  lora,
  channelName,
  primaryPsk,
  additionalChannels,
  telemetry,
  moreConfigValues,
  moreConfigBaseline,
  onConfirm,
  onCancel,
}: {
  snapshot: DeviceSnapshot | null;
  region: LoRaRegion;
  lora: LoRaPresetDef;
  channelName: string;
  primaryPsk: Uint8Array;
  additionalChannels: { name: string; psk: Uint8Array | null }[];
  telemetry: TelemetryPresetDef;
  /** Valores actuales (editados) de "Más configuración"/pestaña Avanzado, si hay conexión. */
  moreConfigValues: MoreConfigValues | null;
  /** Valores de "Más configuración" tal como estaban en el nodo al conectar. */
  moreConfigBaseline: MoreConfigValues | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const regionLabel = (code: string) => (code in REGION_LABEL_KEYS ? t(REGION_LABEL_KEYS[code]) : code);
  const primaryBefore = snapshot?.channels.find((c) => c.role === "PRIMARY");
  const additionalBefore = (snapshot?.channels ?? []).filter((c) => c.role !== "PRIMARY").sort((a, b) => a.index - b.index);
  const powerLabel = (dbm: number) => (dbm === 0 ? t("deviceInfo.lora.powerAuto") : `${dbm} dBm`);
  // Mismo criterio que aplicará applyPreset: 23 dBm predeterminados en 868 MHz, automático
  // (0 → 10 dBm de máximo firmware) en 2.4 GHz, salvo que el usuario haya tocado a mano la
  // potencia en "Más configuración" (pestaña Avanzado).
  const computedTxPower = region === "EU_868" ? 23 : 0;
  const txPowerEdited =
    moreConfigValues !== null && moreConfigBaseline !== null && moreConfigValues.txPower !== moreConfigBaseline.txPower;
  const afterTxPower = txPowerEdited ? moreConfigValues!.txPower : computedTxPower;
  const afterHopLimit = moreConfigValues?.hopLimit ?? snapshot?.lora?.hopLimit ?? 3;

  const rows: CompareRow[] = [
    {
      label: t("confirmApply.row.region"),
      before: snapshot?.lora ? regionLabel(snapshot.lora.region) : t("confirmApply.unknown"),
      after: regionLabel(region),
    },
    {
      label: t("confirmApply.row.loraPreset"),
      before: snapshot?.lora ? loraSummary(snapshot.lora) : t("confirmApply.unknownM"),
      after: lora.values.overrideFrequency ? `${lora.label} · ${lora.values.overrideFrequency.toFixed(3)} MHz` : lora.label,
    },
    {
      label: t("confirmApply.row.txPower"),
      before: snapshot?.lora ? powerLabel(snapshot.lora.txPower) : t("confirmApply.unknownM"),
      after: powerLabel(afterTxPower),
    },
    {
      label: t("confirmApply.row.hopLimit"),
      before: snapshot?.lora ? String(snapshot.lora.hopLimit) : t("confirmApply.unknownM"),
      after: String(afterHopLimit),
    },
    {
      label: t("confirmApply.row.primaryChannel"),
      before: primaryBefore ? primaryBefore.name : t("confirmApply.unknownM"),
      after: channelName.trim() || t("confirmApply.unnamed"),
    },
    {
      label: t("confirmApply.row.primaryEncryption"),
      before: primaryBefore ? (primaryBefore.encrypted ? t("confirmApply.yes") : t("confirmApply.no")) : t("confirmApply.unknownM"),
      after: primaryPsk.length > 0 ? t("confirmApply.yes") : t("confirmApply.no"),
    },
    {
      label: t("confirmApply.row.telemetryDevice"),
      before: snapshot?.telemetry ? formatInterval(snapshot.telemetry.deviceUpdateInterval, t) : t("confirmApply.unknown"),
      after: formatInterval(telemetry.values.deviceUpdateInterval, t),
    },
    {
      label: t("confirmApply.row.telemetryEnvironment"),
      before: snapshot?.telemetry
        ? snapshot.telemetry.environmentMeasurementEnabled
          ? formatInterval(snapshot.telemetry.environmentUpdateInterval, t)
          : t("deviceInfo.telemetry.disabled")
        : t("confirmApply.unknown"),
      after: telemetry.values.environmentMeasurementEnabled
        ? formatInterval(telemetry.values.environmentUpdateInterval, t)
        : t("deviceInfo.telemetry.disabled"),
    },
    {
      label: t("confirmApply.row.telemetryPower"),
      before: snapshot?.telemetry
        ? snapshot.telemetry.powerMeasurementEnabled
          ? formatInterval(snapshot.telemetry.powerUpdateInterval, t)
          : t("deviceInfo.telemetry.disabled")
        : t("confirmApply.unknown"),
      after: telemetry.values.powerMeasurementEnabled
        ? formatInterval(telemetry.values.powerUpdateInterval, t)
        : t("deviceInfo.telemetry.disabled"),
    },
    {
      label: t("confirmApply.row.telemetryAirQuality"),
      before: snapshot?.telemetry
        ? snapshot.telemetry.airQualityEnabled
          ? formatInterval(snapshot.telemetry.airQualityInterval, t)
          : t("deviceInfo.telemetry.disabled")
        : t("confirmApply.unknown"),
      after: telemetry.values.airQualityEnabled
        ? formatInterval(telemetry.values.airQualityInterval, t)
        : t("deviceInfo.telemetry.disabled"),
    },
    {
      label: t("confirmApply.row.telemetryHealth"),
      before: snapshot?.telemetry
        ? snapshot.telemetry.healthMeasurementEnabled
          ? formatInterval(snapshot.telemetry.healthUpdateInterval, t)
          : t("deviceInfo.telemetry.disabled")
        : t("confirmApply.unknown"),
      after: telemetry.values.healthMeasurementEnabled
        ? formatInterval(telemetry.values.healthUpdateInterval, t)
        : t("deviceInfo.telemetry.disabled"),
    },
  ];

  // Los canales adicionales se comparan por posición (1º adicional del nodo vs. 1º de la
  // edición, etc.), no por índice: al aplicar, applyPreset reasigna índices consecutivos
  // desde el 1, así que esta es la comparación que realmente se corresponde con lo que se
  // va a enviar.
  const maxAdditional = Math.max(additionalBefore.length, additionalChannels.length);
  for (let i = 0; i < maxAdditional; i++) {
    const before = additionalBefore[i];
    const after = additionalChannels[i];
    rows.push({
      label: t("confirmApply.row.secondaryChannel", { n: i + 2 }),
      before: before ? before.name : t("confirmApply.none"),
      after: after && after.psk !== null ? after.name.trim() || t("confirmApply.unnamed") : t("confirmApply.none"),
    });
  }

  // txPower y hopLimit ya se muestran arriba junto al resto de LoRa: se excluyen aquí para
  // no duplicar la fila con una etiqueta distinta.
  if (moreConfigValues && moreConfigBaseline) {
    rows.push(...buildMoreConfigChangeRows(moreConfigValues, moreConfigBaseline, t, ["txPower", "hopLimit"]));
  }

  const changedRows = rows.filter((row) => row.before !== row.after);

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal modal-wide">
        <h3>{t("confirmApply.title")}</h3>
        <p className="hint">{t("confirmApply.subtitle")}</p>
        {changedRows.length === 0 ? (
          <p className="hint">{t("confirmApply.noChanges")}</p>
        ) : (
        <table className="compare-table">
          <thead>
            <tr>
              <th></th>
              <th>{t("confirmApply.colBefore")}</th>
              <th>{t("confirmApply.colAfter")}</th>
            </tr>
          </thead>
          <tbody>
            {changedRows.map((row) => (
              <tr key={row.label} className="changed">
                <th>{row.label}</th>
                <td>{row.before}</td>
                <td>{row.after}</td>
              </tr>
            ))}
          </tbody>
        </table>
        )}
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onCancel}>
            {t("confirmApply.cancel")}
          </button>
          <button type="button" className="btn btn-primary" onClick={onConfirm}>
            {t("confirmApply.confirm")}
          </button>
        </div>
      </div>
    </div>
  );
}

function ApplyProgressModal({
  applying,
  progress,
  log,
  error,
  onClose,
}: {
  applying: boolean;
  progress: number | null;
  log: string[];
  error: string | null;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const title = applying
    ? t("applyProgress.titleRunning")
    : error !== null
      ? t("applyProgress.titleError")
      : t("applyProgress.titleDone");

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal modal-wide">
        <h3>{title}</h3>
        {applying && <p className="hint warning">{t("applyProgress.hintRunning")}</p>}
        {!applying && error !== null && <p className="hint warning">{error}</p>}

        {progress !== null && (
          <div className="progress-bar" role="progressbar" aria-valuenow={Math.round(progress)} aria-valuemin={0} aria-valuemax={100}>
            <div className="progress-bar-fill" style={{ width: `${Math.min(100, Math.max(0, progress))}%` }} />
            <span className="progress-bar-label">{Math.round(progress)}%</span>
          </div>
        )}

        {log.length > 0 && (
          <div className="log modal-scroll">
            {log.map((line, i) => (
              <div key={i}>{line}</div>
            ))}
          </div>
        )}

        <div className="modal-actions">
          <button type="button" className="btn btn-primary" disabled={applying} onClick={onClose}>
            {t("applyProgress.close")}
          </button>
        </div>
      </div>
    </div>
  );
}

function ImportConfirmModal({
  sections,
  onConfirm,
  onCancel,
}: {
  sections: ProfileSummarySection[];
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal modal-wide">
        <h3>{t("importConfirm.title")}</h3>
        <p className="hint warning">{t("importConfirm.warning")}</p>
        <div className="device-info modal-scroll">
          {sections.length === 0 ? (
            <p className="hint">{t("importConfirm.empty")}</p>
          ) : (
            sections.map((section) => (
              <div className="device-info-group" key={section.title}>
                <h3>{section.title}</h3>
                <dl>
                  {section.rows.map((row) => (
                    <div key={row.label}>
                      <dt>{row.label}</dt>
                      <dd>{row.value}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            ))
          )}
        </div>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onCancel}>
            {t("confirmApply.cancel")}
          </button>
          <button type="button" className="btn btn-primary" onClick={onConfirm}>
            {t("confirmApply.confirm")}
          </button>
        </div>
      </div>
    </div>
  );
}

function NetworkConnectModal({
  address,
  onAddressChange,
  port,
  onPortChange,
  tls,
  onTlsChange,
  onConfirm,
  onCancel,
}: {
  address: string;
  onAddressChange: (value: string) => void;
  port: string;
  onPortChange: (value: string) => void;
  tls: boolean;
  onTlsChange: (value: boolean) => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const handleEnter = (e: { key: string }) => {
    if (e.key === "Enter" && address.trim() !== "") onConfirm();
  };
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal">
        <h3>{t("networkModal.title")}</h3>
        <div className="field network-connect-row">
          <div className="network-address-field">
            <label htmlFor="network-address">{t("networkModal.address.label")}</label>
            <input
              id="network-address"
              autoFocus
              value={address}
              onChange={(e) => onAddressChange(e.target.value)}
              placeholder={t("networkModal.address.placeholder")}
              onKeyDown={handleEnter}
            />
          </div>
          <div className="network-port-field">
            <label htmlFor="network-port">{t("networkModal.port.label")}</label>
            <input
              id="network-port"
              value={port}
              onChange={(e) => onPortChange(e.target.value.replace(/[^0-9]/g, ""))}
              placeholder="4403"
              inputMode="numeric"
              onKeyDown={handleEnter}
            />
          </div>
        </div>
        <span className="hint">{t("networkModal.hint")}</span>
        <span className="hint">{t("networkModal.httpOnlyNote")}</span>
        <div className="field">
          <label className="network-tls-check">
            <input type="checkbox" checked={tls} onChange={(e) => onTlsChange(e.target.checked)} />
            {t("networkModal.tls.label")}
          </label>
          <span className="hint">{t("networkModal.tls.hint")}</span>
        </div>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onCancel}>
            {t("confirmApply.cancel")}
          </button>
          <button type="button" className="btn btn-primary" disabled={address.trim() === ""} onClick={onConfirm}>
            {t("networkModal.connect")}
          </button>
        </div>
      </div>
    </div>
  );
}

function MeshNodeIcon() {
  return (
    <svg viewBox="0 0 28 28" fill="none" aria-hidden="true">
      <circle cx="14" cy="14" r="3" fill="currentColor" />
      <circle cx="6" cy="6" r="2" fill="currentColor" opacity=".6" />
      <circle cx="22" cy="6" r="2" fill="currentColor" opacity=".6" />
      <circle cx="6" cy="22" r="2" fill="currentColor" opacity=".4" />
      <circle cx="22" cy="22" r="2" fill="currentColor" opacity=".4" />
      <line x1="14" y1="14" x2="6" y2="6" stroke="currentColor" strokeWidth="1" opacity=".5" />
      <line x1="14" y1="14" x2="22" y2="6" stroke="currentColor" strokeWidth="1" opacity=".5" />
      <line x1="14" y1="14" x2="6" y2="22" stroke="currentColor" strokeWidth="1" opacity=".3" />
      <line x1="14" y1="14" x2="22" y2="22" stroke="currentColor" strokeWidth="1" opacity=".3" />
    </svg>
  );
}

export default App;
