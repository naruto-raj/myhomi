# -----------------------------------------------------------------------------
# Downloads the two required open-data files into .\data\.
# Skips files that already exist (use -Force to redownload).
#
# Windows PowerShell 5+ / PowerShell 7+.
# Run from the repo root:  powershell -ExecutionPolicy Bypass -File scripts\download-data.ps1
# -----------------------------------------------------------------------------
param(
    [switch]$Force
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RootDir   = Split-Path -Parent $ScriptDir
$DataDir   = Join-Path $RootDir "data"

New-Item -ItemType Directory -Force -Path (Join-Path $DataDir "price-paid")          | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $DataDir "postcode-directory")  | Out-Null

# --- 1. Price Paid (HM Land Registry, ~4GB) ---------------------------------
$PpdFile = Join-Path $DataDir "price-paid\ppd.csv"
$PpdUrl  = "http://prod.publicdata.landregistry.gov.uk.s3-website-eu-west-1.amazonaws.com/pp-complete.csv"

if ((Test-Path $PpdFile) -and -not $Force) {
    Write-Host "[skip] $PpdFile already exists (use -Force to redownload)"
} else {
    Write-Host "[download] Price Paid data (~4GB, may take 5-20 min)..."
    Invoke-WebRequest -Uri $PpdUrl -OutFile $PpdFile
    Write-Host "[ok] $PpdFile"
}

# --- 2. ONS Postcode Directory (~200MB zip) ---------------------------------
$OnsFile = Join-Path $DataDir "postcode-directory\ons_postcode_directory.csv"
$OnsUrl  = "https://www.arcgis.com/sharing/rest/content/items/295e076b89b542e497e05632706ab429/data"

if ((Test-Path $OnsFile) -and -not $Force) {
    Write-Host "[skip] $OnsFile already exists (use -Force to redownload)"
} else {
    Write-Host "[download] ONS Postcode Directory..."
    $TmpDir = New-Item -ItemType Directory -Force -Path (Join-Path $env:TEMP ("ons_" + [guid]::NewGuid()))
    try {
        $ZipPath = Join-Path $TmpDir "ons.zip"
        Invoke-WebRequest -Uri $OnsUrl -OutFile $ZipPath
        Expand-Archive -Path $ZipPath -DestinationPath (Join-Path $TmpDir "ons") -Force
        $FirstCsv = Get-ChildItem -Path (Join-Path $TmpDir "ons") -Filter *.csv -Recurse | Select-Object -First 1
        if (-not $FirstCsv) {
            throw "No CSV found inside ONS zip"
        }
        Copy-Item -Path $FirstCsv.FullName -Destination $OnsFile -Force
        Write-Host "[ok] $OnsFile"
    } finally {
        Remove-Item -Recurse -Force $TmpDir -ErrorAction SilentlyContinue
    }
}

Write-Host ""
Write-Host "Data downloads complete." -ForegroundColor Green
Write-Host ""
Write-Host "Optional: Council Tax (Band D) data must be downloaded manually."
Write-Host "  See README.md -> 'Optional data' for details."
