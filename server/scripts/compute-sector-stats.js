import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import pg from "pg";

const { Pool } = pg;

dotenv.config();

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is not set");
}

const pool = new Pool({ connectionString: databaseUrl });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const schemaPath = path.join(__dirname, "..", "sql", "sector_stats.sql");

async function ensureSchema() {
  const sql = fs.readFileSync(schemaPath, "utf-8");
  await pool.query(sql);
}

async function compute() {
  await ensureSchema();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("TRUNCATE TABLE sector_stats;");

    await client.query(
      `
        INSERT INTO sector_stats (sector, median_price, avg_price, transactions, latitude, longitude, updated_at)
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
          WHERE pp.postcode IS NOT NULL
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
        SELECT *, now() AS updated_at FROM sectors;
      `
    );

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  console.log("sector_stats refreshed");
}

compute()
  .then(() => pool.end())
  .catch((err) => {
    console.error(err);
    pool.end();
    process.exit(1);
  });
