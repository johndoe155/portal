#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Restore the portal database from an encrypted backup.
#
# This is the script you run on the worst day. It is written to be usable by
# someone who did not write it, under pressure, at 2am:
#   * it refuses to overwrite a database that still has data unless you say
#     --force, so a panicked paste cannot destroy a half-working system;
#   * --list shows what is inside the backup without touching anything;
#   * every destructive step is announced before it happens.
#
# Usage:
#   ./scripts/restore.sh ./backups/portal-20260102T030000Z.dump.enc
#   ./scripts/restore.sh s3://bucket/portal/portal-20260102T030000Z.dump.enc
#   ./scripts/restore.sh --latest                 # newest local backup
#   ./scripts/restore.sh --list <file>            # inspect, change nothing
#   TARGET_DATABASE_URL=... ./scripts/restore.sh --force <file>
#
# Needs BACKUP_ENCRYPTION_KEY — the same value used when the backup was taken.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

log() { printf '%s restore: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }

BACKUP_DIR="${BACKUP_DIR:-./backups}"
PG_RESTORE="${PG_RESTORE_BIN:-pg_restore}"
PSQL="${PSQL_BIN:-psql}"
AWS="${AWS_CLI_BIN:-aws}"
TARGET="${TARGET_DATABASE_URL:-${DATABASE_URL:-}}"
FORCE=false LIST_ONLY=false SRC=""

while [ $# -gt 0 ]; do
  case "$1" in
    --force)  FORCE=true ;;
    --list)   LIST_ONLY=true ;;
    # `|| true`: with `set -o pipefail`, ls failing on an empty/missing
    # directory would abort the script HERE, silently, before the helpful
    # error below ever printed.
    --latest) SRC="$(ls -1t "$BACKUP_DIR"/portal-*.dump.enc 2>/dev/null | head -1 || true)"
              [ -n "$SRC" ] || die "no backups found in $BACKUP_DIR — pass a file or s3:// URL explicitly" ;;
    -h|--help) sed -n '2,25p' "$0"; exit 0 ;;
    *)        SRC="$1" ;;
  esac
  shift
done

[ -n "$SRC" ] || die "usage: $0 [--list|--force|--latest] <backup-file|s3://url>"
[ -n "${BACKUP_ENCRYPTION_KEY:-}" ] || die "BACKUP_ENCRYPTION_KEY is required to decrypt"
$LIST_ONLY || [ -n "$TARGET" ] || die "TARGET_DATABASE_URL (or DATABASE_URL) is required"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT   # the decrypted dump is plaintext pupil data

# ── Fetch ────────────────────────────────────────────────────────────────────
if [ "${SRC#s3://}" != "$SRC" ]; then
  command -v "$AWS" >/dev/null || die "aws CLI needed to fetch $SRC"
  A=(); [ -n "${BACKUP_S3_ENDPOINT:-}" ] && A+=(--endpoint-url "$BACKUP_S3_ENDPOINT")
  [ -n "${BACKUP_S3_REGION:-}" ] && A+=(--region "$BACKUP_S3_REGION")
  log "downloading $SRC"
  "$AWS" "${A[@]}" s3 cp "$SRC" "$WORK/backup.enc" --only-show-errors || die "download failed"
  ENC="$WORK/backup.enc"
else
  [ -f "$SRC" ] || die "no such file: $SRC"
  ENC="$SRC"
fi

# ── Decrypt ──────────────────────────────────────────────────────────────────
PLAIN="$WORK/portal.dump"
log "decrypting"
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 \
  -pass env:BACKUP_ENCRYPTION_KEY -in "$ENC" -out "$PLAIN" 2>/dev/null \
  || die "decryption failed — wrong BACKUP_ENCRYPTION_KEY, or the file is corrupt/truncated"
chmod 600 "$PLAIN"
log "decrypted $(wc -c < "$PLAIN" | tr -d ' ') bytes"

if $LIST_ONLY; then
  command -v "$PG_RESTORE" >/dev/null || die "pg_restore not found"
  "$PG_RESTORE" --list "$PLAIN"
  exit 0
fi

command -v "$PG_RESTORE" >/dev/null || die "pg_restore not found — install postgresql-client"

# ── Guard rail ───────────────────────────────────────────────────────────────
if ! $FORCE && command -v "$PSQL" >/dev/null; then
  EXISTING="$("$PSQL" "$TARGET" -tAc \
    "select count(*) from information_schema.tables where table_schema='public'" 2>/dev/null || echo 0)"
  if [ "${EXISTING:-0}" -gt 0 ]; then
    die "target database already has ${EXISTING} tables in public.
     Restoring would DROP and replace them. If that is what you want, re-run with --force:
       TARGET_DATABASE_URL='...' $0 --force $SRC
     If it is not, point TARGET_DATABASE_URL at an empty database instead."
  fi
fi

log "restoring into target database (this drops and recreates existing objects)"
"$PG_RESTORE" --clean --if-exists --no-owner --no-privileges --exit-on-error \
  --dbname="$TARGET" "$PLAIN" || die "pg_restore failed"

# ── Sanity ───────────────────────────────────────────────────────────────────
if command -v "$PSQL" >/dev/null; then
  USERS="$("$PSQL" "$TARGET" -tAc "select count(*) from users" 2>/dev/null || echo '?')"
  MIGR="$("$PSQL" "$TARGET" -tAc "select count(*) from schema_migrations" 2>/dev/null || echo '?')"
  log "restored: ${USERS} users, ${MIGR} migrations applied"
fi
log "done. Redeploy the application pointing at this database, then log in and verify."
