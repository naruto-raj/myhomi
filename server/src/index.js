import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "node:path";
import {
  getLatestPricePaidByPostcode,
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
            inflation_factor: inflation.factor,
            inflation_adjusted_price: inflationAdjusted,
            inflation_percent_change: pctChange,
          }
        : {
            price_year: transactionYear,
            inflation_base_year: null,
            inflation_latest_year: null,
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
            inflation_factor: inflation.factor,
            inflation_adjusted_price: inflationAdjusted,
            inflation_percent_change: pctChange,
          }
        : {
            price_year: transactionYear,
            inflation_base_year: null,
            inflation_latest_year: null,
            inflation_factor: null,
            inflation_adjusted_price: null,
            inflation_percent_change: null,
          },
    });
  } catch (err) {
    res.status(500).json({ error: err.message || "Failed to fetch nearest postcode" });
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
    if (Math.abs(maxLng - minLng) > 5 || Math.abs(maxLat - minLat) > 5) {
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

app.post("/api/sector-rankings", rateLimit, async (req, res) => {
  try {
    const {
      scope,
      zoom,
      bbox,
      affordability,
      filters,
      priorities,
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
      monthlyBudget: Number(affordability?.monthlyBudget ?? 0),
      deposit: Number(affordability?.deposit ?? 0),
      mortgageRate: Number(affordability?.mortgageRate ?? 0),
      termYears: Number(affordability?.termYears ?? 0),
    };
    const safeFilters = {
      maxCommute: Number(filters?.maxCommute ?? 120),
      minSchools: Number(filters?.minSchools ?? 0),
      maxCrime: Number(filters?.maxCrime ?? 100),
    };

    const cacheKey = `rank:${derivedScope}:${JSON.stringify(bbox)}:${JSON.stringify(safeAffordability)}:${JSON.stringify(
      safeFilters
    )}:${JSON.stringify(safePriorities)}:${limit}`;
    const cached = getCache(cacheKey);
    if (cached) return res.json(cached);

    const result = await getRankedSectors({
      scope: derivedScope,
      bbox,
      affordability: safeAffordability,
      filters: safeFilters,
      priorities: safePriorities,
      limit: Math.min(Number(limit), 100),
    });

    setCache(cacheKey, result, 20_000);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message || "Failed to rank sectors" });
  }
});

app.listen(port, () => {
  console.log(`API server running on http://localhost:${port}`);
});
