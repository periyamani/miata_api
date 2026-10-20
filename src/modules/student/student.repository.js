import { pool } from '../../config/db.js';
import {
  studentAssignmentPredicate,
  studentCoursePredicate,
  studentModulePredicate,
  studentVideoPredicate,
} from '../../repositories/scope.js';
import { SqlBuilder } from '../../utils/sql.js';

// Every query is limited to the signed-in student ($1 / scope predicate), and to the material of their batch.

/**
 * The student's professors for a course aliased `c`: their batch's professors when they take it with their batch,
 * otherwise the course professors. `columns` is the json_build_object body or a plain column.
 */
const professorsOf = (studentExpr, select, aggregate) => `CASE
  WHEN enrolment_batch_id(${studentExpr}, c.id) IS NOT NULL THEN
    (SELECT ${aggregate} FROM batch_professors bp JOIN users u ON u.id = bp.professor_id
      WHERE bp.batch_id = enrolment_batch_id(${studentExpr}, c.id) AND u.is_active)
  ELSE (SELECT ${aggregate} FROM professor_course_assignments pca JOIN users u ON u.id = pca.professor_id
         WHERE pca.course_id = c.id) END${select}`;

export async function enrolments(studentId) {
  const { rows } = await pool.query(
    `SELECT e.id AS enrolment_id, e.status, e.enrolled_at, e.completed_at, e.start_date, e.end_date,
            c.id AS course_id, c.title, c.code, c.description, c.category, c.duration_value, c.duration_unit,
            c.is_active AS course_active,
            (SELECT count(*) FROM modules m WHERE m.course_id = c.id AND ${studentModulePredicate('m.id', '$1')}) AS module_count,
            ${professorsOf('$1', ' AS professor_names', `string_agg(u.full_name, ', ' ORDER BY u.full_name)`)},
            eb.name AS batch_name,
            ep.videos_total, ep.videos_done, ep.assignments_total, ep.assignments_done
       FROM course_enrolments e
       JOIN courses c ON c.id = e.course_id
       JOIN enrolment_progress ep ON ep.enrolment_id = e.id
       LEFT JOIN batches eb ON eb.id = enrolment_batch_id(e.student_id, e.course_id)
      WHERE e.student_id = $1
      ORDER BY (e.status = 'active') DESC, e.enrolled_at DESC`,
    [studentId],
  );
  return rows;
}

/** The last day of the student's access (their latest course end date); null = not enrolled, or no end. */
export async function accessEndsOn(studentId) {
  const { rows } = await pool.query('SELECT access_ends_on FROM student_access WHERE student_id = $1', [studentId]);
  return rows[0]?.access_ends_on ?? null;
}

export async function accessibleEnrolment(studentId, courseId) {
  const { rows } = await pool.query(
    `SELECT e.id AS enrolment_id, e.status, e.enrolled_at, e.completed_at,
            ep.videos_total, ep.videos_done, ep.assignments_total, ep.assignments_done
       FROM course_enrolments e JOIN courses c ON c.id = e.course_id
       JOIN enrolment_progress ep ON ep.enrolment_id = e.id
      WHERE e.student_id = $1 AND e.course_id = $2 AND e.status IN ('active', 'completed') AND c.is_active`,
    [studentId, courseId],
  );
  return rows[0] || null;
}

export async function course(studentId, courseId) {
  const { rows } = await pool.query(
    `SELECT c.id, c.title, c.code, c.description, c.category, c.duration_value, c.duration_unit,
            eb.id AS batch_id, eb.name AS batch_name,
            COALESCE(${professorsOf(
              '$1',
              '',
              `json_agg(json_build_object('id', u.id, 'full_name', u.full_name) ORDER BY u.full_name)`,
            )}, '[]') AS professors
       FROM courses c LEFT JOIN batches eb ON eb.id = enrolment_batch_id($1, c.id)
      WHERE c.id = $2`,
    [studentId, courseId],
  );
  return rows[0];
}

/** Modules of the course available to the student's batch, with their lessons. */
export async function modulesWithLessons(studentId, courseId) {
  const { rows: modules } = await pool.query(
    `SELECT m.id, m.title, m.description, m.position FROM modules m
      WHERE m.course_id = $2 AND ${studentModulePredicate('m.id', '$1')} ORDER BY m.position, m.id`,
    [studentId, courseId],
  );
  const { rows: lessons } = await pool.query(
    `SELECT l.id, l.module_id, l.title, l.content, l.duration_minutes, l.position
       FROM lessons l JOIN modules m ON m.id = l.module_id
      WHERE m.course_id = $2 AND ${studentModulePredicate('m.id', '$1')} ORDER BY l.position, l.id`,
    [studentId, courseId],
  );
  return modules.map((m) => ({ ...m, lessons: lessons.filter((l) => l.module_id === m.id) }));
}

