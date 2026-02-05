import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scoreRegions } from "./services/scoring.js";
import { getPricePaidByPostcode } from "./services/pricePaid.js";
import { getPricePaidInViewport } from "./services/pricePaidViewport.js";
import { getPostcodeLocation } from "./services/postcodes.js";
import { getSectorsInViewport } from "./services/sectors.js";
import { getSectorStats } from "./services/sectorStats.js";
import { getRankedSectors } from "./services/rankings.js";

dotenv.config();

const app = express();
const port = Number(process.env.PORT || 5050);
const corsOrigin = process.env.CORS_ORIGIN || "http://localhost:5173";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const regionsPath = path.join(__dirname, "..", "data", "regions.json");
const regions = JSON.parse(fs.readFileSync(regionsPath, "utf-8"));

app.use(cors({ origin: corsOrigin }));
app.use(express.json({ limit: "1mb" }));
app.use("/tiles", express.static(path.join(__dirname, "..", "tiles")));

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

app.get("/api/regions", (_req, res) => {
  res.json(regions);
});

app.post("/api/feasible", (req, res) => {
  const {
    maxMonthlyBudget,
    deposit,
    mortgageRate,
    termYears,
    maxCommuteMins,
    maxCrimeIndex,
  } = req.body || {};

  const inputs = {
    maxMonthlyBudget: Number(maxMonthlyBudget ?? 0),
    deposit: Number(deposit ?? 0),
    mortgageRate: Number(mortgageRate ?? 0),
    termYears: Number(termYears ?? 0),
    maxCommuteMins: Number(maxCommuteMins ?? 0),
    maxCrimeIndex: Number(maxCrimeIndex ?? 0),
  };

  const scored = scoreRegions(regions, inputs);

  res.json({ scored });
});

app.get("/api/search", (req, res) => {
  const q = String(req.query.q || "").toLowerCase();
  if (!q) {
    return res.json({ results: [] });
  }
  const results = regions.filter((region) => region.name.toLowerCase().includes(q));
  res.json({ results });
});

app.get("/api/region/:id", (req, res) => {
  const region = regions.find((item) => item.id === req.params.id);
  if (!region) {
    return res.status(404).json({ error: "Region not found" });
  }
  res.json(region);
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

app.post("/api/sector-rankings", rateLimit, async (req, res) => {
  try {
    const {
      scope = "viewport",
      bbox,
      affordability,
      filters,
      priorities,
      limit = 20,
    } = req.body || {};

    if (scope === "viewport" && (!Array.isArray(bbox) || bbox.length !== 4)) {
      return res.status(400).json({ error: "bbox is required for viewport scope" });
    }
    if (scope === "viewport") {
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
      maxPrice: Number(filters?.maxPrice ?? 1_000_000),
      maxCommute: Number(filters?.maxCommute ?? 120),
      minSchools: Number(filters?.minSchools ?? 0),
      maxCrime: Number(filters?.maxCrime ?? 100),
    };

    const cacheKey = `rank:${scope}:${JSON.stringify(bbox)}:${JSON.stringify(safeAffordability)}:${JSON.stringify(
      safeFilters
    )}:${JSON.stringify(safePriorities)}:${limit}`;
    const cached = getCache(cacheKey);
    if (cached) return res.json(cached);

    const rows = await getRankedSectors({
      scope,
      bbox,
      affordability: safeAffordability,
      filters: safeFilters,
      priorities: safePriorities,
      limit: Math.min(Number(limit), 100),
    });

    setCache(cacheKey, { rows }, 20_000);
    res.json({ rows });
  } catch (err) {
    res.status(500).json({ error: err.message || "Failed to rank sectors" });
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

app.listen(port, () => {
  console.log(`API server running on http://localhost:${port}`);
});
