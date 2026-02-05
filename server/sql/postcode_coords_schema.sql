CREATE TABLE IF NOT EXISTS postcode_coords (
  postcode TEXT PRIMARY KEY,
  postcode_norm TEXT NOT NULL,
  latitude DOUBLE PRECISION NOT NULL,
  longitude DOUBLE PRECISION NOT NULL,
  geom GEOGRAPHY(POINT, 4326) NOT NULL
);

CREATE INDEX IF NOT EXISTS postcode_coords_norm_idx ON postcode_coords (postcode_norm);
CREATE INDEX IF NOT EXISTS postcode_coords_geom_idx ON postcode_coords USING GIST (geom);
