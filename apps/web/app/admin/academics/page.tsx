import { requireRole, apiGet } from "@/lib/session";
import Shell from "@/components/shell";
import AcademicsPanel from "./academics-panel";
import GradingPanel from "./grading-panel";

interface Year { id: string; name: string; startDate: string; endDate: string; isCurrent: boolean }
interface Term { id: string; academicYearId: string; termNo: number; name: string }
interface Section { id: string; name: string; code?: string }

export default async function AdminAcademics() {
  const session = await requireRole("super_admin", "school_admin", "registrar");
  const [years, terms, sections] = await Promise.all([
    apiGet<{ data: Year[] }>("/academic-years"),
    apiGet<{ data: Term[] }>("/terms"),
    apiGet<{ data: Section[] }>("/sections"),
  ]);
  return (
    <Shell session={session}>
      <h1>Academics</h1>
      <p className="muted">Academic years, terms and teacher assignments — the skeleton every class record hangs from.</p>
      <GradingPanel />
      <AcademicsPanel years={years?.data ?? []} terms={terms?.data ?? []} sections={sections?.data ?? []} />
    </Shell>
  );
}
