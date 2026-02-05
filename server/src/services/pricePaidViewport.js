import { pool } from "../db.js";

export async function getPricePaidInViewport(bbox, limit = 2000) {
  const [minLng, minLat, maxLng, maxLat] = bbox;
  const { rows } = await pool.query(
    `
      SELECT
        pp.transaction_id,
        pp.price,
        pp.date_of_transfer,
        pc.latitude,
        pc.longitude,
        pp.postcode
      FROM price_paid pp
      JOIN postcode_coords pc
        ON pc.postcode_norm = pp.postcode_norm
      WHERE pc.geom && ST_MakeEnvelope($1, $2, $3, $4, 4326)
      LIMIT $5;
    `,
    [minLng, minLat, maxLng, maxLat, limit]
  );
  return rows;
}
