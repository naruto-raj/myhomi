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
const csvPath = process.env.PRICE_PAID_CSV || path.join(dataDir, "price-paid", "ppd.csv");

if (!databaseUrl) {
  throw new Error("DATABASE_URL is not set");
}

const pool = new Pool({ connectionString: databaseUrl });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const schemaPath = path.join(__dirname, "..", "sql", "price_paid_schema.sql");

async function ensureSchema() {
  const sql = fs.readFileSync(schemaPath, "utf-8");
  await pool.query(sql);
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

    for await (const record of parser) {
      if (!record || record.length < 14) continue;
      if (String(record[0]).toLowerCase().includes("transaction")) {
        continue;
      }
      const [
        transactionId,
        price,
        dateOfTransfer,
        postcode,
        propertyType,
        oldNew,
        duration,
        paon,
        saon,
        street,
        locality,
        townCity,
        district,
        county,
        ppdCategoryType,
        recordStatus,
      ] = record;

      const priceValue = Number(price);
      if (!Number.isFinite(priceValue)) {
        continue;
      }

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
          ) VALUES (
            $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17
          )
          ON CONFLICT (transaction_id) DO NOTHING;
        `,
        [
          transactionId,
          priceValue,
          dateOfTransfer,
          postcode,
          String(postcode || "").replace(/\s+/g, "").toUpperCase(),
          propertyType,
          oldNew,
          duration,
          paon,
          saon,
          street,
          locality,
          townCity,
          district,
          county,
          ppdCategoryType,
          recordStatus,
        ]
      );

      count += 1;
      if (count % 1000 === 0) {
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
