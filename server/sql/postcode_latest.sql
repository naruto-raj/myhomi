CREATE TABLE IF NOT EXISTS postcode_latest (
  postcode_norm TEXT PRIMARY KEY,
  postcode TEXT,
  sector TEXT,
  property_type TEXT,
  old_new TEXT,
  duration TEXT,
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION,
  geom GEOMETRY(POINT, 4326) NOT NULL,
  transaction_id TEXT,
  price INTEGER,
  date_of_transfer DATE,
  price_adj INTEGER,
  updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE postcode_latest ADD COLUMN IF NOT EXISTS sector TEXT;
ALTER TABLE postcode_latest ADD COLUMN IF NOT EXISTS property_type TEXT;
ALTER TABLE postcode_latest ADD COLUMN IF NOT EXISTS old_new TEXT;
ALTER TABLE postcode_latest ADD COLUMN IF NOT EXISTS duration TEXT;

CREATE INDEX IF NOT EXISTS postcode_latest_geom_idx ON postcode_latest USING GIST (geom);
CREATE INDEX IF NOT EXISTS postcode_latest_price_adj_idx ON postcode_latest (price_adj);
CREATE INDEX IF NOT EXISTS postcode_latest_sector_idx ON postcode_latest (sector);
CREATE INDEX IF NOT EXISTS postcode_latest_type_idx ON postcode_latest (property_type);
