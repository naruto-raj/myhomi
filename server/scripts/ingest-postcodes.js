import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "csv-parse";
import dotenv from "dotenv";
import pg from "pg";
import { from as copyFrom } from "pg-copy-streams";

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
const ladSchemaPath = path.join(__dirname, "..", "sql", "postcode_lad_schema.sql");

async function ensureSchema() {
  const sql = fs.readFileSync(schemaPath, "utf-8");
  await pool.query(sql);
  const ladSql = fs.readFileSync(ladSchemaPath, "utf-8");
  await pool.query(ladSql);
}

function findColumnIndex(headers, candidates) {
  for (const candidate of candidates) {
    const idx = headers.indexOf(candidate);
    if (idx !== -1) return idx;
  }
  return -1;
}

// Escape a value for Postgres COPY text format (tab-delimited).
// Backslash, tab, newline, carriage return must be escaped.
function copyEscape(value) {
  if (value === null || value === undefined || value === "") return "\\N";
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/\t/g, "\\t")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r");
}

async function ingest() {
  await ensureSchema();
  const client = await pool.connect();
  let count = 0;
  const t0 = Date.now();

  try {
    // Stage data in a TEMP table first, then INSERT...SELECT into the
    // real tables with the geometry computed in SQL. ~100x faster than
    // per-row INSERTs.
    await client.query("BEGIN");
    await client.query(`
      CREATE TEMP TABLE postcode_stage (
        postcode TEXT,
        postcode_norm TEXT,
        latitude DOUBLE PRECISION,
        longitude DOUBLE PRECISION,
        lad_code TEXT
      ) ON COMMIT DROP;
    `);

    // First pass: read headers synchronously to detect column positions.
    // We use a small synchronous parser by streaming until we get the
    // first record, then continue with COPY.
    const headerParser = fs
      .createReadStream(csvPath)
      .pipe(parse({ relax_quotes: true, relax_column_count: true, trim: true, to_line: 1 }));
    let headers = null;
    for await (const record of headerParser) {
      headers = record.map((value) => {
        // Strip UTF-8 BOM that ONS sometimes ships on the first column header,
        // then trim + lowercase for case-insensitive matching.
        return String(value).replace(/^﻿/, "").trim().toLowerCase();
      });
      break;
    }
    if (!headers) throw new Error("Empty CSV");

    const postcodeIdx = findColumnIndex(headers, ["pcds", "pcd", "postcode"]);
    const latIdx = findColumnIndex(headers, ["lat", "latitude"]);
    const lonIdx = findColumnIndex(headers, ["long", "longitude", "lon", "lng"]);
    // Try common LAD column names across ONSPD vintages (LAD25CD, LAD24CD, …).
    const ladIdx = findColumnIndex(headers, [
      "lad25cd", "lad24cd", "lad23cd", "lad22cd", "lad21cd", "lad20cd", "ladcd", "oslaua",
    ]);

    if (postcodeIdx === -1 || latIdx === -1 || lonIdx === -1) {
      const missing = [];
      if (postcodeIdx === -1) missing.push("postcode (one of: pcds, pcd, postcode)");
      if (latIdx === -1) missing.push("latitude (one of: lat, latitude)");
      if (lonIdx === -1) missing.push("longitude (one of: long, longitude, lon, lng)");
      throw new Error(
        `Could not detect required columns in ${csvPath}.\n` +
          `  Missing: ${missing.join("; ")}\n` +
          `  Found columns: ${headers.join(", ")}\n` +
          `\n` +
          `  This usually means the wrong CSV got selected from the ONS zip.\n` +
          `  The correct file is named ONSPD_<MONTH>_<YEAR>_UK.csv and is ~1 GB.\n` +
          `  Re-run:  ./scripts/download-data.sh --force  (or  -Force on Windows)`
      );
    }

    // Open a COPY stream into the staging table.
    const copyStream = client.query(
      copyFrom(
        `COPY postcode_stage (postcode, postcode_norm, latitude, longitude, lad_code) FROM STDIN WITH (FORMAT text, DELIMITER E'\\t', NULL '\\N')`
      )
    );

    // Stream the rest of the CSV (skipping header) and push tab-delimited
    // rows into the COPY stream. Apply backpressure properly.
    const parser = fs
      .createReadStream(csvPath)
      .pipe(parse({ relax_quotes: true, relax_column_count: true, trim: true, from_line: 2 }));

    for await (const record of parser) {
      const postcode = String(record[postcodeIdx] || "").trim();
      const lat = Number(record[latIdx]);
      const lon = Number(record[lonIdx]);
      const ladCode = ladIdx >= 0 ? String(record[ladIdx] || "").trim() : "";

      if (!postcode || !Number.isFinite(lat) || !Number.isFinite(lon)) {
        continue;
      }
      const postcodeNorm = postcode.replace(/\s+/g, "").toUpperCase();

      const line =
        copyEscape(postcode) +
        "\t" +
        copyEscape(postcodeNorm) +
        "\t" +
        lat +
        "\t" +
        lon +
        "\t" +
        copyEscape(ladCode) +
        "\n";

      if (!copyStream.write(line)) {
        await new Promise((resolve) => copyStream.once("drain", resolve));
      }
      count += 1;
      if (count % 200000 === 0) {
        console.log(`  streamed ${count.toLocaleString()} rows...`);
      }
    }

    copyStream.end();
    await new Promise((resolve, reject) => {
      copyStream.on("finish", resolve);
      copyStream.on("error", reject);
    });

    console.log(`Staged ${count.toLocaleString()} rows in ${(Date.now() - t0) / 1000}s. Merging...`);

    // Merge staging → real tables (single SQL statement each).
    await client.query(`
      INSERT INTO postcode_coords (postcode, postcode_norm, latitude, longitude, geom)
      SELECT DISTINCT ON (postcode)
        postcode,
        postcode_norm,
        latitude,
        longitude,
        ST_SetSRID(ST_MakePoint(longitude, latitude), 4326)::geography
      FROM postcode_stage
      ON CONFLICT (postcode) DO NOTHING;
    `);

    await client.query(`
      INSERT INTO postcode_lad (postcode_norm, lad_code)
      SELECT DISTINCT ON (postcode_norm) postcode_norm, lad_code
      FROM postcode_stage
      WHERE lad_code IS NOT NULL AND lad_code <> ''
      ON CONFLICT (postcode_norm) DO UPDATE SET lad_code = EXCLUDED.lad_code;
    `);

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  console.log(
    `Ingested ${count.toLocaleString()} rows from ${csvPath} in ${(
      (Date.now() - t0) /
      1000
    ).toFixed(1)}s`
  );
}

ingest()
  .then(() => pool.end())
  .catch((err) => {
    console.error(err);
    pool.end();
    process.exit(1);
  });
