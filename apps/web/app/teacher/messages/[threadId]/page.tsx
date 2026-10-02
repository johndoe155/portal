import Link from "next/link";
import { notFound } from "next/navigation";
import { requireRole, apiGet } from "@/lib/session";
import Shell from "@/components/shell";
import ThreadView from "@/components/thread-view";

interface Message { id: string; senderUserId: string; senderName: string; bodyText: string; createdAt: string }
interface ThreadDetail { thread: { id: string; subject: string; status: string; studentName: string | null }; messages: Message[] }

export default async function TeacherThread({ params }: { params: Promise<{ threadId: string }> }) {
  const session = await requireRole("teacher", "teacher_assistant");
  const { threadId } = await params;
  const detail = await apiGet<ThreadDetail>(`/threads/${threadId}`);
  if (!detail) notFound();
  return (
    <Shell session={session}>
      <Link href="/teacher/messages" className="muted">← Messages</Link>
      <ThreadView thread={detail.thread} messages={detail.messages} canReply meId={session.userId} />
    </Shell>
  );
}
