// One-shot pre-warm of the sector_nearest_stop cache for London sectors.
// Run at setup time (called by scripts/ingest-all.{sh,ps1}) so that every
// London commute lookup gets real TfL fares from day one with no per-request
// /StopPoint latency.
//
// Why "London only": TfL's fare engine only computes fares for journeys on
// TfL services. Resolving stops for sectors outside London (e.g. Manchester,
// Edinburgh) would burn TfL API calls for zero benefit — those journeys all
// route through OpenRouteService instead.
//
// Re-runnable. Existing cache rows are reused; only missing sectors are
// resolved. Rate-limited to ~20 req/sec to stay well under TfL's 50/sec cap.

import dotenv from "dotenv";
import { pool } from "../src/db.js";
import {
  ensureNearestStopSchema,
  getNearestStopForSector,
} from "../src/services/stops.js";

dotenv.config();

// Matches the bbox in adapters/tfl.js so the prewarm covers exactly the area
// where the runtime would dispatch to TfL.
const LONDON_BOUNDS = {
  minLat: 51.2868,
  maxLat: 51.6919,
  minLng: -0.5103,
  maxLng: 0.334,
};

// TfL's /StopPoint endpoint can be slow (1–10s per call depending on backend
// load). Serial polling would take hours for ~1,300 London sectors. Fire
// requests in parallel batches to stay well under the 50 req/sec rate limit
// while making real progress. Empirically a batch of 8 with 200ms between
// batches finishes ~1,300 sectors in 4–8 minutes even on a slow TfL day.
const BATCH_SIZE = 8;
const BATCH_DELAY_MS = 200;

if (!process.env.TFL_APP_KEY && !process.env.TFL_APP_ID) {
  console.log("[skip] TFL_APP_KEY / TFL_APP_ID not set — nothing to prewarm.");
  console.log("       This step is optional. The runtime will still work,");
  console.log("       just without real TfL fares (heuristic fallback only).");
  await pool.end();
  process.exit(0);
}

async function fetchLondonSectors() {
  await ensureNearestStopSchema();
  const { rows } = await pool.query(
    `
      SELECT sc.sector, sc.latitude, sc.longitude
      FROM sector_centroids sc
      LEFT JOIN sector_nearest_stop sns ON sns.sector = sc.sector
      WHERE sc.latitude BETWEEN $1 AND $2
        AND sc.longitude BETWEEN $3 AND $4
        AND sns.sector IS NULL
      ORDER BY sc.sector;
    `,
    [
      LONDON_BOUNDS.minLat,
      LONDON_BOUNDS.maxLat,
      LONDON_BOUNDS.minLng,
      LONDON_BOUNDS.maxLng,
    ]
  );
  return rows;
}

async function main() {
  const t0 = Date.now();
  const sectors = await fetchLondonSectors();
  if (!sectors.length) {
    console.log("[ok] sector_nearest_stop already covers every London sector.");
    return;
  }
  console.log(
    `[info] Pre-warming ${sectors.length} London sectors → TfL stops ` +
      `(${BATCH_SIZE} parallel, ~${BATCH_DELAY_MS}ms between batches)...`
  );

  let resolved = 0;
  let noStop = 0;
  let failed = 0;
  let processed = 0;

  for (let i = 0; i < sectors.length; i += BATCH_SIZE) {
    const batch = sectors.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map((s) =>
        getNearestStopForSector({
          sector: s.sector,
          lat: Number(s.latitude),
          lng: Number(s.longitude),
        })
      )
    );

    results.forEach((r, idx) => {
      if (r.status === "fulfilled") {
        if (r.value?.naptan_id) resolved += 1;
        else noStop += 1;
      } else {
        failed += 1;
        if (failed <= 3) {
          console.error(`  ⚠ ${batch[idx].sector}: ${r.reason?.message || r.reason}`);
        }
      }
    });

    processed += batch.length;
    if (processed % 80 === 0 || processed >= sectors.length) {
      const pct = ((processed / sectors.length) * 100).toFixed(0);
      console.log(
        `  ${processed}/${sectors.length} (${pct}%) — ${resolved} resolved, ${noStop} no stop within 1.5 km, ${failed} errors`
      );
    }

    if (processed < sectors.length) {
      await new Promise((r) => setTimeout(r, BATCH_DELAY_MS));
    }
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(
    `[ok] Done in ${elapsed}s. ${resolved} resolved, ${noStop} no nearby stop, ${failed} failed.`
  );
}

main()
  .then(() => pool.end())
  .catch((err) => {
    console.error(err);
    pool.end();
    process.exit(1);
  });
