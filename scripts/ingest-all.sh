#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# Runs every ingest step in the correct order.
# Safe to re-run — each step uses ON CONFLICT / TRUNCATE-then-INSERT semantics.
#
# Assumes:
#   - Docker Desktop is running
#   - `docker compose up -d` has been done (db + server containers exist)
#   - Data files are present in ./data/  (run scripts/download-data.sh first)
# -----------------------------------------------------------------------------
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

run_step() {
  local label="$1"
  shift
  echo ""
  echo "=========================================================="
  echo "▶  $label"
  echo "=========================================================="
  "$@"
}

# 1. Price Paid (~3-8 min)
run_step "Ingesting Price Paid" \
  docker compose run --rm server sh -lc \
    "PRICE_PAID_FAST=true PRICE_PAID_TRUNCATE=true node scripts/ingest-price-paid.js"

# 2. ONS Postcodes (~1-2 min)
run_step "Ingesting ONS Postcodes" \
  docker compose run --rm server sh -lc "node scripts/ingest-postcodes.js"

# 3. CPIH inflation index (~2 sec) — writes server/data/cpih_annual.json
run_step "Fetching CPIH index" \
  docker compose run --rm server sh -lc "node scripts/fetch-cpih.js"

# 4. Council Tax (England) — only if file exists
if [[ -f "data/council_tax_band_d_2025_26.csv" ]]; then
  run_step "Ingesting Council Tax (England)" \
    docker compose run --rm server sh -lc "node scripts/ingest-council-tax.js"
else
  echo ""
  echo "[skip] data/council_tax_band_d_2025_26.csv not found — skipping England council tax."
fi

# 5. Council Tax (Wales) — only if file exists
if [[ -f "data/council_tax_band_d_wales_2025_26.csv" ]]; then
  run_step "Ingesting Council Tax (Wales)" \
    docker compose run --rm server sh -lc \
      "COUNCIL_TAX_CSV=../data/council_tax_band_d_wales_2025_26.csv node scripts/ingest-council-tax.js"
else
  echo ""
  echo "[skip] data/council_tax_band_d_wales_2025_26.csv not found — skipping Wales council tax."
fi

# 6. Compute sector stats (depends on price_paid + postcodes + cpih)
run_step "Computing sector stats" \
  docker compose run --rm server sh -lc "node scripts/compute-sector-stats.js"

# 7. Pre-warm TfL stop cache for London sectors (~30s, optional but recommended).
#    Skipped automatically if TFL_APP_KEY isn't set. Without this, the first
#    user to query each London sector pays a ~200ms /StopPoint latency.
run_step "Pre-warming TfL stop cache (London)" \
  docker compose run --rm server sh -lc "node scripts/prewarm-stops.js"

echo ""
echo "✅ All ingests complete."
echo ""
echo "Verify with:"
echo "  docker compose exec db sh -lc \"/scripts/db-sanity.sh\""
echo ""
echo "Then open: http://localhost:5173"
