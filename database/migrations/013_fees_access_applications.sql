-- 013 · Course access periods, fees and payments, agent applications.
--
-- Access period (automatic deactivation)
--   course_enrolments.start_date   the day the student's course starts: their batch's start date when the course is
--                                  taken with a batch that has one, otherwise the day of enrolment
--   course_enrolments.end_date     the last day of access: start + course duration − 1 day (NULL = no duration, never ends)
--   student_access (view)          the day a student's access ends: the latest end_date of their enrolments
--                                  (NULL when not enrolled, or when any enrolment has no end)
--   users.deactivated_reason       why an account is inactive: 'admin' or 'course_expired'
--   student_profiles.access_expired_on
--                                  the end date that deactivated the account automatically. Each end date deactivates an
--                                  account once (services/accessExpiry.service.js): an admin who reactivates it is not
--                                  overruled until a later end date passes.
--
-- Fees and payments
--   courses.fee_amount             the course's standard fee (NULL = not set); copied to each new enrolment
--   course_enrolments.fee_amount   what this student is charged for the course, and any scholarship / discount.
--   course_enrolments.discount_amount
--                                  Admins may change both; changing the course fee does not change existing enrolments.
--   fee_payments                   payments a student reports with a proof (screenshot or receipt). An admin verifies
--                                  them: pending → approved | rejected (and back to pending to correct a mistake).
--   enrolment_fees (view)          payable, paid (approved only), pending and balance — derived, never stored
--
-- Agent applications ("Apply Now")
--   agent_referrals.source 'agent' the agent registered the student; applied_course_id and notes record the application

-- ─── Functions ──────────────────────────────────────────────────────────

-- Last day of access for a course of the given duration starting on p_start (inclusive): 1 Jan + 3 months → 31 Mar.
CREATE FUNCTION access_end_date(p_start DATE, p_value INTEGER, p_unit TEXT) RETURNS DATE
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
           WHEN p_start IS NULL OR p_value IS NULL OR p_unit IS NULL THEN NULL
           ELSE (p_start + make_interval(
                   years  => CASE WHEN p_unit = 'years'  THEN p_value ELSE 0 END,
                   months => CASE WHEN p_unit = 'months' THEN p_value ELSE 0 END,
                   weeks  => CASE WHEN p_unit = 'weeks'  THEN p_value ELSE 0 END,
                   days   => CASE WHEN p_unit = 'days'   THEN p_value ELSE 0 END))::date - 1
         END
$$;

-- Defaults for a new enrolment, whichever code path inserts it (enrolment service, batches, mock data):
-- start date (batch start or enrolment day), end date (start + course duration) and fee (the course fee).
CREATE FUNCTION enrolment_defaults() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  c RECORD;
BEGIN
  SELECT duration_value, duration_unit, fee_amount INTO c FROM courses WHERE id = NEW.course_id;
  IF NEW.start_date IS NULL THEN
    NEW.start_date := COALESCE(
      (SELECT b.start_date FROM batches b WHERE b.id = enrolment_batch_id(NEW.student_id, NEW.course_id)),
      NEW.enrolled_at::date);
  END IF;
  IF NEW.end_date IS NULL THEN
    NEW.end_date := access_end_date(NEW.start_date, c.duration_value, c.duration_unit);
  END IF;
  NEW.fee_amount := COALESCE(NEW.fee_amount, c.fee_amount, 0);
  NEW.discount_amount := COALESCE(NEW.discount_amount, 0);
  RETURN NEW;
END
$$;

-- ─── Columns ────────────────────────────────────────────────────────────

ALTER TABLE courses ADD COLUMN fee_amount NUMERIC(12,2);

ALTER TABLE course_enrolments
  ADD COLUMN start_date      DATE,
  ADD COLUMN end_date        DATE,
  ADD COLUMN fee_amount      NUMERIC(12,2),
  ADD COLUMN discount_amount NUMERIC(12,2) NOT NULL DEFAULT 0;

-- Existing enrolments get the same dates a new enrolment would get. The fee is not set (0) until an admin sets it.
UPDATE course_enrolments e
   SET start_date = COALESCE((SELECT b.start_date FROM batches b WHERE b.id = enrolment_batch_id(e.student_id, e.course_id)),
                             e.enrolled_at::date),
       fee_amount = 0;
UPDATE course_enrolments e
   SET end_date = access_end_date(e.start_date, c.duration_value, c.duration_unit)
  FROM courses c WHERE c.id = e.course_id;

ALTER TABLE course_enrolments ALTER COLUMN start_date SET NOT NULL;
ALTER TABLE course_enrolments ALTER COLUMN fee_amount SET NOT NULL;

ALTER TABLE users ADD COLUMN deactivated_reason TEXT;
UPDATE users SET deactivated_reason = 'admin' WHERE NOT is_active;

ALTER TABLE student_profiles ADD COLUMN access_expired_on DATE;

ALTER TABLE agent_referrals
  ADD COLUMN applied_course_id BIGINT,
  ADD COLUMN notes             TEXT;

-- ─── Tables ─────────────────────────────────────────────────────────────

CREATE TABLE fee_payments (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  enrolment_id   BIGINT        NOT NULL,          -- the student's enrolment the payment is for
  amount         NUMERIC(12,2) NOT NULL,
  paid_on        DATE          NOT NULL,          -- the day the student made the transfer
  method         TEXT          NOT NULL DEFAULT 'bank_transfer',
  reference      TEXT,                            -- transaction / UTR / receipt number
  notes          TEXT,
  proof_file_id  BIGINT        NOT NULL,          -- screenshot or receipt (files.kind = 'payment_proof')
  status         TEXT          NOT NULL DEFAULT 'pending',
  review_note    TEXT,                            -- the admin's note; required when rejected (the student sees it)
  reviewed_by    BIGINT,
  reviewed_at    TIMESTAMPTZ,
  submitted_by   BIGINT,
  created_at     TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ   NOT NULL DEFAULT now()
);

