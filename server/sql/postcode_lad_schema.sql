CREATE TABLE IF NOT EXISTS postcode_lad (
  postcode_norm TEXT PRIMARY KEY,
  lad_code TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS postcode_lad_lad_idx ON postcode_lad (lad_code);
