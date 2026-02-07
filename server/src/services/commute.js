import { pool } from "../db.js";
import { fetchCommuteMatrix, normalizeCommuteMode } from "../adapters/commute.js";
import { getPostcodeLocation } from "./postcodes.js";

const DEFAULT_COST_PER_KM = Number(process.env.COMMUTE_COST_PER_KM || 0.35);
const DEFAULT_DAYS_PER_WEEK = Number(process.env.COMMUTE_DAYS_PER_WEEK || 5);
const COMMUTE_CACHE_TTL_DAYS = Number(process.env.COMMUTE_CACHE_TTL_DAYS || 30);
const COMMUTE_MAX_ORIGINS = Number(process.env.COMMUTE_MAX_ORIGINS || 120);
const COMMUTE_BATCH_SIZE = Number(process.env.COMMUTE_BATCH_SIZE || 50);
const WEEKS_PER_MONTH = 4.33;

let cacheReady = false;

function normalizePostcode(postcode) {
  return String(postcode || "").replace(/\s+/g, "").toUpperCase();
}

function normalizeDays(value) {
  const days = Number(value);
  if (!Number.isFinite(days) || days <= 0) return DEFAULT_DAYS_PER_WEEK;
  return Math.min(Math.max(days, 1), 7);
}

function clampNumber(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(Math.max(num, min), max);
}

function computeMonthlyCommuteCost(distanceKm, daysPerWeek, costPerKm) {
  if (!Number.isFinite(distanceKm)) return null;
  const tripsPerMonth = daysPerWeek * 2 * WEEKS_PER_MONTH;
  return distanceKm * costPerKm * tripsPerMonth;
}

async function ensureCacheTable() {
  if (cacheReady) return;
  const createTableSql = `
    CREATE TABLE IF NOT EXISTS commute_cache (
      origin_key TEXT NOT NULL,
      dest_postcode_norm TEXT NOT NULL,
      mode TEXT NOT NULL,
      duration_sec INT,
      distance_km NUMERIC,
      computed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (origin_key, dest_postcode_norm, mode)
    );
  `;
  await pool.query(createTableSql);

  const { rows: columnRows } = await pool.query(
    `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'commute_cache';
    `
  );
  const columns = new Set(columnRows.map((row) => row.column_name));
  const required = [
    "origin_key",
    "dest_postcode_norm",
    "mode",
    "duration_sec",
    "distance_km",
    "computed_at",
  ];
  const missing = required.filter((column) => !columns.has(column));

  const { rows: pkRows } = await pool.query(
    `
      SELECT kcu.column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
      WHERE tc.table_name = 'commute_cache'
        AND tc.constraint_type = 'PRIMARY KEY'
      ORDER BY kcu.ordinal_position;
    `
  );
  const pkColumns = pkRows.map((row) => row.column_name);
  const expectedPk = ["origin_key", "dest_postcode_norm", "mode"];
  const pkMismatch =
    pkColumns.length !== expectedPk.length ||
    pkColumns.some((column, idx) => column !== expectedPk[idx]);

  if (missing.length || pkMismatch) {
    await pool.query(`DROP TABLE IF EXISTS commute_cache;`);
    await pool.query(createTableSql);
  }

  await pool.query(
    `
      CREATE INDEX IF NOT EXISTS commute_cache_computed_at_idx
        ON commute_cache (computed_at);
    `
  );
  cacheReady = true;
}

async function loadCachedCommutes({ originKeys, destPostcodeNorm, mode }) {
  if (!originKeys.length) return new Map();
  const { rows } = await pool.query(
    `
      SELECT origin_key, duration_sec, distance_km
      FROM commute_cache
      WHERE dest_postcode_norm = $1
        AND mode = $2
        AND origin_key = ANY($3::text[])
        AND computed_at > now() - make_interval(days => $4::int);
    `,
    [destPostcodeNorm, mode, originKeys, COMMUTE_CACHE_TTL_DAYS]
  );
  const map = new Map();
  rows.forEach((row) => {
    map.set(row.origin_key, {
      duration_sec: row.duration_sec ? Number(row.duration_sec) : null,
      distance_km: row.distance_km ? Number(row.distance_km) : null,
    });
  });
  return map;
}

