import * as fs from "node:fs";

/**
 * Backup freshness, read from a heartbeat file that scripts/backup.sh writes
 * after a SUCCESSFUL encrypt-and-upload.
 *
 * Why a file and not a database row: the backup job must be able to report
 * success even when it is the only thing still running, and it must not need
 * database credentials beyond the dump itself. The file is written last, so
 * its mtime is proof the whole pipeline finished — not just that it started.
 *
 * A backup that silently stops running is the single most dangerous ops
 * failure a school can have: nobody notices until a restore is needed and
 * there is nothing to restore from. This makes the silence visible on
 * /health and on the admin console.
 */

export interface BackupStatus {
  configured: boolean;
  lastBackupAt: string | null;
  ageHours: number | null;
  stale: boolean;
  destination?: string | null;
  sizeBytes?: number | null;
}

const HEARTBEAT_PATH = () => process.env.BACKUP_HEARTBEAT_FILE ?? "./data/last-backup.json";

/** Past this age, a nightly backup is considered missed. */
const STALE_AFTER_HOURS = () => Number(process.env.BACKUP_STALE_AFTER_HOURS ?? 36);

export function backupFreshness(): BackupStatus {
  const configured = Boolean(process.env.BACKUP_S3_BUCKET && process.env.BACKUP_ENCRYPTION_KEY);
  const path = HEARTBEAT_PATH();
  try {
    const raw = JSON.parse(fs.readFileSync(path, "utf8"));
    const at = new Date(raw.completed_at ?? raw.at);
    if (Number.isNaN(at.getTime())) throw new Error("bad timestamp");
    const ageHours = Math.round((Date.now() - at.getTime()) / 3_600_000);
    return {
      configured,
      lastBackupAt: at.toISOString(),
      ageHours,
      stale: ageHours > STALE_AFTER_HOURS(),
      destination: raw.destination ?? null,
      sizeBytes: raw.size_bytes ?? null,
    };
  } catch {
    return {
      configured,
      lastBackupAt: null,
      ageHours: null,
      // Only alarming once backups are meant to be running. An operator who
      // has not configured them yet gets the nudge from the go-live checklist
      // instead, so /health does not cry wolf during setup.
      stale: configured,
    };
  }
}
