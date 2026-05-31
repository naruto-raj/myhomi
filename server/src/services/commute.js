import { pool } from "../db.js";
import { fetchCommuteMatrix, normalizeCommuteMode } from "../adapters/commute.js";
import { fetchTflJourney, isWithinLondon } from "../adapters/tfl.js";
import { getPostcodeLocation } from "./postcodes.js";
import {
  getNearestStopForSector,
  getNearestStopForPostcode,
} from "./stops.js";

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

function computeMonthlyCommuteCost(distanceKm, fareGbp, daysPerWeek, costPerKm) {
  const tripsPerMonth = daysPerWeek * 2 * WEEKS_PER_MONTH;
  if (Number.isFinite(fareGbp)) return fareGbp * tripsPerMonth;
  if (!Number.isFinite(distanceKm)) return null;
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
      fare_gbp NUMERIC,
      computed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (origin_key, dest_postcode_norm, mode)
    );
  `;
  await pool.query(createTableSql);

  // Idempotent column add for users who created the table before fare_gbp
  // existed. Without this, the storeCommutes INSERT would fail with
  // 'column "fare_gbp" of relation "commute_cache" does not exist'.
  await pool.query(`ALTER TABLE commute_cache ADD COLUMN IF NOT EXISTS fare_gbp NUMERIC;`);

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
    "fare_gbp",
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
      SELECT origin_key, duration_sec, distance_km, fare_gbp
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
      fare_gbp: row.fare_gbp != null ? Number(row.fare_gbp) : null,
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
    const fareGbp = entry.fare_gbp == null ? null : Number(entry.fare_gbp);
    values.push(`($${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, now())`);
    params.push(
      entry.origin_key,
      destPostcodeNorm,
      mode,
      Number.isFinite(durationSec) ? durationSec : null,
      entry.distance_km,
      Number.isFinite(fareGbp) ? fareGbp : null
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
        fare_gbp,
        computed_at
      )
      VALUES ${values.join(",")}
      ON CONFLICT (origin_key, dest_postcode_norm, mode)
      DO UPDATE SET
        duration_sec = EXCLUDED.duration_sec,
        distance_km = EXCLUDED.distance_km,
        fare_gbp = EXCLUDED.fare_gbp,
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
    const useTfl =
      normalizedMode === "PUBLIC" &&
      isWithinLondon(dest.latitude, dest.longitude);
    const tflOrigins = [];
    const orsOrigins = [];

    missing.forEach((sector) => {
      const lng = Number(sector.longitude);
      const lat = Number(sector.latitude);
      if (!Number.isFinite(lng) || !Number.isFinite(lat)) return;
      const origin = { lng, lat, origin_key: sector.sector };
      if (useTfl && isWithinLondon(lat, lng)) {
        tflOrigins.push(origin);
      } else {
        orsOrigins.push(origin);
      }
    });

    // Resolve the workplace once per request — passing TfL a NaPTAN station
    // ID (instead of raw lat/lng) is what unlocks the fare engine. We resolve
    // origins inside the loop because each is a different sector.
    const destStop = useTfl
      ? await getNearestStopForPostcode({
          postcodeNorm: destPostcodeNorm,
          lat: dest.latitude,
          lng: dest.longitude,
        })
      : null;
    const destPoint = destStop?.naptan_id
      ? { naptan_id: destStop.naptan_id }
      : { lng: dest.longitude, lat: dest.latitude };

    for (const origin of tflOrigins) {
      try {
        // Sector-level cache: prewarmed for London at setup; lazy-fills
        // anywhere else on first hit.
        const originStop = await getNearestStopForSector({
          sector: origin.origin_key,
          lat: origin.lat,
          lng: origin.lng,
        });
        const originPoint = originStop?.naptan_id
          ? { naptan_id: originStop.naptan_id }
          : { lng: origin.lng, lat: origin.lat };

        const tfl = await fetchTflJourney({
          origin: originPoint,
          destination: destPoint,
        });
        const entries = [
          {
            origin_key: origin.origin_key,
            duration_sec: tfl.duration_sec ?? null,
            distance_km: tfl.distance_km ?? null,
            fare_gbp: tfl.fare_gbp ?? null,
          },
        ];
        await storeCommutes({ destPostcodeNorm, mode: normalizedMode, entries });
        cached.set(origin.origin_key, {
          duration_sec: tfl.duration_sec ?? null,
          distance_km: tfl.distance_km ?? null,
          fare_gbp: tfl.fare_gbp ?? null,
        });
      } catch {
        orsOrigins.push(origin);
      }
    }

    for (let i = 0; i < orsOrigins.length; i += COMMUTE_BATCH_SIZE) {
      const chunk = orsOrigins.slice(i, i + COMMUTE_BATCH_SIZE);
      if (!chunk.length) continue;
      const results = await fetchCommuteMatrix({
        origins: chunk,
        destination: { lng: dest.longitude, lat: dest.latitude },
        mode: normalizedMode,
      });
      const entries = chunk.map((origin, idx) => ({
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
    const costMonthly = computeMonthlyCommuteCost(distanceKm, value.fare_gbp, days, costPerKm);
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
  const days = normalizeDays(daysPerWeek);
  const costPerKm = clampNumber(DEFAULT_COST_PER_KM, 0, 10, 0.35);
  const useTfl =
    normalizedMode === "PUBLIC" &&
    isWithinLondon(origin.lat, origin.lng) &&
    isWithinLondon(dest.latitude, dest.longitude);
  try {
    if (useTfl) {
      const tfl = await fetchTflJourney({
        origin: { lng: origin.lng, lat: origin.lat },
        destination: { lng: dest.longitude, lat: dest.latitude },
      });
      const costMonthly = computeMonthlyCommuteCost(tfl.distance_km, tfl.fare_gbp, days, costPerKm);
      return {
        duration_sec: tfl.duration_sec ?? null,
        distance_km: tfl.distance_km ?? null,
        cost_monthly: costMonthly,
        mode: normalizedMode,
        days_per_week: days,
        cost_per_km: costPerKm,
      };
    }

    const results = await fetchCommuteMatrix({
      origins: [{ lng: origin.lng, lat: origin.lat }],
      destination: { lng: dest.longitude, lat: dest.latitude },
      mode: normalizedMode,
    });
    const entry = results[0] || {};
    const costMonthly = computeMonthlyCommuteCost(entry.distance_km, null, days, costPerKm);

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

  // Mirror the TfL fast-path from getCommuteForSectors: when mode is PUBLIC
  // and the destination is in London, route in-London origins through TfL to
  // get real fares instead of distance-based estimates. Non-London origins
  // (or non-PUBLIC mode) fall through to OpenRouteService as before.
  const useTfl =
    normalizedMode === "PUBLIC" && isWithinLondon(dest.latitude, dest.longitude);
  const tflOrigins = [];
  const orsOrigins = [];

  // We need the origin's sector (for the sector cache) and postcode_norm (for
  // the per-postcode cache). The callers populate `origin.origin_key` with
  // postcode_norm in nearest-affordable; the sector comes from the postcode.
  missing.forEach((origin) => {
    const lng = Number(origin.longitude);
    const lat = Number(origin.latitude);
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return;
    const normalized = {
      lng,
      lat,
      origin_key: origin.origin_key,
      postcode_norm: origin.postcode_norm || origin.origin_key,
      sector: origin.sector || null,
    };
    if (useTfl && isWithinLondon(lat, lng)) {
      tflOrigins.push(normalized);
    } else {
      orsOrigins.push(normalized);
    }
  });

  // Resolve the workplace stop once. Postcode-level cache: lazy-fills on miss.
  const destStop = useTfl
    ? await getNearestStopForPostcode({
        postcodeNorm: destPostcodeNorm,
        lat: dest.latitude,
        lng: dest.longitude,
      })
    : null;
  const destPoint = destStop?.naptan_id
    ? { naptan_id: destStop.naptan_id }
    : { lng: dest.longitude, lat: dest.latitude };

  // TfL: one journey lookup per origin. Failures fall back to ORS.
  for (const origin of tflOrigins) {
    try {
      const originStop = await getNearestStopForPostcode({
        postcodeNorm: origin.postcode_norm,
        sector: origin.sector,
        lat: origin.lat,
        lng: origin.lng,
      });
      const originPoint = originStop?.naptan_id
        ? { naptan_id: originStop.naptan_id }
        : { lng: origin.lng, lat: origin.lat };

      const tfl = await fetchTflJourney({
        origin: originPoint,
        destination: destPoint,
      });
      await storeCommutes({
        destPostcodeNorm,
        mode: normalizedMode,
        entries: [
          {
            origin_key: origin.origin_key,
            duration_sec: tfl.duration_sec ?? null,
            distance_km: tfl.distance_km ?? null,
            fare_gbp: tfl.fare_gbp ?? null,
          },
        ],
      });
      cached.set(origin.origin_key, {
        duration_sec: tfl.duration_sec ?? null,
        distance_km: tfl.distance_km ?? null,
        fare_gbp: tfl.fare_gbp ?? null,
      });
    } catch {
      orsOrigins.push(origin);
    }
  }

  // ORS: batched. If the whole batch fails, KEEP any TfL results that already
  // landed in `cached` — don't wipe partial successes. Previously the catch
  // returned an empty map, throwing away everything TfL had earned.
  let orsError = null;
  for (let i = 0; i < orsOrigins.length; i += COMMUTE_BATCH_SIZE) {
    const chunk = orsOrigins.slice(i, i + COMMUTE_BATCH_SIZE);
    if (!chunk.length) continue;
    try {
      const results = await fetchCommuteMatrix({
        origins: chunk,
        destination: { lng: dest.longitude, lat: dest.latitude },
        mode: normalizedMode,
      });
      const entries = chunk.map((origin, idx) => ({
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
    } catch (err) {
      orsError = err?.message || "Commute matrix failed";
      // Subsequent batches will hit the same error — stop trying.
      break;
    }
  }

  const days = normalizeDays(daysPerWeek);
  const costPerKm = clampNumber(DEFAULT_COST_PER_KM, 0, 10, 0.35);
  const map = new Map();
  cached.forEach((value, key) => {
    const distanceKm = value.distance_km;
    const costMonthly = computeMonthlyCommuteCost(distanceKm, value.fare_gbp, days, costPerKm);
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
      // Surface ORS failures only when nothing else worked — if TfL got us
      // useful data, don't pollute the response with an unrelated error.
      ...(orsError && map.size === 0 ? { error: orsError } : {}),
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
