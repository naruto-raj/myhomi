import { pool } from "../db.js";

export async function getSectorsInViewport(bbox, limit = 500) {
  const [minLng, minLat, maxLng, maxLat] = bbox;
  const { rows } = await pool.query(
    `
      WITH filtered AS (
        SELECT
          pp.price,
          pp.postcode,
          pc.latitude,
          pc.longitude,
          regexp_replace(pp.postcode, '\\s+.*', '') AS outward,
          substring(pp.postcode from '\\s+(.+)') AS inward
        FROM price_paid pp
        JOIN postcode_coords pc ON pc.postcode_norm = pp.postcode_norm
        WHERE pc.geom && ST_MakeEnvelope($1, $2, $3, $4, 4326)
          AND pp.postcode IS NOT NULL
      ),
      sectors AS (
        SELECT
          outward || ' ' || substring(inward, 1, 1) AS sector,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY price) AS median_price,
          AVG(price)::int AS avg_price,
          COUNT(*)::int AS transactions,
          AVG(latitude) AS latitude,
          AVG(longitude) AS longitude
        FROM filtered
        WHERE inward IS NOT NULL
        GROUP BY sector
      )
      SELECT * FROM sectors
      ORDER BY transactions DESC
      LIMIT $5;
    `,
    [minLng, minLat, maxLng, maxLat, limit]
  );
  return rows;
}
