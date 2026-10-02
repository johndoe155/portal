#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Restore drill: prove the newest backup can actually be restored.
#
# "We take nightly backups" is a claim. "We restored last Sunday's backup into
# a scratch database and it had 1,214 pupils in it" is a fact. This script
# turns the claim into the fact, on a schedule, and records the result where
# /api/v1/health can see it — so a backup chain that has silently been writing
# garbage is caught in days rather than during an actual disaster.
#
# It restores into a THROWAWAY database (created and dropped here). It never
# touches the live one; it refuses to run if the scratch name looks like prod.
#
# Usage:
#   DATABASE_URL=postgres://.../portal BACKUP_ENCRYPTION_KEY=... ./scripts/backup-verify.sh
#
# Exit 0 = the backup restored and passed sanity checks.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

log() { printf '%s verify: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2; }
die() { log "ERROR: $*"; write_result "failed" "$*"; exit 1; }

BACKUP_DIR="${BACKUP_DIR:-./backups}"
PSQL="${PSQL_BIN:-psql}"
RESULT_FILE="${BACKUP_VERIFY_FILE:-./data/last-restore-test.json}"
SCRATCH="${BACKUP_VERIFY_DB:-portal_restore_test}"
# Minimum rows expected in a real school's database. A backup that restores
# cleanly but is empty is still a failed backup.
MIN_USERS="${BACKUP_VERIFY_MIN_USERS:-1}"

write_result() {
  mkdir -p "$(dirname "$RESULT_FILE")"
  cat > "$RESULT_FILE" <<JSON
{
  "completed_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "result": "$1",
  "detail": $(printf '%s' "${2:-}" | sed 's/"/\\"/g' | awk '{printf "\"%s\"", $0}'),
  "backup": "${SRC:-}",
  "users": ${USERS:-0},
  "duration_sec": ${DURATION:-0}
}
JSON
}

case "$SCRATCH" in
  *portal_restore_test*|*scratch*|*verify*) : ;;
  *) die "BACKUP_VERIFY_DB='${SCRATCH}' does not look like a scratch database name. Refusing: this script DROPS it." ;;
esac

[ -n "${BACKUP_ENCRYPTION_KEY:-}" ] || die "BACKUP_ENCRYPTION_KEY is required"
[ -n "${DATABASE_URL:-}" ] || die "DATABASE_URL is required (used to reach the server, not to restore into)"
command -v "$PSQL" >/dev/null || die "psql not found"

SRC="${1:-}"
if [ -z "$SRC" ]; then
  if [ -n "${BACKUP_S3_BUCKET:-}" ]; then
    A=(); [ -n "${BACKUP_S3_ENDPOINT:-}" ] && A+=(--endpoint-url "$BACKUP_S3_ENDPOINT")
    [ -n "${BACKUP_S3_REGION:-}" ] && A+=(--region "$BACKUP_S3_REGION")
    # Verify what is actually offsite — that is the copy a disaster leaves us.
    KEY="$(aws "${A[@]}" s3api list-objects-v2 --bucket "$BACKUP_S3_BUCKET" \
      --prefix "${BACKUP_S3_PREFIX:-portal}/" \
      --query 'sort_by(Contents,&LastModified)[-1].Key' --output text 2>/dev/null)"
    [ -n "$KEY" ] && [ "$KEY" != "None" ] || die "no backup objects found in the bucket"
    SRC="s3://${BACKUP_S3_BUCKET}/${KEY}"
  else
    # `|| true` for the same pipefail reason as in restore.sh.
    SRC="$(ls -1t "$BACKUP_DIR"/portal-*.dump.enc 2>/dev/null | head -1 || true)"
    [ -n "$SRC" ] || die "no local backups found in $BACKUP_DIR"
  fi
fi
log "drilling with ${SRC}"

# Admin connection on the same server, pointed at the maintenance database.
ADMIN_URL="$(printf '%s' "$DATABASE_URL" | sed -E 's#(/)[^/?]+(\?|$)#\1postgres\2#')"
SCRATCH_URL="$(printf '%s' "$DATABASE_URL" | sed -E "s#(/)[^/?]+(\\?|\$)#\\1${SCRATCH}\\2#")"

START=$(date +%s)
cleanup() {
  "$PSQL" "$ADMIN_URL" -q -c "drop database if exists \"${SCRATCH}\" with (force)" >/dev/null 2>&1 \
    || "$PSQL" "$ADMIN_URL" -q -c "drop database if exists \"${SCRATCH}\"" >/dev/null 2>&1 || true
}
trap cleanup EXIT

cleanup
log "creating scratch database ${SCRATCH}"
"$PSQL" "$ADMIN_URL" -q -c "create database \"${SCRATCH}\"" || die "could not create scratch database"

TARGET_DATABASE_URL="$SCRATCH_URL" "$(dirname "$0")/restore.sh" --force "$SRC" \
  || die "restore failed — THE BACKUP CHAIN IS NOT USABLE"

# ── Sanity checks: did we get a school back, or an empty shell? ──────────────
USERS="$("$PSQL" "$SCRATCH_URL" -tAc "select count(*) from users" 2>/dev/null || echo 0)"
TABLES="$("$PSQL" "$SCRATCH_URL" -tAc \
  "select count(*) from information_schema.tables where table_schema='public'" 2>/dev/null || echo 0)"
[ "${TABLES:-0}" -ge 10 ] || die "only ${TABLES} tables restored — the dump looks incomplete"
[ "${USERS:-0}" -ge "$MIN_USERS" ] || die "only ${USERS} users restored (expected >= ${MIN_USERS}) — the dump restored but is empty"

# Spot-check that a few load-bearing tables survived, not just that rows exist.
for t in users roles audit_log students; do
  "$PSQL" "$SCRATCH_URL" -tAc "select 1 from ${t} limit 1" >/dev/null 2>&1 \
    || log "WARNING: table ${t} is missing or unreadable in the restored copy"
done

DURATION=$(( $(date +%s) - START ))
log "PASS — ${TABLES} tables, ${USERS} users, restored in ${DURATION}s"
write_result "passed" "restored ${TABLES} tables and ${USERS} users in ${DURATION}s"
