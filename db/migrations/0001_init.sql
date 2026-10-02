-- 0001_init.sql — core schema + RLS (Phase 2 subset implemented in Phase 5.1)
-- Conventions: uuid-v7-ish (gen_random_uuid() here; app generates v7 at insert),
-- timestamptz everywhere, CHECK constraints mirror contracts enums,
-- RLS ENABLED + FORCED on every PII-bearing table (FORCE: app connects as owner in dev/PGlite).

BEGIN;

-- ═══ IDENTITY ═══
CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL,
  password_hash text,
  display_name  text NOT NULL,
  status        text NOT NULL DEFAULT 'active'
                CHECK (status IN ('invited','active','suspended','left')),
  directory_opt_out boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz
);
CREATE UNIQUE INDEX users_email_uq ON users (lower(email));

CREATE TABLE identities (
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider       text NOT NULL CHECK (provider IN ('local','entra','google')),
  subject        text NOT NULL,
  email_snapshot text,
  last_seen_at   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, subject),
  UNIQUE (user_id, provider)
);

CREATE TABLE sessions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash      text NOT NULL UNIQUE,
  active_role     text NOT NULL,
  amr             text NOT NULL DEFAULT '[]',
  mfa_verified_at timestamptz,
  ip              text,
  user_agent      text,
  expires_at      timestamptz NOT NULL,
  last_active_at  timestamptz,
  revoked_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_idx ON sessions (user_id) WHERE revoked_at IS NULL;

