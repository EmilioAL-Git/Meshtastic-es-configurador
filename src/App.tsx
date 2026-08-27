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
  downloadTextFile,
  encodePskBase64,
  exportDeviceProfileJson,
  isWebBluetoothSupported,
  isWebSerialSupported,
  parseDeviceProfileJson,
  summarizeDeviceProfile,
  translateError,
  type ChannelPreset,
  type DeviceProfile,
  type DeviceProfileSource,
  type DeviceProfileSummary,
  type DeviceSnapshot,
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

type ConnectionVia = "usb" | "bluetooth" | "network";

type ConnectionState =
  | { status: "disconnected" }
  | { status: "connecting"; via: ConnectionVia }
  | { status: "connected"; via: ConnectionVia; device: MeshDevice }
  | { status: "error"; message: string };

const VIA_LABELS: Record<ConnectionVia, string> = { usb: "USB", bluetooth: "Bluetooth", network: "red" };

type ChannelNameMode = "standard" | "custom";
type SecondarySelection = "custom" | string;

function App() {
  const [conn, setConn] = useState<ConnectionState>({ status: "disconnected" });
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
  const importFileInputRef = useRef<HTMLInputElement | null>(null);
  const [importPending, setImportPending] = useState<{ profile: DeviceProfile; summary: DeviceProfileSummary } | null>(null);

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
    setConn({ status: "connecting", via });
    setLog([]);
    setProgress(0);
    setDeviceSnapshot(null);
    try {
      // La identidad/LoRa/canales/telemetría llegan durante el propio handshake, así
      // que hay que empezar a escucharlos desde ya (dentro de connectSerial/
      // connectBluetooth/connectNetwork) — si nos suscribiéramos después de
      // "Conectado", ya habrían pasado y el panel se quedaría esperando para siempre.
      const { device, stopSnapshotTracking, getDeviceProfileSource } =
        via === "usb"
          ? await connectSerial(appendLog, setDeviceSnapshot)
          : via === "bluetooth"
            ? await connectBluetooth(appendLog, setDeviceSnapshot)
            : await connectNetwork(networkHostPort, networkTls, appendLog, setDeviceSnapshot);
      stopSnapshotTrackingRef.current = stopSnapshotTracking;
      getDeviceProfileSourceRef.current = getDeviceProfileSource;
      setConn({ status: "connected", via, device });
      appendLog(`Conectado por ${VIA_LABELS[via]}.`);
    } catch (err) {
      setConn({ status: "error", message: translateError(err) });
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
    stopSnapshotTrackingRef.current?.();
    stopSnapshotTrackingRef.current = null;
    getDeviceProfileSourceRef.current = null;
    if (conn.status === "connected") {
      await conn.device.disconnect();
    }
    setConn({ status: "disconnected" });
    setDeviceSnapshot(null);
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
      await applyPreset(conn.device, {
        lora,
        channel,
        secondaryChannel,
        telemetry,
        region: LORA_REGION_CODES[region],
        onProgress: appendLog,
      });
    } catch (err) {
      appendLog(`Error: ${translateError(err)}`);
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
    appendLog("Configuración actual guardada en un fichero.");
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
      setImportPending({ profile, summary: summarizeDeviceProfile(profile) });
    } catch (err) {
      appendLog(`Error al leer el fichero de configuración: ${translateError(err)}`);
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
      await applyDeviceProfile(conn.device, profile, appendLog);
    } catch (err) {
      appendLog(`Error: ${translateError(err)}`);
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
        <span className="tagline">Ajustes de LoRa, canal y telemetría en un clic</span>
      </header>

      <main className="app-main">
        {!serialSupported && !bluetoothSupported && (
          <div className="browser-warning">
            Tu navegador no soporta Web Serial ni Web Bluetooth. Usa Chrome o Edge de escritorio.
          </div>
        )}

        <div className={`layout${conn.status === "connected" || conn.status === "connecting" ? " has-sidebar" : ""}`}>
        <div className="main-column">
        <section className="panel">
          <h2>
            <span className="step">1</span> Conecta tu nodo
          </h2>
          <div className="connect-buttons">
            <button
              type="button"
              className="btn"
              disabled={!serialSupported || conn.status === "connecting" || conn.status === "connected"}
              onClick={() => handleConnect("usb")}
            >
              Conectar por USB
            </button>
            <button
              type="button"
              className="btn"
              disabled={!bluetoothSupported || conn.status === "connecting" || conn.status === "connected"}
              onClick={() => handleConnect("bluetooth")}
            >
              Conectar por Bluetooth
            </button>
            <button
              type="button"
              className="btn"
              disabled={conn.status === "connecting" || conn.status === "connected"}
              onClick={handleOpenNetworkModal}
            >
              Conectar por red
            </button>
            {conn.status === "connected" && (
              <button type="button" className="btn" onClick={handleDisconnect}>
                Desconectar
              </button>
            )}
          </div>

          {conn.status === "connecting" && <p className="status-line">Conectando…</p>}
          {conn.status === "connected" && <p className="status-line ok">Conectado ({VIA_LABELS[conn.via]}).</p>}
          {conn.status === "error" && <p className="status-line error">Error: {conn.message}</p>}

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
            <span className="step">2</span> Elige la configuración
          </h2>

          <div className="field">
            <label htmlFor="lora-region">Banda / región</label>
            <select
              id="lora-region"
              value={region}
              onChange={(e) => handleRegionChange(e.target.value as LoRaRegion)}
            >
              <option value="EU_868">868 MHz</option>
              <option value="LORA_24">2.4 GHz</option>
            </select>
            <span className="hint">
              {region === "LORA_24"
                ? "Requiere un nodo con radio de 2.4GHz. No es compatible con nodos que solo llevan radio de 868MHz."
                : "Banda habitual en la mayoría de nodos Meshtastic."}
            </span>
          </div>

          <div className="field">
            <label htmlFor="lora-preset">Preset LoRa</label>
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
            <label htmlFor="channel-name-mode">Nombre del canal primario</label>
            <select
              id="channel-name-mode"
              value={channelNameMode}
              onChange={(e) => handleChannelNameModeChange(e.target.value as ChannelNameMode)}
            >
              <option value="standard">Estándar ({defaultChannelName})</option>
              <option value="custom">Personalizado</option>
            </select>
            {channelNameMode === "custom" ? (
              <>
                <input
                  value={customChannelName}
                  onChange={(e) => setCustomChannelName(e.target.value)}
                  placeholder="p.ej. AlbaceteMesh"
                  maxLength={11}
                />
                <span className="hint warning">
                  Un nombre de canal distinto de "{defaultChannelName}" no es la configuración normal/estándar de este
                  preset: tu nodo dejará de encontrar automáticamente a otros nodos que usen el nombre estándar. Solo
                  cámbialo si sabes lo que haces o tu grupo lo usa así deliberadamente.
                </span>
              </>
            ) : (
              <span className="hint">
                Nombre estándar recomendado para este preset; se usa además para derivar la frecuencia del canal.
              </span>
            )}
          </div>

          {channelNameMode === "custom" && (
            <div className="field">
              <label htmlFor="primary-psk">Clave del canal (PSK, en base64)</label>
              <input
                id="primary-psk"
                value={primaryPskText}
                onChange={(e) => setPrimaryPskText(e.target.value)}
                placeholder="p.ej. AQ=="
              />
              {primaryPskInvalid ? (
                <span className="hint warning">
                  Esa clave no es válida: debe ser el texto en base64 tal como lo muestra la app o una URL de canal de
                  Meshtastic (1 byte para claves públicas tipo "AQ==", o 16/32 bytes para AES128/256), no la frase o
                  contraseña del grupo escrita tal cual.
                </span>
              ) : (
                <span className="hint">
                  Ya viene rellenada con la clave pública estándar ("AQ=="). Déjala así, vacíala para no cifrar, o
                  escribe la PSK real de tu comunidad si la conoces.
                </span>
              )}
            </div>
          )}

          <div className="field">
            {!secondaryVisible ? (
              <button type="button" className="btn" onClick={handleAddSecondaryChannel}>
                + Añadir otro canal
              </button>
            ) : (
              <>
                <label htmlFor="secondary-channel">Canal adicional</label>
                <select
                  id="secondary-channel"
                  value={secondarySelection}
                  onChange={(e) => handleSecondarySelectionChange(e.target.value)}
                >
                  <option value="custom">Personalizado</option>
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
                    placeholder="Nombre del canal"
                    maxLength={11}
                  />
                )}
                <input
                  value={secondaryPskText}
                  onChange={(e) => setSecondaryPskText(e.target.value)}
                  placeholder={secondarySelection === "custom" ? "PSK en base64 (vacío = sin cifrar)" : "p.ej. AQ=="}
                />
                {secondaryPskInvalid ? (
                  <span className="hint warning">
                    Esa clave no es válida: debe ser el texto en base64 tal como lo muestra la app o una URL de canal
                    de Meshtastic (1 byte para claves públicas tipo "AQ==", o 16/32 bytes para AES128/256), no la
                    frase o contraseña del grupo escrita tal cual.
                  </span>
                ) : (
                  <span className="hint">
                    {secondarySelection === "custom"
                      ? "Vacío = sin cifrar. Escribe la PSK del grupo si la tienes."
                      : "Ya viene rellenada con la clave estándar de esta provincia; cámbiala solo si tu grupo usa una propia."}
                  </span>
                )}
                <button type="button" className="link-button" onClick={handleRemoveSecondaryChannel}>
                  Quitar canal
                </button>
              </>
            )}
          </div>

          <div className="field">
            <label htmlFor="telemetry-preset">Intervalo de telemetría</label>
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
                Ver guía de buenas prácticas
              </a>
              .
            </span>
          </div>

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
            {applying ? "Aplicando…" : "Aplicar configuración al nodo"}
          </button>
        </section>
        </div>

        {(conn.status === "connected" || conn.status === "connecting") && (
          <aside className="panel side-panel">
            <h2>Configuración actual del nodo</h2>
            <DeviceInfoPanel snapshot={deviceSnapshot} />

            {conn.status === "connected" && (
              <>
                <div className="connect-buttons">
                  <button type="button" className="btn" onClick={handleSaveConfig}>
                    💾 Guardar configuración actual
                  </button>
                  <button type="button" className="btn" disabled={applying} onClick={handleUploadConfigClick}>
                    📤 Subir configuración
                  </button>
                  <input
                    ref={importFileInputRef}
                    type="file"
                    accept="application/json,.json"
                    className="visually-hidden"
                    onChange={handleUploadConfigFile}
                  />
                </div>
                <span className="hint">
                  El fichero es un perfil de dispositivo Meshtastic en JSON (el mismo formato que exportan la app
                  oficial y el CLI): identidad, canales y toda la configuración del nodo. Por seguridad, la clave
                  privada del nodo nunca se incluye en el fichero exportado.
                </span>
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
        <ImportConfirmModal summary={importPending.summary} onConfirm={handleConfirmImport} onCancel={handleCancelImport} />
      )}

      <footer className="app-footer">
        <span>Herramienta no oficial de la comunidad Meshtastic España</span>
        <span>
          <a href="https://meshtastic.es" target="_blank" rel="noopener noreferrer">
            meshtastic.es
          </a>
          {" · "}
          <a href="https://mapa.meshtastic.es" target="_blank" rel="noopener noreferrer">
            mapa
          </a>
        </span>
      </footer>
    </div>
  );
}

