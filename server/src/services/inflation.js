import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dataPath = path.join(__dirname, "..", "..", "data", "cpih_annual.json");

// Lazy-load + graceful fallback. If the CPIH JSON isn't present yet (fresh
// clone before fetch-cpih.js has run, or partial setup), the server should
// still boot — inflation features just return null until the file appears.
// Previously a top-level readFileSync crashed the entire server import chain.
let cpihAnnual = null;
let lastLoadAttempt = 0;
const RELOAD_INTERVAL_MS = 5_000;

function loadCpih() {
  const now = Date.now();
  // Re-attempt periodically so the server picks up the file once it's written
  // without needing a restart.
  if (cpihAnnual && now - lastLoadAttempt < RELOAD_INTERVAL_MS) return cpihAnnual;
  if (!cpihAnnual && now - lastLoadAttempt < RELOAD_INTERVAL_MS) return null;
  lastLoadAttempt = now;
  try {
    const raw = fs.readFileSync(dataPath, "utf-8");
    cpihAnnual = JSON.parse(raw);
  } catch (err) {
    if (err && err.code !== "ENOENT") {
      console.warn(`[inflation] Failed to load ${dataPath}:`, err.message);
    }
    cpihAnnual = null;
  }
  return cpihAnnual;
}

export function getCpihAnnualIndex() {
  return loadCpih() || {};
}

export function getLatestCpihYear() {
  const data = loadCpih();
  if (!data) return null;
  const years = Object.keys(data).map((year) => Number(year)).filter(Number.isFinite);
  if (!years.length) return null;
  return Math.max(...years);
}

export function getCpihIndex(year) {
  if (!year) return null;
  const data = loadCpih();
  if (!data) return null;
  const value = data[String(year)];
  return Number.isFinite(value) ? value : null;
}

export function getInflationFactor(fromYear) {
  if (!fromYear) return null;
  const data = loadCpih();
  if (!data) return null;
  const latestYear = getLatestCpihYear();
  if (!latestYear) return null;
  const availableYears = Object.keys(data)
    .map((year) => Number(year))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  if (!availableYears.length) return null;

  const baseYear = data[String(fromYear)]
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
