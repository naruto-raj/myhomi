import { useEffect, useMemo, useRef } from "react";
import maplibregl, { Map } from "maplibre-gl";
import { Protocol } from "pmtiles";
import type { PricePaidPoint, SectorStat } from "../api/client";
import { fetchNearestPostcode } from "../api/client";

type Props = {
  pricePaidPoints: PricePaidPoint[];
  sectors: SectorStat[];
  showHeatmap: boolean;
  showCentroids: boolean;
  showBestFit: boolean;
  onViewportChange?: (bbox: number[], zoom: number) => void;
  focusPoint?: { latitude: number; longitude: number } | null;
};

const MAP_STYLE_URL = import.meta.env.VITE_MAP_STYLE_URL || "/tiles/style.json";

export default function MapView({
  pricePaidPoints,
  sectors,
  showHeatmap,
  showCentroids,
  showBestFit,
  onViewportChange,
  focusPoint,
}: Props) {
  const mapRef = useRef<Map | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const showCentroidsRef = useRef(showCentroids);
  const onViewportChangeRef = useRef<Props["onViewportChange"]>(onViewportChange);

  const pricePoints = useMemo(
    () => ({
      type: "FeatureCollection",
      features: pricePaidPoints.map((point) => ({
        type: "Feature",
        id: point.transaction_id,
        properties: {
          price: point.price,
          postcode: point.postcode,
        },
        geometry: {
          type: "Point",
          coordinates: [point.longitude, point.latitude],
        },
      })),
    }),
    [pricePaidPoints]
  );
  const sectorPoints = useMemo(
    () => ({
      type: "FeatureCollection",
      features: sectors.map((sector) => ({
        type: "Feature",
        id: sector.sector,
        properties: {
          sector: sector.sector,
          score: sector.score ?? 0,
          median_price: sector.median_price,
          transactions: sector.transactions,
        },
        geometry: {
          type: "Point",
          coordinates: [sector.longitude, sector.latitude],
        },
      })),
    }),
    [sectors]
  );

  useEffect(() => {
    showCentroidsRef.current = showCentroids;
  }, [showCentroids]);

  useEffect(() => {
    onViewportChangeRef.current = onViewportChange;
  }, [onViewportChange]);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const protocol = new Protocol();
    maplibregl.addProtocol("pmtiles", protocol.tile);

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: MAP_STYLE_URL,
      center: [-1.5, 52.6],
      zoom: 6,
    });

    mapRef.current = map;

    map.on("load", () => {
      map.addSource("price-paid", {
        type: "geojson",
        data: pricePoints,
      });
      map.addSource("sectors", {
        type: "geojson",
        data: sectorPoints,
      });

      map.addLayer({
        id: "price-paid-heat",
        type: "heatmap",
        source: "price-paid",
        layout: {
          visibility: showHeatmap ? "visible" : "none",
        },
        paint: {
          "heatmap-intensity": 0.8,
          "heatmap-radius": 18,
          "heatmap-opacity": 0.6,
          "heatmap-color": [
            "interpolate",
            ["linear"],
            ["heatmap-density"],
            0,
            "rgba(15,23,42,0)",
            0.2,
            "#38bdf8",
            0.4,
            "#22c55e",
            0.6,
            "#facc15",
            0.8,
            "#fb7185",
          ],
        },
      });

      map.addLayer({
        id: "best-fit-heat",
        type: "heatmap",
        source: "sectors",
        layout: {
          visibility: showBestFit ? "visible" : "none",
        },
        paint: {
          "heatmap-weight": ["interpolate", ["linear"], ["get", "score"], 0, 0, 1, 1],
          "heatmap-intensity": 1.1,
          "heatmap-radius": 24,
          "heatmap-opacity": 0.7,
          "heatmap-color": [
            "interpolate",
            ["linear"],
            ["heatmap-density"],
            0,
            "rgba(15,23,42,0)",
            0.3,
            "#60a5fa",
            0.6,
            "#34d399",
            0.8,
            "#fbbf24",
          ],
        },
      });

      map.addLayer({
        id: "sector-points",
        type: "circle",
        source: "sectors",
        layout: {
          visibility: showCentroids ? "visible" : "none",
        },
        paint: {
          "circle-radius": [
            "interpolate",
            ["linear"],
            ["get", "transactions"],
            1,
            4,
            50,
            10,
            200,
            16,
          ],
          "circle-color": [
            "interpolate",
            ["linear"],
            ["get", "score"],
            0,
            "#64748b",
            0.5,
            "#38bdf8",
            1,
            "#facc15",
          ],
          "circle-opacity": 0.75,
          "circle-stroke-color": "#0f172a",
          "circle-stroke-width": 1,
        },
      });

      const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false });
      const clickPopup = new maplibregl.Popup({ closeButton: true, closeOnClick: false });

      map.on("mousemove", "sector-points", (event) => {
        if (!showCentroidsRef.current) return;
        const feature = event.features?.[0];
        if (!feature || !event.lngLat) return;
        const props = feature.properties || {};
        const sector = props.sector || "Sector";
        const median = Number(props.median_price || 0);
        const transactions = Number(props.transactions || 0);
        const html = `
          <div style="font-size:12px">
            <div style="font-weight:600">${sector}</div>
            <div>Median price: £${median.toLocaleString()}</div>
            <div>Sales: ${transactions}</div>
          </div>
        `;
        popup.setLngLat(event.lngLat).setHTML(html).addTo(map);
      });

      map.on("mouseleave", "sector-points", () => {
        popup.remove();
      });

      let dragStart: { x: number; y: number } | null = null;
      let dragged = false;

      map.on("mousedown", (event) => {
        dragStart = { x: event.point.x, y: event.point.y };
        dragged = false;
      });

      map.on("mousemove", (event) => {
        if (!dragStart) return;
        const dx = event.point.x - dragStart.x;
        const dy = event.point.y - dragStart.y;
        if (Math.hypot(dx, dy) > 6) {
          dragged = true;
        }
      });

      map.on("mouseup", () => {
        dragStart = null;
      });

      map.on("click", async (event) => {
        if (!event.lngLat) return;
        if (dragged) return;
        try {
          const result = await fetchNearestPostcode(event.lngLat.lat, event.lngLat.lng);
          const row = result.row;
          const targetLat = row?.latitude ?? event.lngLat.lat;
          const targetLng = row?.longitude ?? event.lngLat.lng;
          const rawDate = row?.date_of_transfer ? String(row.date_of_transfer) : "";
          const parsedDate = rawDate ? new Date(rawDate) : null;
          const date =
            parsedDate && !Number.isNaN(parsedDate.valueOf())
              ? parsedDate.toLocaleDateString("en-GB", {
                  day: "2-digit",
                  month: "short",
                  year: "numeric",
                })
              : "—";
          const year =
            parsedDate && !Number.isNaN(parsedDate.valueOf()) ? parsedDate.getUTCFullYear() : null;
          const price = row?.price ?? null;
          const adjusted = result.meta?.inflation_adjusted_price ?? null;
          const pct = result.meta?.inflation_percent_change ?? null;
          const pctText = pct !== null ? `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%` : "—";
          const arrow = pct === null ? "" : pct > 0 ? "▲" : pct < 0 ? "▼" : "•";
          const color = pct === null ? "#0f172a" : pct > 0 ? "#16a34a" : pct < 0 ? "#dc2626" : "#64748b";

          map.flyTo({
            center: [targetLng, targetLat],
            zoom: Math.max(map.getZoom(), 13),
            speed: 1.2,
          });

          const inflationLine =
            adjusted !== null
              ? `<div style="color:#0f172a;">£${Number(adjusted).toLocaleString()}</div>`
              : `<div style="color:#94a3b8">Unavailable</div>`;

          const pctBadge =
            pct !== null
              ? `<span style="display:inline-flex;align-items:center;gap:6px;padding:2px 8px;border-radius:999px;background:${color}1A;color:${color};font-weight:600;">${arrow} ${pctText}</span>`
              : `<span style="display:inline-flex;align-items:center;padding:2px 8px;border-radius:999px;background:#e2e8f0;color:#64748b;font-weight:600;">No change</span>`;

          const html = `
            <div style="font-family:ui-sans-serif,system-ui,-apple-system; min-width:200px; border-radius:12px; background:#ffffff; padding:12px 14px; box-shadow:0 10px 30px rgba(15,23,42,0.15); border:1px solid #e2e8f0;">
              <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
                <div style="font-size:11px; letter-spacing:0.12em; text-transform:uppercase; color:#64748b;">Nearest Sale</div>
                ${pctBadge}
              </div>
              <div style="margin-top:6px; font-size:16px; font-weight:700; color:#0f172a;">${row?.postcode ?? "Nearest sale"}</div>
              <div style="margin-top:2px; font-size:12px; color:#64748b;">${date}${year ? ` (${year})` : ""}</div>

              <div style="margin-top:10px; display:grid; grid-template-columns:1fr; gap:6px;">
                <div style="display:flex;justify-content:space-between;gap:8px;font-size:12px;color:#64748b;">
                  <span>Last price</span>
                  <span style="color:#0f172a;font-weight:600;">£${price ? Number(price).toLocaleString() : "—"}</span>
                </div>
                <div style="display:flex;justify-content:space-between;gap:8px;font-size:12px;color:#64748b;">
                  <span>Adj. ${result.meta?.inflation_latest_year ?? ""}</span>
                  ${inflationLine}
                </div>
              </div>
            </div>
          `;
          clickPopup.setLngLat([targetLng, targetLat]).setHTML(html).addTo(map);
        } catch {
          // ignore
        }
      });

      if (onViewportChangeRef.current) {
        const bounds = map.getBounds();
        onViewportChangeRef.current(
          [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()],
          map.getZoom()
        );
      }

      map.on("moveend", () => {
        if (!onViewportChangeRef.current) return;
        const bounds = map.getBounds();
        const bbox = [
          bounds.getWest(),
          bounds.getSouth(),
          bounds.getEast(),
          bounds.getNorth(),
        ];
        onViewportChangeRef.current(bbox, map.getZoom());
      });
    });

    return () => {
      map.remove();
      maplibregl.removeProtocol("pmtiles");
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.getSource("price-paid")) return;
    const priceSource = map.getSource("price-paid") as maplibregl.GeoJSONSource;
    priceSource.setData(pricePoints);
    const sectorSource = map.getSource("sectors") as maplibregl.GeoJSONSource;
    sectorSource.setData(sectorPoints);
  }, [pricePoints, sectorPoints]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (map.getLayer("price-paid-heat")) {
      map.setLayoutProperty("price-paid-heat", "visibility", showHeatmap ? "visible" : "none");
    }
    if (map.getLayer("sector-points")) {
      map.setLayoutProperty("sector-points", "visibility", showCentroids ? "visible" : "none");
    }
    if (map.getLayer("best-fit-heat")) {
      map.setLayoutProperty("best-fit-heat", "visibility", showBestFit ? "visible" : "none");
    }
  }, [showHeatmap, showCentroids, showBestFit]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !focusPoint) return;
    map.flyTo({
      center: [focusPoint.longitude, focusPoint.latitude],
      zoom: Math.max(map.getZoom(), 12),
      speed: 1.2,
    });
  }, [focusPoint]);

  return <div ref={containerRef} className="h-full min-h-[520px] w-full" />;
}
