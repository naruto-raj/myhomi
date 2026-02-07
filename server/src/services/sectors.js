import { pool } from "../db.js";

export async function getSectorsInViewport(bbox, limit = 500) {
  const [minLng, minLat, maxLng, maxLat] = bbox;
  const { rows } = await pool.query(
    `
      SELECT
        sector,
        median_price,
        avg_price,
        median_price_adj,
        avg_price_adj,
        transactions,
        latitude,
        longitude,
        updated_at
      FROM sector_centroids
      WHERE geom && ST_MakeEnvelope($1, $2, $3, $4, 4326)
      ORDER BY transactions DESC
      LIMIT $5;
    `,
    [minLng, minLat, maxLng, maxLat, limit]
  );
  return rows;
}
