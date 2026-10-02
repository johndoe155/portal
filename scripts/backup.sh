#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Nightly encrypted logical backup of the portal database.
#
#   pg_dump ──▶ AES-256 ──▶ local staging ──▶ S3-compatible object store
#                             └─ pruned to BACKUP_RETENTION_DAYS ─┘
#
# The runbook promises "nightly encrypted pg_dump → object storage, 35-day
# retention". This script is what makes that sentence true; docs/backup.md
# explains the whole scheme and the restore drill.
#
# Design notes, in case you are the person changing this at 3am:
#
#   * The plaintext dump NEVER touches disk. pg_dump is piped straight into
#     openssl, so a stolen backup volume yields ciphertext only. (The previous
#     version wrote an unencrypted .dump to ./backups and left it there.)
#   * PIPESTATUS is checked explicitly: `set -o pipefail` catches most of it,
#     but we want to name the stage that failed in the log and the alert.
#   * The heartbeat file is written LAST, after the upload is verified. Its
#     mtime therefore proves the entire pipeline finished, not that it began.
#     /api/v1/health reads it and goes "warning" when it goes stale, so a
#     backup that quietly stops running becomes visible within a day.
#   * Exit codes are distinct per stage so a cron wrapper can alert usefully.
#
# Usage:
#   DATABASE_URL=postgres://... BACKUP_ENCRYPTION_KEY=... ./scripts/backup.sh
#   ./scripts/backup.sh --check     # validate configuration and exit
#
# Restore: ./scripts/restore.sh <file-or-s3-url>
# Drill:   ./scripts/backup-verify.sh      (restores into a scratch DB)
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

E_CONFIG=2 E_DUMP=3 E_UPLOAD=4 E_PRUNE=5 E_VERIFY=6

log()  { printf '%s backup: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2; }
die()  { local c=$1; shift; log "ERROR: $*"; exit "$c"; }

# ── Configuration ────────────────────────────────────────────────────────────
BACKUP_DIR="${BACKUP_DIR:-./backups}"
BACKUP_RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-35}"
PG_DUMP="${PG_DUMP_BIN:-pg_dump}"
AWS="${AWS_CLI_BIN:-aws}"
HEARTBEAT="${BACKUP_HEARTBEAT_FILE:-./data/last-backup.json}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
# The random suffix is not decoration. Two runs in the same second (a manual
# run next to the cron one, or a retry) would otherwise produce the SAME
# filename — and the cleanup trap of the second run would delete the first
# run's good backup. Uniqueness here prevents a failed run destroying a
# successful one.
NAME="portal-${STAMP}-$(openssl rand -hex 3).dump.enc"
STAGED="${BACKUP_DIR}/${NAME}"

check_config() {
  [ -n "${DATABASE_URL:-}" ] || die $E_CONFIG "DATABASE_URL is required"
  [ -n "${BACKUP_ENCRYPTION_KEY:-}" ] || die $E_CONFIG \
    "BACKUP_ENCRYPTION_KEY is required — generate one with: openssl rand -base64 32
     Store it in a password manager, NOT alongside the backups. Without it every
     backup this script writes is permanently unreadable."
  # A short key is worse than no key because it looks like protection.
  [ "${#BACKUP_ENCRYPTION_KEY}" -ge 20 ] || die $E_CONFIG \
    "BACKUP_ENCRYPTION_KEY is too short (${#BACKUP_ENCRYPTION_KEY} chars, need >= 20)"
  command -v openssl >/dev/null || die $E_CONFIG "openssl not found"
  if [ "${BACKUP_SKIP_DUMP:-}" != "true" ]; then
    command -v "$PG_DUMP" >/dev/null || die $E_CONFIG \
      "$PG_DUMP not found — install the postgresql-client matching your server major version"
  fi
  if [ -n "${BACKUP_S3_BUCKET:-}" ]; then
    command -v "$AWS" >/dev/null || die $E_CONFIG \
      "BACKUP_S3_BUCKET is set but the aws CLI is missing — offsite upload cannot run"
    [ -n "${AWS_ACCESS_KEY_ID:-}" ] || die $E_CONFIG "AWS_ACCESS_KEY_ID is required for S3 upload"
    [ -n "${AWS_SECRET_ACCESS_KEY:-}" ] || die $E_CONFIG "AWS_SECRET_ACCESS_KEY is required for S3 upload"
  else
    # Local-only backups are a stopgap, not a backup strategy: the usual
    # disaster (host dies, volume corrupts, ransomware) takes them with it.
    log "WARNING: BACKUP_S3_BUCKET is not set — backups stay on this host only."
    log "WARNING: a failure that destroys this machine also destroys them."
  fi
}

