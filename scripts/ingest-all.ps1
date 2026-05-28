# -----------------------------------------------------------------------------
# Runs every ingest step in the correct order. Safe to re-run.
# Assumes Docker Desktop is running and `docker compose up -d` has been done.
# -----------------------------------------------------------------------------
$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RootDir   = Split-Path -Parent $ScriptDir
Set-Location $RootDir

function Run-Step {
    param([string]$Label, [string]$Cmd)
    Write-Host ""
    Write-Host "==========================================================" -ForegroundColor Cyan
    Write-Host "==> $Label" -ForegroundColor Cyan
    Write-Host "==========================================================" -ForegroundColor Cyan
    Invoke-Expression $Cmd
    if ($LASTEXITCODE -ne 0) { throw "Step failed: $Label" }
}

# 1. Price Paid (~3-8 min)
Run-Step "Ingesting Price Paid" `
  'docker compose run --rm server sh -lc "PRICE_PAID_FAST=true PRICE_PAID_TRUNCATE=true node scripts/ingest-price-paid.js"'

# 2. ONS Postcodes (~1-2 min)
Run-Step "Ingesting ONS Postcodes" `
  'docker compose run --rm server sh -lc "node scripts/ingest-postcodes.js"'

# 3. CPIH inflation index
Run-Step "Fetching CPIH index" `
  'docker compose run --rm server sh -lc "node scripts/fetch-cpih.js"'

# 4. Council Tax (England)
if (Test-Path "data\council_tax_band_d_2025_26.csv") {
    Run-Step "Ingesting Council Tax (England)" `
      'docker compose run --rm server sh -lc "node scripts/ingest-council-tax.js"'
} else {
    Write-Host "[skip] data\council_tax_band_d_2025_26.csv not found — skipping England council tax." -ForegroundColor Yellow
}

# 5. Council Tax (Wales)
if (Test-Path "data\council_tax_band_d_wales_2025_26.csv") {
    Run-Step "Ingesting Council Tax (Wales)" `
      'docker compose run --rm server sh -lc "COUNCIL_TAX_CSV=../data/council_tax_band_d_wales_2025_26.csv node scripts/ingest-council-tax.js"'
} else {
    Write-Host "[skip] data\council_tax_band_d_wales_2025_26.csv not found — skipping Wales council tax." -ForegroundColor Yellow
}

# 6. Compute sector stats (must run last)
Run-Step "Computing sector stats" `
  'docker compose run --rm server sh -lc "node scripts/compute-sector-stats.js"'

Write-Host ""
Write-Host "All ingests complete." -ForegroundColor Green
Write-Host ""
Write-Host "Verify with:"
Write-Host '  docker compose exec db sh -lc "/scripts/db-sanity.sh"'
Write-Host ""
Write-Host "Then open: http://localhost:5173"
