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
const centroidSchemaPath = path.join(__dirname, "..", "sql", "sector_centroids.sql");
const metaSchemaPath = path.join(__dirname, "..", "sql", "data_meta.sql");

async function ensureSchema() {
  const statsSql = fs.readFileSync(schemaPath, "utf-8");
  const centroidsSql = fs.readFileSync(centroidSchemaPath, "utf-8");
  const metaSql = fs.readFileSync(metaSchemaPath, "utf-8");
  await pool.query(statsSql);
  await pool.query(centroidsSql);
  await pool.query(metaSql);
}

async function compute() {
  await ensureSchema();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("TRUNCATE TABLE sector_stats;");
    await client.query("TRUNCATE TABLE sector_centroids;");

    await client.query(
      `
        CREATE TEMP TABLE sectors_tmp AS
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
        SELECT * FROM sectors;
      `
    );

    await client.query(
      `
        INSERT INTO sector_stats (sector, median_price, avg_price, transactions, latitude, longitude, updated_at)
        SELECT *, now() AS updated_at FROM sectors_tmp;
      `
    );

    await client.query(
      `
        INSERT INTO sector_centroids (
          sector,
          median_price,
          avg_price,
          transactions,
          latitude,
          longitude,
          geom,
          updated_at
        )
        SELECT
          sector,
          median_price,
          avg_price,
          transactions,
          latitude,
          longitude,
          ST_SetSRID(ST_MakePoint(longitude, latitude), 4326) AS geom,
          now() AS updated_at
        FROM sectors_tmp;
      `
    );

    const { rows: maxRows } = await client.query(
      `SELECT MAX(date_of_transfer) AS max_date FROM price_paid;`
    );
    const maxDate = maxRows[0]?.max_date;
    const maxYear = maxDate ? new Date(maxDate).getUTCFullYear() : null;

    await client.query(
      `
        INSERT INTO data_meta (key, value)
        VALUES
          ('price_paid_max_date', $1),
          ('price_paid_max_year', $2)
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
      `,
      [maxDate ? new Date(maxDate).toISOString().slice(0, 10) : "", maxYear ? String(maxYear) : ""]
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
