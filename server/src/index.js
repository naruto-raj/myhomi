import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scoreRegions } from "./services/scoring.js";

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

app.listen(port, () => {
  console.log(`API server running on http://localhost:${port}`);
});
