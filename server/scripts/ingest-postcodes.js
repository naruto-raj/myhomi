import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "csv-parse";
import dotenv from "dotenv";
import pg from "pg";

const { Pool } = pg;

dotenv.config();

const databaseUrl = process.env.DATABASE_URL;
const dataDir = process.env.DATA_DIR || "../data";
const csvPath =
  process.env.POSTCODE_CSV || path.join(dataDir, "postcode-directory", "ons_postcode_directory.csv");

if (!databaseUrl) {
  throw new Error("DATABASE_URL is not set");
}

const pool = new Pool({ connectionString: databaseUrl });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const schemaPath = path.join(__dirname, "..", "sql", "postcode_coords_schema.sql");

async function ensureSchema() {
  const sql = fs.readFileSync(schemaPath, "utf-8");
  await pool.query(sql);
}

function findColumnIndex(headers, candidates) {
  for (const candidate of candidates) {
    const idx = headers.indexOf(candidate);
    if (idx !== -1) return idx;
  }
  return -1;
}

async function ingest() {
  await ensureSchema();
  const client = await pool.connect();
  let count = 0;

  try {
    await client.query("BEGIN");

    const parser = fs
      .createReadStream(csvPath)
      .pipe(
        parse({
          relax_quotes: true,
          relax_column_count: true,
          trim: true,
        })
      );

    let headers = null;
    let postcodeIdx = -1;
    let latIdx = -1;
    let lonIdx = -1;

    for await (const record of parser) {
      if (!headers) {
        headers = record.map((value) => String(value).trim().toLowerCase());
        postcodeIdx = findColumnIndex(headers, ["pcds", "pcd", "postcode"]);
        latIdx = findColumnIndex(headers, ["lat", "latitude"]);
        lonIdx = findColumnIndex(headers, ["long", "longitude", "lon", "lng"]);

        if (postcodeIdx === -1 || latIdx === -1 || lonIdx === -1) {
          throw new Error(
            "Could not detect required columns. Set POSTCODE_CSV with columns pcds/pcd, lat, long."
          );
        }
        continue;
      }

      const postcode = String(record[postcodeIdx] || "").trim();
      const lat = Number(record[latIdx]);
      const lon = Number(record[lonIdx]);

      if (!postcode || !Number.isFinite(lat) || !Number.isFinite(lon)) {
        continue;
      }

      const postcodeNorm = postcode.replace(/\s+/g, "").toUpperCase();

      await client.query(
        `
          INSERT INTO postcode_coords (
            postcode,
            postcode_norm,
            latitude,
            longitude,
            geom
          ) VALUES ($1, $2, $3, $4, ST_SetSRID(ST_MakePoint($4, $3), 4326))
          ON CONFLICT (postcode) DO NOTHING;
        `,
        [postcode, postcodeNorm, lat, lon]
      );

      count += 1;
      if (count % 5000 === 0) {
        await client.query("COMMIT");
        await client.query("BEGIN");
      }
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  console.log(`Ingested ${count} rows from ${csvPath}`);
}

ingest()
  .then(() => pool.end())
  .catch((err) => {
    console.error(err);
    pool.end();
    process.exit(1);
  });
