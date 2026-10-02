#!/usr/bin/env bash
# Scheduler for the backup sidecar.
#
# The old setup had scripts/backup.sh in the repo and nothing that ran it —
# which is the most common way a school discovers it has no backups. This
# container runs it nightly, runs the restore drill weekly, and fails its
# healthcheck if the last backup has gone stale.
#
#   BACKUP_CRON         nightly backup schedule   (default 15 02 * * *)
#   BACKUP_VERIFY_CRON  weekly restore drill      (default 40 03 * * 0)
#   BACKUP_RUN_ON_START take one immediately on boot (default true)
set -euo pipefail

log() { printf '%s sidecar: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

export BACKUP_DIR="${BACKUP_DIR:-/var/lib/portal/backups}"
export BACKUP_HEARTBEAT_FILE="${BACKUP_HEARTBEAT_FILE:-/var/lib/portal/state/last-backup.json}"
export BACKUP_VERIFY_FILE="${BACKUP_VERIFY_FILE:-/var/lib/portal/state/last-restore-test.json}"
mkdir -p "$BACKUP_DIR" "$(dirname "$BACKUP_HEARTBEAT_FILE")"

# Fail fast and loudly: a misconfigured backup container that keeps restarting
# is far better than one that sits there "running" and backing up nothing.
/opt/portal/scripts/backup.sh --check

if [ "$#" -gt 0 ]; then exec "$@"; fi   # `docker compose run backup ./scripts/restore.sh ...`

# cron does not inherit the container environment, so export it for the jobs.
# Credentials land in a root-only file inside the container.
ENVFILE=/opt/portal/.cron-env
: > "$ENVFILE"; chmod 600 "$ENVFILE"
for v in DATABASE_URL BACKUP_ENCRYPTION_KEY BACKUP_DIR BACKUP_RETENTION_DAYS \
         BACKUP_S3_BUCKET BACKUP_S3_ENDPOINT BACKUP_S3_REGION BACKUP_S3_PREFIX \
         AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY BACKUP_HEARTBEAT_FILE \
         BACKUP_VERIFY_FILE BACKUP_VERIFY_DB BACKUP_VERIFY_MIN_USERS TZ; do
  [ -n "${!v:-}" ] && printf 'export %s=%q\n' "$v" "${!v}" >> "$ENVFILE"
done

cat > /etc/crontabs/root <<CRON
${BACKUP_CRON:-15 02 * * *} . $ENVFILE; /opt/portal/scripts/backup.sh >> /proc/1/fd/1 2>&1
${BACKUP_VERIFY_CRON:-40 03 * * 0} . $ENVFILE; /opt/portal/scripts/backup-verify.sh >> /proc/1/fd/1 2>&1
CRON

if [ "${BACKUP_RUN_ON_START:-true}" = "true" ]; then
  log "taking an initial backup so the first night is not the first attempt"
  ( . "$ENVFILE"; /opt/portal/scripts/backup.sh ) || log "WARNING: initial backup failed — see the error above"
fi

log "scheduled: backup '${BACKUP_CRON:-15 02 * * *}', restore drill '${BACKUP_VERIFY_CRON:-40 03 * * 0}'"
exec crond -f -l 8
