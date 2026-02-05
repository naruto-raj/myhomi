# Phase 3 Plan

## Goals
- Replace mock datasets with real UK data sources (Land Registry, crime, schools, commute).
- Scale map rendering for large polygon datasets (KML -> vector tiles).
- Add search by address/postcode and a richer detail panel.

## Data Sources (placeholders)
- Land Registry: price paid + property details.
- Crime: local crime indices.
- Schools: Ofsted/education ratings.
- Commute: distance + public transit time.

## Data Pipeline
1. KML import from source.
2. Convert to GeoJSON.
3. Simplify geometry by zoom level.
4. Generate vector tiles (MVT/PMTiles).
5. Serve tiles locally or via tile server/CDN.

## Backend Responsibilities
- Proxy external APIs.
- Normalize responses to a common Region/Property shape.
- Cache popular queries and tiles.

## Frontend Responsibilities
- Search bar + autocomplete (address/postcode).
- Map layer switch (Leaflet -> MapLibre).
- Detail drawer with property data + scoring breakdown.

## Next Steps
- Decide data sources and provide API keys.
- Choose MapLibre vs Mapbox.
- Pick storage (Postgres + PostGIS suggested).
