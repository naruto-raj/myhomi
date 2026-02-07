import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dataPath = path.join(__dirname, "..", "..", "data", "cpih_annual.json");
const cpihAnnual = JSON.parse(fs.readFileSync(dataPath, "utf-8"));

export function getCpihAnnualIndex() {
  return cpihAnnual;
}

export function getLatestCpihYear() {
  const years = Object.keys(cpihAnnual).map((year) => Number(year)).filter(Number.isFinite);
  if (!years.length) return null;
  return Math.max(...years);
}

export function getCpihIndex(year) {
  if (!year) return null;
  const value = cpihAnnual[String(year)];
  return Number.isFinite(value) ? value : null;
}

export function getInflationFactor(fromYear) {
  if (!fromYear) return null;
  const latestYear = getLatestCpihYear();
  if (!latestYear) return null;
  const availableYears = Object.keys(cpihAnnual)
    .map((year) => Number(year))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  if (!availableYears.length) return null;

  const baseYear = cpihAnnual[String(fromYear)]
    ? fromYear
    : availableYears.filter((year) => year <= fromYear).pop() ?? availableYears[0];

  const base = getCpihIndex(baseYear);
  const latest = getCpihIndex(latestYear);
  if (!base || !latest) return null;
  return {
    fromYear,
    baseYear,
    latestYear,
    baseIndex: base,
    latestIndex: latest,
    factor: latest / base,
  };
}
