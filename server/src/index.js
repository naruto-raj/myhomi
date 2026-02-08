import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "node:path";
import { pool } from "./db.js";
import {
  getLatestPricePaidByPostcode,
  getNearestAffordableCandidates,
  getLatestPricePaidNearPoint,
  getPricePaidByPostcode,
} from "./services/pricePaid.js";
import { getPricePaidInViewport } from "./services/pricePaidViewport.js";
import { getPostcodeLocation } from "./services/postcodes.js";
import { getSectorsInViewport } from "./services/sectors.js";
import { getSectorStats } from "./services/sectorStats.js";
import { getRankedSectors } from "./services/rankings.js";
import { getDataMeta } from "./services/meta.js";
import { getInflationFactor } from "./services/inflation.js";
import { getAffordableHeatmap } from "./services/affordableHeatmap.js";
import {
  computeEffectiveMonthlyBudget,
  getCommuteForOrigins,
  getCommuteForSectors,
  normalizeCostSensitivity,
} from "./services/commute.js";

dotenv.config();

const app = express();
const port = Number(process.env.PORT || 5050);
const corsOrigin = process.env.CORS_ORIGIN || "http://localhost:5173";
const zoomThreshold = Number(process.env.ZOOM_THRESHOLD || 8);

app.use(cors({ origin: corsOrigin }));
app.use(express.json({ limit: "1mb" }));
app.use("/tiles", express.static(path.join(process.cwd(), "tiles")));

const cache = new Map();
const rateLimits = new Map();
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 120;

function getCache(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expires) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}

function setCache(key, value, ttlMs = 15_000) {
  cache.set(key, { value, expires: Date.now() + ttlMs });
}

function rateLimit(req, res, next) {
  const ip = req.headers["x-forwarded-for"]?.toString() || req.socket.remoteAddress || "unknown";
  const now = Date.now();
  const entry = rateLimits.get(ip) || { count: 0, reset: now + RATE_LIMIT_WINDOW_MS };
  if (now > entry.reset) {
    entry.count = 0;
    entry.reset = now + RATE_LIMIT_WINDOW_MS;
  }
  entry.count += 1;
  rateLimits.set(ip, entry);
  if (entry.count > RATE_LIMIT_MAX) {
    return res.status(429).json({ error: "Rate limit exceeded. Please try again later." });
  }
  next();
}

function safeNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function computeMaxAffordable(affordability) {
  const monthlyBudget = safeNumber(affordability?.monthlyBudget);
  const deposit = safeNumber(affordability?.deposit);
  const mortgageRate = safeNumber(affordability?.mortgageRate);
  const termYears = safeNumber(affordability?.termYears);
  const monthlyRate = mortgageRate / 100 / 12;
  const n = termYears * 12;
  if (n <= 0) return deposit;
  const loan =
    monthlyRate === 0
      ? monthlyBudget * n
      : (monthlyBudget * (Math.pow(1 + monthlyRate, n) - 1)) /
        (monthlyRate * Math.pow(1 + monthlyRate, n));
  return Math.max(loan, 0) + deposit;
}

function computeMaxAffordableWithBudget({ monthlyBudget, deposit, mortgageRate, termYears }) {
  const monthlyRate = safeNumber(mortgageRate) / 100 / 12;
  const n = safeNumber(termYears) * 12;
  if (n <= 0) return safeNumber(deposit);
  const loan =
    monthlyRate === 0
      ? safeNumber(monthlyBudget) * n
      : (safeNumber(monthlyBudget) * (Math.pow(1 + monthlyRate, n) - 1)) /
        (monthlyRate * Math.pow(1 + monthlyRate, n));
  return Math.max(loan, 0) + safeNumber(deposit);
}

function computeMonthlyMortgagePayment({ price, deposit, mortgageRate, termYears }) {
  const principal = Math.max(safeNumber(price) - safeNumber(deposit), 0);
  const monthlyRate = safeNumber(mortgageRate) / 100 / 12;
  const n = safeNumber(termYears) * 12;
  if (n <= 0) return 0;
  if (monthlyRate === 0) return principal / n;
  const pow = Math.pow(1 + monthlyRate, n);
  return principal * (monthlyRate * pow) / (pow - 1);
}

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.get("/api/price-paid", async (req, res) => {
  try {
    const postcode = String(req.query.postcode || "").trim();
    if (!postcode) {
      return res.status(400).json({ error: "postcode is required" });
    }
    const limit = Number(req.query.limit || 50);
    const rows = await getPricePaidByPostcode(postcode, Math.min(limit, 200));
    res.json({ rows });
  } catch (err) {
    res.status(500).json({ error: err.message || "Failed to fetch price paid data" });
  }
});

