-- 016 · Course lecturers: who teaches a course, and when, as part of the course structure.
--
--   courses ─ 1:N ─ course_lecturers   the lecturer allocations: name exactly as on the timetable, optional link to the
--                                       lecturer's professor account, allocation, delivery day, start / end time, session
--                                       length
--   lessons ─ N:1 ─ course_lecturers   lessons.course_lecturer_id: the lecturer teaching a scheduled session (a lesson with
--                                       a week_number); curriculum topics have neither
--
-- A module is a curriculum module, and its weekly sessions can be taught by different lecturers, so the lecturer columns
-- 015 put on modules move here: each distinct (course, lecturer) on a module becomes a course lecturer, and the module's
-- scheduled lessons are linked to it. The module columns are then dropped.

CREATE TABLE course_lecturers (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  course_id        BIGINT      NOT NULL,
  lecturer_name    TEXT        NOT NULL,
  professor_id     BIGINT,
  allocation       TEXT,
  delivery_day     TEXT,
  start_time       TIME,
  end_time         TIME,
  session_minutes  INTEGER,
  position         INTEGER     NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE lessons ADD COLUMN course_lecturer_id BIGINT;

-- Relationships
ALTER TABLE course_lecturers ADD CONSTRAINT fk_course_lecturers_course    FOREIGN KEY (course_id)    REFERENCES courses (id) ON DELETE CASCADE;
ALTER TABLE course_lecturers ADD CONSTRAINT fk_course_lecturers_professor FOREIGN KEY (professor_id) REFERENCES users (id)   ON DELETE SET NULL;
ALTER TABLE lessons ADD CONSTRAINT fk_lessons_course_lecturer FOREIGN KEY (course_lecturer_id) REFERENCES course_lecturers (id) ON DELETE SET NULL;

-- Constraints
ALTER TABLE course_lecturers ADD CONSTRAINT ck_course_lecturers_delivery_day
  CHECK (delivery_day IN ('monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'weekday', 'agreed'));
ALTER TABLE course_lecturers ADD CONSTRAINT ck_course_lecturers_times CHECK (end_time > start_time);
ALTER TABLE course_lecturers ADD CONSTRAINT ck_course_lecturers_session_minutes CHECK (session_minutes BETWEEN 15 AND 480);

-- Indexes. A lecturer appears once per course (names compared without case).
CREATE UNIQUE INDEX course_lecturers_name_uq ON course_lecturers (course_id, lower(lecturer_name));
CREATE INDEX course_lecturers_professor_idx ON course_lecturers (professor_id);
CREATE INDEX lessons_course_lecturer_idx ON lessons (course_lecturer_id);

-- Triggers
CREATE TRIGGER course_lecturers_updated_at BEFORE UPDATE ON course_lecturers FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Move the lecturers recorded on modules (015). A lecturer named on several modules of a course becomes one course
-- lecturer with the day, times and length of the first such module (by position).
INSERT INTO course_lecturers (course_id, lecturer_name, delivery_day, start_time, end_time, session_minutes, position)
SELECT DISTINCT ON (m.course_id, lower(m.lecturer_name))
       m.course_id, m.lecturer_name, m.delivery_day, m.start_time, m.end_time, m.session_minutes, m.position
  FROM modules m
 WHERE m.lecturer_name IS NOT NULL
 ORDER BY m.course_id, lower(m.lecturer_name), m.position, m.id;

UPDATE lessons l SET course_lecturer_id = cl.id
  FROM modules m JOIN course_lecturers cl ON cl.course_id = m.course_id AND lower(cl.lecturer_name) = lower(m.lecturer_name)
 WHERE l.module_id = m.id AND l.week_number IS NOT NULL;

ALTER TABLE modules DROP COLUMN lecturer_name;
ALTER TABLE modules DROP COLUMN delivery_day;
ALTER TABLE modules DROP COLUMN start_time;
ALTER TABLE modules DROP COLUMN end_time;
ALTER TABLE modules DROP COLUMN session_minutes;
