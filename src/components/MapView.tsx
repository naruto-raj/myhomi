import { useCallback, useEffect, useMemo, useRef } from "react";
import maplibregl, { Map } from "maplibre-gl";
import { Protocol } from "pmtiles";
import type { AffordableHeatmapPoint, PricePaidPoint, SectorStat } from "../api/client";
import { fetchNearestAffordablePostcode, fetchNearestPostcode } from "../api/client";

type Props = {
  pricePaidPoints: PricePaidPoint[];
  sectors: SectorStat[];
  affordableHeatmap: AffordableHeatmapPoint[];
  showHeatmap: boolean;
  showCentroids: boolean;
  showBestFit: boolean;
  affordability?: {
    monthlyBudget: number;
    deposit: number;
    mortgageRate: number;
    termYears: number;
    workplacePostcode?: string | null;
    commuteMode?: string | null;
    commuteDaysPerWeek?: number | null;
    commuteCostSensitivity?: number | null;
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
  affordableHeatmap,
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
  const affordablePoints = useMemo(() => {
    const features = affordableHeatmap.flatMap((point, idx) => {
        const lng = Number(point.longitude);
        const lat = Number(point.latitude);
        if (!Number.isFinite(lng) || !Number.isFinite(lat)) return [];
        const weightRaw = Number(point.weight ?? 1);
        const countRaw = Number(point.count ?? 1);
        return [
          {
            type: "Feature",
            id: `affordable-${idx}`,
            properties: {
              weight: Number.isFinite(weightRaw) ? weightRaw : 1,
              count: Number.isFinite(countRaw) ? countRaw : 1,
            },
            geometry: {
              type: "Point",
              coordinates: [lng, lat],
            },
          } as const,
        ];
      });

    return {
      type: "FeatureCollection",
      features,
    };
  }, [affordableHeatmap]);
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
          result = await fetchNearestAffordablePostcode(lat, lng, affordabilityValue, propertyTypeValue, {
            workplacePostcode: affordabilityValue.workplacePostcode,
            commuteMode: affordabilityValue.commuteMode,
            commuteDaysPerWeek: affordabilityValue.commuteDaysPerWeek,
            commuteCostSensitivity: affordabilityValue.commuteCostSensitivity,
          });
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
      const commute = result.meta?.commute ?? null;
      const commuteMinutes = commute?.duration_sec ? Math.round(commute.duration_sec / 60) : null;
      const commuteDistance = Number.isFinite(commute?.distance_km ?? NaN)
        ? Number(commute?.distance_km).toFixed(1)
        : null;
      const commuteCost = commute?.cost_monthly ?? null;
      const mortgageMonthly = result.meta?.mortgage_monthly ?? null;
      const totalMonthlyCost = result.meta?.total_monthly_cost ?? null;
      const budgetRemaining = result.meta?.budget_remaining ?? null;
      const effectiveBudget = commute?.effective_monthly_budget ?? null;
      const affordabilityCapAdjusted = commute?.affordability_cap_adjusted ?? null;
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
          ? `<div style="color:#0f172a; font-weight:700; font-size:18px;">£${Number(adjusted).toLocaleString()}</div>`
          : `<div style="color:#94a3b8">Unavailable</div>`;

      const pctBadge =
        pct !== null
          ? `<span style="display:inline-flex;align-items:center;gap:6px;padding:2px 8px;border-radius:999px;background:${color}1A;color:${color};font-weight:600;">${arrow} ${pctText}</span>`
          : `<span style="display:inline-flex;align-items:center;padding:2px 8px;border-radius:999px;background:#e2e8f0;color:#64748b;font-weight:600;">No change</span>`;

      const inflationMeta =
        baseYear && latestYear && baseIndex && latestIndex
          ? `CPIH 2015=100: ${baseYear} ${baseIndex} → ${latestYear} ${latestIndex}`
          : "CPIH data unavailable";

      const commuteLine =
        commuteMinutes !== null || commuteCost !== null || commuteDistance !== null || totalMonthlyCost !== null
          ? `<div style="display:flex;justify-content:space-between;gap:8px;font-size:12px;color:#64748b;">
              <span>Commute</span>
              <span style="color:#0f172a;font-weight:600;">
                ${commuteMinutes !== null ? `${commuteMinutes} min` : "—"}
                ${commuteDistance !== null ? ` · ${commuteDistance} km` : ""}
                ${commuteCost !== null ? ` · £${Math.round(commuteCost).toLocaleString()}/mo` : ""}
              </span>
            </div>
            ${
              mortgageMonthly !== null
                ? `<div style=\"display:flex;justify-content:space-between;gap:8px;font-size:12px;color:#64748b;\">
                    <span>Mortgage / mo</span>
                    <span style=\"color:#0f172a;font-weight:600;\">£${Math.round(mortgageMonthly).toLocaleString()}</span>
                  </div>`
                : ""
            }
            ${
              totalMonthlyCost !== null
                ? `<div style=\"display:flex;justify-content:space-between;gap:8px;font-size:12px;color:#64748b;\">
                    <span>Total monthly cost</span>
                    <span style=\"color:#0f172a;font-weight:600;\">£${Math.round(totalMonthlyCost).toLocaleString()}</span>
                  </div>`
                : ""
            }
            ${
              budgetRemaining !== null
                ? `<div style=\"display:flex;justify-content:space-between;gap:8px;font-size:12px;color:#64748b;\">
                    <span>Budget remaining</span>
                    <span style=\"color:#0f172a;font-weight:600;\">£${Math.round(budgetRemaining).toLocaleString()}</span>
                  </div>`
                : ""
            }
            ${
              effectiveBudget !== null
                ? `<div style=\"display:flex;justify-content:space-between;gap:8px;font-size:12px;color:#64748b;\">
                    <span>Effective budget</span>
                    <span style=\"color:#0f172a;font-weight:600;\">£${Math.round(effectiveBudget).toLocaleString()}</span>
                  </div>`
                : ""
            }
            ${
              affordabilityCapAdjusted !== null
                ? `<div style=\"display:flex;justify-content:space-between;gap:8px;font-size:12px;color:#64748b;\">
                    <span>Adj. affordability</span>
                    <span style=\"color:#0f172a;font-weight:600;\">£${Math.round(affordabilityCapAdjusted).toLocaleString()}</span>
                  </div>`
                : ""
            }`
          : "";

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
        <div class="map-popup">
          <div class="map-popup__card">
            <button type="button" class="map-popup__close" aria-label="Close">×</button>
            <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
              <div style="font-size:10px; letter-spacing:0.18em; text-transform:uppercase; color:#64748b;">${label}</div>
              ${pctBadge}
            </div>
            <div style="margin-top:8px; font-size:18px; font-weight:700; color:#0f172a; font-family:var(--font-display, ui-serif, Georgia, serif);">
              ${row?.postcode ?? "Nearest sale"}
            </div>
            <div style="margin-top:6px; display:flex; flex-wrap:wrap; gap:6px;">
              <span style="padding:3px 8px; border-radius:999px; background:#fef3c7; font-size:11px; color:#92400e;">
                ${propertyTypeLabel}
              </span>
            </div>

            <div style="margin-top:12px; padding:10px; border-radius:12px; background:#f8fafc; border:1px solid #e2e8f0;">
              <div style="display:flex;justify-content:space-between;align-items:end;gap:8px;">
                <span style="font-size:11px; color:#64748b;">Adj. ${latestYear ?? ""}</span>
                ${inflationLine}
              </div>
              <div style="margin-top:8px; display:flex;justify-content:space-between;align-items:end;gap:8px;">
                <span style="font-size:11px; color:#64748b;">Last price</span>
                <span style="font-size:15px; font-weight:600; color:#0f172a;">
                  £${price ? Number(price).toLocaleString() : "—"}
                </span>
              </div>
              <div style="margin-top:4px; font-size:11px; color:#94a3b8;">
                ${date}${year ? ` (${year})` : ""}
              </div>
            </div>

            <div style="margin-top:10px; display:grid; grid-template-columns:1fr; gap:6px;">
              ${sectorLine}
              ${commuteLine}
              <div style="font-size:10px; color:#94a3b8;">${inflationMeta}</div>
            </div>
          </div>
        </div>
      `;

      clickPopup.setLngLat([targetLng, targetLat]).setHTML(html).addTo(map);
      const popupEl = clickPopup.getElement();
      const closeButton = popupEl.querySelector(".map-popup__close");
      if (closeButton) {
        closeButton.onclick = () => clickPopup.remove();
      }
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
      map.addSource("affordable", {
        type: "geojson",
        data: affordablePoints,
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
        source: "affordable",
        layout: {
          visibility: showBestFit ? "visible" : "none",
        },
        paint: {
          "heatmap-weight": [
            "interpolate",
            ["linear"],
            ["coalesce", ["get", "weight"], 1],
            0,
            0.15,
            1,
            1,
          ],
          "heatmap-intensity": [
            "interpolate",
            ["linear"],
            ["zoom"],
            5,
            0.6,
            9,
            1.2,
            12,
            1.6,
          ],
          "heatmap-radius": [
            "interpolate",
            ["linear"],
            ["zoom"],
            5,
            20,
            9,
            28,
            12,
            40,
          ],
          "heatmap-opacity": 0.85,
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
            "#f59e0b",
            0.8,
            "#f97316",
            1,
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
      const clickPopup = new maplibregl.Popup({ closeButton: false, closeOnClick: false });
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

      const emitViewport = () => {
        if (!onViewportChangeRef.current) return;
        const bounds = map.getBounds();
        const bbox = [
          bounds.getWest(),
          bounds.getSouth(),
          bounds.getEast(),
          bounds.getNorth(),
        ];
        onViewportChangeRef.current(bbox, map.getZoom());
      };

      emitViewport();

      map.on("moveend", emitViewport);
      map.on("zoomend", emitViewport);
      map.on("idle", emitViewport);
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
    const affordableSource = map.getSource("affordable") as maplibregl.GeoJSONSource;
    affordableSource.setData(affordablePoints);
  }, [pricePoints, sectorPoints, affordablePoints]);

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
