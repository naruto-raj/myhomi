# Housing Map (Price Paid Explorer)

MapLibre + real UK data (Price Paid + ONS Postcode Directory) with postcode-sector ranking.

## Quick Start (Docker)
```bash
docker compose up -d --build
```

### URLs
- Web: http://localhost:5173
- API: http://localhost:5050
- Postgres: localhost:5432 (user: housing_user, db: housing_map)

## Data Downloads
### Price Paid Data (HM Land Registry)
Download the full CSV and place it at:
`data/price-paid/ppd.csv`

Suggested source:
- `http://prod.publicdata.landregistry.gov.uk.s3-website-eu-west-1.amazonaws.com/pp-complete.csv`

### ONS Postcode Directory
Download the ZIP and place the CSV at:
`data/postcode-directory/ons_postcode_directory.csv`

Download + extract:
```bash
curl -L "https://www.arcgis.com/sharing/rest/content/items/295e076b89b542e497e05632706ab429/data" -o /tmp/ons_postcodes.zip
unzip -q /tmp/ons_postcodes.zip -d /tmp/ons_postcodes
first_csv=$(find /tmp/ons_postcodes -type f -name "*.csv" | head -n 1)
cp "$first_csv" /Users/naveenrajg/Documents/VibeCoding/housing-map/data/postcode-directory/ons_postcode_directory.csv
```

## Docker Data Ingest
```bash
# Price Paid (fast mode)
docker compose run --rm server sh -lc "PRICE_PAID_FAST=true PRICE_PAID_TRUNCATE=true node scripts/ingest-price-paid.js"

# ONS Postcode Directory
docker compose run --rm server sh -lc "node scripts/ingest-postcodes.js"

# Compute sector stats
docker compose run --rm server sh -lc "node scripts/compute-sector-stats.js"
```

## DB Sanity Check
```bash
docker compose exec db sh -lc "/scripts/db-sanity.sh"
```

## Ranking Behavior (Zoom-Based)
- Rankings automatically switch based on zoom:
  - `zoom >= 8` uses `sector_centroids` (fast viewport)
  - `zoom < 8` uses `sector_stats` (nationwide)
- Price cap = max affordable * 1.05 (derived from affordability inputs).

## Environment
Example `server/.env` (local only):
```
DATABASE_URL=postgres://housing_user:<PASSWORD>@localhost:5432/housing_map
DATA_DIR=../data
PORT=5050
CORS_ORIGIN=http://localhost:5173
ZOOM_THRESHOLD=8
```

Example root `.env`:
```
VITE_MAP_STYLE_URL=...
VITE_ZOOM_THRESHOLD=8
```

## Notes
- Map uses MapLibre with a hosted style URL from `.env`.
- Sector rankings are computed server-side (`/api/sector-rankings`).
- Contains HM Land Registry data © Crown copyright and database right 2021.
  This data is licensed under the Open Government Licence v3.0.
- Inflation-adjusted prices use CPIH annual index values (2015=100) and are a
  projection from the latest transaction year in the dataset to the latest
  CPIH year available.

## Key APIs
- Postcode lookup: `GET /api/postcode?postcode=SW1A1AA`
- Price paid by postcode: `GET /api/price-paid?postcode=SW1A1AA`
- Price paid by viewport: `GET /api/price-paid/viewport?bbox=minLng,minLat,maxLng,maxLat`
- Sector rankings: `POST /api/sector-rankings`
