// Cache-aside resolver from (sector | postcode) → nearest TfL NaPTAN station ID.
//
// Why: TfL's Journey Planner only returns a real `fare` object when you pass
// it recognised stop IDs. Raw lat/lng inputs route correctly but often come
// back with no fare. By resolving once via /StopPoint and caching, we get
// real fares with minimal extra latency after first resolution.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "../db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const schemaPath = path.join(__dirname, "..", "..", "sql", "nearest_stop.sql");

const TFL_BASE_URL = process.env.TFL_BASE_URL || "https://api.tfl.gov.uk";
const TFL_APP_KEY = process.env.TFL_APP_KEY;
const TFL_APP_ID = process.env.TFL_APP_ID;
// Stops we accept as fare-bearing endpoints. Bus stops are excluded — TfL
// doesn't compute station-pair fares for bus-only journeys, and the heuristic
// fallback in adapters/tfl.js handles those well enough.
const STOP_TYPES = "NaptanMetroStation,NaptanRailStation";
const STOP_SEARCH_RADIUS_M = 1500;

let schemaReady = false;
async function ensureSchema() {
  if (schemaReady) return;
  const sql = fs.readFileSync(schemaPath, "utf-8");
  await pool.query(sql);
  schemaReady = true;
}

async function callTflStopPoint({ lat, lng }) {
  if (!TFL_APP_KEY && !TFL_APP_ID) return null; // No TfL key → no stop resolution.
  const url = new URL(`${TFL_BASE_URL}/StopPoint`);
  url.searchParams.set("lat", String(lat));
  url.searchParams.set("lon", String(lng));
  url.searchParams.set("stopTypes", STOP_TYPES);
  url.searchParams.set("radius", String(STOP_SEARCH_RADIUS_M));
  url.searchParams.set("returnLines", "false");
  if (TFL_APP_ID) url.searchParams.set("app_id", TFL_APP_ID);
  if (TFL_APP_KEY) url.searchParams.set("app_key", TFL_APP_KEY);

  const response = await fetch(url.toString());
  if (!response.ok) {
    throw new Error(`StopPoint failed (${response.status})`);
  }
  const data = await response.json();
  const stops = Array.isArray(data?.stopPoints) ? data.stopPoints : [];
  if (!stops.length) return null;

  // The API returns stops sorted by distance, but be defensive.
  stops.sort((a, b) => (Number(a?.distance) || Infinity) - (Number(b?.distance) || Infinity));
  const nearest = stops[0];
  const naptanId = nearest?.naptanId || nearest?.id;
  if (!naptanId) return null;
  return {
    naptan_id: String(naptanId),
    stop_name: nearest?.commonName || null,
    modes: Array.isArray(nearest?.modes) ? nearest.modes.join(",") : null,
    distance_m: Number.isFinite(Number(nearest?.distance))
      ? Math.round(Number(nearest.distance))
      : null,
  };
}

async function readCachedSectorStop(sector) {
  const { rows } = await pool.query(
    `SELECT naptan_id, stop_name, distance_m FROM sector_nearest_stop WHERE sector = $1`,
    [sector]
  );
  return rows[0] || null;
}

async function writeSectorStop(sector, stop) {
  await pool.query(
    `INSERT INTO sector_nearest_stop (sector, naptan_id, stop_name, modes, distance_m, resolved_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (sector) DO UPDATE SET
       naptan_id   = EXCLUDED.naptan_id,
       stop_name   = EXCLUDED.stop_name,
       modes       = EXCLUDED.modes,
       distance_m  = EXCLUDED.distance_m,
       resolved_at = now();`,
    [sector, stop.naptan_id, stop.stop_name, stop.modes, stop.distance_m]
  );
}

async function readCachedPostcodeStop(postcodeNorm) {
  const { rows } = await pool.query(
    `SELECT naptan_id, stop_name, distance_m FROM postcode_nearest_stop WHERE postcode_norm = $1`,
    [postcodeNorm]
  );
  return rows[0] || null;
}

async function writePostcodeStop(postcodeNorm, stop) {
  await pool.query(
    `INSERT INTO postcode_nearest_stop (postcode_norm, naptan_id, stop_name, modes, distance_m, resolved_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (postcode_norm) DO UPDATE SET
       naptan_id   = EXCLUDED.naptan_id,
       stop_name   = EXCLUDED.stop_name,
       modes       = EXCLUDED.modes,
       distance_m  = EXCLUDED.distance_m,
       resolved_at = now();`,
    [postcodeNorm, stop.naptan_id, stop.stop_name, stop.modes, stop.distance_m]
  );
}

/**
 * Resolve the nearest fare-bearing TfL stop for a postcode SECTOR, cache it
 * permanently, and return its NaPTAN ID. Returns null if nothing within range.
 */
export async function getNearestStopForSector({ sector, lat, lng }) {
  if (!sector) return null;
  await ensureSchema();
  const cached = await readCachedSectorStop(sector);
  if (cached) return cached;
  try {
    const stop = await callTflStopPoint({ lat, lng });
    if (!stop) return null;
    await writeSectorStop(sector, stop);
    return stop;
  } catch (err) {
    // Don't poison the cache on transient errors — just skip resolution this
    // round. Caller falls back to lat/lng.
    return null;
  }
}

/**
 * Resolve the nearest fare-bearing TfL stop for a UNIT postcode (lazy upgrade
 * path). Uses the sector cache as a free hint when possible.
 */
export async function getNearestStopForPostcode({ postcodeNorm, sector, lat, lng }) {
  if (!postcodeNorm) return null;
  await ensureSchema();
  const cached = await readCachedPostcodeStop(postcodeNorm);
  if (cached) return cached;

  // Cheap fallback: if the sector is already resolved, use that ID. Saves an
  // API call. We still won't write to postcode_nearest_stop here — we leave
  // the postcode-level cache untouched so a future "real" resolve can land.
  if (sector) {
    const sectorCached = await readCachedSectorStop(sector);
    if (sectorCached) return sectorCached;
  }

  try {
    const stop = await callTflStopPoint({ lat, lng });
    if (!stop) return null;
    await writePostcodeStop(postcodeNorm, stop);
    return stop;
  } catch (err) {
    return null;
  }
}

export async function ensureNearestStopSchema() {
  await ensureSchema();
}
