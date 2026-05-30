#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# Downloads the two required open-data files into ./data/.
# Skips files that already exist (use --force to redownload).
#
# Works on macOS, Linux, WSL2, and Git Bash on Windows.
# Requires: curl, unzip
# -----------------------------------------------------------------------------
set -euo pipefail

FORCE=0
if [[ "${1:-}" == "--force" ]]; then
  FORCE=1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DATA_DIR="$ROOT_DIR/data"

mkdir -p "$DATA_DIR/price-paid" "$DATA_DIR/postcode-directory"

# --- 1. Price Paid (HM Land Registry, ~4GB) ---------------------------------
PPD_FILE="$DATA_DIR/price-paid/ppd.csv"
PPD_URL="http://prod.publicdata.landregistry.gov.uk.s3-website-eu-west-1.amazonaws.com/pp-complete.csv"

if [[ -f "$PPD_FILE" && $FORCE -eq 0 ]]; then
  echo "[skip] $PPD_FILE already exists (use --force to redownload)"
else
  echo "[download] Price Paid data (~4GB, may take 5-20 min)..."
  curl -L --fail "$PPD_URL" -o "$PPD_FILE"
  echo "[ok] $PPD_FILE"
fi

# --- 2. ONS Postcode Directory (~200MB zip) ---------------------------------
ONS_FILE="$DATA_DIR/postcode-directory/ons_postcode_directory.csv"
ONS_URL="https://www.arcgis.com/sharing/rest/content/items/295e076b89b542e497e05632706ab429/data"

if [[ -f "$ONS_FILE" && $FORCE -eq 0 ]]; then
  echo "[skip] $ONS_FILE already exists (use --force to redownload)"
else
  echo "[download] ONS Postcode Directory..."
  TMP_DIR="$(mktemp -d)"
  trap 'rm -rf "$TMP_DIR"' EXIT
  curl -L --fail "$ONS_URL" -o "$TMP_DIR/ons.zip"
  unzip -q "$TMP_DIR/ons.zip" -d "$TMP_DIR/ons"

  # The ZIP contains many CSVs: a few small geography-classification lookups
  # plus the actual postcode directory (named ONSPD_*.csv, ~1 GB). The right
  # one lives in a Data/ subfolder and has 'pcds'/'lat'/'long' columns.
  # Strategy: prefer ONSPD_* by name; fall back to the largest CSV.
  ONSPD_CSV="$(find "$TMP_DIR/ons" -type f -iname 'ONSPD_*.csv' | head -n 1)"
  if [[ -z "$ONSPD_CSV" ]]; then
    # Fallback: pick the largest CSV (the directory is dramatically bigger
    # than every lookup table).
    ONSPD_CSV="$(find "$TMP_DIR/ons" -type f -name '*.csv' -print0 \
      | xargs -0 stat -f '%z %N' 2>/dev/null \
      | sort -nr | head -n 1 | cut -d' ' -f2-)"
    # GNU stat fallback (Linux)
    if [[ -z "$ONSPD_CSV" ]]; then
      ONSPD_CSV="$(find "$TMP_DIR/ons" -type f -name '*.csv' -printf '%s %p\n' 2>/dev/null \
        | sort -nr | head -n 1 | cut -d' ' -f2-)"
    fi
  fi

  if [[ -z "$ONSPD_CSV" || ! -f "$ONSPD_CSV" ]]; then
    echo "[error] Could not locate the ONS Postcode Directory CSV inside the zip." >&2
    echo "[error] Contents:" >&2
    find "$TMP_DIR/ons" -type f -name '*.csv' >&2
    exit 1
  fi

  echo "[info] Selected: $(basename "$ONSPD_CSV") ($(du -h "$ONSPD_CSV" | cut -f1))"
  cp "$ONSPD_CSV" "$ONS_FILE"
  echo "[ok] $ONS_FILE"
fi

echo ""
echo "✅ Data downloads complete."
echo ""
echo "Optional: Council Tax (Band D) data must be downloaded manually."
echo "  See README.md → 'Optional data' for details."