app.get("/api/postcode/latest", async (req, res) => {
  try {
    const postcode = String(req.query.postcode || "").trim();
    if (!postcode) {
      return res.status(400).json({ error: "postcode is required" });
    }
    const row = await getLatestPricePaidByPostcode(postcode);
    if (!row) {
      return res.status(404).json({ error: "postcode not found" });
    }
    const transactionYear = row?.date_of_transfer
      ? new Date(row.date_of_transfer).getUTCFullYear()
      : null;
    const inflation = transactionYear ? getInflationFactor(transactionYear) : null;
    const inflationAdjusted =
      row.price_adj ??
      (inflation?.factor && row.price ? Math.round(Number(row.price) * inflation.factor) : null);
    const pctChange =
      inflationAdjusted && row.price
        ? ((inflationAdjusted - Number(row.price)) / Number(row.price)) * 100
        : null;

    res.json({
      row,
      meta: inflation
        ? {
            price_year: inflation.fromYear,
            inflation_base_year: inflation.baseYear,
            inflation_latest_year: inflation.latestYear,
            inflation_base_index: inflation.baseIndex,
            inflation_latest_index: inflation.latestIndex,
            inflation_factor: inflation.factor,
            inflation_adjusted_price: inflationAdjusted,
            inflation_percent_change: pctChange,
          }
        : {
            price_year: transactionYear,
            inflation_base_year: null,
            inflation_latest_year: null,
            inflation_base_index: null,
            inflation_latest_index: null,
            inflation_factor: null,
            inflation_adjusted_price: null,
            inflation_percent_change: null,
          },
    });
  } catch (err) {
    res.status(500).json({ error: err.message || "Failed to fetch postcode details" });
  }
});

app.get("/api/postcode/nearest", async (req, res) => {
  try {
    const lat = Number(req.query.lat);
    const lng = Number(req.query.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return res.status(400).json({ error: "lat and lng are required" });
    }

    const row = await getLatestPricePaidNearPoint(lng, lat);
    if (!row) {
      return res.status(404).json({ error: "postcode not found" });
    }

    const transactionYear = row?.date_of_transfer
      ? new Date(row.date_of_transfer).getUTCFullYear()
      : null;
    const inflation = transactionYear ? getInflationFactor(transactionYear) : null;
    const inflationAdjusted =
      inflation?.factor && row.price ? Math.round(Number(row.price) * inflation.factor) : null;
    const pctChange =
      inflationAdjusted && row.price
        ? ((inflationAdjusted - Number(row.price)) / Number(row.price)) * 100
        : null;

    res.json({
      row,
      meta: inflation
        ? {
            price_year: inflation.fromYear,
            inflation_base_year: inflation.baseYear,
            inflation_latest_year: inflation.latestYear,
            inflation_base_index: inflation.baseIndex,
            inflation_latest_index: inflation.latestIndex,
            inflation_factor: inflation.factor,
            inflation_adjusted_price: inflationAdjusted,
            inflation_percent_change: pctChange,
          }
        : {
            price_year: transactionYear,
            inflation_base_year: null,
            inflation_latest_year: null,
            inflation_base_index: null,
            inflation_latest_index: null,
            inflation_factor: null,
            inflation_adjusted_price: null,
            inflation_percent_change: null,
          },
    });
  } catch (err) {
    res.status(500).json({ error: err.message || "Failed to fetch nearest postcode" });
  }
});

