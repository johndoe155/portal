# Backups & restore

The portal holds the school's pupil records. If the database is lost and the
backups are missing, stale, unreadable or untested, the school loses its
register, its marks and its fee history. This document is the whole scheme and
the drill that proves it works.

**What is promised, and what delivers it:**

| Promise | Delivered by |
| --- | --- |
| Nightly dump | `backup` service cron, `02:15` UTC by default |
| Encrypted at rest (AES-256) | `scripts/backup.sh` — `pg_dump` is piped straight into `openssl`; plaintext never touches disk |
| Stored off this host | upload to S3-compatible storage (Cloudflare R2, AWS S3, Backblaze B2) |
| 35-day retention | pruned locally and in the bucket every run |
| Restores actually work | `scripts/backup-verify.sh`, weekly, into a throwaway database |
| Silent failure is visible | heartbeat files → `/api/v1/health` `warnings[]` |

---

## 1. Setup (once, before go-live)

Generate an encryption key and store it **in a password manager, not next to
the backups**:

```bash
openssl rand -base64 32
```

> Losing this key makes every backup permanently unreadable. Storing it in the
> same bucket as the backups makes the encryption pointless. Two people at the
> school should be able to retrieve it.

Create a bucket and a scoped access key, then fill in `.env`:

```ini
BACKUP_ENCRYPTION_KEY=<the value you just generated>
BACKUP_S3_BUCKET=school-portal-backups
BACKUP_S3_ENDPOINT=https://<accountid>.r2.cloudflarestorage.com
BACKUP_S3_REGION=auto
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
BACKUP_RETENTION_DAYS=35
```

On the bucket itself, turn on **object versioning** and a **lifecycle rule**
matching your retention. Versioning is what saves you if ransomware or a buggy
script deletes the objects — the delete becomes a marker, not an erasure. If
your provider supports object lock / immutability for a short window, use it.

Verify the configuration without taking a backup:

```bash
docker compose run --rm backup /opt/portal/scripts/backup.sh --check
```

Then bring the stack up. The sidecar takes one backup immediately on start, so
the first night is not the first attempt:

```bash
docker compose up -d backup
docker compose logs -f backup
```

## 2. What runs, and when

| Job | Default schedule | Override |
| --- | --- | --- |
| Encrypted backup + upload + prune | `15 02 * * *` | `BACKUP_CRON` |
| Restore drill into a scratch DB | `40 03 * * 0` (Sundays) | `BACKUP_VERIFY_CRON` |

Both run inside the `backup` container. Its healthcheck fails once the newest
backup is more than 36 hours old, so `docker compose ps` shows the problem even
if nobody is reading logs.

### Managed PaaS (no Docker host)

If the app runs on Railway/Render/Fly and Postgres is managed, you still need
these jobs — the provider's own snapshots are tied to that provider account.

**Railway** — add a cron service from the same repo:

```
Build:  docker build -f ops/backup/Dockerfile .
Cron:   15 2 * * *
Start:  /opt/portal/scripts/backup.sh
```

Add a second service with `40 3 * * 0` running `/opt/portal/scripts/backup-verify.sh`.

**Render** — a Cron Job service, Docker runtime, `ops/backup/Dockerfile`,
schedule `15 2 * * *`, command `/opt/portal/scripts/backup.sh`.

**GitHub Actions** (works anywhere, keeps backups outside the hosting account —
a genuine advantage if that account is ever lost):

```yaml
# .github/workflows/backup.yml
name: nightly-backup
on:
  schedule: [{ cron: "15 2 * * *" }]
  workflow_dispatch:
jobs:
  backup:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: sudo apt-get update && sudo apt-get install -y postgresql-client-17
      - run: ./scripts/backup.sh
        env:
          DATABASE_URL: ${{ secrets.DATABASE_URL }}
          BACKUP_ENCRYPTION_KEY: ${{ secrets.BACKUP_ENCRYPTION_KEY }}
          BACKUP_S3_BUCKET: ${{ secrets.BACKUP_S3_BUCKET }}
          BACKUP_S3_ENDPOINT: ${{ secrets.BACKUP_S3_ENDPOINT }}
          AWS_ACCESS_KEY_ID: ${{ secrets.AWS_ACCESS_KEY_ID }}
          AWS_SECRET_ACCESS_KEY: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
```

Note that a hosted runner cannot write the heartbeat file the API reads, so
point your alerting at the workflow's own failure notifications instead, and
set `BACKUP_STALE_AFTER_HOURS` high enough that `/health` does not nag.

## 3. Monitoring

`GET /api/v1/health` reports (public, no PII):

```json
{
  "backup": {
    "configured": true,
    "offsite": true,
    "lastBackupAt": "2026-10-02T02:15:09Z",
    "ageHours": 7,
    "stale": false,
    "sizeBytes": 48210944,
    "restoreTest": { "lastTestAt": "2026-09-28T03:40:11Z", "ageDays": 4, "result": "passed", "stale": false }
  },
  "warnings": []
}
```