const YEAR_SECONDS = 3600 * 24 * 365;

function formatInterval(seconds: number): string {
  if (seconds === 0) return "desactivado";
  if (seconds >= YEAR_SECONDS) return `${(seconds / YEAR_SECONDS).toFixed(0)} años (prácticamente nunca)`;
  if (seconds % 3600 === 0) return `${seconds / 3600} h`;
  if (seconds % 60 === 0) return `${seconds / 60} min`;
  return `${seconds} s`;
}

const ROLE_LABELS: Record<string, string> = { PRIMARY: "Primario", SECONDARY: "Secundario" };

function DeviceInfoPanel({ snapshot }: { snapshot: DeviceSnapshot | null }) {
  if (!snapshot || (!snapshot.longName && !snapshot.lora && snapshot.channels.length === 0 && !snapshot.telemetry)) {
    return <p className="hint">Esperando datos del nodo…</p>;
  }

  return (
    <div className="device-info">
      {(snapshot.longName || snapshot.shortName) && (
        <div className="device-info-group">
          <h3>Identidad</h3>
          <dl>
            {snapshot.longName && (
              <div>
                <dt>Nombre</dt>
                <dd>
                  {snapshot.longName} {snapshot.shortName && `(${snapshot.shortName})`}
                </dd>
              </div>
            )}
            {snapshot.hwModel && (
              <div>
                <dt>Hardware</dt>
                <dd>{snapshot.hwModel}</dd>
              </div>
            )}
            {snapshot.nodeNum !== null && (
              <div>
                <dt>Núm. nodo</dt>
                <dd>{snapshot.nodeNum}</dd>
              </div>
            )}
          </dl>
        </div>
      )}

      {snapshot.lora && (
        <div className="device-info-group">
          <h3>LoRa</h3>
          <dl>
            <div>
              <dt>Región</dt>
              <dd>{snapshot.lora.region}</dd>
            </div>
            <div>
              <dt>Preset</dt>
              <dd>
                {snapshot.lora.usePreset
                  ? snapshot.lora.modemPreset
                  : `BW ${snapshot.lora.bandwidth}kHz · SF${snapshot.lora.spreadFactor} · CR4/${snapshot.lora.codingRate}`}
              </dd>
            </div>
            {snapshot.lora.overrideFrequency > 0 && (
              <div>
                <dt>Frecuencia fija</dt>
                <dd>{snapshot.lora.overrideFrequency.toFixed(3)} MHz</dd>
              </div>
            )}
            <div>
              <dt>Potencia</dt>
              <dd>{snapshot.lora.txPower === 0 ? "Automática" : `${snapshot.lora.txPower} dBm`}</dd>
            </div>
            <div>
              <dt>Máx. saltos</dt>
              <dd>{snapshot.lora.hopLimit}</dd>
            </div>
          </dl>
        </div>
      )}

      {snapshot.channels.length > 0 && (
        <div className="device-info-group">
          <h3>Canales</h3>
          <ul className="channel-list">
            {snapshot.channels.map((c) => (
              <li key={c.index}>
                <span className="channel-index">{c.index}</span>
                <span className="channel-name">{c.name}</span>
                <span className="channel-tag">{ROLE_LABELS[c.role] ?? c.role}</span>
                <span className="channel-tag">{c.encrypted ? "🔒" : "sin cifrar"}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {snapshot.telemetry && (
        <div className="device-info-group">
          <h3>Telemetría</h3>
          <dl>
            <div>
              <dt>Dispositivo</dt>
              <dd>
                {snapshot.telemetry.deviceUpdateInterval === 0
                  ? "por defecto del firmware"
                  : formatInterval(snapshot.telemetry.deviceUpdateInterval)}
              </dd>
            </div>
            <div>
              <dt>Entorno</dt>
              <dd>
                {snapshot.telemetry.environmentMeasurementEnabled
                  ? formatInterval(snapshot.telemetry.environmentUpdateInterval)
                  : "desactivada"}
              </dd>
            </div>
          </dl>
        </div>
      )}
    </div>
  );
}

const REGION_LABELS: Record<string, string> = { EU_868: "868 MHz", LORA_24: "2.4 GHz" };

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
  const primaryBefore = snapshot?.channels.find((c) => c.role === "PRIMARY");
  const secondaryBefore = snapshot?.channels.find((c) => c.role === "SECONDARY");
  const secondaryAfterLabel = secondaryVisible && secondaryPsk !== null ? secondaryChannelName.trim() || "(sin nombre)" : "(ninguno)";

  const rows: CompareRow[] = [
    {
      label: "Región",
      before: snapshot?.lora ? REGION_LABELS[snapshot.lora.region] ?? snapshot.lora.region : "desconocida",
      after: REGION_LABELS[region] ?? region,
    },
    {
      label: "Preset LoRa",
      before: snapshot?.lora ? loraSummary(snapshot.lora) : "desconocido",
      after: lora.values.overrideFrequency ? `${lora.label} · ${lora.values.overrideFrequency.toFixed(3)} MHz` : lora.label,
    },
    {
      label: "Canal primario",
      before: primaryBefore ? primaryBefore.name : "desconocido",
      after: channelName.trim() || "(sin nombre)",
    },
    {
      label: "Cifrado canal primario",
      before: primaryBefore ? (primaryBefore.encrypted ? "sí" : "no") : "desconocido",
      after: primaryPsk.length > 0 ? "sí" : "no",
    },
    {
      label: "Canal secundario",
      before: secondaryBefore ? secondaryBefore.name : "(ninguno)",
      after: secondaryAfterLabel,
    },
    {
      label: "Telemetría dispositivo",
      before: snapshot?.telemetry ? formatInterval(snapshot.telemetry.deviceUpdateInterval) : "desconocida",
      after: formatInterval(telemetry.values.deviceUpdateInterval),
    },
    {
      label: "Telemetría entorno",
      before: snapshot?.telemetry
        ? snapshot.telemetry.environmentMeasurementEnabled
          ? formatInterval(snapshot.telemetry.environmentUpdateInterval)
          : "desactivada"
        : "desconocida",
      after: telemetry.values.environmentMeasurementEnabled
        ? formatInterval(telemetry.values.environmentUpdateInterval)
        : "desactivada",
    },
  ];

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal modal-wide">
        <h3>¿Seguro que quieres aplicar esta configuración?</h3>
        <p className="hint">
          El nodo se reiniciará al terminar. Revisa los cambios antes de continuar.
        </p>
        <table className="compare-table">
          <thead>
            <tr>
              <th></th>
              <th>Antes</th>
              <th>Después</th>
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
            Cancelar
          </button>
          <button type="button" className="btn btn-primary" onClick={onConfirm}>
            Sí, aplicar
          </button>
        </div>
      </div>
    </div>
  );
}

function ImportConfirmModal({
  summary,
  onConfirm,
  onCancel,
}: {
  summary: DeviceProfileSummary;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal">
        <h3>¿Aplicar esta configuración al nodo?</h3>
        <p className="hint warning">
          Esto sobrescribe toda la configuración del nodo con la del fichero (identidad, LoRa, canales y el resto de
          secciones que incluya el perfil) y lo reinicia al terminar.
        </p>
        <dl>
          {(summary.longName || summary.shortName) && (
            <div>
              <dt>Nombre</dt>
              <dd>
                {summary.longName} {summary.shortName && `(${summary.shortName})`}
              </dd>
            </div>
          )}
          <div>
            <dt>Canales</dt>
            <dd>{summary.channelCount > 0 ? summary.channelCount : "ninguno"}</dd>
          </div>
          <div>
            <dt>Config. incluida</dt>
            <dd>{summary.configSections.length > 0 ? summary.configSections.join(", ") : "ninguna"}</dd>
          </div>
          <div>
            <dt>Módulos incluidos</dt>
            <dd>{summary.moduleConfigSections.length > 0 ? summary.moduleConfigSections.join(", ") : "ninguno"}</dd>
          </div>
        </dl>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onCancel}>
            Cancelar
          </button>
          <button type="button" className="btn btn-primary" onClick={onConfirm}>
            Sí, aplicar
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
  const handleEnter = (e: { key: string }) => {
    if (e.key === "Enter" && address.trim() !== "") onConfirm();
  };
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal">
        <h3>Conectar por red</h3>
        <div className="field network-connect-row">
          <div className="network-address-field">
            <label htmlFor="network-address">IP u host del nodo</label>
            <input
              id="network-address"
              autoFocus
              value={address}
              onChange={(e) => onAddressChange(e.target.value)}
              placeholder="p.ej. 192.168.1.50 o meshtastic.local"
              onKeyDown={handleEnter}
            />
          </div>
          <div className="network-port-field">
            <label htmlFor="network-port">Puerto</label>
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
        <span className="hint">
          Usa la IP u host del nodo en tu red local (visible en la pantalla del nodo o en tu router). El nodo debe
          tener la interfaz web habilitada.
        </span>
        <div className="field">
          <label className="network-tls-check">
            <input type="checkbox" checked={tls} onChange={(e) => onTlsChange(e.target.checked)} />
            Usar HTTPS
          </label>
          <span className="hint">
            Actívalo solo si tu nodo tiene TLS habilitado en su interfaz web. Si esta página se sirve por HTTPS,
            tu nodo también deberá usar HTTPS, porque el navegador bloquea conexiones HTTP simples desde una página
            segura.
          </span>
        </div>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onCancel}>
            Cancelar
          </button>
          <button type="button" className="btn btn-primary" disabled={address.trim() === ""} onClick={onConfirm}>
            Conectar
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
