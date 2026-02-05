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

app.get("/api/price-paid/viewport", async (req, res) => {
  try {
    const bboxRaw = String(req.query.bbox || "").trim();
    if (!bboxRaw) {
      return res.status(400).json({ error: "bbox is required" });
    }
    const parts = bboxRaw.split(",").map((value) => Number(value.trim()));
    if (parts.length !== 4 || parts.some((value) => !Number.isFinite(value))) {
      return res.status(400).json({ error: "bbox must be minLng,minLat,maxLng,maxLat" });
    }
    const limit = Math.min(Number(req.query.limit || 2000), 5000);
    const rows = await getPricePaidInViewport(parts, limit);
    res.json({ rows });
  } catch (err) {
    res.status(500).json({ error: err.message || "Failed to fetch viewport data" });
  }
});

app.get("/api/sectors/viewport", async (req, res) => {
  try {
    const bboxRaw = String(req.query.bbox || "").trim();
    if (!bboxRaw) {
      return res.status(400).json({ error: "bbox is required" });
    }
    const parts = bboxRaw.split(",").map((value) => Number(value.trim()));
    if (parts.length !== 4 || parts.some((value) => !Number.isFinite(value))) {
      return res.status(400).json({ error: "bbox must be minLng,minLat,maxLng,maxLat" });
    }
    const limit = Math.min(Number(req.query.limit || 500), 1000);
    const rows = await getSectorsInViewport(parts, limit);
    res.json({ rows });
  } catch (err) {
    res.status(500).json({ error: err.message || "Failed to fetch sectors" });
  }
});

app.get("/api/sectors", async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit || 2000), 5000);
    const rows = await getSectorStats(limit);
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

app.listen(port, () => {
  console.log(`API server running on http://localhost:${port}`);
});
