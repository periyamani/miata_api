-- 010 · Batches: cohorts of students who learn together.
--
--   batches ─ N:M ─ courses     via batch_courses      the courses the batch takes
--   batches ─ 1:N ─ students    via batch_students     UNIQUE student_id: a student belongs to at most one batch
--   batches ─ N:M ─ professors  via batch_professors   they teach every course of the batch, to that batch only
--
-- Availability of learning material (no rows = every student of the course, exactly as before batches):
--   modules ─ N:M ─ batches     via module_batches     rows = only students of the listed batches (and the module's
--                                                      lessons, videos and assignments with it)
--   videos  ─ N:M ─ batches     via video_batches      rows = only students of the listed batches
--   assignments.batch_id                               NULL = course-wide (every enrolled student, as before);
--                                                      set  = that batch only, narrowed to the students listed in
--                                                      assignment_students (no rows = the whole batch)
--
-- Course access is still decided by course_enrolments. Adding a student to a batch, or a course to a batch, enrols the
-- students, so progress, completion and history keep working unchanged.

-- ─── Tables ─────────────────────────────────────────────────────────────

CREATE TABLE batches (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code         TEXT        NOT NULL,
  name         TEXT        NOT NULL,
  description  TEXT,
  start_date   DATE,
  end_date     DATE,
  is_active    BOOLEAN     NOT NULL DEFAULT TRUE,
  created_by   BIGINT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE batch_courses (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  batch_id   BIGINT      NOT NULL,
  course_id  BIGINT      NOT NULL,
  added_by   BIGINT,
  added_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE batch_students (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  batch_id    BIGINT      NOT NULL,
  student_id  BIGINT      NOT NULL,
  added_by    BIGINT,
  added_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE batch_professors (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  batch_id      BIGINT      NOT NULL,
  professor_id  BIGINT      NOT NULL,
  assigned_by   BIGINT,
  assigned_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE module_batches (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  module_id   BIGINT      NOT NULL,
  batch_id    BIGINT      NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE video_batches (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  video_id    BIGINT      NOT NULL,
  batch_id    BIGINT      NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE assignments ADD COLUMN batch_id BIGINT;

CREATE TABLE assignment_students (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  assignment_id  BIGINT      NOT NULL,
  student_id     BIGINT      NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── Relationships ──────────────────────────────────────────────────────
-- A batch referenced by availability rows or assignments cannot be deleted (RESTRICT): removing it would silently
-- widen restricted material to every student. The service only deletes empty batches.

ALTER TABLE batches ADD CONSTRAINT fk_batches_created_by FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL;

ALTER TABLE batch_courses ADD CONSTRAINT fk_batch_courses_batch    FOREIGN KEY (batch_id)  REFERENCES batches (id) ON DELETE CASCADE;
ALTER TABLE batch_courses ADD CONSTRAINT fk_batch_courses_course   FOREIGN KEY (course_id) REFERENCES courses (id) ON DELETE CASCADE;
ALTER TABLE batch_courses ADD CONSTRAINT fk_batch_courses_added_by FOREIGN KEY (added_by)  REFERENCES users (id)   ON DELETE SET NULL;

ALTER TABLE batch_students ADD CONSTRAINT fk_batch_students_batch    FOREIGN KEY (batch_id)   REFERENCES batches (id) ON DELETE CASCADE;
ALTER TABLE batch_students ADD CONSTRAINT fk_batch_students_student  FOREIGN KEY (student_id) REFERENCES users (id)   ON DELETE CASCADE;
ALTER TABLE batch_students ADD CONSTRAINT fk_batch_students_added_by FOREIGN KEY (added_by)   REFERENCES users (id)   ON DELETE SET NULL;

ALTER TABLE batch_professors ADD CONSTRAINT fk_batch_professors_batch       FOREIGN KEY (batch_id)     REFERENCES batches (id) ON DELETE CASCADE;
ALTER TABLE batch_professors ADD CONSTRAINT fk_batch_professors_professor   FOREIGN KEY (professor_id) REFERENCES users (id)   ON DELETE CASCADE;
ALTER TABLE batch_professors ADD CONSTRAINT fk_batch_professors_assigned_by FOREIGN KEY (assigned_by)  REFERENCES users (id)   ON DELETE SET NULL;

ALTER TABLE module_batches ADD CONSTRAINT fk_module_batches_module FOREIGN KEY (module_id) REFERENCES modules (id) ON DELETE CASCADE;
ALTER TABLE module_batches ADD CONSTRAINT fk_module_batches_batch  FOREIGN KEY (batch_id)  REFERENCES batches (id) ON DELETE RESTRICT;
ALTER TABLE video_batches  ADD CONSTRAINT fk_video_batches_video   FOREIGN KEY (video_id)  REFERENCES videos (id)  ON DELETE CASCADE;
ALTER TABLE video_batches  ADD CONSTRAINT fk_video_batches_batch   FOREIGN KEY (batch_id)  REFERENCES batches (id) ON DELETE RESTRICT;

ALTER TABLE assignments ADD CONSTRAINT fk_assignments_batch FOREIGN KEY (batch_id) REFERENCES batches (id) ON DELETE RESTRICT;
ALTER TABLE assignment_students ADD CONSTRAINT fk_assignment_students_assignment FOREIGN KEY (assignment_id) REFERENCES assignments (id) ON DELETE CASCADE;
ALTER TABLE assignment_students ADD CONSTRAINT fk_assignment_students_student    FOREIGN KEY (student_id)    REFERENCES users (id)       ON DELETE CASCADE;

-- ─── Constraints ────────────────────────────────────────────────────────

ALTER TABLE batches ADD CONSTRAINT uq_batches_code UNIQUE (code);
ALTER TABLE batches ADD CONSTRAINT ck_batches_code CHECK (code ~ '^[A-Z0-9-]{2,30}$');
ALTER TABLE batches ADD CONSTRAINT ck_batches_dates CHECK (start_date IS NULL OR end_date IS NULL OR end_date >= start_date);

ALTER TABLE batch_courses    ADD CONSTRAINT uq_batch_courses UNIQUE (batch_id, course_id);
-- One batch per student: "the student's batch" is always unambiguous.
ALTER TABLE batch_students   ADD CONSTRAINT uq_batch_students_student UNIQUE (student_id);
ALTER TABLE batch_professors ADD CONSTRAINT uq_batch_professors UNIQUE (batch_id, professor_id);
ALTER TABLE module_batches   ADD CONSTRAINT uq_module_batches UNIQUE (module_id, batch_id);
ALTER TABLE video_batches    ADD CONSTRAINT uq_video_batches UNIQUE (video_id, batch_id);
ALTER TABLE assignment_students ADD CONSTRAINT uq_assignment_students UNIQUE (assignment_id, student_id);

-- ─── Indexes ────────────────────────────────────────────────────────────

CREATE INDEX batches_active_idx ON batches (is_active, start_date DESC);
CREATE INDEX batch_courses_course_idx ON batch_courses (course_id);
CREATE INDEX batch_students_batch_idx ON batch_students (batch_id);
CREATE INDEX batch_professors_professor_idx ON batch_professors (professor_id);
CREATE INDEX module_batches_batch_idx ON module_batches (batch_id);
CREATE INDEX video_batches_batch_idx ON video_batches (batch_id);
CREATE INDEX assignments_batch_idx ON assignments (batch_id);
CREATE INDEX assignment_students_student_idx ON assignment_students (student_id);

-- ─── Triggers ───────────────────────────────────────────────────────────

CREATE TRIGGER batches_updated_at BEFORE UPDATE ON batches FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─── Audience rules ─────────────────────────────────────────────────────
-- One definition of "what belongs to whom", used by the enrolment_progress view and by every API query
-- (src/repositories/scope.js), so admin, professor and student views always agree.

-- The batch through which a student takes a course: their batch, when that batch includes the course. NULL means an
-- unbatched enrolment, which the course's own professors handle exactly as before batches existed.
CREATE FUNCTION enrolment_batch_id(p_student_id BIGINT, p_course_id BIGINT) RETURNS BIGINT
LANGUAGE sql STABLE AS $$
  SELECT bs.batch_id
    FROM batch_students bs
    JOIN batch_courses bc ON bc.batch_id = bs.batch_id AND bc.course_id = p_course_id
   WHERE bs.student_id = p_student_id
$$;

-- A module (NULL = course-level content) is available to a student unless it is restricted to other batches.
CREATE FUNCTION module_available_to(p_module_id BIGINT, p_student_id BIGINT) RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
  SELECT p_module_id IS NULL
      OR NOT EXISTS (SELECT 1 FROM module_batches mb WHERE mb.module_id = p_module_id)
      OR EXISTS (SELECT 1 FROM module_batches mb JOIN batch_students bs ON bs.batch_id = mb.batch_id
                  WHERE mb.module_id = p_module_id AND bs.student_id = p_student_id)
$$;

-- A video is available when its module is and it is not restricted to other batches.
CREATE FUNCTION video_available_to(p_video_id BIGINT, p_module_id BIGINT, p_student_id BIGINT) RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
  SELECT module_available_to(p_module_id, p_student_id)
     AND (NOT EXISTS (SELECT 1 FROM video_batches vb WHERE vb.video_id = p_video_id)
          OR EXISTS (SELECT 1 FROM video_batches vb JOIN batch_students bs ON bs.batch_id = vb.batch_id
                      WHERE vb.video_id = p_video_id AND bs.student_id = p_student_id))
$$;

-- An assignment is assigned to a student when its module is available to them and it is course-wide, or set for the
-- student's batch (and, if students were selected, the student is one of them).
CREATE FUNCTION assignment_assigned_to(p_assignment_id BIGINT, p_batch_id BIGINT, p_module_id BIGINT, p_student_id BIGINT)
RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
  SELECT module_available_to(p_module_id, p_student_id)
     AND (p_batch_id IS NULL
          OR (EXISTS (SELECT 1 FROM batch_students bs WHERE bs.batch_id = p_batch_id AND bs.student_id = p_student_id)
              AND (NOT EXISTS (SELECT 1 FROM assignment_students x WHERE x.assignment_id = p_assignment_id)
                   OR EXISTS (SELECT 1 FROM assignment_students x
                               WHERE x.assignment_id = p_assignment_id AND x.student_id = p_student_id))))
$$;

-- ─── Views ──────────────────────────────────────────────────────────────
-- Progress counts only the material that applies to the student, so another batch's videos or assignments can
-- never block a student's course completion. Same columns as before (007).

CREATE OR REPLACE VIEW enrolment_progress AS
SELECT
  e.id AS enrolment_id,
  e.course_id,
  e.student_id,
  (SELECT count(*) FROM videos v
     WHERE v.course_id = e.course_id AND v.is_published AND v.is_required
       AND video_available_to(v.id, v.module_id, e.student_id)) AS videos_total,
  (SELECT count(*) FROM videos v
     JOIN video_progress vp ON vp.video_id = v.id AND vp.student_id = e.student_id AND vp.completed_at IS NOT NULL
     WHERE v.course_id = e.course_id AND v.is_published AND v.is_required
       AND video_available_to(v.id, v.module_id, e.student_id)) AS videos_done,
  (SELECT count(*) FROM assignments a
     WHERE a.course_id = e.course_id AND a.is_published AND a.is_required
       AND assignment_assigned_to(a.id, a.batch_id, a.module_id, e.student_id)) AS assignments_total,
  (SELECT count(*) FROM assignments a
     WHERE a.course_id = e.course_id AND a.is_published AND a.is_required
       AND assignment_assigned_to(a.id, a.batch_id, a.module_id, e.student_id)
       AND EXISTS (SELECT 1 FROM assignment_submissions s
                   WHERE s.assignment_id = a.id AND s.student_id = e.student_id AND s.status = 'completed')) AS assignments_done
FROM course_enrolments e;
