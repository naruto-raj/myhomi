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

  # The ZIP contains many CSVs: a few small lookups (sector centroids,
  # outward-code lookups, geography classifications) plus the actual postcode
  # directory (~1 GB). Multiple files share the ONSPD_* prefix, so name
  # matching is unreliable. Heuristic: pick the LARGEST CSV — the directory
  # dwarfs every lookup by 100×+.
  CANDIDATES_LIST="$TMP_DIR/csv_list.txt"
  # Try BSD stat (macOS) first, then GNU stat (Linux). Output: "<bytes>\t<path>".
  if find "$TMP_DIR/ons" -type f -name '*.csv' -exec stat -f '%z	%N' {} + 2>/dev/null > "$CANDIDATES_LIST" && [[ -s "$CANDIDATES_LIST" ]]; then
    :
  else
    find "$TMP_DIR/ons" -type f -name '*.csv' -exec stat -c '%s	%n' {} + > "$CANDIDATES_LIST"
  fi

  if [[ ! -s "$CANDIDATES_LIST" ]]; then
    echo "[error] No CSV files found inside ONS zip" >&2
    exit 1
  fi

  echo "[info] CSVs found in zip (size in bytes):"
  sort -nr "$CANDIDATES_LIST" | awk -F'\t' '{ printf "       %12d  %s\n", $1, $2 }' >&2

  ONSPD_CSV="$(sort -nr "$CANDIDATES_LIST" | head -n 1 | cut -f2)"

  # Validate: the directory MUST have lat/long columns. Headers are case-
  # variable across vintages, so match case-insensitively.
  HEADER_LINE="$(head -n 1 "$ONSPD_CSV" | tr -d '\r' | tr '[:upper:]' '[:lower:]')"
  if ! echo "$HEADER_LINE" | grep -qE '(^|,)"?(lat|latitude)"?(,|$)' \
     || ! echo "$HEADER_LINE" | grep -qE '(^|,)"?(long|longitude|lon|lng)"?(,|$)'; then
    echo "[error] The largest CSV in the zip doesn't have lat/long columns." >&2
    echo "[error] Selected: $ONSPD_CSV" >&2
    echo "[error] Header  : $(head -n 1 "$ONSPD_CSV" | head -c 400)" >&2
    echo "[error] This usually means ONS changed the zip layout. File an issue." >&2
    exit 1
  fi

  echo "[info] Selected: $(basename "$ONSPD_CSV") ($(du -h "$ONSPD_CSV" | cut -f1)) — has lat/long ✓"
  cp "$ONSPD_CSV" "$ONS_FILE"
  echo "[ok] $ONS_FILE"
fi

echo ""
echo "✅ Data downloads complete."
echo ""
echo "Optional: Council Tax (Band D) data must be downloaded manually."
echo "  See README.md → 'Optional data' for details."
