-- 015 · Course timetables: the weekly schedule is part of the course structure.
--
--   courses  academic_year (e.g. '2026–2027'), start_date / end_date (week 1 begins on start_date), schedule_notes
--   modules  lecturer_name (the doctor teaching the module, exactly as written on the timetable), delivery_day,
--            start_time / end_time (NULL until confirmed), session_minutes
--   lessons  week_number: the programme week in which the topic is taught (dates are derived from the course's start_date)
--
-- It replaces the separate timetables / timetable_streams / timetable_sessions tables of the withdrawn
-- 014_timetables.sql. Those only reached development databases, were never used by the application and are empty; they
-- are dropped here, and the migration stops instead if any of them still holds rows.

ALTER TABLE courses ADD COLUMN academic_year TEXT;
ALTER TABLE courses ADD COLUMN start_date DATE;
ALTER TABLE courses ADD COLUMN end_date DATE;
ALTER TABLE courses ADD COLUMN schedule_notes TEXT;

ALTER TABLE modules ADD COLUMN lecturer_name TEXT;
ALTER TABLE modules ADD COLUMN delivery_day TEXT;
ALTER TABLE modules ADD COLUMN start_time TIME;
ALTER TABLE modules ADD COLUMN end_time TIME;
ALTER TABLE modules ADD COLUMN session_minutes INTEGER;

ALTER TABLE lessons ADD COLUMN week_number INTEGER;

-- Constraints
ALTER TABLE courses ADD CONSTRAINT ck_courses_academic_year CHECK (academic_year ~ '^\d{4}[–-]\d{4}$');
ALTER TABLE courses ADD CONSTRAINT ck_courses_dates CHECK (end_date >= start_date);
ALTER TABLE modules ADD CONSTRAINT ck_modules_delivery_day
  CHECK (delivery_day IN ('monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'weekday', 'agreed'));
ALTER TABLE modules ADD CONSTRAINT ck_modules_times CHECK (end_time > start_time);
ALTER TABLE modules ADD CONSTRAINT ck_modules_session_minutes CHECK (session_minutes BETWEEN 15 AND 480);
ALTER TABLE lessons ADD CONSTRAINT ck_lessons_week_number CHECK (week_number BETWEEN 1 AND 104);

-- Indexes
CREATE INDEX lessons_week_idx ON lessons (module_id, week_number) WHERE week_number IS NOT NULL;

-- The withdrawn separate timetable tables: never lose rows that might still be in them.
DO $$
DECLARE
  t TEXT;
  n BIGINT;
BEGIN
  FOREACH t IN ARRAY ARRAY['timetable_sessions', 'timetable_streams', 'timetables'] LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('SELECT count(*) FROM %I', t) INTO n;
      IF n > 0 THEN
        RAISE EXCEPTION 'Table % still has % row(s): move them into courses / modules / lessons before applying this migration', t, n;
      END IF;
    END IF;
  END LOOP;
END $$;

DROP TABLE IF EXISTS timetable_sessions;
DROP TABLE IF EXISTS timetable_streams;
DROP TABLE IF EXISTS timetables;
-- Its file no longer exists; keep the migration history consistent with the files.
DELETE FROM schema_migrations WHERE name = '014_timetables.sql';
