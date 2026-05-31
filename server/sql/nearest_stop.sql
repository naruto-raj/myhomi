-- Cache of the nearest TfL-recognised stop for each postcode sector and
-- (lazily) each unit postcode. Used to pass NaPTAN station IDs to TfL's
-- /Journey/JourneyResults endpoint, which only returns real fare data when
-- the from/to are recognised stops (not raw lat/lng).
--
-- Filled by scripts/prewarm-stops.js at setup time for London sectors, and
-- lazily by services/stops.js when a unit-postcode lookup misses cache.

CREATE TABLE IF NOT EXISTS sector_nearest_stop (
  sector       TEXT PRIMARY KEY,
  naptan_id    TEXT NOT NULL,
  stop_name    TEXT,
  modes        TEXT,
  distance_m   INTEGER,
  resolved_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS postcode_nearest_stop (
  postcode_norm TEXT PRIMARY KEY,
  naptan_id     TEXT NOT NULL,
  stop_name     TEXT,
  modes         TEXT,
  distance_m    INTEGER,
  resolved_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
