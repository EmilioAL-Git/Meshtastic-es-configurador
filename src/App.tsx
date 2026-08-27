import { useRef, useState } from "react";
import type { MeshDevice } from "@meshtastic/core";
import "./App.css";
import {
  applyPreset,
  connectBluetooth,
  connectSerial,
  decodeCustomPsk,
  defaultSimplePsk,
  encodePskBase64,
  isWebBluetoothSupported,
  isWebSerialSupported,
  translateError,
  type ChannelPreset,
  type DeviceSnapshot,
} from "./lib/meshtastic";
import { getDefaultChannelName, getPresetsForRegion, LORA_REGION_CODES, type LoRaRegion } from "./presets/loraPresets";
import { PROVINCE_CHANNELS } from "./presets/provinceChannels";
import { TELEMETRY_PRESETS } from "./presets/telemetryPresets";

type ConnectionState =
  | { status: "disconnected" }
  | { status: "connecting"; via: "usb" | "bluetooth" }
  | { status: "connected"; via: "usb" | "bluetooth"; device: MeshDevice }
  | { status: "error"; message: string };

type ChannelNameMode = "standard" | "custom";
type SecondarySelection = "custom" | string;

type PskModalContext = "primary" | "secondary";

interface PskModalState {
  context: PskModalContext;
  channelLabel: string;
  initialValue: string;
}

