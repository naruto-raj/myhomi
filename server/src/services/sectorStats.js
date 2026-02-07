import { pool } from "../db.js";

export async function getSectorStats(limit = 2000) {
  const { rows } = await pool.query(
    `
      SELECT sector, median_price, avg_price, median_price_adj, avg_price_adj, transactions, latitude, longitude, updated_at
      FROM sector_stats
      ORDER BY transactions DESC
      LIMIT $1;
    `,
    [limit]
  );
  return rows;
}