const VIDEO_COLUMNS = `v.id, v.title, v.description, v.duration_seconds, v.position, v.is_required,
  v.course_id, v.module_id, v.lesson_id, v.published_at,
  c.title AS course_title, m.title AS module_title, l.title AS lesson_title,
  COALESCE(vp.watched_seconds, 0) AS watched_seconds, COALESCE(vp.last_position, 0) AS last_position, vp.completed_at`;

/** Published videos available to the student (course access + batch availability), with their own progress. */
export async function videos(studentId, { courseId, moduleId, status, limit } = {}) {
  const q = new SqlBuilder();
  const sid = q.param(studentId);
  q.where('v.is_published');
  q.where(studentCoursePredicate('v.course_id', sid));
  q.where(studentVideoPredicate('v', sid));
  if (courseId) q.where(`v.course_id = ${q.param(courseId)}`);
  if (moduleId) q.where(`v.module_id = ${q.param(moduleId)}`);
  if (status === 'watched') q.where('vp.completed_at IS NOT NULL');
  if (status === 'unwatched') q.where('vp.completed_at IS NULL');
  const { rows } = await pool.query(
    `SELECT ${VIDEO_COLUMNS}
       FROM videos v
       JOIN courses c ON c.id = v.course_id
       LEFT JOIN modules m ON m.id = v.module_id
       LEFT JOIN lessons l ON l.id = v.lesson_id
       LEFT JOIN video_progress vp ON vp.video_id = v.id AND vp.student_id = ${sid}
      ${q.whereClause()}
      ORDER BY c.title, m.position NULLS LAST, l.position NULLS LAST, v.position, v.id
      ${limit ? `LIMIT ${q.param(limit)}` : ''}`,
    q.params,
  );
  return rows;
}

export async function videoProgress(studentId, videoId) {
  const { rows } = await pool.query(
    'SELECT watched_seconds, last_position, completed_at FROM video_progress WHERE student_id = $1 AND video_id = $2',
    [studentId, videoId],
  );
  return rows[0] || { watched_seconds: 0, last_position: 0, completed_at: null };
}

/** Per-module requirement counts (material of the student's batch only) used for module status and progress breakdowns. */
export async function moduleProgress(studentId, courseId = null) {
  const { rows } = await pool.query(
    `SELECT m.id, m.title, m.description, m.position, m.course_id, c.title AS course_title,
            (SELECT count(*) FROM lessons l WHERE l.module_id = m.id) AS lesson_count,
            (SELECT count(*) FROM videos v WHERE v.module_id = m.id AND v.is_published AND v.is_required
                AND ${studentVideoPredicate('v', '$1')}) AS videos_total,
            (SELECT count(*) FROM videos v JOIN video_progress vp ON vp.video_id = v.id AND vp.student_id = $1 AND vp.completed_at IS NOT NULL
              WHERE v.module_id = m.id AND v.is_published AND v.is_required AND ${studentVideoPredicate('v', '$1')}) AS videos_done,
            (SELECT count(*) FROM assignments a WHERE a.module_id = m.id AND a.is_published AND a.is_required
                AND assignment_assigned_to(a.id, a.batch_id, a.module_id, $1)) AS assignments_total,
            (SELECT count(*) FROM assignments a WHERE a.module_id = m.id AND a.is_published AND a.is_required
                AND assignment_assigned_to(a.id, a.batch_id, a.module_id, $1)
                AND EXISTS (SELECT 1 FROM assignment_submissions s WHERE s.assignment_id = a.id AND s.student_id = $1 AND s.status = 'completed')) AS assignments_done
       FROM modules m JOIN courses c ON c.id = m.course_id
      WHERE ${studentCoursePredicate('m.course_id', '$1')} AND ${studentModulePredicate('m.id', '$1')}
        AND ($2::bigint IS NULL OR m.course_id = $2)
      ORDER BY c.title, m.position, m.id`,
    [studentId, courseId],
  );
  return rows;
}

