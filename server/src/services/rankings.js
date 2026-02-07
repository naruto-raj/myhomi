import { pool } from "../db.js";
import { getDataMeta } from "./meta.js";
import { getInflationFactor } from "./inflation.js";

function normalize(value, min, max) {
  if (max - min <= 0) return 0.5;
  return (value - min) / (max - min);
}

export async function getRankedSectors({
  scope,
  bbox,
  affordability,
  filters,
  priorities,
  propertyType,
  limit = 50,
}) {
  const maxAffordable = (() => {
    const monthlyRate = affordability.mortgageRate / 100 / 12;
    const n = affordability.termYears * 12;
    if (n <= 0) return affordability.deposit;
    const loan =
      monthlyRate === 0
        ? affordability.monthlyBudget * n
        : (affordability.monthlyBudget * (Math.pow(1 + monthlyRate, n) - 1)) /
          (monthlyRate * Math.pow(1 + monthlyRate, n));
    return Math.max(loan, 0) + affordability.deposit;
  })();

  const maxPriceCap = Math.floor(maxAffordable * 1.05);

  const filterByType = propertyType && propertyType !== "ALL";
  let rows = [];
  if (scope === "viewport") {
    const [minLng, minLat, maxLng, maxLat] = bbox;
    const result = await pool.query(
      `
        SELECT
          sector,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY price) AS median_price,
          AVG(price)::int AS avg_price,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY price_adj) AS median_price_adj,
          AVG(price_adj)::int AS avg_price_adj,
          COUNT(*)::int AS transactions,
          AVG(latitude) AS latitude,
          AVG(longitude) AS longitude
        FROM postcode_latest
        WHERE geom && ST_MakeEnvelope($1, $2, $3, $4, 4326)
          AND price_adj <= $5
          AND ($6::boolean = false OR property_type = $7::text)
        GROUP BY sector
        ORDER BY transactions DESC
        LIMIT $8;
      `,
      [
        minLng,
        minLat,
        maxLng,
        maxLat,
        maxPriceCap,
        Boolean(filterByType),
        propertyType || "ALL",
        Math.min(limit * 5, 2000),
      ]
    );
    rows = result.rows;
  } else {
    const result = await pool.query(
      `
        SELECT
          sector,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY price) AS median_price,
          AVG(price)::int AS avg_price,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY price_adj) AS median_price_adj,
          AVG(price_adj)::int AS avg_price_adj,
          COUNT(*)::int AS transactions,
          AVG(latitude) AS latitude,
          AVG(longitude) AS longitude
        FROM postcode_latest
        WHERE price_adj <= $1
          AND ($2::boolean = false OR property_type = $3::text)
        GROUP BY sector
        ORDER BY transactions DESC
        LIMIT $4;
      `,
      [maxPriceCap, Boolean(filterByType), propertyType || "ALL", Math.min(limit * 5, 5000)]
    );
    rows = result.rows;
  }

  if (!rows.length) {
    return {
      rows: [],
      meta: {
        price_year: null,
        inflation_base_year: null,
        inflation_latest_year: null,
        inflation_base_index: null,
        inflation_latest_index: null,
        inflation_factor: null,
        affordability_cap: maxPriceCap,
        property_type: propertyType || "ALL",
        type_ranges: [],
      },
    };
  }

  const densities = rows.map((row) => Number(row.transactions || 0));
  const minDensity = Math.min(...densities);
  const maxDensity = Math.max(...densities);

  let typeRanges = [];
  if (scope === "viewport") {
    const [minLng, minLat, maxLng, maxLat] = bbox;
    const result = await pool.query(
      `
        SELECT
          property_type,
          MIN(price_adj)::int AS min_price_adj,
          MAX(price_adj)::int AS max_price_adj,
          COUNT(*)::int AS count
        FROM postcode_latest
        WHERE geom && ST_MakeEnvelope($1, $2, $3, $4, 4326)
          AND price_adj <= $5
          AND property_type IS NOT NULL
        GROUP BY property_type
        ORDER BY property_type;
      `,
      [minLng, minLat, maxLng, maxLat, maxPriceCap]
    );
    typeRanges = result.rows;
  } else {
    const result = await pool.query(
      `
        SELECT
          property_type,
          MIN(price_adj)::int AS min_price_adj,
          MAX(price_adj)::int AS max_price_adj,
          COUNT(*)::int AS count
        FROM postcode_latest
        WHERE price_adj <= $1
          AND property_type IS NOT NULL
        GROUP BY property_type
        ORDER BY property_type;
      `,
      [maxPriceCap]
    );
    typeRanges = result.rows;
  }

  const meta = await getDataMeta();
  const priceYear = meta.price_paid_max_year ? Number(meta.price_paid_max_year) : null;
  const inflation = priceYear ? getInflationFactor(priceYear) : null;

  const adjustedRows = rows
    .map((row) => {
      const densityScore = normalize(Number(row.transactions || 0), minDensity, maxDensity);
      const score = densityScore;

      const inflation_adjusted_price =
        row.median_price_adj ?? (inflation?.factor && row.median_price
          ? Math.round(Number(row.median_price) * inflation.factor)
          : null);
      return { ...row, score, inflation_adjusted_price };
    })
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, limit);

  return {
    rows: adjustedRows,
    meta: inflation
      ? {
          price_year: inflation.fromYear,
          inflation_base_year: inflation.baseYear,
          inflation_latest_year: inflation.latestYear,
          inflation_base_index: inflation.baseIndex,
          inflation_latest_index: inflation.latestIndex,
          inflation_factor: inflation.factor,
          affordability_cap: maxPriceCap,
          property_type: propertyType || "ALL",
          type_ranges: typeRanges,
        }
      : {
          price_year: priceYear,
          inflation_base_year: null,
          inflation_latest_year: null,
          inflation_base_index: null,
          inflation_latest_index: null,
          inflation_factor: null,
          affordability_cap: maxPriceCap,
          property_type: propertyType || "ALL",
          type_ranges: typeRanges,
        },
  };
}
