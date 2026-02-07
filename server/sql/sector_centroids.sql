CREATE TABLE IF NOT EXISTS sector_centroids (
  sector TEXT PRIMARY KEY,
  median_price INTEGER,
  avg_price INTEGER,
  median_price_adj INTEGER,
  avg_price_adj INTEGER,
  transactions INTEGER,
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION,
  geom GEOMETRY(POINT, 4326) NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE sector_centroids ADD COLUMN IF NOT EXISTS median_price_adj INTEGER;
ALTER TABLE sector_centroids ADD COLUMN IF NOT EXISTS avg_price_adj INTEGER;

CREATE INDEX IF NOT EXISTS sector_centroids_geom_idx ON sector_centroids USING GIST (geom);
CREATE INDEX IF NOT EXISTS sector_centroids_price_idx ON sector_centroids (median_price);
CREATE INDEX IF NOT EXISTS sector_centroids_price_adj_idx ON sector_centroids (median_price_adj);
