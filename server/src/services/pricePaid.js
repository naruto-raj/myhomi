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

export async function getLatestPricePaidNearPoint(longitude, latitude) {
  const { rows } = await pool.query(
    `
      SELECT
        pc.postcode,
        pc.postcode_norm,
        pc.latitude,
        pc.longitude,
        pp.transaction_id,
        pp.price,
        pp.date_of_transfer,
        pp.property_type,
        pp.old_new,
        pp.duration,
        pp.paon,
        pp.saon,
        pp.street,
        pp.locality,
        pp.town_city,
        pp.district,
        pp.county,
        pp.ppd_category_type,
        pp.record_status
      FROM postcode_coords pc
      JOIN LATERAL (
        SELECT *
        FROM price_paid
        WHERE postcode_norm = pc.postcode_norm
        ORDER BY date_of_transfer DESC
        LIMIT 1
      ) pp ON true
      ORDER BY pc.geom <-> ST_SetSRID(ST_MakePoint($1, $2), 4326)
      LIMIT 1;
    `,
    [longitude, latitude]
  );
  return rows[0] || null;
}

export async function getNearestAffordablePricePaid(longitude, latitude, maxPrice, propertyType) {
  const filterByType = propertyType && propertyType !== "ALL";
  const { rows } = await pool.query(
    `
      SELECT
        pl.postcode,
        pl.postcode_norm,
        pl.latitude,
        pl.longitude,
        pl.transaction_id,
        pl.price,
        pl.date_of_transfer,
        pl.property_type,
        pl.old_new,
        pl.duration,
        pl.price_adj
      FROM postcode_latest pl
      WHERE pl.price_adj <= $3
        AND (COALESCE($4::boolean, false) = false OR pl.property_type = $5)
      ORDER BY pl.geom <-> ST_SetSRID(ST_MakePoint($1, $2), 4326)
      LIMIT 1;
    `,
    [longitude, latitude, maxPrice, filterByType, propertyType || null]
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
