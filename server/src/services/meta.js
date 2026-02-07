import { pool } from "../db.js";

let cached = null;
let cachedAt = 0;
const TTL_MS = 60 * 60 * 1000;

export async function getDataMeta() {
  const now = Date.now();
  if (cached && now - cachedAt < TTL_MS) return cached;
  const { rows } = await pool.query(`SELECT key, value FROM data_meta;`);
  const meta = rows.reduce((acc, row) => {
    acc[row.key] = row.value;
    return acc;
  }, {});
  cached = meta;
  cachedAt = now;
  return meta;
}
