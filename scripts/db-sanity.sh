#!/usr/bin/env bash
set -euo pipefail

echo "== DB context =="
psql -U "${POSTGRES_USER:-housing_user}" -d "${POSTGRES_DB:-housing_map}" -c "SELECT current_database(), current_user;"

echo "== Tables =="
psql -U "${POSTGRES_USER:-housing_user}" -d "${POSTGRES_DB:-housing_map}" -c "\\dt"

echo "== Row counts =="
psql -U "${POSTGRES_USER:-housing_user}" -d "${POSTGRES_DB:-housing_map}" -c "SELECT COUNT(*) AS price_paid_rows FROM price_paid;"
psql -U "${POSTGRES_USER:-housing_user}" -d "${POSTGRES_DB:-housing_map}" -c "SELECT COUNT(*) AS postcode_rows FROM postcode_coords;"
psql -U "${POSTGRES_USER:-housing_user}" -d "${POSTGRES_DB:-housing_map}" -c "SELECT COUNT(*) AS sector_rows FROM sector_stats;"

echo "== Samples =="
psql -U "${POSTGRES_USER:-housing_user}" -d "${POSTGRES_DB:-housing_map}" -c "SELECT * FROM price_paid WHERE postcode IS NOT NULL LIMIT 3;"
psql -U "${POSTGRES_USER:-housing_user}" -d "${POSTGRES_DB:-housing_map}" -c "SELECT * FROM sector_stats ORDER BY transactions DESC LIMIT 3;"

echo "== Postcode norm coverage =="
psql -U "${POSTGRES_USER:-housing_user}" -d "${POSTGRES_DB:-housing_map}" -c "SELECT COUNT(*) AS missing_norm FROM price_paid WHERE postcode_norm IS NULL OR postcode_norm = '';"

echo "== Sector stats freshness =="
psql -U "${POSTGRES_USER:-housing_user}" -d "${POSTGRES_DB:-housing_map}" -c "SELECT MAX(updated_at) AS sector_stats_updated_at FROM sector_stats;"

echo "== PostGIS =="
psql -U "${POSTGRES_USER:-housing_user}" -d "${POSTGRES_DB:-housing_map}" -c "SELECT PostGIS_Version();"

echo "== Table sizes =="
psql -U "${POSTGRES_USER:-housing_user}" -d "${POSTGRES_DB:-housing_map}" -c "SELECT relname, pg_size_pretty(pg_total_relation_size(relid)) AS size FROM pg_catalog.pg_statio_user_tables ORDER BY pg_total_relation_size(relid) DESC;"
