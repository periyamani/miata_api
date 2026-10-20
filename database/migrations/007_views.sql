-- 007 · Views: derived data that must never be stored (so it can never go stale).

-- Raw counts behind course progress. The completion policy (app_settings) decides which counts matter.
CREATE VIEW enrolment_progress AS
SELECT
  e.id AS enrolment_id,
  e.course_id,
  e.student_id,
  (SELECT count(*) FROM videos v
     WHERE v.course_id = e.course_id AND v.is_published AND v.is_required) AS videos_total,
  (SELECT count(*) FROM videos v
     JOIN video_progress vp ON vp.video_id = v.id AND vp.student_id = e.student_id AND vp.completed_at IS NOT NULL
     WHERE v.course_id = e.course_id AND v.is_published AND v.is_required) AS videos_done,
  (SELECT count(*) FROM assignments a
     WHERE a.course_id = e.course_id AND a.is_published AND a.is_required) AS assignments_total,
  (SELECT count(*) FROM assignments a
     WHERE a.course_id = e.course_id AND a.is_published AND a.is_required
       AND EXISTS (SELECT 1 FROM assignment_submissions s
                   WHERE s.assignment_id = a.id AND s.student_id = e.student_id AND s.status = 'completed')) AS assignments_done
FROM course_enrolments e;

-- One definition of a student's overall status, shared by admin lists, agent referral counts and reports.
--   inactive  : account deactivated
--   active    : has at least one active enrolment (currently learning)
--   completed : no active enrolment, at least one completed course
--   pending   : registered but not (or no longer) actively enrolled
CREATE VIEW student_status AS
SELECT
  u.id AS student_id,
  CASE
    WHEN NOT u.is_active THEN 'inactive'
    WHEN EXISTS (SELECT 1 FROM course_enrolments e WHERE e.student_id = u.id AND e.status = 'active') THEN 'active'
    WHEN EXISTS (SELECT 1 FROM course_enrolments e WHERE e.student_id = u.id AND e.status = 'completed') THEN 'completed'
    ELSE 'pending'
  END AS status,
  (SELECT string_agg(c.title, ', ' ORDER BY c.title)
     FROM course_enrolments e JOIN courses c ON c.id = e.course_id
    WHERE e.student_id = u.id) AS course_titles,
  (SELECT count(*) FROM course_enrolments e WHERE e.student_id = u.id) AS enrolment_count,
  (SELECT count(*) FROM course_enrolments e WHERE e.student_id = u.id AND e.status = 'completed') AS completed_count
FROM users u
WHERE u.role = 'student';
