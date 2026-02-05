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
