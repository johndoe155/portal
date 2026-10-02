/** Client-safe constants (no server imports) — ROLE_HOME routing + display enums. */
export const ROLE_HOME: Record<string, string> = {
  super_admin: "/admin", school_admin: "/admin", registrar: "/admin", auditor: "/admin",
  counselor: "/admin",
  teacher: "/teacher", teacher_assistant: "/teacher",
  student: "/student", parent: "/parent",
};

export const ATTENDANCE_STATUSES = ["present", "late", "absent", "excused"] as const;
export type AttendanceStatus = (typeof ATTENDANCE_STATUSES)[number];
