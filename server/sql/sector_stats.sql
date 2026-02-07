CREATE TABLE IF NOT EXISTS sector_stats (
  sector TEXT PRIMARY KEY,
  median_price INTEGER,
  avg_price INTEGER,
  median_price_adj INTEGER,
  avg_price_adj INTEGER,
  transactions INTEGER,
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION,
  updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE sector_stats ADD COLUMN IF NOT EXISTS median_price_adj INTEGER;
ALTER TABLE sector_stats ADD COLUMN IF NOT EXISTS avg_price_adj INTEGER;

CREATE INDEX IF NOT EXISTS sector_stats_price_idx ON sector_stats (median_price);
CREATE INDEX IF NOT EXISTS sector_stats_price_adj_idx ON sector_stats (median_price_adj);
