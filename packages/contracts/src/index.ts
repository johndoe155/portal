/**
 * @portal/contracts — single source of truth for wire schemas (ADR-001).
 * Shared by apps/api (validation) and apps/web (forms + client).
 */
import { z } from "zod";

/* ── enums as const arrays (CHECK constraints mirror these in SQL) ── */
export const ROLE_CODES = [
  "super_admin", "school_admin", "registrar", "counselor",
  "teacher", "teacher_assistant", "student", "parent", "auditor",
] as const;
export const ATTENDANCE_STATUS = ["present", "late", "absent", "excused"] as const;
export const GRADE_SOURCES = ["assignment", "exam", "custom"] as const;

/* ── auth ── */
export const LoginBody = z.object({
  email: z.string().email().max(254),
  password: z.string().min(8).max(128),
});
export type LoginBody = z.infer<typeof LoginBody>;

/** review-4 #4: password-proven linking of a federated identity (Entra). */
export const SsoLinkBody = z.object({
  link_token: z.string().min(16).max(2048),
  email: z.string().email().max(254),
  password: z.string().min(8).max(128),
});
export type SsoLinkBody = z.infer<typeof SsoLinkBody>;

export const TotpVerifyBody = z.object({ code: z.string().regex(/^\d{6}$/) });
export const RoleSwitchBody = z.object({ role: z.enum(ROLE_CODES) });

/* ── production hardening: controlled MFA enrollment + account lifecycle ── */
export const TotpEnrollBody = z.object({
  token: z.string().min(16).max(128).optional(),
});
export type TotpEnrollBody = z.infer<typeof TotpEnrollBody>;

/** Recovery-code step-up (review-2 #5): xxxx-xxxx-xxxx-xxxx, dashes optional. */
export const RecoveryVerifyBody = z.object({
  code: z.string().regex(/^[0-9a-fA-F-]{16,40}$/),
});
export type RecoveryVerifyBody = z.infer<typeof RecoveryVerifyBody>;

export const ForgotPasswordBody = z.object({ email: z.string().email().max(254) });
export type ForgotPasswordBody = z.infer<typeof ForgotPasswordBody>;

export const ResetPasswordBody = z.object({
  token: z.string().min(16).max(128),
  password: z.string().min(12).max(200),
});
export type ResetPasswordBody = z.infer<typeof ResetPasswordBody>;

export const ChangePasswordBody = z.object({
  current_password: z.string().min(1).max(200),
  new_password: z.string().min(12).max(200),
});
export type ChangePasswordBody = z.infer<typeof ChangePasswordBody>;

export const InviteAcceptBody = z.object({
  token: z.string().min(16).max(128),
  password: z.string().min(12).max(200),
  // review-6 #4: grade/admission come from the INVITE only — invitee-supplied
  // values are not accepted (a made-up admission no would collide with the real
  // one later and get the real CSV row skipped as a duplicate).
});
export type InviteAcceptBody = z.infer<typeof InviteAcceptBody>;

export const IssueInviteBody = z.object({
  email: z.string().email().max(254),
  display_name: z.string().min(1).max(120),
  roles: z.array(z.enum(ROLE_CODES)).min(1).max(4),
  grade_level: z.number().int().min(1).max(13).optional(),
  admission_no: z.string().min(1).max(32).optional(),
});
export type IssueInviteBody = z.infer<typeof IssueInviteBody>;

export const SessionView = z.object({
  userId: z.string().uuid(),
  email: z.string(),
  displayName: z.string(),
  roles: z.array(z.enum(ROLE_CODES)),
  activeRole: z.enum(ROLE_CODES),
  permissions: z.array(z.string()),
  mfaVerified: z.boolean(),
  mfaRequired: z.boolean(),
});
export type SessionView = z.infer<typeof SessionView>;

/* ── attendance ── */
export const AttendanceRecordBody = z.object({
  student_user_id: z.string().uuid(),
  status: z.enum(ATTENDANCE_STATUS),
  note: z.string().max(500).optional(),
});
export const AttendanceBulkBody = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  records: z.array(AttendanceRecordBody).min(1).max(500),
  client_rev: z.number().int().nonnegative().optional(),
});
export type AttendanceBulkBody = z.infer<typeof AttendanceBulkBody>;

