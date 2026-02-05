import { pool } from "../db.js";

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
        WITH filtered AS (
          SELECT
            pp.price,
            pp.postcode,
            pc.latitude,
            pc.longitude,
            regexp_replace(pp.postcode, '\\s+.*', '') AS outward,
            substring(pp.postcode from '\\s+(.+)') AS inward
          FROM price_paid pp
          JOIN postcode_coords pc ON pc.postcode_norm = pp.postcode_norm
          WHERE pc.geom && ST_MakeEnvelope($1, $2, $3, $4, 4326)
            AND pp.postcode IS NOT NULL
        ),
        sectors AS (
          SELECT
            outward || ' ' || substring(inward, 1, 1) AS sector,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY price) AS median_price,
            AVG(price)::int AS avg_price,
            COUNT(*)::int AS transactions,
            AVG(latitude) AS latitude,
            AVG(longitude) AS longitude
          FROM filtered
          WHERE inward IS NOT NULL
          GROUP BY sector
        )
        SELECT * FROM sectors
        ORDER BY transactions DESC
        LIMIT $5;
      `,
      [minLng, minLat, maxLng, maxLat, Math.min(limit * 5, 2000)]
    );
    rows = result.rows;
  } else {
    const result = await pool.query(
      `
        SELECT sector, median_price, avg_price, transactions, latitude, longitude, updated_at
        FROM sector_stats
        ORDER BY transactions DESC
        LIMIT $1;
      `,
      [Math.min(limit * 5, 5000)]
    );
    rows = result.rows;
  }

  if (!rows.length) return [];

  const prices = rows.map((row) => Number(row.median_price || 0));
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

  return rows
    .map((row) => {
      const priceScore = normalize(Number(row.median_price || 0), minPrice, maxPrice);
      const commuteScore = 0.5;
      const schoolsScore = 0.5;
      const crimeScore = 0.5;
      const score =
        priceScore * (weightMap.price || 0) +
        commuteScore * (weightMap.commute || 0) +
        schoolsScore * (weightMap.schools || 0) +
        (1 - crimeScore) * (weightMap.crime || 0);

      return { ...row, score };
    })
    .filter((row) => Number(row.median_price || 0) <= filters.maxPrice)
    .filter((row) => Number(row.median_price || 0) <= maxAffordable)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, limit);
}
