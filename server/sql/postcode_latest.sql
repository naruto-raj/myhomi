CREATE TABLE IF NOT EXISTS postcode_latest (
  postcode_norm TEXT PRIMARY KEY,
  postcode TEXT,
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION,
  geom GEOMETRY(POINT, 4326) NOT NULL,
  transaction_id TEXT,
  price INTEGER,
  date_of_transfer DATE,
  price_adj INTEGER,
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS postcode_latest_geom_idx ON postcode_latest USING GIST (geom);
CREATE INDEX IF NOT EXISTS postcode_latest_price_adj_idx ON postcode_latest (price_adj);
