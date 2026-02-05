import { useEffect, useMemo, useRef } from "react";
import maplibregl, { Map } from "maplibre-gl";
import { Protocol } from "pmtiles";
import type { ScoredRegion } from "../api/client";

type Props = {
  regions: ScoredRegion[];
  onSelect: (id: string) => void;
  selectedId: string | null;
};

const MAP_STYLE_URL = import.meta.env.VITE_MAP_STYLE_URL || "/tiles/style.json";

function toGeoJson(regions: ScoredRegion[]) {
  return {
    type: "FeatureCollection",
    features: regions.map((item) => ({
      type: "Feature",
      id: item.region.id,
      properties: {
        id: item.region.id,
        name: item.region.name,
        feasible: item.feasible,
      },
      geometry: {
        type: "Polygon",
        coordinates: [item.region.polygon.map(([lat, lng]) => [lng, lat])],
      },
    })),
  } as GeoJSON.FeatureCollection;
}

function toPointGeoJson(regions: ScoredRegion[]) {
  return {
    type: "FeatureCollection",
    features: regions.map((item) => ({
      type: "Feature",
      id: `${item.region.id}-pt`,
      properties: {
        id: item.region.id,
        name: item.region.name,
        feasible: item.feasible,
      },
      geometry: {
        type: "Point",
        coordinates: [item.region.center[1], item.region.center[0]],
      },
    })),
  } as GeoJSON.FeatureCollection;
}

export default function MapView({ regions, onSelect, selectedId }: Props) {
  const mapRef = useRef<Map | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const polygons = useMemo(() => toGeoJson(regions), [regions]);
  const points = useMemo(() => toPointGeoJson(regions), [regions]);

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
      map.addSource("regions", {
        type: "geojson",
        data: polygons,
      });
      map.addSource("region-points", {
        type: "geojson",
        data: points,
      });

      map.addLayer({
        id: "region-fill",
        type: "fill",
        source: "regions",
        paint: {
          "fill-color": [
            "case",
            ["boolean", ["get", "feasible"], false],
            "#10b981",
            "#0f172a",
          ],
          "fill-opacity": [
            "case",
            ["boolean", ["get", "feasible"], false],
            0.35,
            0.2,
          ],
        },
      });

      map.addLayer({
        id: "region-outline",
        type: "line",
        source: "regions",
        paint: {
          "line-color": [
            "case",
            ["boolean", ["get", "feasible"], false],
            "#34d399",
            "#475569",
          ],
          "line-width": 2,
        },
      });

      map.addLayer({
        id: "region-points",
        type: "circle",
        source: "region-points",
        paint: {
          "circle-radius": [
            "case",
            ["boolean", ["get", "feasible"], false],
            7,
            5,
          ],
          "circle-color": [
            "case",
            ["boolean", ["get", "feasible"], false],
            "#22c55e",
            "#94a3b8",
          ],
          "circle-opacity": 0.9,
        },
      });

      map.addLayer({
        id: "region-selected",
        type: "line",
        source: "regions",
        paint: {
          "line-color": "#facc15",
          "line-width": 3,
        },
        filter: ["==", ["get", "id"], selectedId ?? ""],
      });

      map.on("click", "region-fill", (event) => {
        const feature = event.features?.[0];
        const id = feature?.properties?.id;
        if (typeof id === "string") {
          onSelect(id);
        }
      });

      map.on("click", "region-points", (event) => {
        const feature = event.features?.[0];
        const id = feature?.properties?.id;
        if (typeof id === "string") {
          onSelect(id);
        }
      });

      map.on("mouseenter", "region-fill", () => {
        map.getCanvas().style.cursor = "pointer";
      });
      map.on("mouseleave", "region-fill", () => {
        map.getCanvas().style.cursor = "";
      });
    });

    return () => {
      map.remove();
      maplibregl.removeProtocol("pmtiles");
      mapRef.current = null;
    };
  }, [onSelect, polygons, points, selectedId]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.getSource("regions")) return;

    const source = map.getSource("regions") as maplibregl.GeoJSONSource;
    source.setData(polygons);

    const pointSource = map.getSource("region-points") as maplibregl.GeoJSONSource;
    pointSource.setData(points);

    if (map.getLayer("region-selected")) {
      map.setFilter("region-selected", ["==", ["get", "id"], selectedId ?? ""]);
    }
  }, [polygons, points, selectedId]);

  return <div ref={containerRef} className="h-full min-h-[520px] w-full" />;
}
