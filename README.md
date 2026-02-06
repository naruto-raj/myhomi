# Housing Map (Price Paid Explorer)

Prototype with MapLibre + real UK data (Price Paid + ONS Postcode Directory) and sector ranking.

## Setup

```bash
npm install

# in one terminal
cd server
npm install
npm run dev

# in another terminal
cd ..
npm run dev
```

## Docker (Hot Reload)
```bash
docker compose up --build
```

### Container URLs
- Web: http://localhost:5173
- API: http://localhost:5050
- Postgres: localhost:5432 (user: housing_user, db: housing_map)

### Docker Data Ingest (inside compose)
```bash
# Price Paid (fast mode)
docker compose run --rm server sh -lc \"PRICE_PAID_FAST=true PRICE_PAID_TRUNCATE=true node scripts/ingest-price-paid.js\"

# ONS Postcode Directory
docker compose run --rm server sh -lc \"node scripts/ingest-postcodes.js\"

# Compute sector stats
docker compose run --rm server sh -lc \"node scripts/compute-sector-stats.js\"
```

## Notes
- Map uses MapLibre with a hosted style URL from `.env`.
- Sector rankings are computed server-side (`/api/sector-rankings`).
- Phase 3 notes live in `docs/phase-3.md`.
- Self-hosted tiles setup in `docs/tiles.md`.

## Map tiles (POC)
- The app reads `VITE_MAP_STYLE_URL` from `.env`.
- Current POC uses MapTiler's hosted style (non-commercial).

## Data Downloads
### Price Paid Data (HM Land Registry)
Download the full CSV and place it at:
`data/price-paid/ppd.csv`

Suggested source:
- `http://prod.publicdata.landregistry.gov.uk.s3-website-eu-west-1.amazonaws.com/pp-complete.csv`

### ONS Postcode Directory
Download a CSV that includes `pcd/pcds`, `lat`, and `long` columns and place it at:
`data/postcode-directory/ons_postcode_directory.csv`

## Environment
Example `server/.env`:
```
DATABASE_URL=postgres://housing_user:<PASSWORD>@localhost:5432/housing_map
DATA_DIR=../data
PORT=5050
CORS_ORIGIN=http://localhost:5173
```

Example root `.env`:
```
VITE_MAP_STYLE_URL=...
```

## Local Data Pipeline (Recommended Order)
1) Create tables (if not present):
```bash
psql "$DATABASE_URL" -f server/sql/price_paid_schema.sql
psql "$DATABASE_URL" -f server/sql/postcode_coords_schema.sql
psql "$DATABASE_URL" -f server/sql/sector_stats.sql
```

2) Ingest Price Paid (fast mode):
```bash
cd server
PRICE_PAID_FAST=true PRICE_PAID_TRUNCATE=true node scripts/ingest-price-paid.js
```
If the CSV has a header:
```bash
PRICE_PAID_FAST=true PRICE_PAID_TRUNCATE=true PRICE_PAID_HAS_HEADER=true node scripts/ingest-price-paid.js
```

3) Ingest ONS Postcode Directory:
```bash
node scripts/ingest-postcodes.js
```

4) Compute nationwide sector stats:
```bash
node scripts/compute-sector-stats.js
```

5) Run servers:
```bash
cd server
npm run dev
```
```bash
cd ..
npm run dev
```

## Key APIs
- Postcode lookup: `GET /api/postcode?postcode=SW1A1AA`
- Price paid by postcode: `GET /api/price-paid?postcode=SW1A1AA`
- Price paid by viewport: `GET /api/price-paid/viewport?bbox=minLng,minLat,maxLng,maxLat`
- Sector rankings: `POST /api/sector-rankings`