/** A published assignment the student may see (assigned to them, or already submitted to), with who it is for. */
export async function findPublishedAssignment(studentId, assignmentId) {
  const { rows } = await pool.query(
    `SELECT a.id, a.title, a.instructions, a.due_at, a.is_required, a.course_id, a.module_id, a.attachment_file_id, a.batch_id,
            c.title AS course_title, m.title AS module_title, f.original_name AS attachment_name, f.size_bytes AS attachment_size,
            ab.name AS batch_name,
            EXISTS (SELECT 1 FROM assignment_students x WHERE x.assignment_id = a.id) AS for_selected_students,
            e.status AS enrolment_status
       FROM assignments a
       JOIN courses c ON c.id = a.course_id
       JOIN course_enrolments e ON e.course_id = a.course_id AND e.student_id = $2
       LEFT JOIN modules m ON m.id = a.module_id
       LEFT JOIN files f ON f.id = a.attachment_file_id
       LEFT JOIN batches ab ON ab.id = a.batch_id
      WHERE a.id = $1 AND a.is_published AND c.is_active AND e.status IN ('active', 'completed')
        AND ${studentAssignmentPredicate('a', '$2')}`,
    [assignmentId, studentId],
  );
  return rows[0] || null;
}

export async function latestAttempt(studentId, assignmentId, db = pool) {
  const { rows } = await db.query(
    `SELECT id, attempt_no, status FROM assignment_submissions
      WHERE student_id = $1 AND assignment_id = $2 ORDER BY attempt_no DESC LIMIT 1`,
    [studentId, assignmentId],
  );
  return rows[0] || null;
}

export async function insertSubmission({ assignmentId, studentId, attemptNo, fileId, notes }, db) {
  const { rows } = await db.query(
    `INSERT INTO assignment_submissions (assignment_id, student_id, attempt_no, file_id, notes)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [assignmentId, studentId, attemptNo, fileId, notes],
  );
  return rows[0];
}

export async function submissionHistory(studentId) {
  const { rows } = await pool.query(
    `SELECT s.id, s.attempt_no, s.status, s.submitted_at, s.reviewed_at, s.notes,
            a.id AS assignment_id, a.title AS assignment_title, a.due_at, c.title AS course_title,
            f.original_name AS file_name, f.size_bytes AS file_size, rv.full_name AS reviewer_name,
            (SELECT r.feedback FROM assignment_reviews r WHERE r.submission_id = s.id ORDER BY r.created_at DESC LIMIT 1) AS latest_feedback
       FROM assignment_submissions s
       JOIN assignments a ON a.id = s.assignment_id
       JOIN courses c ON c.id = a.course_id
       JOIN files f ON f.id = s.file_id
       LEFT JOIN users rv ON rv.id = s.reviewed_by
      WHERE s.student_id = $1
      ORDER BY s.submitted_at DESC`,
    [studentId],
  );
  return rows;
}

export async function ownsSubmission(studentId, submissionId) {
  const { rowCount } = await pool.query('SELECT 1 FROM assignment_submissions WHERE id = $1 AND student_id = $2', [
    submissionId,
    studentId,
  ]);
  return rowCount > 0;
}

/** The student's own learning timeline: videos completed, submissions, reviews and comments received. */
export async function recentActivity(studentId, limit = 6) {
  const { rows } = await pool.query(
    `SELECT * FROM (
       SELECT 'video_completed' AS kind, vp.completed_at AS at, v.title AS title, v.id AS ref_id, NULL AS detail
         FROM video_progress vp JOIN videos v ON v.id = vp.video_id
        WHERE vp.student_id = $1 AND vp.completed_at IS NOT NULL
       UNION ALL
       SELECT 'submitted', s.submitted_at, a.title, a.id, 'Attempt ' || s.attempt_no
         FROM assignment_submissions s JOIN assignments a ON a.id = s.assignment_id WHERE s.student_id = $1
       UNION ALL
       SELECT 'review_' || r.decision, r.created_at, a.title, a.id, r.feedback
         FROM assignment_reviews r JOIN assignment_submissions s ON s.id = r.submission_id
         JOIN assignments a ON a.id = s.assignment_id WHERE s.student_id = $1
       UNION ALL
       SELECT 'comment', sc.created_at, a.title, a.id, sc.body
         FROM submission_comments sc JOIN assignment_submissions s ON s.id = sc.submission_id
         JOIN assignments a ON a.id = s.assignment_id WHERE s.student_id = $1 AND sc.author_id <> $1
       UNION ALL
       SELECT 'course_completed', e.completed_at, c.title, c.id, NULL
         FROM course_enrolments e JOIN courses c ON c.id = e.course_id WHERE e.student_id = $1 AND e.completed_at IS NOT NULL
     ) events ORDER BY at DESC LIMIT $2`,
    [studentId, limit],
  );
  return rows;
}
