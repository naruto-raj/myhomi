CREATE TABLE IF NOT EXISTS sector_centroids (
  sector TEXT PRIMARY KEY,
  median_price INTEGER,
  avg_price INTEGER,
  transactions INTEGER,
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION,
  geom GEOMETRY(POINT, 4326) NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sector_centroids_geom_idx ON sector_centroids USING GIST (geom);
CREATE INDEX IF NOT EXISTS sector_centroids_price_idx ON sector_centroids (median_price);
