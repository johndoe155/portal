import {
  pgTable, uuid, text, timestamp, boolean, numeric, smallint, date, jsonb,
  primaryKey, unique, bigint, integer,
} from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull(),
  passwordHash: text("password_hash"),
  displayName: text("display_name").notNull(),
  status: text("status").notNull().default("active"),
  directoryOptOut: boolean("directory_opt_out").notNull().default(false),
  /* 0004 production hardening */
  failedLoginCount: integer("failed_login_count").notNull().default(0),
  lockedUntil: timestamp("locked_until", { withTimezone: true }),
  mfaLastCounter: bigint("mfa_last_counter", { mode: "number" }),
  /* 0008 review-6: forced change after an admin/CSV-issued temporary password */
  mustChangePassword: boolean("must_change_password").notNull().default(false),
  /* 0011 offboarding — reversible deactivation, with provenance */
  deactivatedAt: timestamp("deactivated_at", { withTimezone: true }),
  deactivatedBy: uuid("deactivated_by"),
  deactivationReason: text("deactivation_reason"),
  /* 0013 erasure — anonymisation is a recorded state, not a silent UPDATE */
  anonymizedAt: timestamp("anonymized_at", { withTimezone: true }),
  anonymizedBy: uuid("anonymized_by"),
  /** Records held under a statutory window: restricted, not erased (NDPA §34(4)). */
  processingRestricted: boolean("processing_restricted").notNull().default(false),
  erasureNote: text("erasure_note"),
  /* 0014: opt-outs for non-essential email. Absent key = subscribed. */
  notificationPrefs: jsonb("notification_prefs").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }),
});

export const identities = pgTable("identities", {
  userId: uuid("user_id").notNull(),
  provider: text("provider").notNull(),
  subject: text("subject").notNull(),
  emailSnapshot: text("email_snapshot"),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ pk: primaryKey({ columns: [t.provider, t.subject] }) }));