app.get("/api/postcode/nearest-affordable", async (req, res) => {
  try {
    const lat = Number(req.query.lat);
    const lng = Number(req.query.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return res.status(400).json({ error: "lat and lng are required" });
    }
    const affordability = {
      monthlyBudget: Number(req.query.monthlyBudget ?? 0),
      deposit: Number(req.query.deposit ?? 0),
      mortgageRate: Number(req.query.mortgageRate ?? 0),
      termYears: Number(req.query.termYears ?? 0),
      workplacePostcode:
        typeof req.query.workplacePostcode === "string" ? req.query.workplacePostcode : null,
      commuteMode: typeof req.query.commuteMode === "string" ? req.query.commuteMode : null,
      commuteDaysPerWeek: Number(req.query.commuteDaysPerWeek ?? 0),
      commuteCostSensitivity: normalizeCostSensitivity(req.query.commuteCostSensitivity),
    };
    const propertyType = typeof req.query.propertyType === "string" ? req.query.propertyType : "ALL";
    const maxAffordable = computeMaxAffordable(affordability);
    const maxAffordableCap = Math.floor(maxAffordable * 1.05);

    let commuteMeta = null;
    let adjustedAffordabilityCap = null;

    const candidates = await getNearestAffordableCandidates(
      lng,
      lat,
      maxAffordableCap,
      propertyType,
      60
    );
    if (!candidates.length) {
      return res.status(404).json({ error: "no affordable postcode found" });
    }

    let row = affordability.workplacePostcode ? null : candidates[0];
    if (affordability.workplacePostcode) {
      const commuteOrigins = candidates.map((candidate) => ({
        origin_key: candidate.postcode_norm,
        longitude: candidate.longitude,
        latitude: candidate.latitude,
      }));
      const commuteResult = await getCommuteForOrigins({
        origins: commuteOrigins,
        workplacePostcode: affordability.workplacePostcode,
        mode: affordability.commuteMode,
        daysPerWeek: affordability.commuteDaysPerWeek,
      });

      for (const candidate of candidates) {
        const commute = commuteResult.map.get(candidate.postcode_norm);
        const effectiveMonthlyBudget = computeEffectiveMonthlyBudget({
          monthlyBudget: affordability.monthlyBudget,
          commuteCostMonthly: commute?.cost_monthly ?? null,
          costSensitivity: affordability.commuteCostSensitivity,
        });
        const adjustedCap = computeMaxAffordableWithBudget({
          monthlyBudget: effectiveMonthlyBudget,
          deposit: affordability.deposit,
          mortgageRate: affordability.mortgageRate,
          termYears: affordability.termYears,
        });
        if (Number(candidate.price_adj ?? 0) <= adjustedCap) {
          row = candidate;
          commuteMeta = {
            ...(commuteResult.meta || {}),
            duration_sec: commute?.duration_sec ?? null,
            distance_km: commute?.distance_km ?? null,
            cost_monthly: commute?.cost_monthly ?? null,
            effective_monthly_budget: Math.round(effectiveMonthlyBudget),
            affordability_cap_adjusted: Math.round(adjustedCap),
          };
          adjustedAffordabilityCap = adjustedCap;
          break;
        }
      }
    }

    if (!row) {
      return res.status(404).json({ error: "no commute-affordable postcode found" });
    }

    const capToUse =
      Number.isFinite(adjustedAffordabilityCap) && adjustedAffordabilityCap > 0
        ? adjustedAffordabilityCap
        : maxAffordableCap;

    const transactionYear = row?.date_of_transfer
      ? new Date(row.date_of_transfer).getUTCFullYear()
      : null;
    const inflation = transactionYear ? getInflationFactor(transactionYear) : null;
    const inflationAdjusted =
      inflation?.factor && row.price ? Math.round(Number(row.price) * inflation.factor) : null;
    const pctChange =
      inflationAdjusted && row.price
        ? ((inflationAdjusted - Number(row.price)) / Number(row.price)) * 100
        : null;
    const priceForMortgage = Number(row?.price_adj ?? inflationAdjusted ?? row?.price ?? 0);
    const mortgageMonthly = computeMonthlyMortgagePayment({
      price: priceForMortgage,
      deposit: affordability.deposit,
      mortgageRate: affordability.mortgageRate,
      termYears: affordability.termYears,
    });
    const commuteCostMonthly = commuteMeta?.cost_monthly ?? 0;
    const commuteSensitivity = affordability.commuteCostSensitivity ?? 0;
    const commuteAdjusted = commuteCostMonthly * commuteSensitivity;
    const totalMonthlyCost = mortgageMonthly + commuteCostMonthly;
    const totalMonthlyCostAdjusted = mortgageMonthly + commuteAdjusted;
    const budgetRemaining = affordability.monthlyBudget - totalMonthlyCost;
    const budgetRemainingAdjusted = affordability.monthlyBudget - totalMonthlyCostAdjusted;

    res.json({
      row,
      meta: inflation
        ? {
            price_year: inflation.fromYear,
            inflation_base_year: inflation.baseYear,
            inflation_latest_year: inflation.latestYear,
            inflation_base_index: inflation.baseIndex,
            inflation_latest_index: inflation.latestIndex,
            inflation_factor: inflation.factor,
            inflation_adjusted_price: inflationAdjusted,
            inflation_percent_change: pctChange,
            affordability_cap: Math.round(capToUse),
            affordability_cap_base: Math.round(maxAffordableCap),
            commute: commuteMeta,
            mortgage_monthly: Math.round(mortgageMonthly),
            total_monthly_cost: Math.round(totalMonthlyCost),
            total_monthly_cost_adjusted: Math.round(totalMonthlyCostAdjusted),
            budget_remaining: Math.round(budgetRemaining),
            budget_remaining_adjusted: Math.round(budgetRemainingAdjusted),
            price_for_mortgage: Math.round(priceForMortgage),
          }
        : {
            price_year: transactionYear,
            inflation_base_year: null,
            inflation_latest_year: null,
            inflation_base_index: null,
            inflation_latest_index: null,
            inflation_factor: null,
            inflation_adjusted_price: null,
            inflation_percent_change: null,
            affordability_cap: Math.round(capToUse),
            affordability_cap_base: Math.round(maxAffordableCap),
            commute: commuteMeta,
            mortgage_monthly: Math.round(mortgageMonthly),
            total_monthly_cost: Math.round(totalMonthlyCost),
            total_monthly_cost_adjusted: Math.round(totalMonthlyCostAdjusted),
            budget_remaining: Math.round(budgetRemaining),
            budget_remaining_adjusted: Math.round(budgetRemainingAdjusted),
            price_for_mortgage: Math.round(priceForMortgage),
          },
    });
  } catch (err) {
    res.status(500).json({ error: err.message || "Failed to fetch nearest affordable postcode" });
  }
});