**Alert on `warnings` being non-empty.** The backup-related ones are:

- `last successful backup was 52h ago` — the chain has stopped.
- `backups are configured but none has ever completed` — it has never worked.
- `backups are not being copied off this host` — one failure loses everything.
- `no restore drill has ever run — these backups are unverified`.
- `the last restore drill FAILED: … — backups may be unusable` ← **treat as an
  incident.** You currently have no recovery path.

`status` deliberately stays `ok` for all of these: a backup problem must not
cause load balancers to pull a working API out of rotation. Liveness and
operational health are separate signals.

## 4. Restoring (the real thing)

**Stop the application first** so nothing writes while you restore.

```bash
docker compose stop api worker web
```

Look at what you have, without changing anything:

```bash
docker compose run --rm backup aws s3 ls s3://$BACKUP_S3_BUCKET/portal/ --endpoint-url $BACKUP_S3_ENDPOINT
docker compose run --rm backup /opt/portal/scripts/restore.sh --list s3://.../portal-20261002T021509Z-9f2a1c.dump.enc
```

Restore:

```bash
docker compose run --rm backup /opt/portal/scripts/restore.sh \
  s3://$BACKUP_S3_BUCKET/portal/portal-20261002T021509Z-9f2a1c.dump.enc
```

The script refuses a target database that still has tables unless you pass
`--force`. That guard exists so a panicked paste cannot wipe a partially
working system. When you genuinely mean to overwrite:

```bash
docker compose run --rm backup /opt/portal/scripts/restore.sh --force <url>
```

Then start back up and check the data before telling anyone it is fixed:

```bash
docker compose up -d
curl -s https://<domain>/api/v1/health | jq '.status, .db'
```

Log in as an admin and confirm a known class register and a recent invoice.
`restore.sh` prints the restored user and migration counts; if the user count
looks wrong, **stop and investigate before letting staff log in** — a
half-restored portal that people start editing is worse than a down one.

### Point-in-time recovery

These logical dumps restore to the moment the dump ran — up to 24 hours of data
can be lost. If the school cannot tolerate that, run Postgres on a managed
provider with PITR (Neon, Supabase, RDS) and keep these dumps as the portable,
provider-independent second tier. Logical dumps also protect against a class of
failure PITR does not: a provider account being lost or closed.

## 5. The restore drill

Run by cron weekly, and runnable by hand at any time:

```bash
docker compose run --rm backup /opt/portal/scripts/backup-verify.sh
```

It fetches the newest **offsite** backup (the copy a real disaster leaves you),
creates a throwaway database, restores into it, checks the table and user
counts are plausible, drops it, and writes the outcome to the heartbeat that
`/health` reads. It refuses to run unless the scratch database name looks like
a scratch name, because it drops that database.

A drill that passes is the only evidence that any of the above is true. Once a
term, do it manually as well and time it — "how long until we are back" is the
question the head teacher will ask, and you want a measured answer.

## 6. Recovery objectives

| | Target | Determined by |
| --- | --- | --- |
| RPO (data loss) | ≤ 24 h | nightly schedule; use PITR for tighter |
| RTO (time to restore) | ≤ 2 h | download + `pg_restore` + redeploy; measure it in a drill |

## 7. Failure modes this design handles

| Failure | Outcome |
| --- | --- |
| Host dies | Restore the offsite copy onto new hardware |
| Volume corrupts | Same |
| Someone deletes rows by mistake | Restore last night's copy into a scratch DB, extract just those rows |
| Backup disk stolen | Dumps are AES-256 encrypted; the key is not stored with them |
| Bucket credentials leak | Dumps are encrypted; rotate credentials, keep versioning on |
| `pg_dump` silently writes nothing | Size floor rejects it; no heartbeat; `/health` warns within a day |
| Encryption key wrong/changed | The decrypt self-check fails the run immediately, before it is trusted |
| Backups quietly stop | Heartbeat goes stale → `/health` warning + container healthcheck fails |
| Backups run but are unrestorable | Weekly drill fails → `/health` warning |
| A failed run leaves a partial file | Removed by the cleanup trap, so `--latest` cannot pick a corpse |

## 8. Operational notes

- The sidecar image pins the Postgres major version via `POSTGRES_MAJOR`
  (default 17). `pg_dump` must be **>=** the server version — bump both
  together when you upgrade Postgres, or backups start failing.
- Keep `BACKUP_RETENTION_DAYS` >= the longest period you might need to detect a
  slow-burning data problem. 35 days covers a half-term.
- Backups contain the full pupil roster. Treat the bucket as confidential data:
  no public access, scoped credentials, access logging on.
- If you run on a managed Postgres service, point `DATABASE_URL` at it and
  leave the rest unchanged — the sidecar does not care where the server is.