CREATE TABLE mfa_factors (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       text NOT NULL CHECK (kind IN ('totp','webauthn')),
  label      text NOT NULL DEFAULT 'default',
  secret_enc text NOT NULL,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ═══ RBAC ═══
CREATE TABLE roles (
  code      text PRIMARY KEY,
  name      text NOT NULL,
  is_system boolean NOT NULL DEFAULT true
);
CREATE TABLE user_roles (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_code  text NOT NULL REFERENCES roles(code),
  granted_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  UNIQUE (user_id, role_code)
);
CREATE UNIQUE INDEX user_roles_active_uq ON user_roles (user_id, role_code)
  WHERE revoked_at IS NULL;
CREATE TABLE role_permissions (
  role_code  text NOT NULL REFERENCES roles(code),
  permission text NOT NULL,
  PRIMARY KEY (role_code, permission)
);

-- ═══ DIRECTORY ═══
CREATE TABLE students (
  user_id      uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  admission_no text NOT NULL UNIQUE,
  grade_level  smallint NOT NULL CHECK (grade_level BETWEEN 1 AND 13),
  status       text NOT NULL DEFAULT 'active'
               CHECK (status IN ('active','graduated','transferred','withdrawn')),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE guardians (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  student_user_id uuid NOT NULL REFERENCES students(user_id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  relationship    text NOT NULL DEFAULT 'guardian',
  can_view        boolean NOT NULL DEFAULT true,
  verified_at     timestamptz,
  ended_at        timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (student_user_id, user_id)
);

-- ═══ ACADEMICS ═══
CREATE TABLE academic_years (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL UNIQUE,
  start_date date NOT NULL,
  end_date   date NOT NULL,
  is_current boolean NOT NULL DEFAULT false
);
CREATE UNIQUE INDEX one_current_year_uq ON academic_years (is_current) WHERE is_current;
CREATE TABLE terms (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  academic_year_id uuid NOT NULL REFERENCES academic_years(id),
  term_no          smallint NOT NULL,
  name             text NOT NULL,
  UNIQUE (academic_year_id, term_no)
);
CREATE TABLE courses (
  id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code  text NOT NULL UNIQUE,
  title text NOT NULL
);
CREATE TABLE course_sections (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id uuid NOT NULL REFERENCES courses(id),
  term_id   uuid NOT NULL REFERENCES terms(id),
  name      text NOT NULL,
  status    text NOT NULL DEFAULT 'active' CHECK (status IN ('draft','active','archived')),
  UNIQUE (term_id, course_id, name)
);
CREATE TABLE section_staff (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  section_id uuid NOT NULL REFERENCES course_sections(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       text NOT NULL CHECK (role IN ('teacher','assistant')),
  UNIQUE (section_id, user_id)
);
CREATE TABLE enrollments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  student_user_id uuid NOT NULL REFERENCES students(user_id) ON DELETE CASCADE,
  section_id      uuid NOT NULL REFERENCES course_sections(id) ON DELETE CASCADE,
  status          text NOT NULL DEFAULT 'enrolled'
                  CHECK (status IN ('enrolled','dropped','completed')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (student_user_id, section_id)
);

-- ═══ ATTENDANCE ═══
CREATE TABLE attendance_sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  section_id   uuid NOT NULL REFERENCES course_sections(id) ON DELETE CASCADE,
  date         date NOT NULL,
  taken_by     uuid REFERENCES users(id),
  status       text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','final')),
  finalized_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (section_id, date)
);
CREATE TABLE attendance_records (
  session_id      uuid NOT NULL REFERENCES attendance_sessions(id) ON DELETE CASCADE,
  student_user_id uuid NOT NULL REFERENCES students(user_id) ON DELETE CASCADE,
  status          text NOT NULL CHECK (status IN ('present','late','absent','excused')),
  note            text,
  PRIMARY KEY (session_id, student_user_id)
);
CREATE INDEX attendance_records_student_idx ON attendance_records (student_user_id);

-- ═══ GRADEBOOK ═══
CREATE TABLE grades (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  student_user_id uuid NOT NULL REFERENCES students(user_id) ON DELETE CASCADE,
  section_id      uuid NOT NULL REFERENCES course_sections(id) ON DELETE CASCADE,
  source_type     text NOT NULL CHECK (source_type IN ('assignment','exam','custom')),
  source_id       uuid,
  label           text NOT NULL,
  points          numeric(6,2) NOT NULL,
  max_points      numeric(6,2) NOT NULL,
  weight_pct      numeric(5,2),
  graded_by       uuid REFERENCES users(id),
  graded_at       timestamptz NOT NULL DEFAULT now(),
  released_at     timestamptz,
  feedback_text   text,
  CHECK (points >= 0 AND max_points > 0 AND points <= max_points)
);
CREATE UNIQUE INDEX grades_source_uq ON grades (student_user_id, source_type, source_id)
  WHERE source_id IS NOT NULL;
CREATE INDEX grades_student_section_idx ON grades (student_user_id, section_id, released_at);
CREATE TABLE grade_revisions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  grade_id    uuid NOT NULL REFERENCES grades(id) ON DELETE CASCADE,
  prev_points numeric(6,2),
  new_points  numeric(6,2) NOT NULL,
  changed_by  uuid NOT NULL REFERENCES users(id),
  reason      text NOT NULL,
  changed_at  timestamptz NOT NULL DEFAULT now()
);

-- ═══ COMPLIANCE ═══
CREATE TABLE audit_log (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id uuid,
  action        text NOT NULL,
  entity_type   text,
  entity_id     uuid,
  before_json   jsonb,
  after_json    jsonb,
  ip            text,
  user_agent    text,
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  row_hash      text NOT NULL
);
CREATE INDEX audit_entity_idx ON audit_log (entity_type, entity_id);

-- ═══════════════ ROW-LEVEL SECURITY ═══════════════
-- Actor vars set per transaction: app.user_id, app.role (see apps/api db/actor.ts).
-- 'service' = internal worker/auth path, never set from a request.

ALTER TABLE users ENABLE ROW LEVEL SECURITY;           ALTER TABLE users FORCE ROW LEVEL SECURITY;
ALTER TABLE identities ENABLE ROW LEVEL SECURITY;      ALTER TABLE identities FORCE ROW LEVEL SECURITY;
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;        ALTER TABLE sessions FORCE ROW LEVEL SECURITY;
ALTER TABLE mfa_factors ENABLE ROW LEVEL SECURITY;     ALTER TABLE mfa_factors FORCE ROW LEVEL SECURITY;
ALTER TABLE roles ENABLE ROW LEVEL SECURITY;           ALTER TABLE roles FORCE ROW LEVEL SECURITY;
ALTER TABLE user_roles ENABLE ROW LEVEL SECURITY;      ALTER TABLE user_roles FORCE ROW LEVEL SECURITY;
ALTER TABLE role_permissions ENABLE ROW LEVEL SECURITY;ALTER TABLE role_permissions FORCE ROW LEVEL SECURITY;
ALTER TABLE students ENABLE ROW LEVEL SECURITY;        ALTER TABLE students FORCE ROW LEVEL SECURITY;
ALTER TABLE guardians ENABLE ROW LEVEL SECURITY;       ALTER TABLE guardians FORCE ROW LEVEL SECURITY;
ALTER TABLE academic_years ENABLE ROW LEVEL SECURITY;  ALTER TABLE academic_years FORCE ROW LEVEL SECURITY;
ALTER TABLE terms ENABLE ROW LEVEL SECURITY;           ALTER TABLE terms FORCE ROW LEVEL SECURITY;
ALTER TABLE courses ENABLE ROW LEVEL SECURITY;         ALTER TABLE courses FORCE ROW LEVEL SECURITY;
ALTER TABLE course_sections ENABLE ROW LEVEL SECURITY; ALTER TABLE course_sections FORCE ROW LEVEL SECURITY;
ALTER TABLE section_staff ENABLE ROW LEVEL SECURITY;   ALTER TABLE section_staff FORCE ROW LEVEL SECURITY;
ALTER TABLE enrollments ENABLE ROW LEVEL SECURITY;     ALTER TABLE enrollments FORCE ROW LEVEL SECURITY;
ALTER TABLE attendance_sessions ENABLE ROW LEVEL SECURITY; ALTER TABLE attendance_sessions FORCE ROW LEVEL SECURITY;
ALTER TABLE attendance_records ENABLE ROW LEVEL SECURITY;  ALTER TABLE attendance_records FORCE ROW LEVEL SECURITY;
ALTER TABLE grades ENABLE ROW LEVEL SECURITY;          ALTER TABLE grades FORCE ROW LEVEL SECURITY;
ALTER TABLE grade_revisions ENABLE ROW LEVEL SECURITY; ALTER TABLE grade_revisions FORCE ROW LEVEL SECURITY;
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;       ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;

CREATE FUNCTION is_staff_role() RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT current_setting('app.role', true) IN
    ('super_admin','school_admin','registrar','counselor','teacher','teacher_assistant','auditor','service') $$;
-- admin-tier: directory-wide reads; teachers scope via section_staff instead
CREATE FUNCTION is_admin_role() RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT current_setting('app.role', true) IN
    ('super_admin','school_admin','registrar','counselor','auditor','service') $$;

-- helpers (never used inside policies on the tables they read)
CREATE FUNCTION is_section_staff(sec uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM section_staff ss
    WHERE ss.section_id = sec
      AND ss.user_id = nullif(current_setting('app.user_id', true),'')::uuid) $$;
CREATE FUNCTION is_guardian_of(stu uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM guardians g
    WHERE g.student_user_id = stu
      AND g.user_id = nullif(current_setting('app.user_id', true),'')::uuid
      AND g.can_view AND g.verified_at IS NOT NULL AND g.ended_at IS NULL) $$;
CREATE FUNCTION is_enrolled_in(stu uuid, sec uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM enrollments e
    WHERE e.student_user_id = stu AND e.section_id = sec AND e.status = 'enrolled') $$;

-- users
CREATE POLICY users_sel ON users FOR SELECT USING (
  id = nullif(current_setting('app.user_id', true),'')::uuid
  OR is_guardian_of(id) OR is_staff_role());
CREATE POLICY users_ins ON users FOR INSERT WITH CHECK (
  current_setting('app.role', true) IN ('super_admin','school_admin','registrar','service'));
CREATE POLICY users_upd ON users FOR UPDATE USING (
  current_setting('app.role', true) IN ('super_admin','school_admin','registrar','service')
  OR id = nullif(current_setting('app.user_id', true),'')::uuid);

-- identities: self / service
CREATE POLICY identities_sel ON identities FOR SELECT USING (
  user_id = nullif(current_setting('app.user_id', true),'')::uuid
  OR current_setting('app.role', true) = 'service');
CREATE POLICY identities_wr ON identities FOR INSERT WITH CHECK (current_setting('app.role', true) = 'service');
CREATE POLICY identities_upd ON identities FOR UPDATE USING (current_setting('app.role', true) = 'service');

-- sessions: self / service
CREATE POLICY sessions_sel ON sessions FOR SELECT USING (
  user_id = nullif(current_setting('app.user_id', true),'')::uuid
  OR current_setting('app.role', true) IN ('service','school_admin','super_admin'));
CREATE POLICY sessions_ins ON sessions FOR INSERT WITH CHECK (current_setting('app.role', true) = 'service');
CREATE POLICY sessions_upd ON sessions FOR UPDATE USING (
  user_id = nullif(current_setting('app.user_id', true),'')::uuid
  OR current_setting('app.role', true) = 'service');
CREATE POLICY sessions_del ON sessions FOR DELETE USING (
  user_id = nullif(current_setting('app.user_id', true),'')::uuid
  OR current_setting('app.role', true) = 'service');

-- mfa_factors: self / service
CREATE POLICY mfa_sel ON mfa_factors FOR SELECT USING (
  user_id = nullif(current_setting('app.user_id', true),'')::uuid
  OR current_setting('app.role', true) = 'service');
CREATE POLICY mfa_ins ON mfa_factors FOR INSERT WITH CHECK (
  user_id = nullif(current_setting('app.user_id', true),'')::uuid
  OR current_setting('app.role', true) = 'service');
CREATE POLICY mfa_upd ON mfa_factors FOR UPDATE USING (
  user_id = nullif(current_setting('app.user_id', true),'')::uuid
  OR current_setting('app.role', true) = 'service');

-- rbac tables readable by any authenticated actor
CREATE POLICY roles_sel ON roles FOR SELECT USING (current_setting('app.role', true) <> '');
CREATE POLICY roles_wr ON roles FOR ALL USING (
  current_setting('app.role', true) IN ('super_admin','service'))
  WITH CHECK (current_setting('app.role', true) IN ('super_admin','service'));
CREATE POLICY user_roles_sel ON user_roles FOR SELECT USING (current_setting('app.role', true) <> '');
CREATE POLICY user_roles_wr ON user_roles FOR ALL USING (
  current_setting('app.role', true) IN ('super_admin','school_admin','service'))
  WITH CHECK (current_setting('app.role', true) IN ('super_admin','school_admin','service'));
CREATE POLICY role_perms_sel ON role_permissions FOR SELECT USING (current_setting('app.role', true) <> '');
CREATE POLICY role_perms_wr ON role_permissions FOR ALL USING (
  current_setting('app.role', true) IN ('super_admin','service'))
  WITH CHECK (current_setting('app.role', true) IN ('super_admin','service'));

-- directory
CREATE POLICY students_sel ON students FOR SELECT USING (
  user_id = nullif(current_setting('app.user_id', true),'')::uuid
  OR is_guardian_of(user_id) OR is_staff_role());
CREATE POLICY students_ins ON students FOR INSERT WITH CHECK (
  current_setting('app.role', true) IN ('super_admin','school_admin','registrar','service'));
CREATE POLICY students_upd ON students FOR UPDATE USING (
  current_setting('app.role', true) IN ('super_admin','school_admin','registrar','service'));

CREATE POLICY guardians_sel ON guardians FOR SELECT USING (
  user_id = nullif(current_setting('app.user_id', true),'')::uuid
  OR student_user_id = nullif(current_setting('app.user_id', true),'')::uuid
  OR is_staff_role());
CREATE POLICY guardians_wr ON guardians FOR ALL USING (
  current_setting('app.role', true) IN ('super_admin','school_admin','registrar','service'))
  WITH CHECK (current_setting('app.role', true) IN ('super_admin','school_admin','registrar','service'));

-- academics (reference data readable by any authenticated actor)
CREATE POLICY years_sel ON academic_years FOR SELECT USING (current_setting('app.role', true) <> '');
CREATE POLICY years_wr ON academic_years FOR ALL USING (
  current_setting('app.role', true) IN ('super_admin','school_admin','service'))
  WITH CHECK (current_setting('app.role', true) IN ('super_admin','school_admin','service'));
CREATE POLICY terms_sel ON terms FOR SELECT USING (current_setting('app.role', true) <> '');
CREATE POLICY terms_wr ON terms FOR ALL USING (
  current_setting('app.role', true) IN ('super_admin','school_admin','service'))
  WITH CHECK (current_setting('app.role', true) IN ('super_admin','school_admin','service'));
CREATE POLICY courses_sel ON courses FOR SELECT USING (current_setting('app.role', true) <> '');
CREATE POLICY courses_wr ON courses FOR ALL USING (
  current_setting('app.role', true) IN ('super_admin','school_admin','registrar','service'))
  WITH CHECK (current_setting('app.role', true) IN ('super_admin','school_admin','registrar','service'));

CREATE POLICY sections_sel ON course_sections FOR SELECT USING (
  is_admin_role() OR is_section_staff(id)
  OR is_enrolled_in(nullif(current_setting('app.user_id', true),'')::uuid, id)
  OR EXISTS (SELECT 1 FROM enrollments e WHERE e.section_id = course_sections.id
        AND e.status = 'enrolled' AND is_guardian_of(e.student_user_id)));
CREATE POLICY sections_wr ON course_sections FOR ALL USING (
  current_setting('app.role', true) IN ('super_admin','school_admin','registrar','service'))
  WITH CHECK (current_setting('app.role', true) IN ('super_admin','school_admin','registrar','service'));

CREATE POLICY sstaff_sel ON section_staff FOR SELECT USING (
  user_id = nullif(current_setting('app.user_id', true),'')::uuid OR is_staff_role());
CREATE POLICY sstaff_wr ON section_staff FOR ALL USING (
  current_setting('app.role', true) IN ('super_admin','school_admin','registrar','service'))
  WITH CHECK (current_setting('app.role', true) IN ('super_admin','school_admin','registrar','service'));

CREATE POLICY enroll_sel ON enrollments FOR SELECT USING (
  student_user_id = nullif(current_setting('app.user_id', true),'')::uuid
  OR is_guardian_of(student_user_id) OR is_section_staff(section_id) OR is_admin_role());
CREATE POLICY enroll_wr ON enrollments FOR ALL USING (
  current_setting('app.role', true) IN ('super_admin','school_admin','registrar','service'))
  WITH CHECK (current_setting('app.role', true) IN ('super_admin','school_admin','registrar','service'));

-- attendance
CREATE POLICY att_sess_sel ON attendance_sessions FOR SELECT USING (
  is_section_staff(section_id) OR is_admin_role()
  OR EXISTS (SELECT 1 FROM enrollments e WHERE e.section_id = attendance_sessions.section_id
     AND e.status='enrolled'
     AND (e.student_user_id = nullif(current_setting('app.user_id', true),'')::uuid
          OR is_guardian_of(e.student_user_id))));
CREATE POLICY att_sess_wr ON attendance_sessions FOR ALL USING (
  is_section_staff(section_id) OR current_setting('app.role', true) = 'service')
  WITH CHECK (is_section_staff(section_id) OR current_setting('app.role', true) = 'service');

CREATE POLICY att_rec_sel ON attendance_records FOR SELECT USING (
  student_user_id = nullif(current_setting('app.user_id', true),'')::uuid
  OR is_guardian_of(student_user_id)
  OR EXISTS (SELECT 1 FROM attendance_sessions s WHERE s.id = session_id
        AND (is_section_staff(s.section_id) OR is_admin_role())));
CREATE POLICY att_rec_wr ON attendance_records FOR ALL USING (
  EXISTS (SELECT 1 FROM attendance_sessions s WHERE s.id = session_id
     AND (is_section_staff(s.section_id) OR current_setting('app.role', true) = 'service')))
  WITH CHECK (EXISTS (SELECT 1 FROM attendance_sessions s WHERE s.id = session_id
     AND (is_section_staff(s.section_id) OR current_setting('app.role', true) = 'service')));

-- gradebook: release-gated reads; writes = section staff / service; NO parent writes anywhere
CREATE POLICY grades_sel ON grades FOR SELECT USING (
  released_at IS NOT NULL AND (
     student_user_id = nullif(current_setting('app.user_id', true),'')::uuid
     OR is_guardian_of(student_user_id))
  OR is_section_staff(section_id) OR is_admin_role());
CREATE POLICY grades_wr ON grades FOR ALL USING (
  is_section_staff(section_id) OR current_setting('app.role', true) = 'service')
  WITH CHECK (is_section_staff(section_id) OR current_setting('app.role', true) = 'service');

CREATE POLICY grev_sel ON grade_revisions FOR SELECT USING (
  EXISTS (SELECT 1 FROM grades g WHERE g.id = grade_id) );
CREATE POLICY grev_ins ON grade_revisions FOR INSERT WITH CHECK (
  EXISTS (SELECT 1 FROM grades g WHERE g.id = grade_id
     AND (is_section_staff(g.section_id) OR current_setting('app.role', true) = 'service')));

-- audit: insert for any authenticated actor; read = admin/auditor/service
CREATE POLICY audit_ins ON audit_log FOR INSERT WITH CHECK (current_setting('app.role', true) <> '');
CREATE POLICY audit_sel ON audit_log FOR SELECT USING (
  current_setting('app.role', true) IN ('super_admin','school_admin','auditor','service'));

COMMIT;

-- ═══ least-privilege app role ═══
-- The app connection SET LOCAL ROLEs into this non-superuser so RLS actually binds
-- (superusers bypass RLS even with FORCE; PGlite/dev connects as postgres).
BEGIN;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'portal_app') THEN
    CREATE ROLE portal_app NOINHERIT;
  END IF;
END $$;
GRANT USAGE ON SCHEMA public TO portal_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO portal_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO portal_app;
COMMIT;
