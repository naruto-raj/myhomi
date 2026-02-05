import { useEffect, useMemo, useRef } from "react";
import maplibregl, { Map } from "maplibre-gl";
import { Protocol } from "pmtiles";
import type { PricePaidPoint, SectorStat } from "../api/client";

type Props = {
  pricePaidPoints: PricePaidPoint[];
  sectors: SectorStat[];
  onViewportChange?: (bbox: number[], zoom: number) => void;
  focusPoint?: { latitude: number; longitude: number } | null;
};

const MAP_STYLE_URL = import.meta.env.VITE_MAP_STYLE_URL || "/tiles/style.json";

export default function MapView({
  pricePaidPoints,
  sectors,
  onViewportChange,
  focusPoint,
}: Props) {
  const mapRef = useRef<Map | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const pricePoints = useMemo(
    () => ({
      type: "FeatureCollection",
      features: pricePaidPoints.map((point) => ({
        type: "Feature",
        id: point.transaction_id,
        properties: {
          price: point.price,
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
        id: "sector-points",
        type: "circle",
        source: "sectors",
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

      map.on("mousemove", "sector-points", (event) => {
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

      if (onViewportChange) {
        const bounds = map.getBounds();
        onViewportChange(
          [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()],
          map.getZoom()
        );
      }

      map.on("moveend", () => {
        if (!onViewportChange) return;
        const bounds = map.getBounds();
        const bbox = [
          bounds.getWest(),
          bounds.getSouth(),
          bounds.getEast(),
          bounds.getNorth(),
        ];
        onViewportChange(bbox, map.getZoom());
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
    if (!map || !focusPoint) return;
    map.flyTo({
      center: [focusPoint.longitude, focusPoint.latitude],
      zoom: Math.max(map.getZoom(), 12),
      speed: 1.2,
    });
  }, [focusPoint]);

  return <div ref={containerRef} className="h-full min-h-[520px] w-full" />;
}