/* ── grades ─ */
export const GradeItemBody = z.object({
  student_user_id: z.string().uuid(),
  source_type: z.enum(GRADE_SOURCES).default("custom"),
  source_id: z.string().uuid().nullable().optional(),
  label: z.string().min(1).max(120),
  points: z.string().regex(/^\d{1,4}(\.\d{1,2})?$/),
  max_points: z.string().regex(/^\d{1,4}(\.\d{1,2})?$/),
  weight_pct: z.string().regex(/^\d{1,3}(\.\d{1,2})?$/).optional(),
  feedback_text: z.string().max(2000).optional(),
});
export const GradesBulkBody = z.object({ items: z.array(GradeItemBody).min(1).max(500) });
export type GradesBulkBody = z.infer<typeof GradesBulkBody>;

/* ── shared error envelope (RFC 9457 subset) ── */
export const ProblemBody = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number(),
  code: z.string(),
  detail: z.string().optional(),
  trace_id: z.string().optional(),
});

export const CollectionMeta = z.object({
  page: z.number().int(), per: z.number().int(), total: z.number().int(),
});

/* ── Phase 5.3: messaging ── */
export const ThreadCreateBody = z.object({
  student_user_id: z.string().uuid(),
  subject: z.string().min(1).max(200),
});
export type ThreadCreateBody = z.infer<typeof ThreadCreateBody>;

export const MessageBody = z.object({ body_text: z.string().min(1).max(4000) });
export type MessageBody = z.infer<typeof MessageBody>;

/* ── Phase 5.3: push subscriptions (Web Push, RFC 8030 payload subset) ── */
export const PushSubscribeBody = z.object({
  endpoint: z.string().url().max(2000),
  keys: z.object({ p256dh: z.string().min(1), auth: z.string().min(1) }).optional(),
});
export type PushSubscribeBody = z.infer<typeof PushSubscribeBody>;

/* ── Phase 5.3: directory writes ── */
export const UserCreateBody = z.object({
  email: z.string().email().max(254),
  display_name: z.string().min(1).max(120),
  password: z.string().min(8).max(128),
  roles: z.array(z.enum(ROLE_CODES)).min(1).max(5),
  /** phase 6: when roles include "student", these create the students row */
  admission_no: z.string().min(1).max(32).optional(),
  grade_level: z.number().int().min(1).max(13).optional(),
});
export type UserCreateBody = z.infer<typeof UserCreateBody>;

/* ── Phase 6: real-school bootstrap ── */
export const SchoolSettingsBody = z.object({
  name: z.string().min(1).max(140),
  logo_url: z.string().max(2048).nullable().optional(),
  primary_color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  accent_color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  contact_email: z.string().email().max(254).nullable().optional(),
  dpo_email: z.string().email().max(254).nullable().optional(),
  address: z.string().max(300).nullable().optional(),
  phone: z.string().max(40).nullable().optional(),
  timezone: z.string().min(1).max(64).optional(),
  currency: z.string().length(3).optional(),
  mail_sender: z.string().max(254).nullable().optional(),
});
export type SchoolSettingsBody = z.infer<typeof SchoolSettingsBody>;

export const YearBody = z.object({
  name: z.string().min(1).max(60),
  start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  make_current: z.boolean().optional(),
});
export type YearBody = z.infer<typeof YearBody>;

export const TermBody = z.object({
  academic_year_id: z.string().uuid(),
  term_no: z.number().int().min(1).max(4),
  name: z.string().min(1).max(60),
  make_current: z.boolean().optional(),
});
export type TermBody = z.infer<typeof TermBody>;

export const StudentPatchBody = z.object({
  admission_no: z.string().min(1).max(32).optional(),
  grade_level: z.number().int().min(1).max(13).optional(),
  status: z.enum(["active", "graduated", "withdrawn"]).optional(),
});
export type StudentPatchBody = z.infer<typeof StudentPatchBody>;

export const GuardianLinkBody = z.object({
  guardian_email: z.string().email().max(254),
  relationship: z.string().min(1).max(40),
});
export type GuardianLinkBody = z.infer<typeof GuardianLinkBody>;

export const GuardianConfirmBody = z.object({ token: z.string().min(16).max(128) });
export type GuardianConfirmBody = z.infer<typeof GuardianConfirmBody>;

