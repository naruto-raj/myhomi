# Pipeline Placeholder

This folder is reserved for the Phase 3 geodata pipeline:

1. KML -> GeoJSON (ogr2ogr or similar)
2. Simplify geometry (mapshaper)
3. Vector tiles (tippecanoe or PMTiles)

Example (to be wired later):

```bash
# ogr2ogr -f GeoJSON output.geojson input.kml
# mapshaper output.geojson -simplify 10% -o simplified.geojson
# tippecanoe -o tiles.mbtiles -zg --drop-densest-as-needed simplified.geojson
```
