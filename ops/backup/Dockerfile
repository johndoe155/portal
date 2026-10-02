# Backup sidecar: pg_dump + openssl + aws CLI on a cron.
#
# Kept separate from the application image on purpose — the app does not need
# database dump tooling or object-store credentials, and this image must track
# the POSTGRES major version rather than the Node one.
#
# The postgres major here MUST be >= the server's, or pg_dump refuses to run.
ARG POSTGRES_MAJOR=17
FROM postgres:${POSTGRES_MAJOR}-alpine

# aws-cli is in the alpine community repo; no pip/glibc gymnastics needed.
RUN apk add --no-cache aws-cli openssl bash tzdata coreutils findutils

COPY scripts/backup.sh scripts/restore.sh scripts/backup-verify.sh /opt/portal/scripts/
COPY ops/backup/entrypoint.sh /opt/portal/entrypoint.sh
RUN chmod +x /opt/portal/scripts/*.sh /opt/portal/entrypoint.sh

WORKDIR /opt/portal
ENTRYPOINT ["/opt/portal/entrypoint.sh"]
