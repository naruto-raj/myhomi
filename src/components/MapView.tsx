import { useCallback, useEffect, useMemo, useRef } from "react";
import maplibregl, { Map } from "maplibre-gl";
import { Protocol } from "pmtiles";
import type { PricePaidPoint, SectorStat } from "../api/client";
import { fetchNearestAffordablePostcode, fetchNearestPostcode } from "../api/client";

type Props = {
  pricePaidPoints: PricePaidPoint[];
  sectors: SectorStat[];
  showHeatmap: boolean;
  showCentroids: boolean;
  showBestFit: boolean;
  affordability?: {
    monthlyBudget: number;
    deposit: number;
    mortgageRate: number;
    termYears: number;
  };
  maxAffordable?: number;
  propertyType?: string;
  selectedSector?: SectorStat | null;
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
  affordability,
  maxAffordable,
  propertyType,
  selectedSector,
  onViewportChange,
  focusPoint,
}: Props) {
  const mapRef = useRef<Map | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const showCentroidsRef = useRef(showCentroids);
  const showBestFitRef = useRef(showBestFit);
  const affordabilityRef = useRef<Props["affordability"]>(affordability);
  const propertyTypeRef = useRef<string | undefined>(propertyType);
  const onViewportChangeRef = useRef<Props["onViewportChange"]>(onViewportChange);
  const clickPopupRef = useRef<maplibregl.Popup | null>(null);

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
  const sectorPoints = useMemo(() => {
    const rawScores = sectors.map((sector) => Number(sector.transactions || 0));

    const minScore = rawScores.length ? Math.min(...rawScores) : 0;
    const maxScore = rawScores.length ? Math.max(...rawScores) : 1;
    const range = maxScore - minScore;

    return {
      type: "FeatureCollection",
      features: sectors.map((sector, idx) => {
        const priceAdj =
          sector.median_price_adj ?? sector.inflation_adjusted_price ?? sector.median_price;
        const raw = rawScores[idx] ?? 0;
        const normalized = range > 0.0001 ? (raw - minScore) / range : 0;
        return {
          type: "Feature",
          id: sector.sector,
          properties: {
            sector: sector.sector,
            score: sector.score ?? 0,
            median_price: sector.median_price,
            median_price_adj: priceAdj,
            affordability_score: normalized,
            transactions: sector.transactions,
          },
          geometry: {
            type: "Point",
            coordinates: [sector.longitude, sector.latitude],
          },
        };
      }),
    };
  }, [sectors]);

  useEffect(() => {
    showCentroidsRef.current = showCentroids;
  }, [showCentroids]);

  useEffect(() => {
    showBestFitRef.current = showBestFit;
  }, [showBestFit]);

  useEffect(() => {
    affordabilityRef.current = affordability;
  }, [affordability]);

  useEffect(() => {
    propertyTypeRef.current = propertyType;
  }, [propertyType]);

  useEffect(() => {
    onViewportChangeRef.current = onViewportChange;
  }, [onViewportChange]);

  const showNearestAt = useCallback(
    async (
      lng: number,
      lat: number,
      options?: {
        label?: string;
        sectorMedian?: number | null;
        sectorMedianAdj?: number | null;
      }
    ) => {
      const map = mapRef.current;
      const clickPopup = clickPopupRef.current;
      if (!map || !clickPopup) return;

      let result: Awaited<ReturnType<typeof fetchNearestPostcode>> | null = null;
      let label = options?.label || "Nearest Sale";
      const affordabilityValue = affordabilityRef.current;
      const propertyTypeValue = propertyTypeRef.current;
      if (showBestFitRef.current && affordabilityValue) {
        try {
          result = await fetchNearestAffordablePostcode(lat, lng, affordabilityValue, propertyTypeValue);
          label = options?.label || "Nearest Affordable Sale";
        } catch {
          result = await fetchNearestPostcode(lat, lng);
          label = options?.label || "Nearest Sale";
        }
      } else {
        result = await fetchNearestPostcode(lat, lng);
      }

      if (!result) return;
      const row = result.row;
      const targetLat = row?.latitude ?? lat;
      const targetLng = row?.longitude ?? lng;
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
      const baseYear = result.meta?.inflation_base_year ?? null;
      const latestYear = result.meta?.inflation_latest_year ?? null;
      const baseIndex = result.meta?.inflation_base_index ?? null;
      const latestIndex = result.meta?.inflation_latest_index ?? null;
      const propertyTypeCode = row?.property_type ?? null;
      const propertyTypeLabel =
        propertyTypeCode === "D"
          ? "Detached"
          : propertyTypeCode === "S"
            ? "Semi-detached"
            : propertyTypeCode === "T"
              ? "Terraced"
              : propertyTypeCode === "F"
                ? "Flat / Maisonette"
                : propertyTypeCode === "O"
                  ? "Other"
                  : "Unknown";

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

      const inflationMeta =
        baseYear && latestYear && baseIndex && latestIndex
          ? `CPIH 2015=100: ${baseYear} ${baseIndex} → ${latestYear} ${latestIndex}`
          : "CPIH data unavailable";

      const sectorLine =
        options?.sectorMedian || options?.sectorMedianAdj
          ? `<div style="display:flex;justify-content:space-between;gap:8px;font-size:12px;color:#64748b;">
              <span>Sector median</span>
              <span style="color:#0f172a;font-weight:600;">£${options?.sectorMedian ? Number(options.sectorMedian).toLocaleString() : "—"}</span>
            </div>
            <div style="display:flex;justify-content:space-between;gap:8px;font-size:12px;color:#64748b;">
              <span>Sector adj. ${latestYear ?? ""}</span>
              <span style="color:#0f172a;font-weight:600;">£${options?.sectorMedianAdj ? Number(options.sectorMedianAdj).toLocaleString() : "—"}</span>
            </div>`
          : "";

      const html = `
        <div style="font-family:ui-sans-serif,system-ui,-apple-system; min-width:200px; border-radius:12px; background:#ffffff; padding:12px 14px; box-shadow:0 10px 30px rgba(15,23,42,0.15); border:1px solid #e2e8f0;">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
            <div style="font-size:11px; letter-spacing:0.12em; text-transform:uppercase; color:#64748b;">${label}</div>
            ${pctBadge}
          </div>
          <div style="margin-top:6px; font-size:16px; font-weight:700; color:#0f172a;">${row?.postcode ?? "Nearest sale"}</div>
          <div style="margin-top:2px; font-size:12px; color:#64748b;">${date}${year ? ` (${year})` : ""}</div>
          <div style="margin-top:2px; font-size:12px; color:#94a3b8;">${propertyTypeLabel}</div>

          <div style="margin-top:10px; display:grid; grid-template-columns:1fr; gap:6px;">
            <div style="display:flex;justify-content:space-between;gap:8px;font-size:12px;color:#64748b;">
              <span>Last price</span>
              <span style="color:#0f172a;font-weight:600;">£${price ? Number(price).toLocaleString() : "—"}</span>
            </div>
            <div style="display:flex;justify-content:space-between;gap:8px;font-size:12px;color:#64748b;">
              <span>Adj. ${latestYear ?? ""}</span>
              ${inflationLine}
            </div>
            ${sectorLine}
            <div style="font-size:10px; color:#94a3b8;">${inflationMeta}</div>
          </div>
        </div>
      `;

      clickPopup.setLngLat([targetLng, targetLat]).setHTML(html).addTo(map);
    },
    []
  );

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
          "heatmap-weight": [
            "interpolate",
            ["linear"],
            ["get", "affordability_score"],
            0,
            0,
            1,
            1,
          ],
          "heatmap-intensity": 1.2,
          "heatmap-radius": 26,
          "heatmap-opacity": 0.75,
          "heatmap-color": [
            "interpolate",
            ["linear"],
            ["heatmap-density"],
            0,
            "rgba(15,23,42,0)",
            0.25,
            "#0ea5e9",
            0.5,
            "#22c55e",
            0.7,
            "#f59e0b",
            0.9,
            "#ef4444",
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
      clickPopupRef.current = clickPopup;

      map.on("mousemove", "sector-points", (event) => {
        if (!showCentroidsRef.current) return;
        const feature = event.features?.[0];
        if (!feature || !event.lngLat) return;
        const props = feature.properties || {};
        const sector = props.sector || "Sector";
        const median = Number(props.median_price || 0);
        const medianAdj = Number(props.median_price_adj || 0);
        const transactions = Number(props.transactions || 0);
        const html = `
          <div style="font-size:12px">
            <div style="font-weight:600">${sector}</div>
            <div>Median price: £${median.toLocaleString()}</div>
            ${medianAdj ? `<div>Adj. price: £${medianAdj.toLocaleString()}</div>` : ""}
            <div>Affordable latest sales: ${transactions}</div>
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
        showNearestAt(event.lngLat.lng, event.lngLat.lat).catch(() => {});
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

  useEffect(() => {
    if (!selectedSector) return;
    if (!Number.isFinite(selectedSector.longitude) || !Number.isFinite(selectedSector.latitude)) return;
    const label = `Best-fit · ${selectedSector.sector}`;
    const sectorMedian = selectedSector.median_price ?? null;
    const sectorMedianAdj =
      selectedSector.median_price_adj ?? selectedSector.inflation_adjusted_price ?? null;
    showNearestAt(selectedSector.longitude, selectedSector.latitude, {
      label,
      sectorMedian,
      sectorMedianAdj,
    }).catch(() => {});
  }, [selectedSector, showNearestAt]);

  return <div ref={containerRef} className="h-full min-h-[520px] w-full" />;
}
