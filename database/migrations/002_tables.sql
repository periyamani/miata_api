-- 002 · Tables: columns, primary keys, NOT NULL and defaults.
-- Foreign keys live in 003_relationships.sql, unique/check constraints in 004_constraints.sql,
-- indexes in 005_indexes.sql and triggers in 006_triggers.sql.

CREATE SEQUENCE student_code_seq START 1001;
CREATE SEQUENCE professor_code_seq START 1001;

-- ─── Identity & role profiles ───────────────────────────────────────────

CREATE TABLE users (
  id                    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email                 TEXT        NOT NULL,
  password_hash         TEXT        NOT NULL,
  full_name             TEXT        NOT NULL,
  phone                 TEXT,
  role                  TEXT        NOT NULL,
  is_active             BOOLEAN     NOT NULL DEFAULT TRUE,
  must_reset_password   BOOLEAN     NOT NULL DEFAULT FALSE,
  password_reset_reason TEXT,
  -- Incremented to invalidate every access token issued before (logout everywhere, deactivation, completion).
  token_version         INTEGER     NOT NULL DEFAULT 0,
  last_login_at         TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE student_profiles (
  user_id        BIGINT PRIMARY KEY,
  student_code   TEXT        NOT NULL DEFAULT ('STU' || nextval('student_code_seq')),
  date_of_birth  DATE,
  address        TEXT,
  city           TEXT,
  country        TEXT,
  qualification  TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE professor_profiles (
  user_id         BIGINT PRIMARY KEY,
  employee_code   TEXT        NOT NULL DEFAULT ('PRF' || nextval('professor_code_seq')),
  department      TEXT,
  specialization  TEXT,
  qualification   TEXT,
  bio             TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE agent_profiles (
  user_id        BIGINT PRIMARY KEY,
  referral_code  TEXT        NOT NULL,
  organization   TEXT,
  city           TEXT,
  country        TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE agent_referrals (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  agent_id       BIGINT      NOT NULL,
  student_id     BIGINT      NOT NULL,
  referral_code  TEXT        NOT NULL,          -- code in effect when the student was attributed
  source         TEXT        NOT NULL,
  created_by     BIGINT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── Authentication tokens (only SHA-256 hashes are stored) ─────────────

CREATE TABLE refresh_tokens (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id      BIGINT      NOT NULL,
  token_hash   TEXT        NOT NULL,
  persistent   BOOLEAN     NOT NULL DEFAULT FALSE,
  expires_at   TIMESTAMPTZ NOT NULL,
  revoked_at   TIMESTAMPTZ,
  replaced_by  BIGINT,
  user_agent   TEXT,
  ip_address   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE password_reset_tokens (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id     BIGINT      NOT NULL,
  token_hash  TEXT        NOT NULL,
  purpose     TEXT        NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── Courses & content ──────────────────────────────────────────────────

CREATE TABLE courses (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code            TEXT        NOT NULL,
  title           TEXT        NOT NULL,
  description     TEXT,
  category        TEXT,
  duration_value  INTEGER,
  duration_unit   TEXT,
  is_active       BOOLEAN     NOT NULL DEFAULT TRUE,
  created_by      BIGINT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE modules (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  course_id    BIGINT      NOT NULL,
  title        TEXT        NOT NULL,
  description  TEXT,
  position     INTEGER     NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE lessons (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  module_id         BIGINT      NOT NULL,
  title             TEXT        NOT NULL,
  content           TEXT,
  duration_minutes  INTEGER,
  position          INTEGER     NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE course_enrolments (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  course_id     BIGINT      NOT NULL,
  student_id    BIGINT      NOT NULL,
  status        TEXT        NOT NULL DEFAULT 'active',
  enrolled_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at  TIMESTAMPTZ,
  enrolled_by   BIGINT,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE professor_course_assignments (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  professor_id  BIGINT      NOT NULL,
  course_id     BIGINT      NOT NULL,
  assigned_by   BIGINT,
  assigned_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE professor_module_assignments (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  professor_id  BIGINT      NOT NULL,
  module_id     BIGINT      NOT NULL,
  assigned_by   BIGINT,
  assigned_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── Files (metadata only — the bytes live in the upload folder) ────────

CREATE TABLE files (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  storage_key    TEXT        NOT NULL,   -- path relative to the upload folder, e.g. videos/2f1c….mp4
  original_name  TEXT        NOT NULL,
  mime_type      TEXT        NOT NULL,
  size_bytes     BIGINT      NOT NULL,
  kind           TEXT        NOT NULL,
  uploaded_by    BIGINT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE videos (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  course_id         BIGINT      NOT NULL,
  module_id         BIGINT,
  lesson_id         BIGINT,
  file_id           BIGINT      NOT NULL,
  title             TEXT        NOT NULL,
  description       TEXT,
  duration_seconds  INTEGER     NOT NULL,
  position          INTEGER     NOT NULL DEFAULT 0,
  is_published      BOOLEAN     NOT NULL DEFAULT FALSE,
  is_required       BOOLEAN     NOT NULL DEFAULT TRUE,
  published_at      TIMESTAMPTZ,
  uploaded_by       BIGINT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Watch time is credited from playback heartbeats, capped by real elapsed time (progress.service.js).
CREATE TABLE video_progress (
  id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  video_id           BIGINT        NOT NULL,
  student_id         BIGINT        NOT NULL,
  watched_seconds    NUMERIC(10,2) NOT NULL DEFAULT 0,
  last_position      NUMERIC(10,2) NOT NULL DEFAULT 0,
  last_heartbeat_at  TIMESTAMPTZ,
  completed_at       TIMESTAMPTZ,
  created_at         TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ   NOT NULL DEFAULT now()
);

-- ─── Assignments, submissions, reviews ──────────────────────────────────

CREATE TABLE assignments (
  id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  course_id           BIGINT      NOT NULL,
  module_id           BIGINT,
  title               TEXT        NOT NULL,
  instructions        TEXT,
  due_at              TIMESTAMPTZ,
  is_required         BOOLEAN     NOT NULL DEFAULT TRUE,
  is_published        BOOLEAN     NOT NULL DEFAULT TRUE,
  attachment_file_id  BIGINT,
  created_by          BIGINT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE assignment_submissions (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  assignment_id  BIGINT      NOT NULL,
  student_id     BIGINT      NOT NULL,
  attempt_no     INTEGER     NOT NULL,
  file_id        BIGINT      NOT NULL,
  notes          TEXT,
  status         TEXT        NOT NULL DEFAULT 'submitted',
  submitted_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_at    TIMESTAMPTZ,
  reviewed_by    BIGINT,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE assignment_reviews (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  submission_id  BIGINT      NOT NULL,
  professor_id   BIGINT      NOT NULL,
  decision       TEXT        NOT NULL,
  feedback       TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE submission_comments (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  submission_id  BIGINT      NOT NULL,
  author_id      BIGINT      NOT NULL,
  body           TEXT        NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── Enquiries ──────────────────────────────────────────────────────────

CREATE TABLE enquiries (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name             TEXT        NOT NULL,
  email            TEXT        NOT NULL,
  phone            TEXT,
  subject          TEXT,
  message          TEXT        NOT NULL,
  course_interest  TEXT,
  source           TEXT        NOT NULL DEFAULT 'website',
  status           TEXT        NOT NULL DEFAULT 'new',
  follow_up_on     DATE,
  email_status     TEXT        NOT NULL DEFAULT 'pending',
  email_error      TEXT,
  ip_address       TEXT,
  created_by       BIGINT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE enquiry_notes (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  enquiry_id  BIGINT      NOT NULL,
  author_id   BIGINT,
  note        TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── Notifications, activity, settings ─────────────────────────────────

CREATE TABLE notifications (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id     BIGINT      NOT NULL,
  type        TEXT        NOT NULL,
  title       TEXT        NOT NULL,
  body        TEXT,
  link        TEXT,
  read_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE activity_logs (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_id     BIGINT,
  action       TEXT        NOT NULL,     -- e.g. course.created, submission.completed, course.completed
  entity_type  TEXT,
  entity_id    BIGINT,
  description  TEXT        NOT NULL,
  metadata     JSONB       NOT NULL DEFAULT '{}'::jsonb,
  ip_address   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE app_settings (
  key         TEXT PRIMARY KEY,
  value       JSONB       NOT NULL,
  updated_by  BIGINT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
