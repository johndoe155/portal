import { requireRole, apiGet } from "@/lib/session";
import Shell from "@/components/shell";
import Gradebook from "./gradebook";

interface RosterRow { studentUserId: string; admissionNo: string; displayName: string }
interface GradeRow {
  id: string; studentUserId: string; label: string; sourceType: string;
  points: string; maxPoints: string; releasedAt: string | null; feedbackText: string | null;
}
interface ExamRow { id: string; title: string; examDate: string; maxScore: string; weightPct: string | null }

export default async function GradebookPage({ params }: { params: Promise<{ sectionId: string }> }) {
  const session = await requireRole("teacher", "teacher_assistant");
  const { sectionId } = await params;
  const [roster, book, exams] = await Promise.all([
    apiGet<{ data: RosterRow[] }>(`/sections/${sectionId}/roster`),
    apiGet<{ data: GradeRow[] }>(`/sections/${sectionId}/gradebook`),
    apiGet<{ data: ExamRow[] }>(`/sections/${sectionId}/exams`),
  ]);
  return (
    <Shell session={session}>
      <Gradebook sectionId={sectionId} roster={roster?.data ?? []} grades={book?.data ?? []} exams={exams?.data ?? []} />
    </Shell>
  );
}
