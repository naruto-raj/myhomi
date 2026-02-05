# Self-hosted Tiles (MapLibre)

MapLibre needs a style JSON and vector tile source. For self-hosting, you have two common options:

## Option A: TileServer GL (MBTiles)
- Generate MBTiles (from OpenMapTiles or your pipeline).
- Run TileServer GL to serve style + tiles.
- Point `VITE_MAP_STYLE_URL` to the TileServer style endpoint.

## Option B: PMTiles (recommended for simplicity)
- Generate a single `tiles.pmtiles` file from your data.
- Serve it from `/tiles/tiles.pmtiles` (already wired in `server/src/index.js`).
- Provide a `style.json` that references the PMTiles URL and uses the `pmtiles://` protocol.

### Minimal PMTiles style example
Create `server/tiles/style.json`:

```json
{
  "version": 8,
  "name": "Local",
  "glyphs": "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf",
  "sources": {
    "base": {
      "type": "vector",
      "url": "pmtiles://http://localhost:5050/tiles/tiles.pmtiles"
    }
  },
  "layers": [
    {
      "id": "background",
      "type": "background",
      "paint": { "background-color": "#0f172a" }
    }
  ]
}
```

Set `VITE_MAP_STYLE_URL=/tiles/style.json` in your frontend environment.

## Dev fallback (no basemap)
If you just want the app to render now, you can use the included\n`server/tiles/style.json`, which draws only a background. The app’s\nGeoJSON overlays will still render on top. When you add real tiles,\nreplace the style with a PMTiles style.
