# -----------------------------------------------------------------------------
# One-shot bootstrap for Windows (PowerShell 5+ or 7+).
#
# Usage (from repo root):
#   powershell -ExecutionPolicy Bypass -File scripts\setup.ps1
# -----------------------------------------------------------------------------
$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RootDir   = Split-Path -Parent $ScriptDir
Set-Location $RootDir

function Section($msg) { Write-Host ""; Write-Host "==> $msg" -ForegroundColor Cyan }
function Ok($msg)      { Write-Host "OK  $msg" -ForegroundColor Green }
function Warn($msg)    { Write-Host "!!  $msg" -ForegroundColor Yellow }
function Die($msg)     { Write-Host "ERR $msg" -ForegroundColor Red; exit 1 }

# --- 1. Dependency check ----------------------------------------------------
Section "Checking prerequisites..."

function Need-Cmd($cmd) {
    if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
        Die "Missing required command: $cmd"
    }
}

Need-Cmd "docker"

try {
    docker info | Out-Null
} catch {
    Die "Docker is installed but not running. Start Docker Desktop and re-run."
}
Ok "docker present; Docker daemon is reachable"

# --- 2. .env files ----------------------------------------------------------
Section "Checking .env files..."

if (-not (Test-Path ".env")) {
    Copy-Item ".env.example" ".env"
    Warn ""
    Warn "Created .env from .env.example."
    Warn ""
    Warn "  -> This app needs YOUR OWN API keys — none are bundled in the repo."
    Warn "     Edit .env and fill in (at minimum) VITE_MAP_STYLE_URL."
    Warn ""
    Warn "     Required:  VITE_MAP_STYLE_URL    https://www.maptiler.com/         (2 min)"
    Warn "     Commute:   ORS_API_KEY           https://openrouteservice.org/      (2 min)"
    Warn "     London:    TFL_APP_KEY           https://api-portal.tfl.gov.uk/     (5 min)"
    Warn "     Optional:  EPC_API_EMAIL/KEY     https://epc.opendatacommunities.org/"
    Warn ""
    Warn "     See README.md -> 'API keys' section for the full decision tree."
    Warn ""
    Warn "  Once you've filled in .env, re-run: .\scripts\setup.ps1"
    exit 0
}

# Detect host arch and pin Docker's `platform:` accordingly.
# Windows-on-ARM (Snapdragon X) → linux/arm64; everything else → linux/amd64.
$arch = $env:PROCESSOR_ARCHITECTURE
if (-not $arch) { $arch = (Get-CimInstance Win32_Processor).Architecture }
switch -Regex ($arch) {
    "ARM64|12"       { $DbPlatform = "linux/arm64"; break }
    "AMD64|x86_64|9" { $DbPlatform = "linux/amd64"; break }
    default          { $DbPlatform = "linux/amd64"; Warn "Unknown arch '$arch' — defaulting DB_PLATFORM=linux/amd64" }
}

$envContent = Get-Content ".env" -Raw
if ($envContent -match "(?m)^DB_PLATFORM=") {
    $envContent = $envContent -replace "(?m)^DB_PLATFORM=.*", "DB_PLATFORM=$DbPlatform"
    Set-Content -Path ".env" -Value $envContent -NoNewline
} else {
    Add-Content -Path ".env" -Value "`n# Auto-detected by scripts/setup.ps1 — do not edit by hand.`nDB_PLATFORM=$DbPlatform"
}
Ok "DB_PLATFORM=$DbPlatform (host arch: $arch)"

if ((Get-Content ".env" -Raw) -match "YOUR_MAPTILER_KEY") {
    Warn ".env still contains placeholder VITE_MAP_STYLE_URL. Map won't render until you replace it."
    Warn "Continuing — edit .env later and run: docker compose restart web"
} else {
    Ok ".env exists and looks customised"
}

if (-not (Test-Path "server\.env")) {
    Copy-Item "server\.env.example" "server\.env"
    Ok "Created server\.env from server\.env.example"
}

# --- 3. Download data -------------------------------------------------------
Section "Ensuring data files are downloaded..."
& (Join-Path $ScriptDir "download-data.ps1")

# --- 4. Build & start stack -------------------------------------------------
Section "Building and starting Docker stack..."
docker compose up -d --build

# Wait for db to be healthy
Section "Waiting for Postgres to become healthy..."
$healthy = $false
for ($i = 1; $i -le 30; $i++) {
    try {
        $status = docker inspect -f '{{.State.Health.Status}}' housing-map-db 2>$null
    } catch { $status = "unknown" }
    if ($status -eq "healthy") {
        $healthy = $true
        Ok "Database is healthy"
        break
    }
    Write-Host "  (attempt $i/30 -- current status: $status)"
    Start-Sleep -Seconds 2
}
if (-not $healthy) { Die "Database never became healthy. Check 'docker compose logs db'." }

# Verify PostGIS
try {
    docker compose exec -T db psql -U housing_user -d housing_map -c "SELECT postgis_version();" | Out-Null
    Ok "PostGIS extension is active"
} catch {
    Die "PostGIS extension is not loaded. Run: docker compose down -v ; .\scripts\setup.ps1"
}

# --- 5. Ingest --------------------------------------------------------------
Section "Running all ingests (~10 min total)..."
& (Join-Path $ScriptDir "ingest-all.ps1")

# --- 6. Done ----------------------------------------------------------------
Write-Host ""
Write-Host "==========================================================" -ForegroundColor Green
Write-Host "  Setup complete." -ForegroundColor Green
Write-Host "==========================================================" -ForegroundColor Green
Write-Host ""
Write-Host "  Web app:    http://localhost:5173"
Write-Host "  API:        http://localhost:5050/api/health"
Write-Host "  Postgres:   localhost:55432  (user: housing_user, db: housing_map)"
Write-Host ""
Write-Host "  Sanity check:"
Write-Host '    docker compose exec db sh -lc "/scripts/db-sanity.sh"'
Write-Host ""
