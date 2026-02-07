import { pool } from "../db.js";

function getGridSize(zoom) {
  if (!Number.isFinite(zoom)) return 0.2;
  if (zoom <= 5) return 0.3;
  if (zoom <= 7) return 0.18;
  if (zoom <= 9) return 0.09;
  return 0.05;
}

export async function getAffordableHeatmap({
  bbox,
  maxPriceCap,
  propertyType,
  zoom,
  pointZoomThreshold = 10,
  limit = 5000,
}) {
  const [minLng, minLat, maxLng, maxLat] = bbox;
  const usePoints = Number.isFinite(zoom) && zoom >= pointZoomThreshold;

  if (usePoints) {
    const { rows } = await pool.query(
      `
        SELECT
          longitude,
          latitude,
          GREATEST(0, LEAST(1, 1 - (price_adj / $5))) AS weight
        FROM postcode_latest
        WHERE geom && ST_MakeEnvelope($1, $2, $3, $4, 4326)
          AND price_adj <= $5
          AND ($6::text = 'ALL' OR property_type = $6::text)
        ORDER BY price_adj ASC
        LIMIT $7;
      `,
      [minLng, minLat, maxLng, maxLat, maxPriceCap, propertyType || "ALL", limit]
    );
    return { mode: "points", rows };
  }

  const gridSize = getGridSize(zoom);
  const { rows } = await pool.query(
    `
      SELECT
        floor(longitude / $6) * $6 AS lng_bin,
        floor(latitude / $6) * $6 AS lat_bin,
        AVG(longitude) AS longitude,
        AVG(latitude) AS latitude,
        COUNT(*)::int AS count,
        SUM(GREATEST(0, LEAST(1, 1 - (price_adj / $5)))) AS weight
      FROM postcode_latest
      WHERE geom && ST_MakeEnvelope($1, $2, $3, $4, 4326)
        AND price_adj <= $5
        AND ($7::text = 'ALL' OR property_type = $7::text)
      GROUP BY lng_bin, lat_bin
      ORDER BY weight DESC
      LIMIT $8;
    `,
    [minLng, minLat, maxLng, maxLat, maxPriceCap, gridSize, propertyType || "ALL", limit]
  );
  return { mode: "grid", rows, gridSize };
}