s3_args() {
  local a=()
  [ -n "${BACKUP_S3_ENDPOINT:-}" ] && a+=(--endpoint-url "$BACKUP_S3_ENDPOINT")
  [ -n "${BACKUP_S3_REGION:-}" ]   && a+=(--region "$BACKUP_S3_REGION")
  printf '%s\n' "${a[@]:-}"
}

if [ "${1:-}" = "--check" ]; then
  check_config
  log "configuration OK (retention ${BACKUP_RETENTION_DAYS}d, dest ${BACKUP_S3_BUCKET:-local-only})"
  exit 0
fi

check_config
mkdir -p "$BACKUP_DIR" "$(dirname "$HEARTBEAT")"

# A failed run must not leave a partial dump in the staging directory:
# `restore.sh --latest` picks the NEWEST file, so a 32-byte corpse from a
# broken run would shadow the last good backup — exactly when you need it.
SUCCEEDED=false
cleanup() {
  if [ "$SUCCEEDED" != "true" ] && [ -n "${STAGED:-}" ] && [ -f "$STAGED" ]; then
    rm -f "$STAGED"
    log "removed incomplete dump ${STAGED}"
  fi
}
trap cleanup EXIT
# Dumps are readable only by the owner — they are a full copy of every pupil
# record in the school.
chmod 700 "$BACKUP_DIR" 2>/dev/null || true

# ── 1. Dump + encrypt, in one pipe, never landing plaintext ──────────────────
[ -e "$STAGED" ] && die $E_DUMP "refusing to overwrite an existing backup at ${STAGED}"
log "dumping database → ${STAGED}"
if [ "${BACKUP_SKIP_DUMP:-}" = "true" ]; then
  # Test/drill hook: encrypt a caller-provided file instead of running pg_dump.
  # Used by the test suite, which has no postgres server.
  : "${BACKUP_SOURCE_FILE:?BACKUP_SKIP_DUMP=true requires BACKUP_SOURCE_FILE}"
  openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt \
    -pass env:BACKUP_ENCRYPTION_KEY -in "$BACKUP_SOURCE_FILE" -out "$STAGED" \
    || die $E_DUMP "encryption failed"
else
  set +e
  "$PG_DUMP" --format=custom --compress=9 --no-owner --no-privileges \
      --dbname="$DATABASE_URL" \
    | openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt \
        -pass env:BACKUP_ENCRYPTION_KEY -out "$STAGED"
  codes=("${PIPESTATUS[@]}")
  set -e
  [ "${codes[0]}" -eq 0 ] || die $E_DUMP "pg_dump failed (exit ${codes[0]}) — check DATABASE_URL and that the client major version >= server"
  [ "${codes[1]}" -eq 0 ] || die $E_DUMP "openssl encryption failed (exit ${codes[1]})"
fi
chmod 600 "$STAGED"

SIZE="$(wc -c < "$STAGED" | tr -d ' ')"
# An empty or absurdly small dump means pg_dump produced nothing useful. Better
# to fail loudly now than to discover it during a restore.
[ "$SIZE" -ge 512 ] || die $E_DUMP "dump is only ${SIZE} bytes — refusing to call that a backup"
SHA="$(openssl dgst -sha256 "$STAGED" | awk '{print $NF}')"
log "encrypted dump ${SIZE} bytes sha256=${SHA}"

