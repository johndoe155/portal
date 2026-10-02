import Link from "next/link";
import { apiGet } from "@/lib/session";

interface Health {
  status: string;
  db: string;
  mail: string;
  warnings: string[];
  backup?: {
    configured: boolean;
    offsite?: boolean;
    lastBackupAt: string | null;
    ageHours: number | null;
    stale: boolean;
    restoreTest?: { result: string | null; ageDays: number | null; stale: boolean };
  };
}

/**
 * Operational warnings, on the first screen an admin sees.
 *
 * Everything here is already on /api/v1/health for monitoring to scrape, but a
 * small school has no on-call rota and nobody watching a dashboard. The
 * failures that matter most — backups that stopped running, email that stopped
 * being delivered — are silent by nature: nothing breaks visibly until the day
 * someone needs a restore or a password reset. Putting them in front of the
 * registrar is what makes them get fixed.
 */
export default async function SystemStatus() {
  const health = await apiGet<Health>("/health").catch(() => null);
  if (!health) return null;

  const warnings = health.warnings ?? [];
  const b = health.backup;

  // Severity: anything implying we cannot recover data outranks the rest.
  const critical = warnings.filter((w) =>
    /restore drill FAILED|never completed|unverified|not being copied off/i.test(w));
  const rest = warnings.filter((w) => !critical.includes(w));

  if (warnings.length === 0) {
    return (
      <p className="muted" style={{ fontSize: ".85rem", margin: "0 0 12px" }}>
        ✅ System checks passing{b?.lastBackupAt
          ? ` — last backup ${b.ageHours}h ago${b.restoreTest?.result === "passed" ? ", restore-tested" : ""}`
          : ""}.
      </p>
    );
  }

  return (
    <div
      className="card"
      role="status"
      style={{
        borderLeft: `4px solid ${critical.length ? "var(--danger, #b42318)" : "var(--warn, #b54708)"}`,
        marginBottom: 16,
      }}
    >
      <h2 style={{ marginTop: 0, fontSize: "1rem" }}>
        {critical.length ? "Action needed" : "Needs attention"}
      </h2>
      <ul style={{ margin: "0 0 8px", paddingLeft: "1.1rem" }}>
        {[...critical, ...rest].map((w) => (
          <li key={w} style={{ marginBottom: 4 }}>
            {w}
            {/restore drill|backup/i.test(w) && (
              <> — see <Link href="/admin/school">settings</Link> or the backup runbook.</>
            )}
          </li>
        ))}
      </ul>
      <p className="muted" style={{ fontSize: ".8rem", margin: 0 }}>
        {critical.length
          ? "These mean the school may not be able to recover its data. Raise with whoever runs the server today."
          : "Operational warnings. The portal is working normally."}
      </p>
    </div>
  );
}
