import { pool } from "../db.js";

const EPC_BASE_URL = process.env.EPC_BASE_URL || "https://epc.opendatacommunities.org/api/v1";
const EPC_API_KEY = process.env.EPC_API_KEY;
const EPC_API_EMAIL = process.env.EPC_API_EMAIL || process.env.EPC_API_USER || "apikey";
const EPC_CACHE_TTL_DAYS = Number(process.env.EPC_CACHE_TTL_DAYS || 30);

let epcTableReady = false;

function normalizePostcode(postcode) {
  return typeof postcode === "string" ? postcode.replace(/\s+/g, "").toUpperCase() : "";
}

function toNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function pickLatestRow(rows) {
  if (!Array.isArray(rows) || !rows.length) return null;
  let best = rows[0];
  let bestDate = null;
  rows.forEach((row) => {
    const raw =
      row?.["lodgement-date"] ??
      row?.lodgement_date ??
      row?.["inspection-date"] ??
      row?.inspection_date ??
      null;
    if (!raw) return;
    const date = new Date(raw);
    if (Number.isNaN(date.valueOf())) return;
    if (!bestDate || date > bestDate) {
      bestDate = date;
      best = row;
    }
  });
  return best;
}

async function ensureEpcTable() {
  if (epcTableReady) return;
  await pool.query(
    `
      CREATE TABLE IF NOT EXISTS epc_cache (
        postcode_norm text PRIMARY KEY,
        floor_area_m2 numeric,
        property_type text,
        tenure text,
        current_energy_rating text,
        lodgement_date date,
        updated_at timestamptz DEFAULT now()
      );
    `
  );
  epcTableReady = true;
}

async function fetchEpcFromApi(postcodeNorm) {
  if (!EPC_API_KEY) return null;
  const url = new URL(`${EPC_BASE_URL}/domestic/search`);
  url.searchParams.set("postcode", postcodeNorm);
  const auth = Buffer.from(`${EPC_API_EMAIL}:${EPC_API_KEY}`).toString("base64");
  const response = await fetch(url.toString(), {
    headers: {
      Authorization: `Basic ${auth}`,
      Accept: "application/json",
    },
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `EPC request failed (${response.status})`);
  }
  const data = await response.json();
  const rows =
    (Array.isArray(data?.rows) && data.rows) ||
    (Array.isArray(data?.result) && data.result) ||
    (Array.isArray(data?.results) && data.results) ||
    [];
  return pickLatestRow(rows);
}

export async function getEpcByPostcode(postcode) {
  const postcodeNorm = normalizePostcode(postcode);
  if (!postcodeNorm) return null;

  await ensureEpcTable();

  const { rows: cached } = await pool.query(
    `
      SELECT
        postcode_norm,
        floor_area_m2,
        property_type,
        tenure,
        current_energy_rating,
        lodgement_date,
        updated_at
      FROM epc_cache
      WHERE postcode_norm = $1
        AND updated_at > now() - ($2::text || ' days')::interval
      LIMIT 1;
    `,
    [postcodeNorm, EPC_CACHE_TTL_DAYS]
  );

  if (cached.length) {
    const row = cached[0];
    const floorAreaM2 = toNumber(row.floor_area_m2);
    return {
      postcode_norm: row.postcode_norm,
      floor_area_m2: floorAreaM2,
      floor_area_sqft: floorAreaM2 ? Math.round(floorAreaM2 * 10.7639) : null,
      property_type: row.property_type,
      tenure: row.tenure,
      current_energy_rating: row.current_energy_rating,
      lodgement_date: row.lodgement_date,
    };
  }

  if (!EPC_API_KEY) return null;

  let apiRow = null;
  let apiFailed = false;
  try {
    apiRow = await fetchEpcFromApi(postcodeNorm);
  } catch {
    apiFailed = true;
    apiRow = null;
  }

  if (!apiRow) {
    if (!apiFailed) {
      await pool.query(
        `
          INSERT INTO epc_cache (
            postcode_norm,
            floor_area_m2,
            property_type,
            tenure,
            current_energy_rating,
            lodgement_date,
            updated_at
          ) VALUES ($1, NULL, NULL, NULL, NULL, NULL, now())
          ON CONFLICT (postcode_norm) DO UPDATE SET
            floor_area_m2 = NULL,
            property_type = NULL,
            tenure = NULL,
            current_energy_rating = NULL,
            lodgement_date = NULL,
            updated_at = now();
        `,
        [postcodeNorm]
      );
    }
    return null;
  }

  const floorAreaM2 = toNumber(apiRow?.["total-floor-area"] ?? apiRow?.total_floor_area);
  const propertyType = apiRow?.["property-type"] ?? apiRow?.property_type ?? null;
  const tenure = apiRow?.tenure ?? null;
  const rating = apiRow?.["current-energy-rating"] ?? apiRow?.current_energy_rating ?? null;
  const lodgement =
    apiRow?.["lodgement-date"] ?? apiRow?.lodgement_date ?? apiRow?.["inspection-date"] ?? null;

  await pool.query(
    `
      INSERT INTO epc_cache (
        postcode_norm,
        floor_area_m2,
        property_type,
        tenure,
        current_energy_rating,
        lodgement_date,
        updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, now())
      ON CONFLICT (postcode_norm) DO UPDATE SET
        floor_area_m2 = EXCLUDED.floor_area_m2,
        property_type = EXCLUDED.property_type,
        tenure = EXCLUDED.tenure,
        current_energy_rating = EXCLUDED.current_energy_rating,
        lodgement_date = EXCLUDED.lodgement_date,
        updated_at = now();
    `,
    [postcodeNorm, floorAreaM2, propertyType, tenure, rating, lodgement]
  );

  return {
    postcode_norm: postcodeNorm,
    floor_area_m2: floorAreaM2,
    floor_area_sqft: floorAreaM2 ? Math.round(floorAreaM2 * 10.7639) : null,
    property_type: propertyType,
    tenure,
    current_energy_rating: rating,
    lodgement_date: lodgement,
  };
}