-- ─── Relationships ──────────────────────────────────────────────────────
-- Payments are financial records: the enrolment and the proof file cannot be deleted while a payment refers to them.

ALTER TABLE agent_referrals ADD CONSTRAINT fk_agent_referrals_applied_course FOREIGN KEY (applied_course_id) REFERENCES courses (id) ON DELETE SET NULL;

ALTER TABLE fee_payments ADD CONSTRAINT fk_fee_payments_enrolment    FOREIGN KEY (enrolment_id)  REFERENCES course_enrolments (id) ON DELETE RESTRICT;
ALTER TABLE fee_payments ADD CONSTRAINT fk_fee_payments_proof_file   FOREIGN KEY (proof_file_id) REFERENCES files (id)             ON DELETE RESTRICT;
ALTER TABLE fee_payments ADD CONSTRAINT fk_fee_payments_reviewed_by  FOREIGN KEY (reviewed_by)   REFERENCES users (id)             ON DELETE SET NULL;
ALTER TABLE fee_payments ADD CONSTRAINT fk_fee_payments_submitted_by FOREIGN KEY (submitted_by)  REFERENCES users (id)             ON DELETE SET NULL;

-- ─── Constraints ────────────────────────────────────────────────────────

ALTER TABLE courses ADD CONSTRAINT ck_courses_fee CHECK (fee_amount >= 0);

ALTER TABLE course_enrolments ADD CONSTRAINT ck_course_enrolments_dates CHECK (end_date IS NULL OR end_date >= start_date);
ALTER TABLE course_enrolments ADD CONSTRAINT ck_course_enrolments_fee
  CHECK (fee_amount >= 0 AND discount_amount >= 0 AND discount_amount <= fee_amount);

ALTER TABLE users ADD CONSTRAINT ck_users_deactivated_reason CHECK (deactivated_reason IN ('admin', 'course_expired'));

ALTER TABLE agent_referrals DROP CONSTRAINT ck_agent_referrals_source;
ALTER TABLE agent_referrals ADD CONSTRAINT ck_agent_referrals_source CHECK (source IN ('link', 'admin', 'agent'));
ALTER TABLE agent_referrals ADD CONSTRAINT ck_agent_referrals_notes CHECK (length(notes) <= 2000);

ALTER TABLE files DROP CONSTRAINT ck_files_kind;
ALTER TABLE files ADD CONSTRAINT ck_files_kind CHECK (kind IN ('video', 'attachment', 'submission', 'payment_proof'));

ALTER TABLE fee_payments ADD CONSTRAINT ck_fee_payments_amount CHECK (amount > 0);
ALTER TABLE fee_payments ADD CONSTRAINT ck_fee_payments_method
  CHECK (method IN ('bank_transfer', 'upi', 'card', 'cash', 'cheque', 'other'));
ALTER TABLE fee_payments ADD CONSTRAINT ck_fee_payments_status CHECK (status IN ('pending', 'approved', 'rejected'));
ALTER TABLE fee_payments ADD CONSTRAINT ck_fee_payments_reviewed CHECK ((status = 'pending') = (reviewed_at IS NULL));
ALTER TABLE fee_payments ADD CONSTRAINT ck_fee_payments_rejection_note
  CHECK (status <> 'rejected' OR length(trim(coalesce(review_note, ''))) > 0);
ALTER TABLE fee_payments ADD CONSTRAINT uq_fee_payments_proof_file UNIQUE (proof_file_id);

-- ─── Indexes ────────────────────────────────────────────────────────────

CREATE INDEX course_enrolments_end_date_idx ON course_enrolments (student_id, end_date);
CREATE INDEX fee_payments_enrolment_idx ON fee_payments (enrolment_id, status);
CREATE INDEX fee_payments_status_idx ON fee_payments (status, created_at DESC);
CREATE INDEX agent_referrals_applied_course_idx ON agent_referrals (applied_course_id);

-- ─── Triggers ───────────────────────────────────────────────────────────

CREATE TRIGGER course_enrolments_defaults BEFORE INSERT ON course_enrolments FOR EACH ROW EXECUTE FUNCTION enrolment_defaults();
CREATE TRIGGER fee_payments_updated_at BEFORE UPDATE ON fee_payments FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─── Views ──────────────────────────────────────────────────────────────

CREATE VIEW enrolment_fees AS
SELECT e.id AS enrolment_id,
       e.student_id,
       e.course_id,
       e.fee_amount,
       e.discount_amount,
       e.fee_amount - e.discount_amount AS payable,
       COALESCE(sum(p.amount) FILTER (WHERE p.status = 'approved'), 0) AS paid,
       COALESCE(sum(p.amount) FILTER (WHERE p.status = 'pending'), 0) AS pending,
       e.fee_amount - e.discount_amount - COALESCE(sum(p.amount) FILTER (WHERE p.status = 'approved'), 0) AS balance
  FROM course_enrolments e
  LEFT JOIN fee_payments p ON p.enrolment_id = e.id
 GROUP BY e.id;

CREATE VIEW student_access AS
SELECT e.student_id,
       CASE WHEN bool_or(e.end_date IS NULL) THEN NULL ELSE max(e.end_date) END AS access_ends_on
  FROM course_enrolments e
 GROUP BY e.student_id;

-- ─── Reference data ─────────────────────────────────────────────────────
-- Currency of every fee and payment, and the transfer details shown to students (Settings › Fees & payments).

INSERT INTO app_settings (key, value) VALUES ('fee_settings', '{"currency": "AUD", "paymentInstructions": ""}'::jsonb);
