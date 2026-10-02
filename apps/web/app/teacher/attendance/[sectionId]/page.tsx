import { requireRole, apiGet } from "@/lib/session";
import Shell from "@/components/shell";
import Register from "./register";

interface RosterRow { studentUserId: string; admissionNo: string; gradeLevel: number; displayName: string }
interface AttendanceRow { studentUserId: string; status: string; note: string | null }
interface SessionRow { id: string; date: string; status: string }

export default async function AttendancePage({ params, searchParams }: {
  params: Promise<{ sectionId: string }>;
  searchParams: Promise<{ date?: string }>;
}) {
  const session = await requireRole("teacher", "teacher_assistant");
  const { sectionId } = await params;
  const sp = await searchParams;
  const date = /^\d{4}-\d{2}-\d{2}$/.test(sp.date ?? "") ? sp.date! : new Date().toISOString().slice(0, 10);

  const [roster, att] = await Promise.all([
    apiGet<{ data: RosterRow[] }>(`/sections/${sectionId}/roster`),
    apiGet<{ session: SessionRow | null; records: AttendanceRow[] }>(`/sections/${sectionId}/attendance?date=${date}`),
  ]);

  return (
    <Shell session={session}>
      <Register
        sectionId={sectionId}
        date={date}
        roster={roster?.data ?? []}
        initial={att?.records ?? []}
        registerStatus={att?.session?.status ?? null}
      />
    </Shell>
  );
}
