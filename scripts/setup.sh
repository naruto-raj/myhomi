#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# One-shot bootstrap for macOS / Linux / WSL2 / Git Bash on Windows.
#
# What it does:
#   1. Sanity-checks Docker + curl + unzip
#   2. Copies .env.example to .env if missing (warns to fill in MapTiler key)
#   3. Downloads the open-data files (skips if already present)
#   4. Builds and starts the docker compose stack
#   5. Runs all ingest steps
#   6. Prints how to verify and open the app
#
# Re-runnable: safe to invoke multiple times.
# -----------------------------------------------------------------------------
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

bold()   { printf "\033[1m%s\033[0m\n" "$*"; }
green()  { printf "\033[32m%s\033[0m\n" "$*"; }
yellow() { printf "\033[33m%s\033[0m\n" "$*"; }
red()    { printf "\033[31m%s\033[0m\n" "$*"; }

# --- 1. Dependency check ----------------------------------------------------
bold "==> Checking prerequisites..."

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    red "Missing required command: $1"
    return 1
  fi
}

MISSING=0
need_cmd docker || MISSING=1
need_cmd curl   || MISSING=1
need_cmd unzip  || MISSING=1

if [[ $MISSING -eq 1 ]]; then
  red "Please install the missing tools and re-run. See README.md."
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  red "Docker is installed but not running."
  yellow "Start Docker Desktop (macOS/Windows) or 'sudo systemctl start docker' (Linux), then re-run."
  exit 1
fi
green "✓ docker, curl, unzip all present; Docker daemon is reachable"

# --- 2. .env files ----------------------------------------------------------
bold "==> Checking .env files..."

if [[ ! -f .env ]]; then
  cp .env.example .env
  yellow ""
  yellow "  Created .env from .env.example."
  yellow ""
  yellow "  ➜  This app needs YOUR OWN API keys — none are bundled in the repo."
  yellow "     Edit .env and fill in (at minimum) VITE_MAP_STYLE_URL."
  yellow ""
  yellow "     Required:  VITE_MAP_STYLE_URL    https://www.maptiler.com/         (2 min)"
  yellow "     For commute features:"
  yellow "                ORS_API_KEY           https://openrouteservice.org/      (2 min)"
  yellow "     For London fare-accurate commute:"
  yellow "                TFL_APP_KEY           https://api-portal.tfl.gov.uk/     (5 min)"
  yellow "     Optional (floor area):"
  yellow "                EPC_API_EMAIL/KEY     https://epc.opendatacommunities.org/"
  yellow ""
  yellow "     See README.md → '🔑 API keys' for the full decision tree."
  yellow ""
  yellow "  Once you've filled in .env, re-run: ./scripts/setup.sh"
  exit 0
fi

# Detect host architecture and pin Docker's `platform:` accordingly so
# Apple Silicon Macs get native arm64 (no Rosetta emulation) and Intel /
# Windows / Linux x86 hosts get amd64. Idempotently rewrites the
# DB_PLATFORM line in .env on every run so a copied repo across machines
# self-corrects.
ARCH="$(uname -m)"
case "$ARCH" in
  arm64|aarch64)  DB_PLATFORM="linux/arm64" ;;
  x86_64|amd64)   DB_PLATFORM="linux/amd64" ;;
  *)              DB_PLATFORM="linux/amd64" ; yellow "Unknown arch '$ARCH'; defaulting DB_PLATFORM=linux/amd64" ;;
esac

if grep -q "^DB_PLATFORM=" .env; then
  # macOS sed needs `-i ''`; GNU sed needs `-i`. Use a portable rewrite.
  tmp="$(mktemp)"
  sed "s|^DB_PLATFORM=.*|DB_PLATFORM=${DB_PLATFORM}|" .env > "$tmp" && mv "$tmp" .env
else
  printf "\n# Auto-detected by scripts/setup.sh — do not edit by hand.\nDB_PLATFORM=%s\n" "$DB_PLATFORM" >> .env
fi
green "✓ DB_PLATFORM=${DB_PLATFORM} (host arch: ${ARCH})"

if ! grep -q "YOUR_MAPTILER_KEY" .env; then
  green "✓ .env exists and looks customised"
else
  yellow "⚠  .env still contains the placeholder VITE_MAP_STYLE_URL."
  yellow "   The map will not render until you replace YOUR_MAPTILER_KEY with a real key."
  yellow "   Continuing anyway — you can edit .env later and restart with: docker compose restart web"
fi

if [[ ! -f server/.env ]]; then
  cp server/.env.example server/.env
  green "✓ Created server/.env from server/.env.example"
fi

# --- 3. Download data -------------------------------------------------------
bold "==> Ensuring data files are downloaded..."
"$SCRIPT_DIR/download-data.sh"

# --- 4. Build & start stack -------------------------------------------------
bold "==> Building and starting Docker stack..."
docker compose up -d --build

# Wait for the db to become healthy
bold "==> Waiting for Postgres to become healthy..."
for i in {1..30}; do
  status="$(docker inspect -f '{{.State.Health.Status}}' housing-map-db 2>/dev/null || echo unknown)"
  if [[ "$status" == "healthy" ]]; then
    green "✓ Database is healthy"
    break
  fi
  echo "  (attempt $i/30 — current status: $status)"
  sleep 2
done

# Verify PostGIS extension is loaded
if ! docker compose exec -T db psql -U housing_user -d housing_map -c "SELECT postgis_version();" >/dev/null 2>&1; then
  red "PostGIS extension is not loaded in the database."
  red "If you previously had a DB volume from before the Dockerfile.db fix, run:"
  red "  docker compose down -v && ./scripts/setup.sh"
  exit 1
fi
green "✓ PostGIS extension is active"

# --- 5. Ingest --------------------------------------------------------------
bold "==> Running all ingests (this is the slow part: ~10 min total)..."
"$SCRIPT_DIR/ingest-all.sh"

# --- 6. Done ----------------------------------------------------------------
echo ""
green "=========================================================="
green "  ✅ Setup complete."
green "=========================================================="
echo ""
echo "  Web app:    http://localhost:5173"
echo "  API:        http://localhost:5050/api/health"
echo "  Postgres:   localhost:55432  (user: housing_user, db: housing_map)"
echo ""
echo "  Sanity check:"
echo "    docker compose exec db sh -lc \"/scripts/db-sanity.sh\""
echo ""