function App() {
  const [conn, setConn] = useState<ConnectionState>({ status: "disconnected" });
  const [region, setRegion] = useState<LoRaRegion>("EU_868");
  const loraPresets = getPresetsForRegion(region);
  const [loraPresetId, setLoraPresetId] = useState(loraPresets[0].id);
  const selectedLora = loraPresets.find((p) => p.id === loraPresetId) ?? loraPresets[0];
  const defaultChannelName = getDefaultChannelName(selectedLora, region);
  const [telemetryPresetId, setTelemetryPresetId] = useState(TELEMETRY_PRESETS[0].id);
  const [channelNameMode, setChannelNameMode] = useState<ChannelNameMode>("standard");
  const [customChannelName, setCustomChannelName] = useState("");
  const channelName = channelNameMode === "custom" ? customChannelName.trim() : defaultChannelName;
  const [primaryPsk, setPrimaryPsk] = useState<Uint8Array>(defaultSimplePsk);

  const [secondaryVisible, setSecondaryVisible] = useState(false);
  const [secondarySelection, setSecondarySelection] = useState<SecondarySelection>("custom");
  const [secondaryChannelName, setSecondaryChannelName] = useState("");
  const [secondaryPsk, setSecondaryPsk] = useState<Uint8Array | null>(null);

  const [pskModal, setPskModal] = useState<PskModalState | null>(null);

  const [log, setLog] = useState<string[]>([]);
  const [progress, setProgress] = useState<number | null>(null);
  const [applying, setApplying] = useState(false);
  const [deviceSnapshot, setDeviceSnapshot] = useState<DeviceSnapshot | null>(null);
  const stopSnapshotTrackingRef = useRef<(() => void) | null>(null);

  const serialSupported = isWebSerialSupported();
  const bluetoothSupported = isWebBluetoothSupported();

  function appendLog(line: string, opts?: { replace?: boolean; percent?: number }) {
    setLog((prev) => (opts?.replace && prev.length > 0 ? [...prev.slice(0, -1), line] : [...prev, line]));
    if (opts?.percent !== undefined) setProgress(opts.percent);
  }

  async function handleConnect(via: "usb" | "bluetooth") {
    stopSnapshotTrackingRef.current?.();
    stopSnapshotTrackingRef.current = null;
    setConn({ status: "connecting", via });
    setLog([]);
    setProgress(0);
    setDeviceSnapshot(null);
    try {
      // La identidad/LoRa/canales/telemetría llegan durante el propio handshake, así
      // que hay que empezar a escucharlos desde ya (dentro de connectSerial/
      // connectBluetooth) — si nos suscribiéramos después de "Conectado", ya habrían
      // pasado y el panel se quedaría esperando para siempre.
      const { device, stopSnapshotTracking } =
        via === "usb" ? await connectSerial(appendLog, setDeviceSnapshot) : await connectBluetooth(appendLog, setDeviceSnapshot);
      stopSnapshotTrackingRef.current = stopSnapshotTracking;
      setConn({ status: "connected", via, device });
      appendLog(`Conectado por ${via === "usb" ? "USB" : "Bluetooth"}.`);
    } catch (err) {
      setConn({ status: "error", message: translateError(err) });
    }
  }

  async function handleDisconnect() {
    stopSnapshotTrackingRef.current?.();
    stopSnapshotTrackingRef.current = null;
    if (conn.status === "connected") {
      await conn.device.disconnect();
    }
    setConn({ status: "disconnected" });
    setDeviceSnapshot(null);
  }

  function handleChannelNameModeChange(next: ChannelNameMode) {
    setChannelNameMode(next);
    if (next === "standard") {
      setPrimaryPsk(defaultSimplePsk);
    } else {
      setPskModal({
        context: "primary",
        channelLabel: customChannelName.trim() || "canal personalizado",
        initialValue: encodePskBase64(primaryPsk),
      });
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
    setPskModal({ context: "secondary", channelLabel: "canal personalizado", initialValue: encodePskBase64(defaultSimplePsk) });
  }

  function handleRemoveSecondaryChannel() {
    setSecondaryVisible(false);
    setSecondarySelection("custom");
    setSecondaryChannelName("");
    setSecondaryPsk(null);
  }

  function handleSecondarySelectionChange(next: SecondarySelection) {
    setSecondarySelection(next);
    if (next === "custom") {
      setSecondaryChannelName("");
      setPskModal({ context: "secondary", channelLabel: "canal personalizado", initialValue: encodePskBase64(defaultSimplePsk) });
      return;
    }
    const province = PROVINCE_CHANNELS.find((p) => p.id === next);
    if (!province) return;
    setSecondaryChannelName(province.channelName);
    setPskModal({ context: "secondary", channelLabel: province.label, initialValue: encodePskBase64(province.psk) });
  }

  function handlePskModalConfirm(base64: string) {
    if (!pskModal) return;
    const bytes = decodeCustomPsk(base64);
    if (bytes === null) return;
    if (pskModal.context === "primary") {
      setPrimaryPsk(bytes);
    } else {
      setSecondaryPsk(bytes);
    }
    setPskModal(null);
  }

  function handlePskModalCancel() {
    if (pskModal?.context === "secondary" && secondaryPsk === null) {
      handleRemoveSecondaryChannel();
    }
    setPskModal(null);
  }

  const secondaryChannelReady =
    !secondaryVisible ||
    (secondaryPsk !== null && (secondarySelection !== "custom" || secondaryChannelName.trim() !== ""));

  async function handleApply() {
    if (conn.status !== "connected") return;
    const lora = loraPresets.find((p) => p.id === loraPresetId);
    const telemetry = TELEMETRY_PRESETS.find((p) => p.id === telemetryPresetId);
    if (!lora || !telemetry || !secondaryChannelReady) return;

    const channel: ChannelPreset = { name: channelName.trim(), psk: primaryPsk };
    const secondaryChannel: ChannelPreset | undefined =
      secondaryVisible && secondaryPsk !== null ? { name: secondaryChannelName.trim(), psk: secondaryPsk } : undefined;

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
            {conn.status === "connected" && (
              <button type="button" className="btn" onClick={handleDisconnect}>
                Desconectar
              </button>
            )}
          </div>

          {conn.status === "connecting" && <p className="status-line">Conectando…</p>}
          {conn.status === "connected" && (
            <p className="status-line ok">Conectado ({conn.via === "usb" ? "USB" : "Bluetooth"}).</p>
          )}
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
              <label>Clave del canal (PSK)</label>
              <div className="psk-summary">
                <code>{encodePskBase64(primaryPsk) || "(sin cifrar)"}</code>
                <button
                  type="button"
                  className="link-button"
                  onClick={() =>
                    setPskModal({
                      context: "primary",
                      channelLabel: customChannelName.trim() || "canal personalizado",
                      initialValue: encodePskBase64(primaryPsk),
                    })
                  }
                >
                  Editar clave
                </button>
              </div>
              <span className="hint">
                Usa la PSK real de tu comunidad si vas a unirte a una malla existente; si no la conoces,
                pregunta a quien administra tu grupo.
              </span>
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
                {secondaryPsk !== null && (
                  <div className="psk-summary">
                    <code>{encodePskBase64(secondaryPsk) || "(sin cifrar)"}</code>
                    <button
                      type="button"
                      className="link-button"
                      onClick={() =>
                        setPskModal({
                          context: "secondary",
                          channelLabel:
                            secondarySelection === "custom"
                              ? secondaryChannelName.trim() || "canal personalizado"
                              : PROVINCE_CHANNELS.find((p) => p.id === secondarySelection)?.label ?? "",
                          initialValue: encodePskBase64(secondaryPsk),
                        })
                      }
                    >
                      Editar clave
                    </button>
                  </div>
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
            disabled={conn.status !== "connected" || applying || channelName.trim() === "" || !secondaryChannelReady}
            onClick={handleApply}
          >
            {applying ? "Aplicando…" : "Aplicar configuración al nodo"}
          </button>
        </section>
        </div>

        {(conn.status === "connected" || conn.status === "connecting") && (
          <aside className="panel side-panel">
            <h2>Configuración actual del nodo</h2>
            <DeviceInfoPanel snapshot={deviceSnapshot} />
          </aside>
        )}
        </div>
      </main>

      {pskModal && (
        <PskPromptModal
          channelLabel={pskModal.channelLabel}
          initialValue={pskModal.initialValue}
          onConfirm={handlePskModalConfirm}
          onCancel={handlePskModalCancel}
        />
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

function PskPromptModal({
  channelLabel,
  initialValue,
  onConfirm,
  onCancel,
}: {
  channelLabel: string;
  initialValue: string;
  onConfirm: (base64: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initialValue);
  const invalid = decodeCustomPsk(value) === null;

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal">
        <h3>Clave del canal (PSK)</h3>
        <p className="hint">
          Canal: <strong>{channelLabel}</strong>
        </p>
        <div className="field">
          <label htmlFor="psk-modal-input">PSK en base64</label>
          <input
            id="psk-modal-input"
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="p.ej. 1PG7OiApB1nwvP+rz05pAQ=="
          />
          {invalid ? (
            <span className="hint warning">
              Esa clave no es válida: debe ser el texto en base64 tal como lo muestra la app o una URL de canal de
              Meshtastic (16 o 32 bytes decodificados), no la frase o contraseña del grupo escrita tal cual.
            </span>
          ) : (
            <span className="hint">
              Ya viene rellenada con la clave estándar de este canal. Déjala así o cámbiala si tu grupo usa una
              propia. Vacío = sin cifrar.
            </span>
          )}
        </div>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onCancel}>
            Cancelar
          </button>
          <button type="button" className="btn btn-primary" disabled={invalid} onClick={() => onConfirm(value)}>
            Confirmar
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
