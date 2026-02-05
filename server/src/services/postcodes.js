import { pool } from "../db.js";

export async function getPostcodeLocation(postcode) {
  const cleaned = postcode.replace(/\s+/g, "").toUpperCase();
  const { rows } = await pool.query(
    `
      SELECT postcode, latitude, longitude
      FROM postcode_coords
      WHERE postcode_norm = $1
      LIMIT 1;
    `,
    [cleaned]
  );
  return rows[0] || null;
}