app.get("/api/price-paid/viewport", rateLimit, async (req, res) => {
  try {
    const bboxRaw = String(req.query.bbox || "").trim();
    if (!bboxRaw) {
      return res.status(400).json({ error: "bbox is required" });
    }
    const parts = bboxRaw.split(",").map((value) => Number(value.trim()));
    if (parts.length !== 4 || parts.some((value) => !Number.isFinite(value))) {
      return res.status(400).json({ error: "bbox must be minLng,minLat,maxLng,maxLat" });
    }
    const [minLng, minLat, maxLng, maxLat] = parts;
    const maxHeatmapSpan = Number(process.env.HEATMAP_MAX_SPAN || 20);
    if (Math.abs(maxLng - minLng) > maxHeatmapSpan || Math.abs(maxLat - minLat) > maxHeatmapSpan) {
      return res.status(400).json({ error: "bbox is too large" });
    }
    const limit = Math.min(Number(req.query.limit || 2000), 5000);
    const cacheKey = `price-paid:${bboxRaw}:${limit}`;
    const cached = getCache(cacheKey);
    if (cached) return res.json(cached);
    const rows = await getPricePaidInViewport(parts, limit);
    setCache(cacheKey, { rows }, 10_000);
    res.json({ rows });
  } catch (err) {
    res.status(500).json({ error: err.message || "Failed to fetch viewport data" });
  }
});

app.get("/api/sectors/viewport", rateLimit, async (req, res) => {
  try {
    const bboxRaw = String(req.query.bbox || "").trim();
    if (!bboxRaw) {
      return res.status(400).json({ error: "bbox is required" });
    }
    const parts = bboxRaw.split(",").map((value) => Number(value.trim()));
    if (parts.length !== 4 || parts.some((value) => !Number.isFinite(value))) {
      return res.status(400).json({ error: "bbox must be minLng,minLat,maxLng,maxLat" });
    }
    const [minLng, minLat, maxLng, maxLat] = parts;
    if (Math.abs(maxLng - minLng) > 5 || Math.abs(maxLat - minLat) > 5) {
      return res.status(400).json({ error: "bbox is too large" });
    }
    const limit = Math.min(Number(req.query.limit || 500), 1000);
    const cacheKey = `sectors-viewport:${bboxRaw}:${limit}`;
    const cached = getCache(cacheKey);
    if (cached) return res.json(cached);
    const rows = await getSectorsInViewport(parts, limit);
    setCache(cacheKey, { rows }, 15_000);
    res.json({ rows });
  } catch (err) {
    res.status(500).json({ error: err.message || "Failed to fetch sectors" });
  }
});

app.get("/api/sectors", async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit || 2000), 5000);
    const cacheKey = `sectors:${limit}`;
    const cached = getCache(cacheKey);
    if (cached) return res.json(cached);
    const rows = await getSectorStats(limit);
    setCache(cacheKey, { rows }, 30_000);
    res.json({ rows });
  } catch (err) {
    res.status(500).json({ error: err.message || "Failed to fetch sectors" });
  }
});

app.get("/api/postcode", async (req, res) => {
  try {
    const postcode = String(req.query.postcode || "").trim();
    if (!postcode) {
      return res.status(400).json({ error: "postcode is required" });
    }
    const location = await getPostcodeLocation(postcode);
    if (!location) {
      return res.status(404).json({ error: "postcode not found" });
    }
    res.json({ location });
  } catch (err) {
    res.status(500).json({ error: err.message || "Failed to fetch postcode" });
  }
});

