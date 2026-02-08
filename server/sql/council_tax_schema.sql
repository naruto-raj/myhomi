CREATE TABLE IF NOT EXISTS council_tax_band_d (
  lad_code TEXT PRIMARY KEY,
  lad_name TEXT,
  year INT NOT NULL,
  band_d_annual NUMERIC NOT NULL
);