export const StaffAssignBody = z.object({
  user_id: z.string().uuid(),
  role: z.enum(["teacher", "teacher_assistant"]),
});
export type StaffAssignBody = z.infer<typeof StaffAssignBody>;

export const ImportBody = z.object({
  csv: z.string().min(1).max(2_000_000),
  dry_run: z.boolean().optional(),
});
export type ImportBody = z.infer<typeof ImportBody>;

export const GradingConfigBody = z.object({
  scale: z.array(z.object({
    letter: z.string().min(1).max(3),
    min_pct: z.number().min(0).max(100),
    point: z.number().min(0).max(10),
  })).min(1).max(12),
  weights: z.record(z.string(), z.number().min(0).max(100)).optional(),
});
export type GradingConfigBody = z.infer<typeof GradingConfigBody>;

export const FeeTemplateBody = z.object({
  name: z.string().min(1).max(120),
  amount_kobo: z.number().int().positive(),
  grade_level: z.number().int().min(1).max(13).nullable().optional(),
  due_days: z.number().int().min(0).max(120).optional(),
  active: z.boolean().optional(),
});
export type FeeTemplateBody = z.infer<typeof FeeTemplateBody>;

export const TemplateGenerateBody = z.object({ term_id: z.string().uuid() });
export type TemplateGenerateBody = z.infer<typeof TemplateGenerateBody>;

export const RoleGrantBody = z.object({ role_code: z.enum(ROLE_CODES) });
export type RoleGrantBody = z.infer<typeof RoleGrantBody>;

/* ── Phase 5.3: academics writes ── */
export const SectionCreateBody = z.object({
  course_code: z.string().min(2).max(20),
  course_title: z.string().min(1).max(160),
  name: z.string().min(1).max(80),
  term_id: z.string().uuid(),
});
export type SectionCreateBody = z.infer<typeof SectionCreateBody>;

export const EnrollBody = z.object({ student_user_id: z.string().uuid() });
export type EnrollBody = z.infer<typeof EnrollBody>;

/* ── Phase 5.3: report cards ── */
/** review-6 #1: term_id is REQUIRED — picking "the first term in the table" produced arbitrary report cards. */
export const ReportGenerateBody = z.object({ term_id: z.string().uuid() });
export type ReportGenerateBody = z.infer<typeof ReportGenerateBody>;

/* ── Phase 5.4: fees (money in kobo, Paystack convention) ── */
export const InvoiceCreateBody = z.object({
  student_user_id: z.string().uuid(),
  term_id: z.string().uuid(),
  label: z.string().min(1).max(120),
  amount_kobo: z.number().int().positive(),
  due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});
export type InvoiceCreateBody = z.infer<typeof InvoiceCreateBody>;

export const PaymentRecordBody = z.object({
  amount_kobo: z.number().int().positive(),
  channel: z.enum(["cash", "transfer", "paystack"]).default("cash"),
});
export type PaymentRecordBody = z.infer<typeof PaymentRecordBody>;

/* ── Phase 5.4: exams ── */
export const ExamCreateBody = z.object({
  title: z.string().min(1).max(160),
  exam_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  max_score: z.string().regex(/^\d{1,3}(\.\d{1,2})?$/).default("100"),
  weight_pct: z.string().regex(/^\d{1,3}(\.\d{1,2})?$/).optional(),
});
export type ExamCreateBody = z.infer<typeof ExamCreateBody>;

/* ── Phase 5.4: transport ── */
export const RouteCreateBody = z.object({
  name: z.string().min(1).max(120),
  driver_name: z.string().max(120).optional(),
  driver_phone: z.string().max(30).optional(),
  capacity: z.number().int().positive().max(200).optional(),
});
export type RouteCreateBody = z.infer<typeof RouteCreateBody>;

export const StopCreateBody = z.object({
  name: z.string().min(1).max(120),
  pickup_time: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/).optional(),
  seq: z.number().int().min(0).max(500).optional(),
});
export type StopCreateBody = z.infer<typeof StopCreateBody>;

export const TransportAssignBody = z.object({
  student_user_id: z.string().uuid(),
  route_id: z.string().uuid(),
  stop_id: z.string().uuid().optional(),
  term_id: z.string().uuid(),
});
export type TransportAssignBody = z.infer<typeof TransportAssignBody>;