app.get("/api/council-tax", async (req, res) => {
  try {
    const postcode = String(req.query.postcode || "").trim();
    if (!postcode) {
      return res.status(400).json({ error: "postcode is required" });
    }
    const postcodeNorm = postcode.replace(/\s+/g, "").toUpperCase();
    const { rows } = await pool.query(
      `
        SELECT
          ct.lad_code,
          ct.lad_name,
          ct.year,
          ct.band_d_annual
        FROM postcode_lad pl
        JOIN council_tax_band_d ct
          ON ct.lad_code = pl.lad_code
        WHERE pl.postcode_norm = $1
        LIMIT 1;
      `,
      [postcodeNorm]
    );
    if (!rows.length) {
      return res.status(404).json({ error: "council tax not found for postcode" });
    }
    const row = rows[0];
    res.json({
      row,
      monthly_estimate: row.band_d_annual ? Math.round(Number(row.band_d_annual) / 12) : null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message || "Failed to fetch council tax" });
  }
});

app.post("/api/sector-rankings", rateLimit, async (req, res) => {
  try {
    const {
      scope,
      zoom,
      bbox,
      affordability,
      filters,
      priorities,
      propertyType,
      limit = 20,
    } = req.body || {};

    const zoomValue = Number(zoom);
    const derivedScope =
      Number.isFinite(zoomValue) && zoomValue > 0
        ? zoomValue >= zoomThreshold
          ? "viewport"
          : "nationwide"
        : scope || "viewport";

    if (derivedScope === "viewport" && (!Array.isArray(bbox) || bbox.length !== 4)) {
      return res.status(400).json({ error: "bbox is required for viewport scope" });
    }
    if (derivedScope === "viewport") {
      const [minLng, minLat, maxLng, maxLat] = bbox;
      if ([minLng, minLat, maxLng, maxLat].some((value) => !Number.isFinite(value))) {
        return res.status(400).json({ error: "bbox must be minLng,minLat,maxLng,maxLat" });
      }
      if (Math.abs(maxLng - minLng) > 5 || Math.abs(maxLat - minLat) > 5) {
        return res.status(400).json({ error: "bbox is too large" });
      }
    }

    const safePriorities = Array.isArray(priorities) ? priorities : ["price", "commute", "schools", "crime"];
    const safeAffordability = {
      monthlyBudget: safeNumber(affordability?.monthlyBudget),
      deposit: safeNumber(affordability?.deposit),
      mortgageRate: safeNumber(affordability?.mortgageRate),
      termYears: safeNumber(affordability?.termYears),
      workplacePostcode:
        typeof affordability?.workplacePostcode === "string" ? affordability.workplacePostcode : null,
      commuteMode: typeof affordability?.commuteMode === "string" ? affordability.commuteMode : null,
      commuteDaysPerWeek: safeNumber(affordability?.commuteDaysPerWeek),
      commuteCostSensitivity: normalizeCostSensitivity(affordability?.commuteCostSensitivity),
    };
    const safeFilters = {
      maxCommute: safeNumber(filters?.maxCommute ?? 120),
      minSchools: safeNumber(filters?.minSchools ?? 0),
      maxCrime: safeNumber(filters?.maxCrime ?? 100),
    };
    const safePropertyType =
      typeof propertyType === "string" && propertyType.trim() !== ""
        ? propertyType.trim().toUpperCase()
        : "ALL";
    const maxAffordable = computeMaxAffordable(safeAffordability);
    const maxPriceCap = Number.isFinite(maxAffordable) ? Math.floor(maxAffordable * 1.05) : 0;
    let commuteMeta = null;

    const cacheKey = `rank:${derivedScope}:${JSON.stringify(bbox)}:${JSON.stringify(safeAffordability)}:${JSON.stringify(
      safeFilters
    )}:${JSON.stringify(safePriorities)}:${safePropertyType}:${limit}`;
    const cached = getCache(cacheKey);
    if (cached && cached.meta != null) return res.json(cached);

    const baseLimit = Math.min(Number(limit), 100);
    const prefetchLimit = safeAffordability.workplacePostcode
      ? Math.min(baseLimit * 5, 500)
      : baseLimit;

    const result = await getRankedSectors({
      scope: derivedScope,
      bbox,
      affordability: safeAffordability,
      filters: safeFilters,
      priorities: safePriorities,
      propertyType: safePropertyType,
      limit: prefetchLimit,
    });

    if (safeAffordability.workplacePostcode) {
      const commuteResult = await getCommuteForSectors({
        sectors: result.rows,
        workplacePostcode: safeAffordability.workplacePostcode,
        mode: safeAffordability.commuteMode,
        daysPerWeek: safeAffordability.commuteDaysPerWeek,
      });
      commuteMeta = commuteResult.meta ?? null;
      const commuteMap = commuteResult.map;

      result.rows = result.rows
        .map((row) => {
          const commute = commuteMap.get(row.sector);
          const minutes = commute?.duration_sec ? commute.duration_sec / 60 : null;
          const costMonthly = commute?.cost_monthly ?? null;
          const medianAdj = Number(
            row.median_price_adj ?? row.inflation_adjusted_price ?? row.median_price ?? 0
          );
          const mortgageMonthly = computeMonthlyMortgagePayment({
            price: medianAdj,
            deposit: safeAffordability.deposit,
            mortgageRate: safeAffordability.mortgageRate,
            termYears: safeAffordability.termYears,
          });
          const sensitivity = safeAffordability.commuteCostSensitivity ?? 0;
          const commuteAdjusted = Number.isFinite(costMonthly) ? costMonthly * sensitivity : 0;
          const totalMonthlyCost = mortgageMonthly + (Number.isFinite(costMonthly) ? costMonthly : 0);
          const totalMonthlyCostAdjusted = mortgageMonthly + commuteAdjusted;
          const affordabilityRatio =
            safeAffordability.monthlyBudget > 0
              ? totalMonthlyCostAdjusted / safeAffordability.monthlyBudget
              : null;
          if (affordabilityRatio !== null && affordabilityRatio > 1) {
            return null;
          }
          const score = typeof row.score === "number" ? row.score : 0;
          const commuteScore = minutes !== null ? Math.max(0, 1 - minutes / 120) : 0;
          const costPenalty = Number.isFinite(costMonthly) ? Math.min(costMonthly / 2000, 1) : 0;
          const affordabilityPenalty =
            affordabilityRatio !== null ? Math.max(0, Math.min((affordabilityRatio - 1) * 0.5, 1)) : 0;
          const effectiveMonthlyBudget = computeEffectiveMonthlyBudget({
            monthlyBudget: safeAffordability.monthlyBudget,
            commuteCostMonthly: costMonthly,
            costSensitivity: sensitivity,
          });
          const affordabilityCapAdjusted = computeMaxAffordableWithBudget({
            monthlyBudget: effectiveMonthlyBudget,
            deposit: safeAffordability.deposit,
            mortgageRate: safeAffordability.mortgageRate,
            termYears: safeAffordability.termYears,
          });

          return {
            ...row,
            commute_minutes: minutes,
            commute_cost_monthly: costMonthly,
            mortgage_monthly: Math.round(mortgageMonthly),
            total_monthly_cost: Math.round(totalMonthlyCost),
            total_monthly_cost_adjusted: Math.round(totalMonthlyCostAdjusted),
            budget_remaining: Math.round(
              safeAffordability.monthlyBudget - totalMonthlyCostAdjusted
            ),
            effective_monthly_budget: Math.round(effectiveMonthlyBudget),
            affordability_cap_adjusted: Math.round(affordabilityCapAdjusted),
            affordability_ratio: affordabilityRatio,
            commute_score: commuteScore,
            score: score + commuteScore - costPenalty - affordabilityPenalty,
          };
        })
        .filter(Boolean)
        .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
        .slice(0, baseLimit);
    }

    const payload = {
      ...result,
      meta: {
        ...(result.meta || {}),
        affordability_cap: maxPriceCap,
        property_type: safePropertyType,
        zoom: Number(zoom),
        commute: commuteMeta,
        empty_reason: result.rows.length
          ? null
          : safeAffordability.workplacePostcode
            ? "no_commute_affordable_results"
            : "no_affordable_results",
      },
    };

    if (!payload.meta) {
      payload.meta = {
        affordability_cap: maxPriceCap,
        property_type: safePropertyType,
        zoom: Number(zoom),
        commute: commuteMeta,
        empty_reason: safeAffordability.workplacePostcode
          ? "no_commute_affordable_results"
          : "no_affordable_results",
      };
    }

    setCache(cacheKey, payload, 20_000);
    res.json(payload);
  } catch (err) {
    res.status(500).json({ error: err.message || "Failed to rank sectors" });
  }
});

