CREATE TABLE IF NOT EXISTS price_paid (
  transaction_id TEXT PRIMARY KEY,
  price INTEGER NOT NULL,
  date_of_transfer DATE NOT NULL,
  postcode TEXT,
  postcode_norm TEXT,
  property_type TEXT,
  old_new TEXT,
  duration TEXT,
  paon TEXT,
  saon TEXT,
  street TEXT,
  locality TEXT,
  town_city TEXT,
  district TEXT,
  county TEXT,
  ppd_category_type TEXT,
  record_status TEXT
);

CREATE INDEX IF NOT EXISTS price_paid_postcode_idx ON price_paid (postcode);
CREATE INDEX IF NOT EXISTS price_paid_postcode_norm_idx ON price_paid (postcode_norm);
CREATE INDEX IF NOT EXISTS price_paid_date_idx ON price_paid (date_of_transfer);
