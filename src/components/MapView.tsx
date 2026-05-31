import { useCallback, useEffect, useMemo, useRef } from "react";
import maplibregl, { Map } from "maplibre-gl";
import { Protocol } from "pmtiles";
import type { AffordableHeatmapPoint, PricePaidPoint, SectorStat } from "../api/client";
import { fetchCommute, fetchCouncilTax, fetchNearestAffordablePostcode, fetchNearestPostcode } from "../api/client";

type Props = {
  pricePaidPoints: PricePaidPoint[];
  sectors: SectorStat[];
  affordableHeatmap: AffordableHeatmapPoint[];
  showHeatmap: boolean;
  showCentroids: boolean;
  showBestFit: boolean;
  councilTaxMonthly?: number;
  affordability?: {
    incomeAnnual?: number;
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
  tenureFilter?: string;
  selectedSector?: SectorStat | null;
  onCouncilTaxUpdate?: (postcode: string) => void;
  onNearestSelected?: (payload: {
    latitude: number;
    longitude: number;
    postcode?: string | null;
    price?: number | null;
  }) => void;
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
  tenureFilter,
  selectedSector,
  councilTaxMonthly = 0,
  onCouncilTaxUpdate,
  onNearestSelected,
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
  // Sectors data ref — the click handler (set up once in a useEffect) needs
  // to read the latest sector list to find the nearest centroid when the
  // user clicks off-data at high zoom.
  const sectorsRef = useRef<Props["sectors"]>(sectors);

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
    sectorsRef.current = sectors;
  }, [sectors]);

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

      // Two-stage popup:
      // Stage 1 — fast — fetch the geographic-nearest affordable property
      //           WITHOUT workplace, render the popup immediately with
      //           everything we know (price, mortgage, council tax). The
      //           commute row shows a spinner if a commute lookup is coming.
      // Stage 2 — async — fire /api/commute separately. When it lands,
      //           re-render the popup with real commute values + recompute
      //           All-in monthly and Budget remaining. The popup is never
      //           blocked by TfL latency.
      const willFetchCommute = Boolean(
        showBestFitRef.current &&
          affordabilityValue?.workplacePostcode &&
          String(affordabilityValue?.commuteMode || "").toUpperCase().startsWith("PUB")
      );

      if (showBestFitRef.current && affordabilityValue) {
        try {
          result = await fetchNearestAffordablePostcode(
            lat,
            lng,
            affordabilityValue,
            propertyTypeValue,
            tenureFilter,
            {
              // Intentionally omit workplacePostcode/commuteMode here. We
              // want a fast geographic-nearest response — the heatmap has
              // already filtered the area by affordability, so the popup
              // doesn't need to re-pick the property using commute-adjusted
              // budget. Commute is fetched separately for display only.
            }
          );
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
      let councilTaxForPostcode = councilTaxMonthly;
      if (row?.postcode) {
        if (onCouncilTaxUpdate) {
          onCouncilTaxUpdate(row.postcode);
        }
        try {
          const ct = await fetchCouncilTax(row.postcode);
          if (Number.isFinite(ct?.monthly_estimate ?? NaN)) {
            councilTaxForPostcode = ct.monthly_estimate ?? councilTaxMonthly;
          }
        } catch {
          // keep current value
        }
      }
      const targetLat = row?.latitude ?? lat;
      const targetLng = row?.longitude ?? lng;
      const selectedPrice =
        result.meta?.price_for_mortgage ??
        result.meta?.inflation_adjusted_price ??
        (row?.price ?? null);
      if (onNearestSelected && Number.isFinite(targetLat) && Number.isFinite(targetLng)) {
        onNearestSelected({
          latitude: targetLat,
          longitude: targetLng,
          postcode: row?.postcode ?? null,
          price: Number.isFinite(selectedPrice ?? NaN) ? Number(selectedPrice) : null,
        });
      }
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
      const epc = result.epc ?? null;
      const floorAreaM2 = epc?.floor_area_m2 ?? null;
      const floorAreaSqft =
        epc?.floor_area_sqft ?? (floorAreaM2 ? Math.round(Number(floorAreaM2) * 10.7639) : null);
      const pct = result.meta?.inflation_percent_change ?? null;
      const pctText = pct !== null ? `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%` : "—";
      const arrow = pct === null ? "" : pct > 0 ? "▲" : pct < 0 ? "▼" : "•";
      const color = pct === null ? "#0f172a" : pct > 0 ? "#16a34a" : pct < 0 ? "#dc2626" : "#64748b";
      const baseYear = result.meta?.inflation_base_year ?? null;
      const latestYear = result.meta?.inflation_latest_year ?? null;
      const baseIndex = result.meta?.inflation_base_index ?? null;
      const latestIndex = result.meta?.inflation_latest_index ?? null;
      const mortgageMonthly = result.meta?.mortgage_monthly ?? null;
      const councilTax = Number.isFinite(councilTaxForPostcode) ? councilTaxForPostcode : 0;
      const monthlyBudget = Number(affordabilityValue?.monthlyBudget) || null;
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

      map.easeTo({
        center: [targetLng, targetLat],
        zoom: Math.max(map.getZoom(), 13),
        speed: 1.2,
        offset: [0, -140],
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

      const floorAreaLine = `<div style="display:flex;justify-content:space-between;gap:8px;font-size:12px;color:#64748b;">
          <span>Floor area (EPC)</span>
          <span style="color:#0f172a;font-weight:600;">
            ${
              floorAreaM2 || floorAreaSqft
                ? `${floorAreaM2 ? `${Math.round(Number(floorAreaM2))} m²` : ""}${
                    floorAreaSqft ? ` · ${Math.round(Number(floorAreaSqft))} sq ft` : ""
                  }`
                : "—"
            }
          </span>
        </div>`;

      const sectorLine =
        options?.sectorMedianAdj
          ? `<div style="display:flex;justify-content:space-between;gap:8px;font-size:12px;color:#64748b;">
              <span>Sector adj. ${latestYear ?? ""}</span>
              <span style="color:#0f172a;font-weight:600;">£${Number(options.sectorMedianAdj).toLocaleString()}</span>
            </div>`
          : "";

      // Commute state for the popup. Stage 1 sets this to "loading" (if we
      // expect a commute lookup) or "none"; stage 2 swaps in "ready" or "error".
      type CommuteState =
        | { status: "loading" }
        | { status: "none" }
        | { status: "error"; message?: string }
        | {
            status: "ready";
            duration_sec: number | null;
            distance_km: number | null;
            cost_monthly: number | null;
            mode: string;
          };

      const renderHtml = (commuteState: CommuteState) => {
        const isPublic =
          commuteState.status === "ready" ? commuteState.mode === "PUBLIC" : willFetchCommute;

        const sourceTag = isPublic
          ? `<span style="display:inline-flex;align-items:center;gap:4px;border:1px solid #cbd5f5;background:#eef2ff;color:#4338ca;border-radius:999px;padding:1px 6px;font-size:9px;font-weight:600;">TfL</span>`
          : `<span style="display:inline-flex;align-items:center;gap:4px;border:1px solid #e2e8f0;background:#f8fafc;color:#64748b;border-radius:999px;padding:1px 6px;font-size:9px;font-weight:600;">Route</span>`;

        // Right-hand value of the commute row + the cost number we use for
        // total/budget recompute below.
        let commuteValueHtml: string;
        let commuteCostForTotals = 0;
        switch (commuteState.status) {
          case "loading":
            commuteValueHtml = `<span style="display:inline-flex;align-items:center;gap:6px;color:#64748b;font-weight:500;">
              <span class="ms-spin-12" style="display:inline-block;width:10px;height:10px;border:2px solid #cbd5e1;border-top-color:#10b981;border-radius:50%;animation:ms-spin 0.8s linear infinite;"></span>
              <span style="font-size:11px;">fetching…</span>
            </span>`;
            break;
          case "error":
            commuteValueHtml = `<span style="color:#94a3b8;font-size:11px;">unavailable</span>`;
            break;
          case "ready": {
            const mins =
              commuteState.duration_sec != null
                ? Math.round(commuteState.duration_sec / 60)
                : null;
            const km =
              Number.isFinite(commuteState.distance_km ?? NaN)
                ? Number(commuteState.distance_km).toFixed(1)
                : null;
            // TfL's Journey Planner only computes leg.distance for walking
            // legs (tube/rail/bus legs return 0), so summed distance for a
            // PUBLIC journey is the *walking portion* of the trip. Label it
            // so users don't read it as the total journey distance. For
            // non-PUBLIC routes the distance is real road km from ORS.
            const kmLabel = commuteState.mode === "PUBLIC" ? "km walk" : "km";
            const cost = commuteState.cost_monthly;
            commuteCostForTotals = Number.isFinite(cost ?? NaN) ? Number(cost) : 0;
            commuteValueHtml = `
              ${mins !== null ? `${mins} min` : "—"}
              ${km !== null ? ` · ${km} ${kmLabel}` : ""}
              ${cost !== null ? ` · £${Math.round(cost).toLocaleString()}/mo` : ""}
            `;
            break;
          }
          case "none":
          default:
            commuteValueHtml = `<span style="color:#94a3b8;">—</span>`;
            break;
        }

        const commuteLine =
          commuteState.status === "none"
            ? "" // No workplace / not public — skip the row entirely
            : `<div style="display:flex;justify-content:space-between;gap:8px;font-size:12px;color:#64748b;">
                <span>Commute (est.) ${sourceTag}</span>
                <span style="color:#0f172a;font-weight:600;">${commuteValueHtml}</span>
              </div>`;

        const mortgageLine =
          mortgageMonthly !== null
            ? `<div style="display:flex;justify-content:space-between;gap:8px;font-size:12px;color:#64748b;">
                <span>Mortgage / mo</span>
                <span style="color:#0f172a;font-weight:600;">£${Math.round(mortgageMonthly).toLocaleString()}</span>
              </div>`
            : "";

        const councilTaxLine =
          councilTax > 0
            ? `<div style="display:flex;justify-content:space-between;gap:8px;font-size:12px;color:#64748b;">
                <span>Council tax (est. / mo)</span>
                <span style="color:#0f172a;font-weight:600;">£${Math.round(councilTax).toLocaleString()}</span>
              </div>`
            : "";

        // All-in monthly: mortgage + council tax + commute (if known, else 0).
        const allInMonthly =
          mortgageMonthly !== null
            ? Math.round(mortgageMonthly + councilTax + commuteCostForTotals)
            : null;
        const allInLine =
          allInMonthly !== null
            ? `<div style="display:flex;justify-content:space-between;gap:8px;font-size:12px;color:#64748b;">
                <span>All-in monthly</span>
                <span style="color:#0f172a;font-weight:600;">£${allInMonthly.toLocaleString()}</span>
              </div>`
            : "";

        const budgetRemainingAllIn =
          monthlyBudget !== null && allInMonthly !== null
            ? Math.round(monthlyBudget - allInMonthly)
            : null;
        const budgetLine =
          budgetRemainingAllIn !== null
            ? (() => {
                const isPositive = budgetRemainingAllIn >= 0;
                const arrow = isPositive ? "▲" : "▼";
                const color = isPositive ? "#16a34a" : "#dc2626";
                return `<div style="display:flex;justify-content:space-between;gap:8px;font-size:12px;color:#64748b;">
                  <span>Budget remaining</span>
                  <span style="color:${color};font-weight:700;display:inline-flex;align-items:center;gap:6px;">
                    ${arrow} £${Math.abs(budgetRemainingAllIn).toLocaleString()}
                  </span>
                </div>`;
              })()
            : "";

        // Tiny "⟳ TfL" badge near the percent pill while we're fetching, so
        // the user knows fares are arriving even before the row updates.
        const topRightStatus =
          commuteState.status === "loading"
            ? `<span title="Fetching real TfL fare" style="display:inline-flex;align-items:center;gap:4px;padding:2px 6px;border-radius:999px;background:#eef2ff;color:#4338ca;font-size:9px;font-weight:600;">
                <span style="display:inline-block;width:8px;height:8px;border:1.5px solid #c7d2fe;border-top-color:#4338ca;border-radius:50%;animation:ms-spin 0.8s linear infinite;"></span>
                TfL
              </span>`
            : "";

        return `
          <div class="map-popup">
            <div class="map-popup__card" style="max-width:280px;padding:12px;">
              <button type="button" class="map-popup__close" aria-label="Close">×</button>
              <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
                <div style="font-size:9px; letter-spacing:0.16em; text-transform:uppercase; color:#64748b;">${label}</div>
                <div style="display:inline-flex;align-items:center;gap:6px;">
                  ${topRightStatus}
                  ${pctBadge}
                </div>
              </div>
              <div style="margin-top:6px; font-size:16px; font-weight:700; color:#0f172a; font-family:var(--font-display, ui-serif, Georgia, serif);">
                ${row?.postcode ?? "Nearest sale"}
              </div>
              <div style="margin-top:4px; display:flex; flex-wrap:wrap; gap:6px;">
                <span style="padding:2px 8px; border-radius:999px; background:#fef3c7; font-size:10px; color:#92400e;">
                  ${propertyTypeLabel}
                </span>
              </div>

              <div style="margin-top:8px; padding:8px; border-radius:10px; background:#f8fafc; border:1px solid #e2e8f0;">
                <div style="display:flex;justify-content:space-between;align-items:end;gap:8px;">
                  <span style="font-size:10px; color:#64748b;">Adj. ${latestYear ?? ""}</span>
                  ${inflationLine}
                </div>
                <div style="margin-top:6px; display:flex;justify-content:space-between;align-items:end;gap:8px;">
                  <span style="font-size:10px; color:#64748b;">Last price</span>
                  <span style="font-size:13px; font-weight:600; color:#0f172a;">
                    £${price ? Number(price).toLocaleString() : "—"}
                  </span>
                </div>
                <div style="margin-top:2px; font-size:10px; color:#94a3b8;">
                  ${date}${year ? ` (${year})` : ""}
                </div>
              </div>

              <div style="margin-top:8px; display:grid; grid-template-columns:1fr; gap:4px;">
                ${sectorLine}
                ${floorAreaLine}
                ${commuteLine}
                ${mortgageLine}
                ${councilTaxLine}
                ${allInLine}
                ${budgetLine}
                <div style="font-size:9px; color:#94a3b8;">${inflationMeta}</div>
              </div>
            </div>
            <style>@keyframes ms-spin { to { transform: rotate(360deg); } }</style>
          </div>
        `;
      };

      const wirePopup = () => {
        const popupEl = clickPopup.getElement();
        const closeButton = popupEl?.querySelector(".map-popup__close");
        if (closeButton) {
          (closeButton as HTMLElement).onclick = () => clickPopup.remove();
        }
      };

      map.easeTo({
        center: [targetLng, targetLat],
        zoom: Math.max(map.getZoom(), 13),
        speed: 1.2,
        offset: [0, -140],
      });

      // Stage 1: render immediately with whatever we already know. Commute
      // row shows a spinner if a public-transport workplace was set.
      const initialState: CommuteState = willFetchCommute
        ? { status: "loading" }
        : { status: "none" };
      clickPopup.setLngLat([targetLng, targetLat]).setHTML(renderHtml(initialState)).addTo(map);
      wirePopup();

      // Stage 2: async commute fetch. Re-render the popup when it lands.
      // Track the popup identity via the close button DOM so a late response
      // for a closed/replaced popup doesn't repaint the wrong thing.
      if (willFetchCommute && row?.postcode && affordabilityValue?.workplacePostcode) {
        const openWhileFetching = clickPopup;
        fetchCommute(
          row.postcode,
          affordabilityValue.workplacePostcode,
          affordabilityValue.commuteMode || "PUBLIC",
          Number(affordabilityValue.commuteDaysPerWeek) || 5
        )
          .then((c) => {
            if (openWhileFetching !== clickPopupRef.current) return; // popup replaced
            if (!openWhileFetching.isOpen()) return; // user closed it
            const hasData =
              c.cost_monthly !== null ||
              c.duration_sec !== null ||
              c.distance_km !== null;
            const next: CommuteState = hasData
              ? {
                  status: "ready",
                  duration_sec: c.duration_sec,
                  distance_km: c.distance_km,
                  cost_monthly: c.cost_monthly,
                  mode: c.mode,
                }
              : { status: "error", message: c.error || undefined };
            openWhileFetching.setHTML(renderHtml(next));
            wirePopup();
          })
          .catch(() => {
            if (openWhileFetching !== clickPopupRef.current) return;
            if (!openWhileFetching.isOpen()) return;
            openWhileFetching.setHTML(renderHtml({ status: "error" }));
            wirePopup();
          });
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
            0.3,
            1,
            1,
          ],
          "heatmap-intensity": [
            "interpolate",
            ["linear"],
            ["zoom"],
            5,
            0.9,
            9,
            1.7,
            12,
            2.2,
            14,
            2.6,
            16,
            3.0,
          ],
          // Radius keeps growing past zoom 12 so individual points stay
          // covered at street view. Without this the heatmap collapses into
          // a few tiny dots and the page looks empty even where data exists.
          "heatmap-radius": [
            "interpolate",
            ["linear"],
            ["zoom"],
            5,
            26,
            9,
            34,
            12,
            48,
            14,
            80,
            16,
            140,
          ],
          // Constant opacity — the heatmap is the visualization at every
          // zoom level. Sector circles only show when the user explicitly
          // turns them on via the 'Show centroids' toggle.
          "heatmap-opacity": 0.9,
          "heatmap-color": [
            "interpolate",
            ["linear"],
            ["heatmap-density"],
            0,
            "rgba(15,23,42,0.12)",
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

        // When the affordability heatmap or sector circles are visible, only
        // show a popup if the click actually landed on rendered features —
        // not on an arbitrary point in space that happens to be miles from
        // the nearest data. queryRenderedFeatures returns the source features
        // contributing to the pixel under the cursor, which for a heatmap
        // means "within the rendered radius of any data point." Empty result
        // = the user clicked on an area with no affordable property nearby.
        const interactiveLayers: string[] = [];
        if (
          map.getLayer("best-fit-heat") &&
          map.getLayoutProperty("best-fit-heat", "visibility") !== "none"
        ) {
          interactiveLayers.push("best-fit-heat");
        }
        if (
          map.getLayer("sector-points") &&
          map.getLayoutProperty("sector-points", "visibility") !== "none"
        ) {
          interactiveLayers.push("sector-points");
        }
        if (interactiveLayers.length) {
          // Query a generous box around the click, not a single pixel. The
          // size of the halo depends on what's being shown:
          //   • zoom < 13 → heatmap-dominant view, blobs are 48–140 px wide,
          //     so a 28 px halo is comfortable without feeling magnetic.
          //   • zoom ≥ 13 → discrete centroid circles (4–16 px each), so a
          //     tighter 14 px halo keeps the click feeling precise — you're
          //     clicking on or near a specific dot, not anywhere in a blob.
          const TOLERANCE_PX = map.getZoom() >= 13 ? 14 : 28;
          const { x, y } = event.point;
          const features = map.queryRenderedFeatures(
            [
              [x - TOLERANCE_PX, y - TOLERANCE_PX],
              [x + TOLERANCE_PX, y + TOLERANCE_PX],
            ],
            { layers: interactiveLayers }
          );
          if (features.length === 0) {
            // Empty click. At any zoom, navigate to the nearest sector
            // centroid and open the popup there. The user clicked because
            // they want to see data — even if they missed every rendered
            // feature, we should be helpful and bring them to the closest
            // useful spot rather than doing nothing.
            //
            // Zoom is preserved (we just pan). Cap distance generously so
            // a stray click somewhere with no data nearby doesn't fling
            // the camera across the country.
            const NAV_MAX_KM = 50;
            const currentZoom = map.getZoom();
            if (sectorsRef.current.length) {
              const clickLng = event.lngLat.lng;
              const clickLat = event.lngLat.lat;
              let nearest: { longitude: number; latitude: number } | null = null;
              let minSqDeg = Infinity;
              for (const s of sectorsRef.current) {
                const lng = Number(s.longitude);
                const lat = Number(s.latitude);
                if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
                // Squared distance in degrees — fine for finding the nearest,
                // we'll convert to km only for the cap check below.
                const dLng = lng - clickLng;
                const dLat = lat - clickLat;
                const sq = dLng * dLng + dLat * dLat;
                if (sq < minSqDeg) {
                  minSqDeg = sq;
                  nearest = { longitude: lng, latitude: lat };
                }
              }
              if (nearest) {
                // 1° ≈ 111 km. Close enough at UK latitudes (~70km at 1° lng,
                // ~111km at 1° lat — averaging gives a useful upper bound).
                const approxKm = Math.sqrt(minSqDeg) * 111;
                if (approxKm <= NAV_MAX_KM) {
                  const target = nearest;
                  map.flyTo({
                    center: [target.longitude, target.latitude],
                    zoom: currentZoom, // preserve the user's current zoom
                    speed: 1.4,
                  });
                  // Open the popup once the flyTo settles. moveend fires once
                  // the camera is in place; remove the listener immediately
                  // after to avoid re-firing on every subsequent pan.
                  const onSettled = () => {
                    map.off("moveend", onSettled);
                    showNearestAt(target.longitude, target.latitude).catch(() => {});
                  };
                  map.on("moveend", onSettled);
                }
              }
            }
            return;
          }
        }

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
    if (map.getLayer("best-fit-heat")) {
      map.setLayoutProperty("best-fit-heat", "visibility", showBestFit ? "visible" : "none");
    }
    if (map.getLayer("sector-points")) {
      map.setLayoutProperty(
        "sector-points",
        "visibility",
        showCentroids ? "visible" : "none"
      );
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
