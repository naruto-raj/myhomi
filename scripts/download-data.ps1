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

        # The ZIP contains many CSVs: small lookups (sector centroids, outward
        # codes, geography classifications) plus the actual postcode directory
        # (~1 GB). Multiple files share the ONSPD_* prefix, so name matching
        # is unreliable. Pick the LARGEST CSV — the directory dwarfs every
        # lookup by 100x+.
        $AllCsvs = Get-ChildItem -Path (Join-Path $TmpDir "ons") -Filter *.csv -Recurse | Sort-Object Length -Descending
        if (-not $AllCsvs) {
            throw "No CSV files found inside ONS zip"
        }

        Write-Host "[info] CSVs found in zip (size):"
        foreach ($csv in $AllCsvs) {
            $sz = [math]::Round($csv.Length / 1MB, 1)
            Write-Host ("       {0,8} MB  {1}" -f $sz, $csv.FullName)
        }

        $OnspdCsv = $AllCsvs | Select-Object -First 1

        # Validate: the directory MUST have lat/long columns.
        $HeaderLine = (Get-Content $OnspdCsv.FullName -TotalCount 1).ToLower() -replace "`r", ""
        $hasLat  = $HeaderLine -match '(^|,)"?(lat|latitude)"?(,|$)'
        $hasLong = $HeaderLine -match '(^|,)"?(long|longitude|lon|lng)"?(,|$)'
        if (-not ($hasLat -and $hasLong)) {
            Write-Host "[error] The largest CSV in the zip doesn't have lat/long columns." -ForegroundColor Red
            Write-Host "[error] Selected: $($OnspdCsv.FullName)" -ForegroundColor Red
            Write-Host "[error] Header  : $(($HeaderLine).Substring(0, [math]::Min(400, $HeaderLine.Length)))" -ForegroundColor Red
            throw "ONS zip layout has changed. File an issue."
        }

        $SizeMb = [math]::Round($OnspdCsv.Length / 1MB, 1)
        Write-Host "[info] Selected: $($OnspdCsv.Name) ($SizeMb MB) -- has lat/long"
        Copy-Item -Path $OnspdCsv.FullName -Destination $OnsFile -Force
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
