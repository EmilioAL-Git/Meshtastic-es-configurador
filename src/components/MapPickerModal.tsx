import { useEffect, useRef, useState } from "react";
import * as L from "leaflet";
import "leaflet/dist/leaflet.css";
import markerIcon2x from "leaflet/dist/images/marker-icon-2x.png";
import markerIcon from "leaflet/dist/images/marker-icon.png";
import markerShadow from "leaflet/dist/images/marker-shadow.png";
import { useI18n } from "../i18n";

// El icono por defecto de Leaflet referencia rutas relativas a su propio CSS, que no
// existen tal cual una vez empaquetado con Vite: hay que apuntarlo a los assets importados.
delete (L.Icon.Default.prototype as unknown as { _getIconUrl?: unknown })._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: markerIcon2x,
  iconUrl: markerIcon,
  shadowUrl: markerShadow,
});

const DEFAULT_CENTER: L.LatLngTuple = [40.4168, -3.7038]; // Madrid, si no hay coordenadas previas

export function MapPickerModal({
  lat,
  lon,
  onConfirm,
  onCancel,
}: {
  lat: number | null;
  lon: number | null;
  onConfirm: (lat: number, lon: number) => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markerRef = useRef<L.Marker | null>(null);
  const [picked, setPicked] = useState<{ lat: number; lon: number } | null>(
    lat !== null && lon !== null ? { lat, lon } : null,
  );

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const initialCenter: L.LatLngTuple = picked ? [picked.lat, picked.lon] : DEFAULT_CENTER;
    const map = L.map(containerRef.current).setView(initialCenter, picked ? 15 : 6);
    mapRef.current = map;

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      maxZoom: 19,
    }).addTo(map);

    if (picked) {
      markerRef.current = L.marker([picked.lat, picked.lon]).addTo(map);
    }

    map.on("click", (e: L.LeafletMouseEvent) => {
      setPicked({ lat: e.latlng.lat, lon: e.latlng.lng });
      if (markerRef.current) {
        markerRef.current.setLatLng(e.latlng);
      } else {
        markerRef.current = L.marker(e.latlng).addTo(map);
      }
    });

    // El modal aún puede estar animándose/con tamaño 0 en el primer render; sin esto el
    // mapa puede quedar recortado o con los tiles mal alineados.
    setTimeout(() => map.invalidateSize(), 0);

    return () => {
      map.remove();
      mapRef.current = null;
      markerRef.current = null;
    };
    // Solo se monta/desmonta una vez: el mapa mantiene su propio estado de marcador tras el primer render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal modal-wide">
        <h3>{t("mapPicker.title")}</h3>
        <p className="hint">{t("mapPicker.hint")}</p>
        <div ref={containerRef} className="map-picker-canvas" />
        <p className="hint">{picked ? `${picked.lat.toFixed(6)}, ${picked.lon.toFixed(6)}` : t("mapPicker.noneSelected")}</p>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onCancel}>
            {t("mapPicker.cancel")}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!picked}
            onClick={() => picked && onConfirm(picked.lat, picked.lon)}
          >
            {t("mapPicker.confirm")}
          </button>
        </div>
      </div>
    </div>
  );
}