# ── 2. Prove it decrypts before we trust it ──────────────────────────────────
# A backup nobody can open is not a backup. This costs a second and catches
# key/cipher mistakes on the night they happen rather than during an outage.
# NB: decrypt the WHOLE file to /dev/null rather than piping into `head`.
# `head` closing the pipe early kills openssl with SIGPIPE, which makes this
# check fail on a perfectly good backup — a false alarm that would have
# aborted every single run.
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 \
  -pass env:BACKUP_ENCRYPTION_KEY -in "$STAGED" -out /dev/null 2>/dev/null \
  || die $E_VERIFY "the dump cannot be decrypted with BACKUP_ENCRYPTION_KEY — backup aborted"

# ── 3. Offsite ───────────────────────────────────────────────────────────────
DEST="file://${STAGED}"
if [ -n "${BACKUP_S3_BUCKET:-}" ]; then
  mapfile -t S3A < <(s3_args)
  URL="s3://${BACKUP_S3_BUCKET}/${BACKUP_S3_PREFIX:-portal}/${NAME}"
  log "uploading → ${URL}"
  "$AWS" "${S3A[@]}" s3 cp "$STAGED" "$URL" --only-show-errors \
    || die $E_UPLOAD "upload failed — the local copy is kept at ${STAGED}"
  # Verify the object is actually there and the right size. `cp` exiting 0 is
  # not the same as the bytes being readable from the bucket.
  REMOTE_SIZE="$("$AWS" "${S3A[@]}" s3api head-object \
      --bucket "$BACKUP_S3_BUCKET" --key "${BACKUP_S3_PREFIX:-portal}/${NAME}" \
      --query ContentLength --output text 2>/dev/null || echo 0)"
  [ "$REMOTE_SIZE" = "$SIZE" ] \
    || die $E_UPLOAD "uploaded object is ${REMOTE_SIZE} bytes, expected ${SIZE}"
  DEST="$URL"
  log "upload verified (${REMOTE_SIZE} bytes)"
fi

# ── 4. Retention ─────────────────────────────────────────────────────────────
prune_local() {
  find "$BACKUP_DIR" -maxdepth 1 -name 'portal-*.dump.enc' -type f \
    -mtime "+${BACKUP_RETENTION_DAYS}" -print -delete 2>/dev/null | while read -r f; do
      log "pruned local $(basename "$f")"
    done
  # Legacy unencrypted dumps from the old script: remove them outright. They
  # are plaintext pupil data sitting on disk.
  find "$BACKUP_DIR" -maxdepth 1 -name 'portal-*.dump' -type f -print -delete 2>/dev/null \
    | while read -r f; do log "removed legacy UNENCRYPTED dump $(basename "$f")"; done
}
prune_local || die $E_PRUNE "local prune failed"

if [ -n "${BACKUP_S3_BUCKET:-}" ] && [ "${BACKUP_PRUNE_REMOTE:-true}" = "true" ]; then
  mapfile -t S3A < <(s3_args)
  CUTOFF="$(date -u -d "${BACKUP_RETENTION_DAYS} days ago" +%Y-%m-%d 2>/dev/null \
            || date -u -v-"${BACKUP_RETENTION_DAYS}"d +%Y-%m-%d)"
  "$AWS" "${S3A[@]}" s3api list-objects-v2 \
      --bucket "$BACKUP_S3_BUCKET" --prefix "${BACKUP_S3_PREFIX:-portal}/" \
      --query "Contents[?LastModified<='${CUTOFF}'].Key" --output text 2>/dev/null \
    | tr '\t' '\n' | grep -v '^None$' | grep -v '^$' | while read -r key; do
        "$AWS" "${S3A[@]}" s3 rm "s3://${BACKUP_S3_BUCKET}/${key}" --only-show-errors \
          && log "pruned remote ${key}"
      done || log "WARNING: remote prune incomplete (backup itself succeeded)"
fi

# ── 5. Heartbeat — written last, on success only ─────────────────────────────
cat > "$HEARTBEAT" <<JSON
{
  "completed_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "destination": "${DEST}",
  "size_bytes": ${SIZE},
  "sha256": "${SHA}",
  "retention_days": ${BACKUP_RETENTION_DAYS},
  "encrypted": true
}
JSON
SUCCEEDED=true
log "done — ${DEST} (${SIZE} bytes), heartbeat ${HEARTBEAT}"