async function storeCommutes({ destPostcodeNorm, mode, entries }) {
  if (!entries.length) return;
  const values = [];
  const params = [];
  let idx = 1;
  for (const entry of entries) {
    const durationSec =
      entry.duration_sec == null ? null : Math.round(Number(entry.duration_sec));
    values.push(`($${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, now())`);
    params.push(
      entry.origin_key,
      destPostcodeNorm,
      mode,
      Number.isFinite(durationSec) ? durationSec : null,
      entry.distance_km
    );
  }
  await pool.query(
    `
      INSERT INTO commute_cache (
        origin_key,
        dest_postcode_norm,
        mode,
        duration_sec,
        distance_km,
        computed_at
      )
      VALUES ${values.join(",")}
      ON CONFLICT (origin_key, dest_postcode_norm, mode)
      DO UPDATE SET
        duration_sec = EXCLUDED.duration_sec,
        distance_km = EXCLUDED.distance_km,
        computed_at = EXCLUDED.computed_at;
    `,
    params
  );
}

export async function getCommuteForSectors({ sectors, workplacePostcode, mode, daysPerWeek }) {
  const dest = await getPostcodeLocation(workplacePostcode);
  if (!dest) {
    return { map: new Map(), meta: { error: "workplace postcode not found" } };
  }

  await ensureCacheTable();

  const normalizedMode = normalizeCommuteMode(mode);
  const destPostcodeNorm = normalizePostcode(dest.postcode);
  const originKeys = sectors.map((sector) => sector.sector).filter(Boolean);
  const cached = await loadCachedCommutes({
    originKeys,
    destPostcodeNorm,
    mode: normalizedMode,
  });

  const missing = sectors
    .filter((sector) => !cached.has(sector.sector))
    .slice(0, COMMUTE_MAX_ORIGINS);

  try {
    for (let i = 0; i < missing.length; i += COMMUTE_BATCH_SIZE) {
      const chunk = missing.slice(i, i + COMMUTE_BATCH_SIZE);
      const origins = chunk
        .map((sector) => ({
          lng: Number(sector.longitude),
          lat: Number(sector.latitude),
          origin_key: sector.sector,
        }))
        .filter((origin) => Number.isFinite(origin.lng) && Number.isFinite(origin.lat));

      if (!origins.length) continue;

      const results = await fetchCommuteMatrix({
        origins,
        destination: { lng: dest.longitude, lat: dest.latitude },
        mode: normalizedMode,
      });
      const entries = origins.map((origin, idx) => ({
        origin_key: origin.origin_key,
        duration_sec: results[idx]?.duration_sec ?? null,
        distance_km: results[idx]?.distance_km ?? null,
      }));
      await storeCommutes({ destPostcodeNorm, mode: normalizedMode, entries });
      entries.forEach((entry) => {
        cached.set(entry.origin_key, {
          duration_sec: entry.duration_sec,
          distance_km: entry.distance_km,
        });
      });
    }
  } catch (err) {
    return {
      map: new Map(),
      meta: {
        mode: normalizedMode,
        days_per_week: normalizeDays(daysPerWeek),
        cost_per_km: clampNumber(DEFAULT_COST_PER_KM, 0, 10, 0.35),
        destination: dest,
        error: err?.message || "Commute lookup failed",
      },
    };
  }

  const days = normalizeDays(daysPerWeek);
  const costPerKm = clampNumber(DEFAULT_COST_PER_KM, 0, 10, 0.35);
  const map = new Map();
  cached.forEach((value, key) => {
    const distanceKm = value.distance_km;
    const costMonthly = computeMonthlyCommuteCost(distanceKm, days, costPerKm);
    map.set(key, {
      duration_sec: value.duration_sec,
      distance_km: distanceKm,
      cost_monthly: costMonthly,
    });
  });

  return {
    map,
    meta: {
      mode: normalizedMode,
      days_per_week: days,
      cost_per_km: costPerKm,
      destination: dest,
    },
  };
}

