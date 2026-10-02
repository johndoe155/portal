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
  /** True when dumps are encrypted AND shipped off this host. */
  offsite?: boolean;
  /** Outcome of the last automated restore drill (scripts/backup-verify.sh). */
  restoreTest?: RestoreTestStatus;
}

export interface RestoreTestStatus {
  lastTestAt: string | null;
  ageDays: number | null;
  result: "passed" | "failed" | "never" | null;
  detail?: string | null;
  /** True when no drill has run recently enough to trust the backups. */
  stale: boolean;
}

const HEARTBEAT_PATH = () => process.env.BACKUP_HEARTBEAT_FILE ?? "./data/last-backup.json";

/** Past this age, a nightly backup is considered missed. */
const STALE_AFTER_HOURS = () => Number(process.env.BACKUP_STALE_AFTER_HOURS ?? 36);

const VERIFY_PATH = () => process.env.BACKUP_VERIFY_FILE ?? "./data/last-restore-test.json";

/** The drill runs weekly; allow a missed week before complaining. */
const RESTORE_TEST_STALE_AFTER_DAYS = () =>
  Number(process.env.BACKUP_VERIFY_STALE_AFTER_DAYS ?? 14);

/**
 * Backups nobody has ever restored are a hypothesis, not a safety net. The
 * weekly drill (scripts/backup-verify.sh) restores the newest backup into a
 * throwaway database and records the outcome here, so "we have backups" can
 * be checked rather than believed.
 */
export function restoreTestStatus(configured: boolean): RestoreTestStatus {
  try {
    const raw = JSON.parse(fs.readFileSync(VERIFY_PATH(), "utf8"));
    const at = new Date(raw.completed_at);
    if (Number.isNaN(at.getTime())) throw new Error("bad timestamp");
    const ageDays = Math.floor((Date.now() - at.getTime()) / 86_400_000);
    const result = raw.result === "passed" ? "passed" : "failed";
    return {
      lastTestAt: at.toISOString(),
      ageDays,
      result,
      detail: raw.detail ?? null,
      // A failed drill is never "fresh" — it needs attention immediately.
      stale: result === "failed" || ageDays > RESTORE_TEST_STALE_AFTER_DAYS(),
    };
  } catch {
    return {
      lastTestAt: null, ageDays: null, result: configured ? "never" : null,
      stale: configured,
    };
  }
}

export function backupFreshness(): BackupStatus {
  const configured = Boolean(process.env.BACKUP_S3_BUCKET && process.env.BACKUP_ENCRYPTION_KEY);
  const offsite = Boolean(process.env.BACKUP_S3_BUCKET);
  const restoreTest = restoreTestStatus(configured);
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
      offsite,
      restoreTest,
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
      offsite,
      restoreTest,
    };
  }
}