app.post("/api/affordable-heatmap", rateLimit, async (req, res) => {
  try {
    const { zoom, bbox, affordability, propertyType, limit = 5000 } = req.body || {};
    if (!Array.isArray(bbox) || bbox.length !== 4) {
      return res.status(400).json({ error: "bbox is required" });
    }
    const [minLng, minLat, maxLng, maxLat] = bbox;
    if ([minLng, minLat, maxLng, maxLat].some((value) => !Number.isFinite(value))) {
      return res.status(400).json({ error: "bbox must be minLng,minLat,maxLng,maxLat" });
    }
    if (Math.abs(maxLng - minLng) > 5 || Math.abs(maxLat - minLat) > 5) {
      return res.status(400).json({ error: "bbox is too large" });
    }
    const safeAffordability = {
      monthlyBudget: safeNumber(affordability?.monthlyBudget),
      deposit: safeNumber(affordability?.deposit),
      mortgageRate: safeNumber(affordability?.mortgageRate),
      termYears: safeNumber(affordability?.termYears),
      workplacePostcode:
        typeof affordability?.workplacePostcode === "string" ? affordability.workplacePostcode : null,
      commuteMode: typeof affordability?.commuteMode === "string" ? affordability.commuteMode : null,
      commuteDaysPerWeek: safeNumber(affordability?.commuteDaysPerWeek),
      commuteCostSensitivity: normalizeCostSensitivity(affordability?.commuteCostSensitivity),
    };
    const maxAffordable = computeMaxAffordable(safeAffordability);
    const maxPriceCap = Number.isFinite(maxAffordable) ? Math.floor(maxAffordable * 1.05) : 0;
    const safePropertyType =
      typeof propertyType === "string" && propertyType.trim() !== ""
        ? propertyType.trim().toUpperCase()
        : "ALL";

    if (!Number.isFinite(maxPriceCap) || maxPriceCap <= 0) {
      return res.json({
        mode: "grid",
        rows: [],
        meta: {
          affordability_cap: maxPriceCap,
          property_type: safePropertyType,
          zoom: Number(zoom),
        },
      });
    }

    const cacheKey = `affordable-heatmap:${zoom}:${bbox.join(",")}:${maxPriceCap}:${safePropertyType}:${JSON.stringify(
      safeAffordability
    )}:${limit}`;
    const cached = getCache(cacheKey);
    if (cached) return res.json(cached);

    const pointZoomThreshold = Number(process.env.POINT_ZOOM_THRESHOLD || 10);
    const usePoints = Number.isFinite(zoom) && zoom >= pointZoomThreshold;

    if (safeAffordability.workplacePostcode) {
      if (usePoints) {
        const { rows: rawPoints } = await pool.query(
          `
            SELECT
              postcode_norm,
              longitude,
              latitude,
              price_adj
            FROM postcode_latest
            WHERE geom && ST_MakeEnvelope($1, $2, $3, $4, 4326)
              AND price_adj <= $5
              AND ($6::text = 'ALL' OR property_type = $6::text)
            ORDER BY price_adj ASC
            LIMIT $7;
          `,
          [
            minLng,
            minLat,
            maxLng,
            maxLat,
            maxPriceCap,
            safePropertyType,
            Math.min(Number(limit), 5000),
          ]
        );

        if (!rawPoints.length) {
          return res.json({
            mode: "points",
            rows: [],
            meta: {
              affordability_cap: maxPriceCap,
              property_type: safePropertyType,
              zoom: Number(zoom),
            },
          });
        }

        const commuteOrigins = rawPoints.map((point) => ({
          origin_key: point.postcode_norm,
          longitude: point.longitude,
          latitude: point.latitude,
        }));

        const commuteResult = await getCommuteForOrigins({
          origins: commuteOrigins,
          workplacePostcode: safeAffordability.workplacePostcode,
          mode: safeAffordability.commuteMode,
          daysPerWeek: safeAffordability.commuteDaysPerWeek,
        });

        const rows = rawPoints
          .map((point) => {
            const commute = commuteResult.map.get(point.postcode_norm);
            const commuteMinutes =
              commute?.duration_sec && Number.isFinite(commute.duration_sec)
                ? commute.duration_sec / 60
                : null;
            const effectiveMonthlyBudget = computeEffectiveMonthlyBudget({
              monthlyBudget: safeAffordability.monthlyBudget,
              commuteCostMonthly: commute?.cost_monthly ?? null,
              costSensitivity: safeAffordability.commuteCostSensitivity,
            });
            const adjustedCap = computeMaxAffordableWithBudget({
              monthlyBudget: effectiveMonthlyBudget,
              deposit: safeAffordability.deposit,
              mortgageRate: safeAffordability.mortgageRate,
              termYears: safeAffordability.termYears,
            });
            if (!Number.isFinite(adjustedCap) || adjustedCap <= 0) return null;
            if (Number(point.price_adj ?? 0) > adjustedCap) return null;
            const ratio = Number(point.price_adj ?? 0) / adjustedCap;
            const affordabilityWeight = Math.max(0, Math.min(1, 1 - ratio));
            const commuteScore =
              commuteMinutes !== null ? Math.max(0, 1 - Math.min(commuteMinutes / 90, 1)) : 0;
            const weight = Math.max(
              0.2,
              Math.min(1, affordabilityWeight * 0.6 + commuteScore * 0.4)
            );
            return {
              longitude: point.longitude,
              latitude: point.latitude,
              weight,
              count: 1,
            };
          })
          .filter(Boolean);

        const payload = {
          mode: "points",
          rows,
          meta: {
            affordability_cap: maxPriceCap,
            property_type: safePropertyType,
            zoom: Number(zoom),
            commute: commuteResult.meta ?? null,
          },
        };
        setCache(cacheKey, payload, 20_000);
        return res.json(payload);
      }

      const baseRanked = await getRankedSectors({
        scope: "viewport",
        bbox,
        affordability: safeAffordability,
        filters: { maxCommute: 0, minSchools: 0, maxCrime: 100 },
        priorities: ["price"],
        propertyType: safePropertyType,
        limit: Math.min(Number(limit), 1500),
      });
      const commuteResult = await getCommuteForSectors({
        sectors: baseRanked.rows,
        workplacePostcode: safeAffordability.workplacePostcode,
        mode: safeAffordability.commuteMode,
        daysPerWeek: safeAffordability.commuteDaysPerWeek,
      });
      const commuteMap = commuteResult.map;

      const rows = baseRanked.rows
        .map((sector) => {
          const commute = commuteMap.get(sector.sector);
          const commuteMinutes =
            commute?.duration_sec && Number.isFinite(commute.duration_sec)
              ? commute.duration_sec / 60
              : null;
          const costMonthly = commute?.cost_monthly ?? null;
          const effectiveMonthlyBudget = computeEffectiveMonthlyBudget({
            monthlyBudget: safeAffordability.monthlyBudget,
            commuteCostMonthly: costMonthly,
            costSensitivity: safeAffordability.commuteCostSensitivity,
          });
          const adjustedCap = computeMaxAffordableWithBudget({
            monthlyBudget: effectiveMonthlyBudget,
            deposit: safeAffordability.deposit,
            mortgageRate: safeAffordability.mortgageRate,
            termYears: safeAffordability.termYears,
          });
          const medianAdj = Number(
            sector.median_price_adj ?? sector.inflation_adjusted_price ?? sector.median_price ?? 0
          );
          if (!Number.isFinite(adjustedCap) || adjustedCap <= 0) return null;
          const affordabilityRatio = medianAdj / adjustedCap;
          if (!Number.isFinite(affordabilityRatio) || affordabilityRatio > 1) return null;
          const affordabilityWeight = Math.max(0, Math.min(1, 1 - affordabilityRatio));
          const commuteScore =
            commuteMinutes !== null ? Math.max(0, 1 - Math.min(commuteMinutes / 90, 1)) : 0;
          const weight = Math.max(
            0.2,
            Math.min(1, affordabilityWeight * 0.6 + commuteScore * 0.4)
          );
          return {
            longitude: sector.longitude,
            latitude: sector.latitude,
            weight,
            count: sector.transactions ?? 1,
          };
        })
        .filter(Boolean);

      const payload = {
        mode: "points",
        rows,
        meta: {
          affordability_cap: maxPriceCap,
          property_type: safePropertyType,
          zoom: Number(zoom),
          commute: commuteResult.meta ?? null,
        },
      };
      setCache(cacheKey, payload, 20_000);
      return res.json(payload);
    }

    const result = await getAffordableHeatmap({
      bbox,
      maxPriceCap,
      propertyType: safePropertyType,
      zoom: Number(zoom),
      pointZoomThreshold: Number(process.env.HEATMAP_POINT_ZOOM || 10),
      limit: Math.min(Number(limit), 10000),
    });
    const payload = {
      ...result,
      meta: {
        affordability_cap: maxPriceCap,
        property_type: safePropertyType,
        zoom: Number(zoom),
      },
    };
    setCache(cacheKey, payload, 20_000);
    res.json(payload);
  } catch (err) {
    console.error("affordable-heatmap failed", err);
    res.status(500).json({ error: err.message || "Failed to fetch affordable heatmap" });
  }
});

app.listen(port, () => {
  console.log(`API server running on http://localhost:${port}`);
});
