CREATE TABLE IF NOT EXISTS sector_stats (
  sector TEXT PRIMARY KEY,
  median_price INTEGER,
  avg_price INTEGER,
  transactions INTEGER,
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION,
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sector_stats_price_idx ON sector_stats (median_price);
