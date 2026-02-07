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
  limit = 50,
}) {
  let rows = [];
  if (scope === "viewport") {
    const [minLng, minLat, maxLng, maxLat] = bbox;
    const result = await pool.query(
      `
        SELECT
          sector,
          median_price,
          avg_price,
          median_price_adj,
          avg_price_adj,
          transactions,
          latitude,
          longitude,
          updated_at
        FROM sector_centroids
        WHERE geom && ST_MakeEnvelope($1, $2, $3, $4, 4326)
        ORDER BY transactions DESC
        LIMIT $5;
      `,
      [minLng, minLat, maxLng, maxLat, Math.min(limit * 5, 2000)]
    );
    rows = result.rows;
  } else {
    const result = await pool.query(
      `
        SELECT sector, median_price, avg_price, median_price_adj, avg_price_adj, transactions, latitude, longitude, updated_at
        FROM sector_stats
        ORDER BY transactions DESC
        LIMIT $1;
      `,
      [Math.min(limit * 5, 5000)]
    );
    rows = result.rows;
  }

  if (!rows.length) return { rows: [], meta: null };

  const prices = rows.map((row) => Number(row.median_price_adj ?? row.median_price ?? 0));
  const minPrice = Math.min(...prices);
  const maxPrice = Math.max(...prices);

  const weightMap = {};
  priorities.forEach((key, idx) => {
    weightMap[key] = priorities.length - idx;
  });

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

  const maxPriceCap = maxAffordable * 1.05;

  const meta = await getDataMeta();
  const priceYear = meta.price_paid_max_year ? Number(meta.price_paid_max_year) : null;
  const inflation = priceYear ? getInflationFactor(priceYear) : null;

  const adjustedRows = rows
    .map((row) => {
      const priceValue = Number(row.median_price_adj ?? row.median_price ?? 0);
      const priceScore = normalize(priceValue, minPrice, maxPrice);
      const commuteScore = 0.5;
      const schoolsScore = 0.5;
      const crimeScore = 0.5;
      const score =
        priceScore * (weightMap.price || 0) +
        commuteScore * (weightMap.commute || 0) +
        schoolsScore * (weightMap.schools || 0) +
        (1 - crimeScore) * (weightMap.crime || 0);

      const inflation_adjusted_price =
        row.median_price_adj ?? (inflation?.factor && row.median_price
          ? Math.round(Number(row.median_price) * inflation.factor)
          : null);
      return { ...row, score, inflation_adjusted_price };
    })
    .filter((row) => Number(row.median_price_adj ?? row.median_price ?? 0) <= maxPriceCap)
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
        }
      : {
          price_year: priceYear,
          inflation_base_year: null,
          inflation_latest_year: null,
          inflation_base_index: null,
          inflation_latest_index: null,
          inflation_factor: null,
        },
  };
}
