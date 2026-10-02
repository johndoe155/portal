-- ═══════════════════════════════════════════════════════════════════════════
-- 0003 · Phase 5.4 — fees (Paystack/kobo), exams, transport
-- Money is stored in KOBO (NGN minor units, Paystack convention) as bigint.
-- ═══════════════════════════════════════════════════════════════════════════
BEGIN;

CREATE TABLE fee_invoices (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  student_user_id  uuid NOT NULL,
  term_id          uuid NOT NULL,
  label            text NOT NULL,
  amount_kobo      bigint NOT NULL CHECK (amount_kobo > 0),
  status           text NOT NULL DEFAULT 'due' CHECK (status IN ('due','partial','paid','void')),
  due_date         date,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (student_user_id, term_id, label)
);
CREATE INDEX inv_student_idx ON fee_invoices (student_user_id, term_id);

CREATE TABLE fee_payments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id   uuid NOT NULL,
  amount_kobo  bigint NOT NULL CHECK (amount_kobo > 0),
  channel      text NOT NULL DEFAULT 'paystack' CHECK (channel IN ('paystack','cash','transfer')),
  gateway_ref  text UNIQUE,                     -- Paystack reference ⇒ webhook idempotency
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','success','failed')),
  paid_by      uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  paid_at      timestamptz
);
CREATE INDEX pay_invoice_idx ON fee_payments (invoice_id);

CREATE TABLE exams (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  section_id  uuid NOT NULL,
  title       text NOT NULL,
  exam_date   date NOT NULL,
  max_score   numeric(6,2) NOT NULL DEFAULT 100,
  weight_pct  numeric(5,2),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX exams_section_idx ON exams (section_id, exam_date);
-- exam results reuse grades(source_type='exam', source_id=exams.id)

CREATE TABLE bus_routes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL,
  driver_name  text,
  driver_phone text,
  capacity     smallint,
  active       boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE bus_stops (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  route_id     uuid NOT NULL,
  name         text NOT NULL,
  pickup_time  time,
  seq          smallint NOT NULL DEFAULT 0
);

CREATE TABLE transport_assignments (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  student_user_id  uuid NOT NULL,
  route_id         uuid NOT NULL,
  stop_id          uuid,
  term_id          uuid NOT NULL,
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active','ended')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  ended_at         timestamptz
);
-- one ACTIVE route per student per term (history rows may repeat)
CREATE UNIQUE INDEX ta_active_uq ON transport_assignments (student_user_id, term_id)
  WHERE status = 'active';

ALTER TABLE fee_invoices          ENABLE ROW LEVEL SECURITY;
ALTER TABLE fee_invoices          FORCE  ROW LEVEL SECURITY;
ALTER TABLE fee_payments          ENABLE ROW LEVEL SECURITY;
ALTER TABLE fee_payments          FORCE  ROW LEVEL SECURITY;
ALTER TABLE exams                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE exams                 FORCE  ROW LEVEL SECURITY;
ALTER TABLE bus_routes            ENABLE ROW LEVEL SECURITY;
ALTER TABLE bus_routes            FORCE  ROW LEVEL SECURITY;
ALTER TABLE bus_stops             ENABLE ROW LEVEL SECURITY;
ALTER TABLE bus_stops             FORCE  ROW LEVEL SECURITY;
ALTER TABLE transport_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE transport_assignments FORCE  ROW LEVEL SECURITY;

-- fees: family sees own child's ledger; writes = fees:write roles (school_admin/super_admin) + webhook service
CREATE POLICY inv_sel ON fee_invoices FOR SELECT USING (
  student_user_id = nullif(current_setting('app.user_id', true),'')::uuid
  OR is_guardian_of(student_user_id) OR is_admin_role()
  OR current_setting('app.role', true) = 'service');
CREATE POLICY inv_wr ON fee_invoices FOR ALL USING (
  current_setting('app.role', true) IN ('super_admin','school_admin','service'))
  WITH CHECK (
  current_setting('app.role', true) IN ('super_admin','school_admin','service'));

CREATE POLICY pay_sel ON fee_payments FOR SELECT USING (
  EXISTS (SELECT 1 FROM fee_invoices i WHERE i.id = fee_payments.invoice_id
    AND (i.student_user_id = nullif(current_setting('app.user_id', true),'')::uuid
         OR is_guardian_of(i.student_user_id) OR is_admin_role()))
  OR current_setting('app.role', true) = 'service');
CREATE POLICY pay_ins ON fee_payments FOR INSERT WITH CHECK (
  current_setting('app.role', true) IN ('super_admin','school_admin','service'));
CREATE POLICY pay_upd ON fee_payments FOR UPDATE USING (
  current_setting('app.role', true) IN ('super_admin','school_admin','service'));

-- exams: section staff manage; enrolled students + guardians read
CREATE POLICY exams_sel ON exams FOR SELECT USING (
  is_section_staff(section_id) OR is_admin_role()
  OR EXISTS (SELECT 1 FROM enrollments e WHERE e.section_id = exams.section_id
       AND e.status = 'enrolled'
       AND (e.student_user_id = nullif(current_setting('app.user_id', true),'')::uuid
            OR is_guardian_of(e.student_user_id))));
CREATE POLICY exams_wr ON exams FOR ALL USING (
  is_section_staff(section_id)
  OR current_setting('app.role', true) IN ('super_admin','school_admin','service'))
  WITH CHECK (
  is_section_staff(section_id)
  OR current_setting('app.role', true) IN ('super_admin','school_admin','service'));

-- transport: reference data readable by any authenticated actor; assignments private to family/admin
CREATE POLICY routes_sel ON bus_routes FOR SELECT USING (current_setting('app.role', true) <> '');
CREATE POLICY routes_wr ON bus_routes FOR ALL USING (
  current_setting('app.role', true) IN ('super_admin','school_admin','service'))
  WITH CHECK (
  current_setting('app.role', true) IN ('super_admin','school_admin','service'));
CREATE POLICY stops_sel ON bus_stops FOR SELECT USING (current_setting('app.role', true) <> '');
CREATE POLICY stops_wr ON bus_stops FOR ALL USING (
  current_setting('app.role', true) IN ('super_admin','school_admin','service'))
  WITH CHECK (
  current_setting('app.role', true) IN ('super_admin','school_admin','service'));

CREATE POLICY ta_sel ON transport_assignments FOR SELECT USING (
  student_user_id = nullif(current_setting('app.user_id', true),'')::uuid
  OR is_guardian_of(student_user_id) OR is_admin_role()
  OR current_setting('app.role', true) = 'service');
CREATE POLICY ta_wr ON transport_assignments FOR ALL USING (
  current_setting('app.role', true) IN ('super_admin','school_admin','service'))
  WITH CHECK (
  current_setting('app.role', true) IN ('super_admin','school_admin','service'));

COMMIT;
