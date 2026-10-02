import { requireRole, apiGet } from "@/lib/session";
import Shell from "@/components/shell";
import OutboxPanel from "./outbox-panel";

export interface OutboxRow {
  id: string;
  kind: string;
  channel: string;
  status: string;
  attempts: number;
  lastError: string | null;
  createdAt: string;
  sentAt: string | null;
  nextAttemptAt: string | null;
  failedPermanently: boolean;
  recipient: string;
  recipientName: string | null;
}

export interface OutboxStats {
  queued: number; sent: number; failed: number; dead: number;
  oldestQueuedAgeSeconds: number; mailConfigured: boolean;
}

export default async function AdminNotifications({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const session = await requireRole("super_admin", "school_admin", "auditor");
  const sp = await searchParams;
  const status = sp.status ?? "failed,dead";
  const [res, stats] = await Promise.all([
    apiGet<{ data: OutboxRow[]; meta: { total: number } }>(
      `/admin/notifications?status=${encodeURIComponent(status)}&per=100`),
    apiGet<OutboxStats>("/admin/notifications/stats"),
  ]);

  return (
    <Shell session={session}>
      <h1>Email &amp; notifications</h1>
      <p className="muted">
        Every message the portal sends passes through this queue. Failed deliveries are
        retried automatically six times over about 17 hours; what you see here is what
        still needs a human.
      </p>
      <OutboxPanel
        initialRows={res?.data ?? []}
        total={res?.meta.total ?? 0}
        stats={stats}
        status={status}
        canRetry={session.permissions.includes("settings:write")}
      />
    </Shell>
  );
}