export async function getCommuteForPoint({ origin, workplacePostcode, mode, daysPerWeek }) {
  const dest = await getPostcodeLocation(workplacePostcode);
  if (!dest) return null;

  const normalizedMode = normalizeCommuteMode(mode);
  try {
    const results = await fetchCommuteMatrix({
      origins: [{ lng: origin.lng, lat: origin.lat }],
      destination: { lng: dest.longitude, lat: dest.latitude },
      mode: normalizedMode,
    });
    const entry = results[0] || {};
    const days = normalizeDays(daysPerWeek);
    const costPerKm = clampNumber(DEFAULT_COST_PER_KM, 0, 10, 0.35);
    const costMonthly = computeMonthlyCommuteCost(entry.distance_km, days, costPerKm);

    return {
      duration_sec: entry.duration_sec ?? null,
      distance_km: entry.distance_km ?? null,
      cost_monthly: costMonthly,
      mode: normalizedMode,
      days_per_week: days,
      cost_per_km: costPerKm,
    };
  } catch {
    return null;
  }
}

export async function getCommuteForOrigins({ origins, workplacePostcode, mode, daysPerWeek }) {
  const dest = await getPostcodeLocation(workplacePostcode);
  if (!dest) {
    return { map: new Map(), meta: { error: "workplace postcode not found" } };
  }

  await ensureCacheTable();

  const normalizedMode = normalizeCommuteMode(mode);
  const destPostcodeNorm = normalizePostcode(dest.postcode);
  const originKeys = origins.map((origin) => origin.origin_key).filter(Boolean);
  const cached = await loadCachedCommutes({
    originKeys,
    destPostcodeNorm,
    mode: normalizedMode,
  });

  const missing = origins
    .filter((origin) => !cached.has(origin.origin_key))
    .slice(0, COMMUTE_MAX_ORIGINS);

  try {
    for (let i = 0; i < missing.length; i += COMMUTE_BATCH_SIZE) {
      const chunk = missing.slice(i, i + COMMUTE_BATCH_SIZE);
      const chunkOrigins = chunk
        .map((origin) => ({
          lng: Number(origin.longitude),
          lat: Number(origin.latitude),
          origin_key: origin.origin_key,
        }))
        .filter((origin) => Number.isFinite(origin.lng) && Number.isFinite(origin.lat));

      if (!chunkOrigins.length) continue;

      const results = await fetchCommuteMatrix({
        origins: chunkOrigins,
        destination: { lng: dest.longitude, lat: dest.latitude },
        mode: normalizedMode,
      });
      const entries = chunkOrigins.map((origin, idx) => ({
        origin_key: origin.origin_key,
        duration_sec: results[idx]?.duration_sec ?? null,
        distance_km: results[idx]?.distance_km ?? null,
      }));
      await storeCommutes({ destPostcodeNorm, mode: normalizedMode, entries });
      entries.forEach((entry) => {
        cached.set(entry.origin_key, {
          duration_sec: entry.duration_sec,
          distance_km: entry.distance_km,
        });
      });
    }
  } catch (err) {
    return {
      map: new Map(),
      meta: {
        mode: normalizedMode,
        days_per_week: normalizeDays(daysPerWeek),
        cost_per_km: clampNumber(DEFAULT_COST_PER_KM, 0, 10, 0.35),
        destination: dest,
        error: err?.message || "Commute lookup failed",
      },
    };
  }

  const days = normalizeDays(daysPerWeek);
  const costPerKm = clampNumber(DEFAULT_COST_PER_KM, 0, 10, 0.35);
  const map = new Map();
  cached.forEach((value, key) => {
    const distanceKm = value.distance_km;
    const costMonthly = computeMonthlyCommuteCost(distanceKm, days, costPerKm);
    map.set(key, {
      duration_sec: value.duration_sec,
      distance_km: distanceKm,
      cost_monthly: costMonthly,
    });
  });

  return {
    map,
    meta: {
      mode: normalizedMode,
      days_per_week: days,
      cost_per_km: costPerKm,
      destination: dest,
    },
  };
}

export function computeEffectiveMonthlyBudget({ monthlyBudget, commuteCostMonthly, costSensitivity }) {
  const sensitivity = clampNumber(costSensitivity, 0, 1, 0);
  const cost = Number.isFinite(commuteCostMonthly) ? commuteCostMonthly : 0;
  const effective = Number(monthlyBudget || 0) - cost * sensitivity;
  return Math.max(effective, 0);
}

export function normalizeCostSensitivity(input) {
  const raw = Number(input);
  if (!Number.isFinite(raw)) return 0.5;
  if (raw > 1) return clampNumber(raw / 100, 0, 1, 0.5);
  return clampNumber(raw, 0, 1, 0.5);
}
