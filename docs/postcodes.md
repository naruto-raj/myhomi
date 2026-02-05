# ONS Postcode Directory (Ingest)

We use the ONS Postcode Directory to map postcodes to lat/lng for spatial queries.

## Download
Download the ONS Postcode Directory CSV and place it here:
`data/postcode-directory/ons_postcode_directory.csv`

## Ingest
```bash
cd server
node scripts/ingest-postcodes.js
```

## Notes
- The ingest script auto-detects columns named `pcds`/`pcd`, `lat`, and `long`/`longitude`.
- If your CSV uses different column names, set `POSTCODE_CSV` to a file with the expected headers.
