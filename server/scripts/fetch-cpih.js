import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CPIH_CSV_URL =
  process.env.CPIH_CSV_URL ||
  "https://www.ons.gov.uk/generator?format=csv&uri=%2Feconomy%2Finflationandpriceindices%2Ftimeseries%2Fl522%2Fmm23";

const outputPath = path.join(__dirname, "..", "data", "cpih_annual.json");

function parseCsvLine(line) {
  const values = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (char === "," && !inQuotes) {
      values.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  values.push(current);
  return values.map((value) => value.trim());
}

function parseYear(dateValue) {
  if (!dateValue) return null;
  const match = String(dateValue).match(/(\d{4})/);
  if (!match) return null;
  const year = Number(match[1]);
  return Number.isFinite(year) ? year : null;
}

async function fetchCpih() {
  const res = await fetch(CPIH_CSV_URL);
  if (!res.ok) {
    throw new Error(`Failed to download CPIH CSV (${res.status})`);
  }
  const text = await res.text();
  const lines = text.split(/\r?\n/).filter(Boolean);

  const totals = new Map();
  const counts = new Map();

  for (let i = 0; i < lines.length; i += 1) {
    const cols = parseCsvLine(lines[i]);
    if (!cols.length) continue;
    const dateValue = cols[0];
    const year = parseYear(dateValue);
    if (!year) continue;
    const value = cols
      .slice(1)
      .map((value) => Number(value))
      .find((num) => Number.isFinite(num));
    if (!Number.isFinite(value)) continue;
    totals.set(year, (totals.get(year) || 0) + value);
    counts.set(year, (counts.get(year) || 0) + 1);
  }

  const annual = {};
  Array.from(totals.keys())
    .sort((a, b) => a - b)
    .forEach((year) => {
      const total = totals.get(year);
      const count = counts.get(year);
      if (!total || !count) return;
      annual[String(year)] = Number((total / count).toFixed(1));
    });

  if (!Object.keys(annual).length) {
    throw new Error("No CPIH data rows parsed. Check CSV format or URL.");
  }

  fs.writeFileSync(outputPath, JSON.stringify(annual, null, 2) + "\n", "utf-8");
  const years = Object.keys(annual);
  const latestYear = years.length ? years[years.length - 1] : "n/a";
  console.log(`Wrote CPIH annual index to ${outputPath} (latest year ${latestYear}).`);
}

fetchCpih().catch((err) => {
  console.error(err);
  process.exit(1);
});
