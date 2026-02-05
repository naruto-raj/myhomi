# Housing Map (Phase 1)

Prototype with a map, user inputs, and mocked feasibility logic + a lightweight backend proxy.

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

## Notes
- Uses mocked region data served from `server/data/regions.json`.
- Feasibility is calculated by the backend (`/api/feasible`).
- Phase 3 notes live in `docs/phase-3.md`.
- Self-hosted tiles setup in `docs/tiles.md`.

## Map tiles (POC)
- The app reads `VITE_MAP_STYLE_URL` from `.env`.
- Current POC uses MapTiler's hosted style (non-commercial).

## Real Data (Price Paid)
- Place the Price Paid CSV in `data/price-paid/ppd.csv`.
- Run the ingest script from `server/`:
  - `node scripts/ingest-price-paid.js`
- Query by postcode:
  - `GET /api/price-paid?postcode=SW1A1AA`

Example `server/.env`:
```
DATABASE_URL=postgres://housing_user:<PASSWORD>@localhost:5432/housing_map
DATA_DIR=../data
PORT=5050
CORS_ORIGIN=http://localhost:5173
```

## Real Data (Postcodes + Viewport)
- Place ONS Postcode Directory CSV in `data/postcode-directory/ons_postcode_directory.csv`.
- Run the ingest script from `server/`:
  - `node scripts/ingest-postcodes.js`
- Viewport API (bbox = minLng,minLat,maxLng,maxLat):
  - `GET /api/price-paid/viewport?bbox=-0.5,51.2,0.2,51.8`
- UI loads points/heatmap when zoom >= 10.

## Real Data (Sector Stats)
- Compute sector stats (nationwide):
  - `node scripts/compute-sector-stats.js`
- Nationwide sectors API:
  - `GET /api/sectors?limit=2000`
