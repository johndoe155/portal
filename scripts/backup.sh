#!/usr/bin/env bash
# Logical backup of the portal database (pg_dump custom format → compressible,
# selective-restore friendly). Managed PaaS: prefer the provider's PITR +
# snapshots and keep this for portable logical exports.
#
# Usage: DATABASE_URL=postgres://... ./scripts/backup.sh [outdir]
# Restore: pg_restore --clean --if-exists -d "$DATABASE_URL" <file>
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"
OUTDIR="${1:-./backups}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
FILE="$OUTDIR/portal-$STAMP.dump"

mkdir -p "$OUTDIR"
pg_dump --format=custom --compress=9 --dbname="$DATABASE_URL" --file="$FILE"
echo "backup written: $FILE ($(du -h "$FILE" | cut -f1))"

# keep the newest 14 local dumps
ls -1t "$OUTDIR"/portal-*.dump 2>/dev/null | tail -n +15 | xargs -r rm -f
