import { useRef, useState, type ChangeEvent } from "react";
import type { MeshDevice } from "@meshtastic/core";
import "./App.css";
import {
  applyDeviceProfile,
  applyPreset,
  connectBluetooth,
  connectNetwork,
  connectSerial,
  decodeCustomPsk,
  defaultSimplePsk,
  describeDeviceProfile,
  downloadTextFile,
  encodePskBase64,
  exportDeviceProfileJson,
  formatInterval,
  isWebBluetoothSupported,
  isWebSerialSupported,
  parseDeviceProfileJson,
  translateError,
  type ChannelPreset,
  type DeviceProfile,
  type DeviceProfileSource,
  type DeviceSnapshot,
  type ProfileSummarySection,
} from "./lib/meshtastic";
import {
  getDefaultChannelName,
  getPresetsForRegion,
  LORA_REGION_CODES,
  type LoRaPresetDef,
  type LoRaRegion,
} from "./presets/loraPresets";
import { PROVINCE_CHANNELS } from "./presets/provinceChannels";
import { TELEMETRY_PRESETS, type TelemetryPresetDef } from "./presets/telemetryPresets";
import { useI18n } from "./i18n";
import type { MessageKey } from "./i18n/locales/es";
import { LanguageSwitcher } from "./components/LanguageSwitcher";

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
  const [channelNameMode, setChannelNameMode] = useState<ChannelNameMode>("standard");
  const [customChannelName, setCustomChannelName] = useState("");
  const channelName = channelNameMode === "custom" ? customChannelName.trim() : defaultChannelName;
  const [primaryPskText, setPrimaryPskText] = useState(encodePskBase64(defaultSimplePsk));
  const primaryPskBytes = channelNameMode === "standard" ? defaultSimplePsk : decodeCustomPsk(primaryPskText);
  const primaryPskInvalid = channelNameMode === "custom" && primaryPskBytes === null;

  const [secondaryVisible, setSecondaryVisible] = useState(false);
  const [secondarySelection, setSecondarySelection] = useState<SecondarySelection>("custom");
  const [secondaryChannelName, setSecondaryChannelName] = useState("");
  const [secondaryPskText, setSecondaryPskText] = useState("");
  const secondaryPskBytes = secondaryVisible ? decodeCustomPsk(secondaryPskText) : null;
  const secondaryPskInvalid = secondaryVisible && secondaryPskBytes === null;

  const [confirmApplyOpen, setConfirmApplyOpen] = useState(false);

  const [log, setLog] = useState<string[]>([]);
  const [progress, setProgress] = useState<number | null>(null);
  const [applying, setApplying] = useState(false);
  const [deviceSnapshot, setDeviceSnapshot] = useState<DeviceSnapshot | null>(null);
  const stopSnapshotTrackingRef = useRef<(() => void) | null>(null);
  const getDeviceProfileSourceRef = useRef<(() => DeviceProfileSource) | null>(null);
  const connectingDeviceRef = useRef<MeshDevice | null>(null);
  const connectSeqRef = useRef(0);
  const importFileInputRef = useRef<HTMLInputElement | null>(null);
  const [importPending, setImportPending] = useState<{ profile: DeviceProfile; sections: ProfileSummarySection[] } | null>(null);

  const serialSupported = isWebSerialSupported();
  const bluetoothSupported = isWebBluetoothSupported();
  const [networkAddress, setNetworkAddress] = useState("");
  const [networkPort, setNetworkPort] = useState("4403");
  const [networkTls, setNetworkTls] = useState(false);
  const [networkModalOpen, setNetworkModalOpen] = useState(false);
  const networkHostPort = networkPort.trim() ? `${networkAddress.trim()}:${networkPort.trim()}` : networkAddress.trim();

  function appendLog(line: string, opts?: { replace?: boolean; percent?: number }) {
    setLog((prev) => (opts?.replace && prev.length > 0 ? [...prev.slice(0, -1), line] : [...prev, line]));
    if (opts?.percent !== undefined) setProgress(opts.percent);
  }

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
      const { device, stopSnapshotTracking, getDeviceProfileSource } =
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
    if (conn.status === "connected") {
      await conn.device.disconnect();
    } else if (connectingDeviceRef.current) {
      await connectingDeviceRef.current.disconnect().catch(() => {});
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

  function handleSimplePresetSelect(presetId: string) {
    setRegion("EU_868");
    setLoraPresetId(presetId);
    setTelemetryPresetId(TELEMETRY_PRESETS[0].id);
  }

  function handleAddSecondaryChannel() {
    setSecondaryVisible(true);
    setSecondarySelection("custom");
    setSecondaryChannelName("");
    setSecondaryPskText("");
  }

  function handleRemoveSecondaryChannel() {
    setSecondaryVisible(false);
    setSecondarySelection("custom");
    setSecondaryChannelName("");
    setSecondaryPskText("");
  }

  function handleSecondarySelectionChange(next: SecondarySelection) {
    setSecondarySelection(next);
    if (next === "custom") {
      setSecondaryChannelName("");
      setSecondaryPskText("");
      return;
    }
    const province = PROVINCE_CHANNELS.find((p) => p.id === next);
    if (!province) return;
    setSecondaryChannelName(province.channelName);
    setSecondaryPskText(encodePskBase64(province.psk));
  }

  const secondaryChannelReady =
    !secondaryVisible || (!secondaryPskInvalid && (secondarySelection !== "custom" || secondaryChannelName.trim() !== ""));

  function handleRequestApply() {
    if (conn.status !== "connected" || primaryPskInvalid || !secondaryChannelReady) return;
    setConfirmApplyOpen(true);
  }

  function handleCancelApply() {
    setConfirmApplyOpen(false);
  }

  async function handleApply() {
    setConfirmApplyOpen(false);
    if (conn.status !== "connected") return;
    const lora = loraPresets.find((p) => p.id === loraPresetId);
    const telemetry = TELEMETRY_PRESETS.find((p) => p.id === telemetryPresetId);
    if (!lora || !telemetry || !secondaryChannelReady || primaryPskBytes === null) return;

    const channel: ChannelPreset = { name: channelName.trim(), psk: primaryPskBytes };
    const secondaryChannel: ChannelPreset | undefined =
      secondaryVisible && secondaryPskBytes !== null
        ? { name: secondaryChannelName.trim(), psk: secondaryPskBytes }
        : undefined;

    setApplying(true);
    setProgress(0);
    try {
      await applyPreset(conn.device, t, {
        lora,
        channel,
        secondaryChannel,
        telemetry,
        region: LORA_REGION_CODES[region],
        onProgress: appendLog,
      });
    } catch (err) {
      appendLog(t("applyLog.error", { message: translateError(err, t) }));
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
    setApplying(true);
    setProgress(0);
    try {
      await applyDeviceProfile(conn.device, profile, t, appendLog);
    } catch (err) {
      appendLog(t("applyLog.error", { message: translateError(err, t) }));
    } finally {
      setApplying(false);
    }
  }

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

          {(conn.status === "connecting" || applying) && progress !== null && (
            <div className="progress-bar" role="progressbar" aria-valuenow={Math.round(progress)} aria-valuemin={0} aria-valuemax={100}>
              <div className="progress-bar-fill" style={{ width: `${Math.min(100, Math.max(0, progress))}%` }} />
              <span className="progress-bar-label">{Math.round(progress)}%</span>
            </div>
          )}

          {log.length > 0 && <div className="log">{log.join("\n")}</div>}
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
          ) : (
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

          <div className="field">
            {!secondaryVisible ? (
              <button type="button" className="btn" onClick={handleAddSecondaryChannel}>
                {t("secondary.add")}
              </button>
            ) : (
              <>
                <label htmlFor="secondary-channel">{t("secondary.label")}</label>
                <select
                  id="secondary-channel"
                  value={secondarySelection}
                  onChange={(e) => handleSecondarySelectionChange(e.target.value)}
                >
                  <option value="custom">{t("secondary.custom")}</option>
                  {PROVINCE_CHANNELS.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </select>
                {secondarySelection === "custom" && (
                  <input
                    value={secondaryChannelName}
                    onChange={(e) => setSecondaryChannelName(e.target.value)}
                    placeholder={t("secondary.namePlaceholder")}
                    maxLength={11}
                  />
                )}
                <input
                  value={secondaryPskText}
                  onChange={(e) => setSecondaryPskText(e.target.value)}
                  placeholder={secondarySelection === "custom" ? t("secondary.pskPlaceholderCustom") : t("secondary.pskPlaceholderProvince")}
                />
                {secondaryPskInvalid ? (
                  <span className="hint warning">{t("secondary.pskInvalid")}</span>
                ) : (
                  <span className="hint">
                    {secondarySelection === "custom" ? t("secondary.hintCustom") : t("secondary.hintProvince")}
                  </span>
                )}
                <button type="button" className="link-button" onClick={handleRemoveSecondaryChannel}>
                  {t("secondary.remove")}
                </button>
              </>
            )}
          </div>

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

          <div className="field">
            <button type="button" className="btn" disabled title={t("moreConfig.tooltip")}>
              {t("moreConfig.button")}
            </button>
          </div>
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
              !secondaryChannelReady
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
            <DeviceInfoPanel snapshot={deviceSnapshot} />

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
          secondaryVisible={secondaryVisible}
          secondaryChannelName={secondaryChannelName}
          secondaryPsk={secondaryPskBytes}
          telemetry={selectedTelemetry}
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

const ROLE_LABEL_KEYS: Record<string, MessageKey> = { PRIMARY: "deviceInfo.channels.role.primary", SECONDARY: "deviceInfo.channels.role.secondary" };

function DeviceInfoPanel({ snapshot }: { snapshot: DeviceSnapshot | null }) {
  const { t } = useI18n();
  if (!snapshot || (!snapshot.longName && !snapshot.lora && snapshot.channels.length === 0 && !snapshot.telemetry)) {
    return <p className="hint">{t("deviceInfo.waiting")}</p>;
  }

  return (
    <div className="device-info">
      {(snapshot.longName || snapshot.shortName) && (
        <div className="device-info-group">
          <h3>{t("deviceInfo.identity.title")}</h3>
          <dl>
            {snapshot.longName && (
              <div>
                <dt>{t("deviceInfo.identity.name")}</dt>
                <dd>
                  {snapshot.longName} {snapshot.shortName && `(${snapshot.shortName})`}
                </dd>
              </div>
            )}
            {snapshot.hwModel && (
              <div>
                <dt>{t("deviceInfo.identity.hardware")}</dt>
                <dd>{snapshot.hwModel}</dd>
              </div>
            )}
            {snapshot.nodeNum !== null && (
              <div>
                <dt>{t("deviceInfo.identity.nodeNum")}</dt>
                <dd>{snapshot.nodeNum}</dd>
              </div>
            )}
          </dl>
        </div>
      )}

      {snapshot.lora && (
        <div className="device-info-group">
          <h3>{t("deviceInfo.lora.title")}</h3>
          <dl>
            <div>
              <dt>{t("deviceInfo.lora.region")}</dt>
              <dd>{snapshot.lora.region}</dd>
            </div>
            <div>
              <dt>{t("deviceInfo.lora.preset")}</dt>
              <dd>
                {snapshot.lora.usePreset
                  ? snapshot.lora.modemPreset
                  : `BW ${snapshot.lora.bandwidth}kHz · SF${snapshot.lora.spreadFactor} · CR4/${snapshot.lora.codingRate}`}
              </dd>
            </div>
            {snapshot.lora.overrideFrequency > 0 && (
              <div>
                <dt>{t("deviceInfo.lora.fixedFreq")}</dt>
                <dd>{snapshot.lora.overrideFrequency.toFixed(3)} MHz</dd>
              </div>
            )}
            <div>
              <dt>{t("deviceInfo.lora.power")}</dt>
              <dd>{snapshot.lora.txPower === 0 ? t("deviceInfo.lora.powerAuto") : `${snapshot.lora.txPower} dBm`}</dd>
            </div>
            <div>
              <dt>{t("deviceInfo.lora.hopLimit")}</dt>
              <dd>{snapshot.lora.hopLimit}</dd>
            </div>
          </dl>
        </div>
      )}

      {snapshot.channels.length > 0 && (
        <div className="device-info-group">
          <h3>{t("deviceInfo.channels.title")}</h3>
          <ul className="channel-list">
            {snapshot.channels.map((c) => (
              <li key={c.index}>
                <span className="channel-index">{c.index}</span>
                <span className="channel-name">{c.name}</span>
                <span className="channel-tag">{c.role in ROLE_LABEL_KEYS ? t(ROLE_LABEL_KEYS[c.role]) : c.role}</span>
                <span className="channel-tag">{c.encrypted ? "🔒" : t("deviceInfo.channels.unencrypted")}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {snapshot.telemetry && (
        <div className="device-info-group">
          <h3>{t("deviceInfo.telemetry.title")}</h3>
          <dl>
            <div>
              <dt>{t("deviceInfo.telemetry.device")}</dt>
              <dd>
                {snapshot.telemetry.deviceUpdateInterval === 0
                  ? t("deviceInfo.telemetry.deviceDefault")
                  : formatInterval(snapshot.telemetry.deviceUpdateInterval, t)}
              </dd>
            </div>
            <div>
              <dt>{t("deviceInfo.telemetry.environment")}</dt>
              <dd>
                {snapshot.telemetry.environmentMeasurementEnabled
                  ? formatInterval(snapshot.telemetry.environmentUpdateInterval, t)
                  : t("deviceInfo.telemetry.disabled")}
              </dd>
            </div>
          </dl>
        </div>
      )}
    </div>
  );
}

const REGION_LABEL_KEYS: Record<string, MessageKey> = { EU_868: "region.868", LORA_24: "region.24" };

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
    : `BW ${lora.bandwidth}kHz · SF${lora.spreadFactor} · CR4/${lora.codingRate}`;
  return lora.overrideFrequency ? `${base} · ${lora.overrideFrequency.toFixed(3)} MHz` : base;
}

interface CompareRow {
  label: string;
  before: string;
  after: string;
}

function ConfirmApplyModal({
  snapshot,
  region,
  lora,
  channelName,
  primaryPsk,
  secondaryVisible,
  secondaryChannelName,
  secondaryPsk,
  telemetry,
  onConfirm,
  onCancel,
}: {
  snapshot: DeviceSnapshot | null;
  region: LoRaRegion;
  lora: LoRaPresetDef;
  channelName: string;
  primaryPsk: Uint8Array;
  secondaryVisible: boolean;
  secondaryChannelName: string;
  secondaryPsk: Uint8Array | null;
  telemetry: TelemetryPresetDef;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const regionLabel = (code: string) => (code in REGION_LABEL_KEYS ? t(REGION_LABEL_KEYS[code]) : code);
  const primaryBefore = snapshot?.channels.find((c) => c.role === "PRIMARY");
  const secondaryBefore = snapshot?.channels.find((c) => c.role === "SECONDARY");
  const secondaryAfterLabel =
    secondaryVisible && secondaryPsk !== null ? secondaryChannelName.trim() || t("confirmApply.unnamed") : t("confirmApply.none");

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
      label: t("confirmApply.row.secondaryChannel"),
      before: secondaryBefore ? secondaryBefore.name : t("confirmApply.none"),
      after: secondaryAfterLabel,
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
  ];

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal modal-wide">
        <h3>{t("confirmApply.title")}</h3>
        <p className="hint">{t("confirmApply.subtitle")}</p>
        <table className="compare-table">
          <thead>
            <tr>
              <th></th>
              <th>{t("confirmApply.colBefore")}</th>
              <th>{t("confirmApply.colAfter")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.label} className={row.before !== row.after ? "changed" : undefined}>
                <th>{row.label}</th>
                <td>{row.before}</td>
                <td>{row.after}</td>
              </tr>
            ))}
          </tbody>
        </table>
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
