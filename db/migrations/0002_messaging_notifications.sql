-- ═══════════════════════════════════════════════════════════════════════════
-- 0002 · Phase 5.3 — messaging, notification outbox, push subs, report cards
-- Conventions mirror 0001: FORCE RLS on every table; policies read
-- app.user_id / app.role pinned by withActor(); helper functions first.
-- ═══════════════════════════════════════════════════════════════════════════
BEGIN;

CREATE TABLE message_threads (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  student_user_id  uuid NOT NULL,               -- the child the thread is about
  created_by       uuid NOT NULL,               -- authoring teacher
  subject          text NOT NULL,
  status           text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  closed_at        timestamptz
);
CREATE INDEX threads_student_idx ON message_threads (student_user_id);
CREATE INDEX threads_creator_idx ON message_threads (created_by);

CREATE TABLE messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id       uuid NOT NULL,
  sender_user_id  uuid NOT NULL,
  -- denormalized: guardians cannot read staff rows in users (RLS), so the
  -- display name is snapshotted at post time instead of joining users.
  sender_name     text NOT NULL,
  body_text       text NOT NULL CHECK (length(body_text) BETWEEN 1 AND 4000),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX messages_thread_idx ON messages (thread_id, created_at);

CREATE TABLE notifications (               -- transactional outbox (ADR: worker delivers)
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_user_id uuid NOT NULL,
  channel           text NOT NULL CHECK (channel IN ('email','push')),
  kind              text NOT NULL,           -- absence_recorded | grade_released | daily_digest | ...
  payload           jsonb NOT NULL DEFAULT '{}',
  status            text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sent','failed')),
  attempts          smallint NOT NULL DEFAULT 0,
  last_error        text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  sent_at           timestamptz
);
CREATE INDEX notif_queue_idx ON notifications (status, created_at);
CREATE INDEX notif_recipient_idx ON notifications (recipient_user_id, created_at);

CREATE TABLE push_subscriptions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL,
  endpoint    text NOT NULL UNIQUE,
  p256dh      text,
  auth_key    text,
  user_agent  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE report_cards (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  student_user_id  uuid NOT NULL,
  term_id          uuid NOT NULL,
  snapshot         jsonb NOT NULL,
  generated_by     uuid,
  generated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (student_user_id, term_id)
);

-- ── identities: provider set is governed by configuration (SSO_<NAME>_*),
-- not a DB CHECK — onboarding an IdP must not require a migration. Unknown
-- providers are rejected by the API (sso.service.getProvider) before any write.
ALTER TABLE identities DROP CONSTRAINT identities_provider_check;

-- ── helpers ──
-- teacher staffs ≥1 section the student is currently enrolled in
CREATE FUNCTION is_teacher_of(stu uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM section_staff ss
    JOIN enrollments e ON e.section_id = ss.section_id
    WHERE ss.user_id = nullif(current_setting('app.user_id', true),'')::uuid
      AND e.student_user_id = stu
      AND e.status = 'enrolled') $$;

ALTER TABLE message_threads   ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_threads   FORCE  ROW LEVEL SECURITY;
ALTER TABLE messages          ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages          FORCE  ROW LEVEL SECURITY;
ALTER TABLE notifications     ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications     FORCE  ROW LEVEL SECURITY;
ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE push_subscriptions FORCE ROW LEVEL SECURITY;
ALTER TABLE report_cards      ENABLE ROW LEVEL SECURITY;
ALTER TABLE report_cards      FORCE  ROW LEVEL SECURITY;

-- ── message_threads: authoring teacher + the child's guardians (+ admin oversight) ──
CREATE POLICY threads_sel ON message_threads FOR SELECT USING (
  created_by = nullif(current_setting('app.user_id', true),'')::uuid
  OR is_guardian_of(student_user_id)
  OR is_admin_role());
-- Phase-1 decision: parents READ ONLY → only the teaching side may open threads.
CREATE POLICY threads_ins ON message_threads FOR INSERT WITH CHECK (
  is_teacher_of(student_user_id) OR current_setting('app.role', true) = 'service');
CREATE POLICY threads_upd ON message_threads FOR UPDATE USING (
  created_by = nullif(current_setting('app.user_id', true),'')::uuid
  OR current_setting('app.role', true) = 'service');

-- ── messages: visible with the thread; only the thread author (teacher) may post ──
CREATE POLICY msgs_sel ON messages FOR SELECT USING (
  EXISTS (SELECT 1 FROM message_threads t WHERE t.id = messages.thread_id
    AND (t.created_by = nullif(current_setting('app.user_id', true),'')::uuid
         OR is_guardian_of(t.student_user_id)
         OR is_admin_role())));
CREATE POLICY msgs_ins ON messages FOR INSERT WITH CHECK (
  sender_user_id = nullif(current_setting('app.user_id', true),'')::uuid
  AND EXISTS (SELECT 1 FROM message_threads t WHERE t.id = messages.thread_id
        AND t.created_by = nullif(current_setting('app.user_id', true),'')::uuid));

-- ── notifications: own inbox for recipients, admin oversight, worker (service) manages ──
CREATE POLICY notif_sel ON notifications FOR SELECT USING (
  recipient_user_id = nullif(current_setting('app.user_id', true),'')::uuid
  OR is_admin_role() OR current_setting('app.role', true) = 'service');
-- any authenticated actor may enqueue (app-level callers gate who/why)
CREATE POLICY notif_ins ON notifications FOR INSERT WITH CHECK (
  current_setting('app.role', true) <> '');
CREATE POLICY notif_upd ON notifications FOR UPDATE USING (
  current_setting('app.role', true) = 'service' OR is_admin_role());

-- ── push_subscriptions: own rows only ──
CREATE POLICY push_all ON push_subscriptions FOR ALL USING (
  user_id = nullif(current_setting('app.user_id', true),'')::uuid
  OR current_setting('app.role', true) = 'service')
  WITH CHECK (
  user_id = nullif(current_setting('app.user_id', true),'')::uuid
  OR current_setting('app.role', true) = 'service');

-- ── report_cards: student / guardian / admin read; generated by service or admin ──
CREATE POLICY rc_sel ON report_cards FOR SELECT USING (
  student_user_id = nullif(current_setting('app.user_id', true),'')::uuid
  OR is_guardian_of(student_user_id) OR is_admin_role());
CREATE POLICY rc_ins ON report_cards FOR INSERT WITH CHECK (
  current_setting('app.role', true) IN ('super_admin','school_admin','service'));
CREATE POLICY rc_upd ON report_cards FOR UPDATE USING (
  current_setting('app.role', true) IN ('super_admin','school_admin','service'));

COMMIT;

-- grants to portal_app ride on 0001's ALTER DEFAULT PRIVILEGES (same creating role).
