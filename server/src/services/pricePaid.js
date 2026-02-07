import { pool } from "../db.js";

export async function getPricePaidByPostcode(postcode, limit = 50) {
  const cleaned = postcode.replace(/\s+/g, "").toUpperCase();
  const { rows } = await pool.query(
    `
      SELECT
        transaction_id,
        price,
        date_of_transfer,
        postcode,
        property_type,
        old_new,
        duration,
        paon,
        saon,
        street,
        locality,
        town_city,
        district,
        county,
        ppd_category_type,
        record_status
      FROM price_paid
      WHERE postcode_norm = $1 OR REPLACE(UPPER(postcode), ' ', '') = $1
      ORDER BY date_of_transfer DESC
      LIMIT $2;
    `,
    [cleaned, limit]
  );
  return rows;
}

export async function getLatestPricePaidByPostcode(postcode) {
  const cleaned = postcode.replace(/\s+/g, "").toUpperCase();
  const { rows } = await pool.query(
    `
      SELECT
        transaction_id,
        price,
        date_of_transfer,
        postcode,
        postcode_norm,
        property_type,
        old_new,
        duration,
        paon,
        saon,
        street,
        locality,
        town_city,
        district,
        county,
        ppd_category_type,
        record_status
      FROM price_paid
      WHERE postcode_norm = $1 OR REPLACE(UPPER(postcode), ' ', '') = $1
      ORDER BY date_of_transfer DESC
      LIMIT 1;
    `,
    [cleaned]
  );
  return rows[0] || null;
}

export async function getPricePaidSummaryByDistrict(district, limit = 50) {
  const { rows } = await pool.query(
    `
      SELECT
        district,
        COUNT(*)::int AS transactions,
        AVG(price)::int AS avg_price,
        MIN(date_of_transfer) AS first_sale,
        MAX(date_of_transfer) AS last_sale
      FROM price_paid
      WHERE district = $1
      GROUP BY district
      LIMIT $2;
    `,
    [district, limit]
  );
  return rows;
}
