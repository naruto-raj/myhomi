import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import pg from "pg";
import { from as copyFrom } from "pg-copy-streams";

const { Pool } = pg;

dotenv.config();

const databaseUrl = process.env.DATABASE_URL;
const dataDir = process.env.DATA_DIR || "../data";
const csvPath = process.env.PRICE_PAID_CSV || path.join(dataDir, "price-paid", "ppd.csv");
const hasHeader = String(process.env.PRICE_PAID_HAS_HEADER || "false").toLowerCase() === "true";
const truncateFirst = String(process.env.PRICE_PAID_TRUNCATE || "false").toLowerCase() === "true";
const fastInsert = String(process.env.PRICE_PAID_FAST || "false").toLowerCase() === "true";

if (!databaseUrl) {
  throw new Error("DATABASE_URL is not set");
}

const pool = new Pool({ connectionString: databaseUrl });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const schemaPath = path.join(__dirname, "..", "sql", "price_paid_schema.sql");

async function ensureSchema(client) {
  const sql = fs.readFileSync(schemaPath, "utf-8");
  await client.query(sql);
}

function buildCopyCommand() {
  const cols = [
    "transaction_id",
    "price",
    "date_of_transfer",
    "postcode",
    "property_type",
    "old_new",
    "duration",
    "paon",
    "saon",
    "street",
    "locality",
    "town_city",
    "district",
    "county",
    "ppd_category_type",
    "record_status",
  ];
  const headerClause = hasHeader ? "HEADER true" : "HEADER false";
  return `COPY price_paid_stage (${cols.join(",")}) FROM STDIN WITH (FORMAT csv, ${headerClause});`;
}

async function ingest() {
  const client = await pool.connect();
  try {
    await ensureSchema(client);

    if (truncateFirst) {
      console.log("Truncating price_paid...");
      await client.query("TRUNCATE TABLE price_paid;");
    }

    console.log("Creating staging table...");
    await client.query("DROP TABLE IF EXISTS price_paid_stage;");
    await client.query("CREATE TEMP TABLE price_paid_stage (LIKE price_paid INCLUDING DEFAULTS);");

    console.log("Starting COPY (client-side stream) into price_paid_stage...");
    const start = Date.now();
    const fileStats = fs.statSync(csvPath);
    let bytesRead = 0;
    let lastLogged = 0;
    const copyStream = client.query(copyFrom(buildCopyCommand()));
    const fileStream = fs.createReadStream(csvPath);

    await new Promise((resolve, reject) => {
      fileStream
        .on("data", (chunk) => {
          bytesRead += chunk.length;
          if (bytesRead - lastLogged >= 200 * 1024 * 1024) {
            lastLogged = bytesRead;
            const pct = ((bytesRead / fileStats.size) * 100).toFixed(1);
            console.log(`COPY progress: ${(bytesRead / (1024 * 1024)).toFixed(0)}MB (${pct}%)`);
          }
        })
        .on("error", reject)
        .pipe(copyStream)
        .on("error", reject)
        .on("finish", resolve);
    });

    console.log("COPY finished in", ((Date.now() - start) / 1000).toFixed(1), "s");
    const stageCount = await client.query("SELECT COUNT(*)::int AS count FROM price_paid_stage;");
    console.log(`Staging rows: ${stageCount.rows[0].count.toLocaleString()}`);
    if (fastInsert) {
      console.log("Fast insert mode: dropping indexes and primary key...");
      await client.query("ALTER TABLE price_paid DROP CONSTRAINT IF EXISTS price_paid_pkey;");
      await client.query("DROP INDEX IF EXISTS price_paid_postcode_idx;");
      await client.query("DROP INDEX IF EXISTS price_paid_postcode_norm_idx;");
      await client.query("DROP INDEX IF EXISTS price_paid_date_idx;");

      console.log("Inserting into price_paid...");
      await client.query(
        `
          INSERT INTO price_paid (
            transaction_id,
            price,
            date_of_transfer,
            postcode,
            postcode_norm,
            property_type,
            old_new,
            duration,
            paon,
            saon,
            street,
            locality,
            town_city,
            district,
            county,
            ppd_category_type,
            record_status
          )
          SELECT
            transaction_id,
            price,
            date_of_transfer,
            postcode,
            REPLACE(UPPER(postcode), ' ', '') AS postcode_norm,
            property_type,
            old_new,
            duration,
            paon,
            saon,
            street,
            locality,
            town_city,
            district,
            county,
            ppd_category_type,
            record_status
          FROM price_paid_stage;
        `
      );

      console.log("Recreating indexes...");
      await client.query("ALTER TABLE price_paid ADD PRIMARY KEY (transaction_id);");
      await client.query("CREATE INDEX price_paid_postcode_idx ON price_paid (postcode);");
      await client.query("CREATE INDEX price_paid_postcode_norm_idx ON price_paid (postcode_norm);");
      await client.query("CREATE INDEX price_paid_date_idx ON price_paid (date_of_transfer);");
    } else {
      console.log("Upserting into price_paid...");
      await client.query(
        `
          INSERT INTO price_paid (
            transaction_id,
            price,
            date_of_transfer,
            postcode,
            postcode_norm,
            property_type,
            old_new,
            duration,
            paon,
            saon,
            street,
            locality,
            town_city,
            district,
            county,
            ppd_category_type,
            record_status
          )
          SELECT
            transaction_id,
            price,
            date_of_transfer,
            postcode,
            REPLACE(UPPER(postcode), ' ', '') AS postcode_norm,
            property_type,
            old_new,
            duration,
            paon,
            saon,
            street,
            locality,
            town_city,
            district,
            county,
            ppd_category_type,
            record_status
          FROM price_paid_stage
          ON CONFLICT (transaction_id) DO NOTHING;
        `
      );
    }

    const finalCount = await client.query("SELECT COUNT(*)::int AS count FROM price_paid;");
    console.log(`price_paid rows: ${finalCount.rows[0].count.toLocaleString()}`);
    console.log("Ingest complete.");
  } finally {
    client.release();
  }
}

ingest()
  .then(() => pool.end())
  .catch((err) => {
    console.error(err);
    pool.end();
    process.exit(1);
  });
