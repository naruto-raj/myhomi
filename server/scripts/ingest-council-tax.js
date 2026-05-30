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
  process.env.COUNCIL_TAX_CSV || path.join(dataDir, "council_tax_band_d_2025_26.csv");

if (!databaseUrl) {
  throw new Error("DATABASE_URL is not set");
}

// Council tax data is OPTIONAL and requires a manual download from gov.uk /
// gov.wales (no stable URL). If the file isn't there, exit cleanly with a
// pointer to the docs — don't crash the whole setup pipeline.
if (!fs.existsSync(csvPath)) {
  console.log(`[skip] Council tax CSV not found: ${csvPath}`);
  console.log(`       This step is optional. To enable the council-tax overlay,`);
  console.log(`       see README.md → 'Optional data (council tax)'.`);
  process.exit(0);
}

const pool = new Pool({ connectionString: databaseUrl });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const schemaPath = path.join(__dirname, "..", "sql", "council_tax_schema.sql");

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
    let ladIdx = -1;
    let nameIdx = -1;
    let bandIdx = -1;
    let yearIdx = -1;

    for await (const record of parser) {
      if (!headers) {
        headers = record.map((value) => String(value).trim().toLowerCase());
        ladIdx = findColumnIndex(headers, ["lad_code", "ladcd", "ons_code"]);
        nameIdx = findColumnIndex(headers, ["authority", "lad_name", "name"]);
        bandIdx = findColumnIndex(headers, ["band_d_annual", "band_d", "bandd"]);
        yearIdx = findColumnIndex(headers, ["year"]);

        if (ladIdx === -1 || bandIdx === -1) {
          throw new Error("Could not detect columns in council tax CSV.");
        }
        continue;
      }

      const ladCode = String(record[ladIdx] || "").trim();
      const ladName = nameIdx >= 0 ? String(record[nameIdx] || "").trim() : null;
      const bandValue = Number(String(record[bandIdx] || "").replace(/,/g, ""));
      const yearValue = yearIdx >= 0 ? Number(record[yearIdx] || 2025) : 2025;

      if (!ladCode || !Number.isFinite(bandValue)) continue;

      await client.query(
        `
          INSERT INTO council_tax_band_d (lad_code, lad_name, year, band_d_annual)
          VALUES ($1, $2, $3, $4)
          ON CONFLICT (lad_code)
          DO UPDATE SET
            lad_name = EXCLUDED.lad_name,
            year = EXCLUDED.year,
            band_d_annual = EXCLUDED.band_d_annual;
        `,
        [ladCode, ladName, yearValue, bandValue]
      );

      count += 1;
      if (count % 2000 === 0) {
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

  console.log(`Ingested ${count} council tax rows from ${csvPath}`);
}

ingest()
  .then(() => pool.end())
  .catch((err) => {
    console.error(err);
    pool.end();
    process.exit(1);
  });