export const sessions = pgTable("sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull(),
  tokenHash: text("token_hash").notNull(),
  activeRole: text("active_role").notNull(),
  amr: text("amr").notNull().default("[]"),
  mfaVerifiedAt: timestamp("mfa_verified_at", { withTimezone: true }),
  ip: text("ip"),
  userAgent: text("user_agent"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  lastActiveAt: timestamp("last_active_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const mfaFactors = pgTable("mfa_factors", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull(),
  kind: text("kind").notNull(),
  label: text("label").notNull(),
  secretEnc: text("secret_enc").notNull(),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const roles = pgTable("roles", {
  code: text("code").primaryKey(),
  name: text("name").notNull(),
  isSystem: boolean("is_system").notNull().default(true),
});

export const userRoles = pgTable("user_roles", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull(),
  roleCode: text("role_code").notNull(),
  grantedAt: timestamp("granted_at", { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
});

export const rolePermissions = pgTable("role_permissions", {
  roleCode: text("role_code").notNull(),
  permission: text("permission").notNull(),
}, (t) => ({ pk: primaryKey({ columns: [t.roleCode, t.permission] }) }));

export const students = pgTable("students", {
  userId: uuid("user_id").primaryKey(),
  admissionNo: text("admission_no").notNull(),
  gradeLevel: smallint("grade_level").notNull(),
  status: text("status").notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const guardians = pgTable("guardians", {
  id: uuid("id").primaryKey().defaultRandom(),
  studentUserId: uuid("student_user_id").notNull(),
  userId: uuid("user_id").notNull(),
  relationship: text("relationship").notNull(),
  canView: boolean("can_view").notNull().default(true),
  verifiedAt: timestamp("verified_at", { withTimezone: true }),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  // phase 6: emailed verification (admin may also confirm directly, audited)
  verifyTokenHash: text("verify_token_hash"),
  requestedBy: uuid("requested_by"),
});

/** phase 6: single-row school identity (id is always 1). */
export const schoolSettings = pgTable("school_settings", {
  id: integer("id").primaryKey().default(1),
  name: text("name").notNull().default("School Portal"),
  logoUrl: text("logo_url"),
  primaryColor: text("primary_color").notNull().default("#1d4ed8"),
  accentColor: text("accent_color").notNull().default("#0ea5e9"),
  contactEmail: text("contact_email"),
  dpoEmail: text("dpo_email"),
  address: text("address"),
  phone: text("phone"),
  timezone: text("timezone").notNull().default("Africa/Lagos"),
  currency: text("currency").notNull().default("NGN"),
  mailSender: text("mail_sender"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  updatedBy: uuid("updated_by"),
});

/** phase 6: single-row grading scale + default weights. */
export const gradingConfig = pgTable("grading_config", {
  id: integer("id").primaryKey().default(1),
  config: jsonb("config").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  updatedBy: uuid("updated_by"),
});

/** phase 6: fee templates for bulk invoice generation. */
export const feeTemplates = pgTable("fee_templates", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  amountKobo: bigint("amount_kobo", { mode: "number" }).notNull(),
  gradeLevel: smallint("grade_level"),
  dueDays: integer("due_days").notNull().default(14),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid("created_by"),
});

export const academicYears = pgTable("academic_years", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  startDate: date("start_date").notNull(),
  endDate: date("end_date").notNull(),
  isCurrent: boolean("is_current").notNull().default(false),
});

export const terms = pgTable("terms", {
  id: uuid("id").primaryKey().defaultRandom(),
  academicYearId: uuid("academic_year_id").notNull(),
  termNo: smallint("term_no").notNull(),
  name: text("name").notNull(),
});

export const courses = pgTable("courses", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: text("code").notNull(),
  title: text("title").notNull(),
});

export const courseSections = pgTable("course_sections", {
  id: uuid("id").primaryKey().defaultRandom(),
  courseId: uuid("course_id").notNull(),
  termId: uuid("term_id").notNull(),
  name: text("name").notNull(),
  status: text("status").notNull().default("active"),
});

export const sectionStaff = pgTable("section_staff", {
  id: uuid("id").primaryKey().defaultRandom(),
  sectionId: uuid("section_id").notNull(),
  userId: uuid("user_id").notNull(),
  role: text("role").notNull(),
});

export const enrollments = pgTable("enrollments", {
  id: uuid("id").primaryKey().defaultRandom(),
  studentUserId: uuid("student_user_id").notNull(),
  sectionId: uuid("section_id").notNull(),
  status: text("status").notNull().default("enrolled"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const attendanceSessions = pgTable("attendance_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  sectionId: uuid("section_id").notNull(),
  date: date("date").notNull(),
  takenBy: uuid("taken_by"),
  status: text("status").notNull().default("draft"),
  finalizedAt: timestamp("finalized_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const attendanceRecords = pgTable("attendance_records", {
  sessionId: uuid("session_id").notNull(),
  studentUserId: uuid("student_user_id").notNull(),
  status: text("status").notNull(),
  note: text("note"),
}, (t) => ({ pk: primaryKey({ columns: [t.sessionId, t.studentUserId] }) }));

export const grades = pgTable("grades", {
  id: uuid("id").primaryKey().defaultRandom(),
  studentUserId: uuid("student_user_id").notNull(),
  sectionId: uuid("section_id").notNull(),
  sourceType: text("source_type").notNull(),
  sourceId: uuid("source_id"),
  label: text("label").notNull(),
  points: numeric("points", { precision: 6, scale: 2 }).notNull(),
  maxPoints: numeric("max_points", { precision: 6, scale: 2 }).notNull(),
  weightPct: numeric("weight_pct", { precision: 5, scale: 2 }),
  gradedBy: uuid("graded_by"),
  gradedAt: timestamp("graded_at", { withTimezone: true }).notNull().defaultNow(),
  releasedAt: timestamp("released_at", { withTimezone: true }),
  feedbackText: text("feedback_text"),
});

export const gradeRevisions = pgTable("grade_revisions", {
  id: uuid("id").primaryKey().defaultRandom(),
  gradeId: uuid("grade_id").notNull(),
  prevPoints: numeric("prev_points", { precision: 6, scale: 2 }),
  newPoints: numeric("new_points", { precision: 6, scale: 2 }).notNull(),
  changedBy: uuid("changed_by").notNull(),
  reason: text("reason").notNull(),
  changedAt: timestamp("changed_at", { withTimezone: true }).notNull().defaultNow(),
});

export const auditLog = pgTable("audit_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  actorUserId: uuid("actor_user_id"),
  action: text("action").notNull(),
  entityType: text("entity_type"),
  entityId: uuid("entity_id"),
  beforeJson: jsonb("before_json"),
  afterJson: jsonb("after_json"),
  ip: text("ip"),
  userAgent: text("user_agent"),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  rowHash: text("row_hash").notNull(),
  prevHash: text("prev_hash"),
});

/* ── 0004 production hardening: lifecycle + security tables ── */

export const passwordResetTokens = pgTable("password_reset_tokens", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const userInvites = pgTable("user_invites", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull(),
  displayName: text("display_name").notNull(),
  roleCodes: text("role_codes").notNull(),          // JSON array
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  // phase 6: student invites carry the students-row fields
  gradeLevel: smallint("grade_level"),
  admissionNo: text("admission_no"),
  createdBy: uuid("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const mfaEnrollTokens = pgTable("mfa_enroll_tokens", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  createdBy: uuid("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Review-2: scoped per (key, user, path) with a claim row written BEFORE the
 *  work runs — concurrent duplicates conflict on the PK instead of racing. */
export const idempotencyKeys = pgTable("idempotency_keys", {
  key: text("key").notNull(),
  userId: uuid("user_id").notNull(),
  path: text("path").notNull(),
  method: text("method").notNull(),
  status: text("status").notNull().default("processing"), // processing | done
  statusCode: integer("status_code"),
  body: jsonb("body"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ pk: primaryKey({ columns: [t.key, t.userId, t.path] }) }));

/** Review-2 #5: single-use MFA recovery codes (hashed) — lost-phone path. */
export const mfaRecoveryCodes = pgTable("mfa_recovery_codes", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull(),
  codeHash: text("code_hash").notNull().unique(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/* ── Phase 5.3: messaging, notifications, push, report cards (0002) ── */

export const messageThreads = pgTable("message_threads", {
  id: uuid("id").primaryKey().defaultRandom(),
  studentUserId: uuid("student_user_id").notNull(),
  createdBy: uuid("created_by").notNull(),
  subject: text("subject").notNull(),
  status: text("status").notNull().default("open"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  closedAt: timestamp("closed_at", { withTimezone: true }),
});

export const messages = pgTable("messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  threadId: uuid("thread_id").notNull(),
  senderUserId: uuid("sender_user_id").notNull(),
  /** denormalized snapshot — guardians cannot join staff rows in users (RLS) */
  senderName: text("sender_name").notNull(),
  bodyText: text("body_text").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const notifications = pgTable("notifications", {
  id: uuid("id").primaryKey().defaultRandom(),
  recipientUserId: uuid("recipient_user_id"),           // null for bare-email rows (invites)
  recipientEmail: text("recipient_email"),
  channel: text("channel").notNull(),
  kind: text("kind").notNull(),
  payload: jsonb("payload").notNull().default({}),
  /** queued → sent | failed (permanent) | dead (retries exhausted) */
  status: text("status").notNull().default("queued"),
  attempts: smallint("attempts").notNull().default(0),
  lastError: text("last_error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  /* 0009 go-live: retry with backoff instead of failing forever */
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
  lockedAt: timestamp("locked_at", { withTimezone: true }),
  lockedBy: text("locked_by"),
  failedPermanently: boolean("failed_permanently").notNull().default(false),
  lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
});

export const reportCards = pgTable("report_cards", {
  id: uuid("id").primaryKey().defaultRandom(),
  studentUserId: uuid("student_user_id").notNull(),
  termId: uuid("term_id").notNull(),
  snapshot: jsonb("snapshot").notNull(),
  generatedBy: uuid("generated_by"),
  generatedAt: timestamp("generated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ uq: unique().on(t.studentUserId, t.termId) }));

/* ── Phase 5.4: fees (kobo), exams, transport (0003) ── */

export const feeInvoices = pgTable("fee_invoices", {
  id: uuid("id").primaryKey().defaultRandom(),
  studentUserId: uuid("student_user_id").notNull(),
  termId: uuid("term_id").notNull(),
  label: text("label").notNull(),
  amountKobo: bigint("amount_kobo", { mode: "number" }).notNull(),
  status: text("status").notNull().default("due"),
  dueDate: date("due_date"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const feePayments = pgTable("fee_payments", {
  id: uuid("id").primaryKey().defaultRandom(),
  invoiceId: uuid("invoice_id").notNull(),
  amountKobo: bigint("amount_kobo", { mode: "number" }).notNull(),
  channel: text("channel").notNull().default("paystack"),
  gatewayRef: text("gateway_ref").unique(),
  // review-4 #2: stored Paystack Initialize result — retries reuse it instead
  // of re-initializing the same reference (real Paystack rejects duplicates).
  checkoutUrl: text("checkout_url"),
  accessCode: text("access_code"),
  /* 0016: the currency this charge was raised in, copied from
     school_settings at Initialize. The webhook compares against THIS, not
     against the live setting, which may have changed since. */
  currency: text("currency").notNull().default("NGN"),
  status: text("status").notNull().default("pending"),
  paidBy: uuid("paid_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  paidAt: timestamp("paid_at", { withTimezone: true }),
});

export const exams = pgTable("exams", {
  id: uuid("id").primaryKey().defaultRandom(),
  sectionId: uuid("section_id").notNull(),
  title: text("title").notNull(),
  examDate: date("exam_date").notNull(),
  maxScore: numeric("max_score", { precision: 6, scale: 2 }).notNull().default("100"),
  weightPct: numeric("weight_pct", { precision: 5, scale: 2 }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const busRoutes = pgTable("bus_routes", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  driverName: text("driver_name"),
  driverPhone: text("driver_phone"),
  capacity: smallint("capacity"),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const busStops = pgTable("bus_stops", {
  id: uuid("id").primaryKey().defaultRandom(),
  routeId: uuid("route_id").notNull(),
  name: text("name").notNull(),
  pickupTime: text("pickup_time"),
  seq: smallint("seq").notNull().default(0),
});

/** 0010: asynchronous roster import jobs (school-scale CSV files). */
export const importJobs = pgTable("import_jobs", {
  id: uuid("id").primaryKey().defaultRandom(),
  kind: text("kind").notNull(),
  dryRun: boolean("dry_run").notNull().default(false),
  state: text("state").notNull().default("pending"),
  requestedBy: uuid("requested_by").notNull(),
  actorRole: text("actor_role").notNull(),
  filename: text("filename"),
  sourcePath: text("source_path"),
  byteSize: bigint("byte_size", { mode: "number" }),
  totalRows: integer("total_rows").notNull().default(0),
  processedRows: integer("processed_rows").notNull().default(0),
  createdCount: integer("created_count").notNull().default(0),
  duplicateCount: integer("duplicate_count").notNull().default(0),
  errorCount: integer("error_count").notNull().default(0),
  problems: jsonb("problems").notNull().default([]),
  secrets: jsonb("secrets").notNull().default([]),
  errorMessage: text("error_message"),
  lockedBy: text("locked_by"),
  lockedAt: timestamp("locked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  startedAt: timestamp("started_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
});

export const transportAssignments = pgTable("transport_assignments", {
  id: uuid("id").primaryKey().defaultRandom(),
  studentUserId: uuid("student_user_id").notNull(),
  routeId: uuid("route_id").notNull(),
  stopId: uuid("stop_id"),
  termId: uuid("term_id").notNull(),
  status: text("status").notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
});

/* ── 0012: academic year rollover ── */
export const yearRollovers = pgTable("year_rollovers", {
  id: uuid("id").primaryKey().defaultRandom(),
  fromYearId: uuid("from_year_id").notNull(),
  toYearId: uuid("to_year_id").notNull(),
  performedBy: uuid("performed_by"),
  performedAt: timestamp("performed_at", { withTimezone: true }).notNull().defaultNow(),
  summary: jsonb("summary").notNull().default({}),
  /** Per-pupil prior state, so a rollover can actually be undone. */
  studentStates: jsonb("student_states").notNull().default([]),
  revertedAt: timestamp("reverted_at", { withTimezone: true }),
  revertedBy: uuid("reverted_by"),
});

/* ── 0013: retention purge runs ── */
export const retentionRuns = pgTable("retention_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  dryRun: boolean("dry_run").notNull().default(false),
  trigger: text("trigger").notNull().default("schedule"),
  actorUserId: uuid("actor_user_id"),
  counts: jsonb("counts").notNull().default({}),
  ok: boolean("ok").notNull().default(false),
  error: text("error"),
});
