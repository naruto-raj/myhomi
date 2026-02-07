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
const cpihSchemaPath = path.join(__dirname, "..", "sql", "cpih_annual.sql");
const postcodeLatestSchemaPath = path.join(__dirname, "..", "sql", "postcode_latest.sql");
const cpihDataPath = path.join(__dirname, "..", "data", "cpih_annual.json");

async function ensureSchema() {
  const statsSql = fs.readFileSync(schemaPath, "utf-8");
  const centroidsSql = fs.readFileSync(centroidSchemaPath, "utf-8");
  const metaSql = fs.readFileSync(metaSchemaPath, "utf-8");
  const cpihSql = fs.readFileSync(cpihSchemaPath, "utf-8");
  const postcodeLatestSql = fs.readFileSync(postcodeLatestSchemaPath, "utf-8");
  await pool.query(cpihSql);
  await pool.query(postcodeLatestSql);
  await pool.query(statsSql);
  await pool.query(centroidsSql);
  await pool.query(metaSql);
}

async function loadCpih(client) {
  const raw = fs.readFileSync(cpihDataPath, "utf-8");
  const cpih = JSON.parse(raw);
  const entries = Object.entries(cpih)
    .map(([year, index]) => [Number(year), Number(index)])
    .filter(([year, index]) => Number.isFinite(year) && Number.isFinite(index))
    .sort((a, b) => a[0] - b[0]);

  if (!entries.length) {
    throw new Error("CPIH data is empty. Run scripts/fetch-cpih.js first.");
  }

  await client.query("TRUNCATE TABLE cpih_annual;");
  const values = [];
  const placeholders = entries.map((_, i) => {
    const offset = i * 2;
    values.push(entries[i][0], entries[i][1]);
    return `($${offset + 1}, $${offset + 2})`;
  });
  await client.query(
    `INSERT INTO cpih_annual (year, index) VALUES ${placeholders.join(",")};`,
    values
  );
}

async function compute() {
  await ensureSchema();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await loadCpih(client);
    await client.query("TRUNCATE TABLE sector_stats;");
    await client.query("TRUNCATE TABLE sector_centroids;");
    await client.query("TRUNCATE TABLE postcode_latest;");

    await client.query(
      `
        CREATE TEMP TABLE sectors_tmp AS
        WITH latest_cpih AS (
          SELECT year AS latest_year, index AS latest_index
          FROM cpih_annual
          ORDER BY year DESC
          LIMIT 1
        ),
        filtered AS (
          SELECT
            pp.price,
            pp.postcode,
            pc.latitude,
            pc.longitude,
            regexp_replace(pp.postcode, '\\s+.*', '') AS outward,
            substring(pp.postcode from '\\s+(.+)') AS inward,
            EXTRACT(YEAR FROM pp.date_of_transfer)::int AS tx_year,
            cpih.index AS base_index,
            latest_cpih.latest_index AS latest_index,
            (pp.price * (latest_cpih.latest_index / cpih.index)) AS price_adj
          FROM price_paid pp
          JOIN postcode_coords pc ON pc.postcode_norm = pp.postcode_norm
          JOIN cpih_annual cpih ON cpih.year = EXTRACT(YEAR FROM pp.date_of_transfer)::int
          CROSS JOIN latest_cpih
          WHERE pp.postcode IS NOT NULL
        ),
        sectors AS (
          SELECT
            outward || ' ' || substring(inward, 1, 1) AS sector,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY price) AS median_price,
            AVG(price)::int AS avg_price,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY price_adj) AS median_price_adj,
            AVG(price_adj) AS avg_price_adj,
            COUNT(*)::int AS transactions,
            AVG(latitude) AS latitude,
            AVG(longitude) AS longitude
          FROM filtered
          WHERE inward IS NOT NULL
          GROUP BY sector
        )
        SELECT
          sector,
          median_price,
          avg_price,
          ROUND(median_price_adj)::int AS median_price_adj,
          ROUND(avg_price_adj)::int AS avg_price_adj,
          transactions,
          latitude,
          longitude
        FROM sectors;
      `
    );

    await client.query(
      `
        INSERT INTO sector_stats (
          sector,
          median_price,
          avg_price,
          median_price_adj,
          avg_price_adj,
          transactions,
          latitude,
          longitude,
          updated_at
        )
        SELECT
          sector,
          median_price,
          avg_price,
          median_price_adj,
          avg_price_adj,
          transactions,
          latitude,
          longitude,
          now() AS updated_at
        FROM sectors_tmp;
      `
    );

    await client.query(
      `
        INSERT INTO sector_centroids (
          sector,
          median_price,
          avg_price,
          median_price_adj,
          avg_price_adj,
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
          median_price_adj,
          avg_price_adj,
          transactions,
          latitude,
          longitude,
          ST_SetSRID(ST_MakePoint(longitude, latitude), 4326) AS geom,
          now() AS updated_at
        FROM sectors_tmp;
      `
    );

    await client.query(
      `
        INSERT INTO postcode_latest (
          postcode_norm,
          postcode,
          sector,
          property_type,
          old_new,
          duration,
          latitude,
          longitude,
          geom,
          transaction_id,
          price,
          date_of_transfer,
          price_adj,
          updated_at
        )
        WITH latest_cpih AS (
          SELECT index AS latest_index
          FROM cpih_annual
          ORDER BY year DESC
          LIMIT 1
        ),
        latest_sales AS (
          SELECT DISTINCT ON (pp.postcode_norm)
            pp.postcode_norm,
            pp.postcode,
            pp.transaction_id,
            pp.price,
            pp.date_of_transfer,
            pp.property_type,
            pp.old_new,
            pp.duration
          FROM price_paid pp
          WHERE pp.postcode_norm IS NOT NULL
          ORDER BY pp.postcode_norm, pp.date_of_transfer DESC
        )
        SELECT
          pc.postcode_norm,
          pc.postcode,
          regexp_replace(pc.postcode, '\\s+.*', '') || ' ' ||
            left(regexp_replace(pc.postcode, '^\\S+\\s+', ''), 1) AS sector,
          ls.property_type,
          ls.old_new,
          ls.duration,
          pc.latitude,
          pc.longitude,
          ST_SetSRID(ST_MakePoint(pc.longitude, pc.latitude), 4326) AS geom,
          ls.transaction_id,
          ls.price,
          ls.date_of_transfer,
          ROUND(ls.price * (latest_cpih.latest_index / cpih.index))::int AS price_adj,
          now() AS updated_at
        FROM postcode_coords pc
        JOIN latest_sales ls ON ls.postcode_norm = pc.postcode_norm
        JOIN cpih_annual cpih ON cpih.year = EXTRACT(YEAR FROM ls.date_of_transfer)::int
        CROSS JOIN latest_cpih;
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
