-- 012 · Online classes (Google Meet / Zoom links shared by professors), account set-up links and the e-mail log.
--
-- A meeting belongs to one batch (010). audience = 'batch' shares it with every student of the batch; 'selected' only
-- with the students listed in meeting_participants (who must belong to that batch). Who may see a meeting is decided by
-- repositories/scope.js (studentMeetingPredicate), so a student who leaves the batch loses access immediately.

CREATE TABLE meetings (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  batch_id          BIGINT      NOT NULL,
  professor_id      BIGINT      NOT NULL,          -- organiser, one of the batch's professors
  title             TEXT        NOT NULL,
  description       TEXT,
  platform          TEXT        NOT NULL,          -- derived from meeting_url, never client-supplied
  meeting_url       TEXT        NOT NULL,
  starts_at         TIMESTAMPTZ NOT NULL,
  duration_minutes  INTEGER     NOT NULL DEFAULT 60,
  audience          TEXT        NOT NULL DEFAULT 'batch',
  status            TEXT        NOT NULL DEFAULT 'scheduled',
  cancel_reason     TEXT,
  cancelled_at      TIMESTAMPTZ,
  -- Incremented on every change students are told about; part of each notification's dedupe key.
  revision          INTEGER     NOT NULL DEFAULT 1,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE meeting_participants (
  meeting_id  BIGINT      NOT NULL,
  student_id  BIGINT      NOT NULL,
  added_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (meeting_id, student_id)
);

-- One row per e-mail to one person. dedupe_key names the notification (e.g. meeting:12:r2:meeting_updated:user:7), so the
-- same notification can never be queued twice. Rows are written in the transaction that causes them and sent after it
-- commits; the real outcome (sent / failed / skipped) is stored, never assumed.
CREATE TABLE email_deliveries (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  dedupe_key  TEXT        NOT NULL,
  kind        TEXT        NOT NULL,
  user_id     BIGINT,
  meeting_id  BIGINT,
  recipient   TEXT        NOT NULL,
  subject     TEXT        NOT NULL,
  status      TEXT        NOT NULL DEFAULT 'pending',
  error       TEXT,
  attempts    INTEGER     NOT NULL DEFAULT 0,
  sent_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Relationships. A batch or professor with meetings cannot be deleted (RESTRICT): meetings are part of the record.
ALTER TABLE meetings ADD CONSTRAINT fk_meetings_batch     FOREIGN KEY (batch_id)     REFERENCES batches (id) ON DELETE RESTRICT;
ALTER TABLE meetings ADD CONSTRAINT fk_meetings_professor FOREIGN KEY (professor_id) REFERENCES users (id)   ON DELETE RESTRICT;
ALTER TABLE meeting_participants ADD CONSTRAINT fk_meeting_participants_meeting FOREIGN KEY (meeting_id) REFERENCES meetings (id) ON DELETE CASCADE;
ALTER TABLE meeting_participants ADD CONSTRAINT fk_meeting_participants_student FOREIGN KEY (student_id) REFERENCES users (id)    ON DELETE CASCADE;
ALTER TABLE email_deliveries ADD CONSTRAINT fk_email_deliveries_user    FOREIGN KEY (user_id)    REFERENCES users (id)    ON DELETE SET NULL;
ALTER TABLE email_deliveries ADD CONSTRAINT fk_email_deliveries_meeting FOREIGN KEY (meeting_id) REFERENCES meetings (id) ON DELETE SET NULL;

-- Constraints
ALTER TABLE meetings ADD CONSTRAINT ck_meetings_platform CHECK (platform IN ('google_meet', 'zoom'));
ALTER TABLE meetings ADD CONSTRAINT ck_meetings_url CHECK (meeting_url ~ '^https://');
ALTER TABLE meetings ADD CONSTRAINT ck_meetings_duration CHECK (duration_minutes BETWEEN 15 AND 480);
ALTER TABLE meetings ADD CONSTRAINT ck_meetings_audience CHECK (audience IN ('batch', 'selected'));
ALTER TABLE meetings ADD CONSTRAINT ck_meetings_status CHECK (status IN ('scheduled', 'cancelled'));
ALTER TABLE meetings ADD CONSTRAINT ck_meetings_cancelled CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL));
ALTER TABLE meetings ADD CONSTRAINT ck_meetings_revision CHECK (revision >= 1);
ALTER TABLE email_deliveries ADD CONSTRAINT uq_email_deliveries_dedupe UNIQUE (dedupe_key);
ALTER TABLE email_deliveries ADD CONSTRAINT ck_email_deliveries_kind
  CHECK (kind IN ('account_created', 'account_setup', 'meeting_scheduled', 'meeting_updated', 'meeting_cancelled'));
ALTER TABLE email_deliveries ADD CONSTRAINT ck_email_deliveries_status CHECK (status IN ('pending', 'sent', 'failed', 'skipped'));

-- Account set-up links (welcome e-mail) are password-reset tokens with their own purpose and a longer lifetime.
ALTER TABLE password_reset_tokens DROP CONSTRAINT ck_password_reset_tokens_purpose;
ALTER TABLE password_reset_tokens ADD CONSTRAINT ck_password_reset_tokens_purpose CHECK (purpose IN ('reset', 'forced', 'setup'));

-- Indexes
CREATE INDEX meetings_professor_idx ON meetings (professor_id, starts_at DESC);
CREATE INDEX meetings_batch_idx ON meetings (batch_id, starts_at);
CREATE INDEX meeting_participants_student_idx ON meeting_participants (student_id);
CREATE INDEX email_deliveries_meeting_idx ON email_deliveries (meeting_id, user_id, id DESC);
CREATE INDEX email_deliveries_user_idx ON email_deliveries (user_id, created_at DESC);
CREATE INDEX email_deliveries_pending_idx ON email_deliveries (updated_at) WHERE status = 'pending';

-- Triggers
CREATE TRIGGER meetings_updated_at         BEFORE UPDATE ON meetings         FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER email_deliveries_updated_at BEFORE UPDATE ON email_deliveries FOR EACH ROW EXECUTE FUNCTION set_updated_at();
