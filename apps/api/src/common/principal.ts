export interface Principal {
  userId: string;
  sessionId: string;
  email: string;
  displayName: string;
  roles: string[];
  activeRole: string;
  perms: string[];
  mfaVerified: boolean;
  mfaRequired: boolean;
  /** review-6 #3: temporary password issued by admin/CSV — locked to /auth until changed */
  mustChangePassword: boolean;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express { interface Request { principal?: Principal; } }
}

export const STAFF_ROLES = new Set([
  "super_admin", "school_admin", "registrar", "counselor", "teacher", "teacher_assistant",
]);
export const ROLE_PRIORITY = [
  "super_admin", "school_admin", "registrar", "counselor",
  "teacher", "teacher_assistant", "student", "parent", "auditor",
];
