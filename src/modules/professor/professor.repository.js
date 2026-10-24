import { pool } from '../../config/db.js';
import { AUDIENCE_COLUMNS, AUDIENCE_JOIN, submissionCounts } from '../../repositories/assignments.repository.js';
import { TEACHING_STATUS_COLUMNS, TEACHING_STATUS_JOIN } from '../../repositories/moduleStatus.repository.js';
import {
  professorAssignmentPredicate,
  professorAssignmentVisiblePredicate,
  professorBatchCoursePredicate,
  professorBatchPredicate,
  professorCoursePredicate,
  professorPlacementPredicate,
  professorStudentPredicate,
  professorSubmissionPredicate,
  studentInBatchPredicate,
} from '../../repositories/scope.js';
import { limitOffset, orderBy, paged, SqlBuilder } from '../../utils/sql.js';

// Every query here is restricted to the professor passed in — see repositories/scope.js.

/** Submission counts over the students this professor teaches (optionally only one batch's students). */
const countsFor = (p, batchParam = null) =>
  submissionCounts((studentIdExpr) =>
    [professorStudentPredicate(studentIdExpr, 'a.course_id', p), batchParam && studentInBatchPredicate(studentIdExpr, batchParam)]
      .filter(Boolean)
      .join(' AND '),
  );

/** Course-wide work in the batch's courses, or work set for the batch itself. */
const assignmentInBatch = (alias, batchParam) => `(${alias}.batch_id = ${batchParam} OR (${alias}.batch_id IS NULL AND EXISTS (
  SELECT 1 FROM batch_courses bc WHERE bc.batch_id = ${batchParam} AND bc.course_id = ${alias}.course_id)))`;

export async function dashboardStats(professorId) {
  const { rows } = await pool.query(
    `SELECT
       (SELECT count(DISTINCT e.student_id) FROM course_enrolments e
         WHERE e.status IN ('active', 'completed') AND ${professorStudentPredicate('e.student_id', 'e.course_id', '$1')}) AS total_students,
       (SELECT count(*) FROM assignments a WHERE a.is_published AND ${professorAssignmentVisiblePredicate('a', '$1')}) AS total_assignments,
       (SELECT count(*) FROM assignment_submissions s JOIN assignments a ON a.id = s.assignment_id
         WHERE s.status IN ('submitted', 'in_review') AND ${professorSubmissionPredicate('s', 'a', '$1')}) AS pending_reviews,
       (SELECT count(*) FROM assignment_submissions s JOIN assignments a ON a.id = s.assignment_id
         WHERE s.status = 'completed' AND ${professorSubmissionPredicate('s', 'a', '$1')}) AS completed,
       (SELECT count(*) FROM assignment_submissions s JOIN assignments a ON a.id = s.assignment_id
         WHERE s.status = 'rework' AND ${professorSubmissionPredicate('s', 'a', '$1')}
           AND NOT EXISTS (SELECT 1 FROM assignment_submissions s2 WHERE s2.assignment_id = s.assignment_id
                             AND s2.student_id = s.student_id AND s2.attempt_no > s.attempt_no)) AS rework,
       (SELECT count(*) FROM batch_professors bp WHERE bp.professor_id = $1) AS total_batches`,
    [professorId],
  );
  return rows[0];
}

/** Courses the professor sees: taught as a whole, through modules, or through their batches. */
export async function assignedCourses(professorId) {
  const { rows } = await pool.query(
    `SELECT c.id, c.title, c.code, c.is_active,
            EXISTS (SELECT 1 FROM professor_course_assignments pca WHERE pca.course_id = c.id AND pca.professor_id = $1) AS whole_course,
            COALESCE((SELECT json_agg(json_build_object('id', m.id, 'title', m.title) ORDER BY m.position)
                        FROM professor_module_assignments pma JOIN modules m ON m.id = pma.module_id
                       WHERE pma.professor_id = $1 AND m.course_id = c.id), '[]') AS modules,
            COALESCE((SELECT json_agg(json_build_object('id', b.id, 'name', b.name, 'code', b.code, 'is_active', b.is_active) ORDER BY b.name)
                        FROM batch_professors bp JOIN batch_courses bc ON bc.batch_id = bp.batch_id JOIN batches b ON b.id = bp.batch_id
                       WHERE bp.professor_id = $1 AND bc.course_id = c.id), '[]') AS batches,
            (SELECT count(*) FROM course_enrolments e WHERE e.course_id = c.id AND e.status IN ('active', 'completed')
                AND ${professorStudentPredicate('e.student_id', 'c.id', '$1')}) AS student_count
       FROM courses c
      WHERE ${professorCoursePredicate('c.id', '$1')}
      ORDER BY c.title`,
    [professorId],
  );
  return rows;
}

/** The professor's batches with their courses, co-professors and workload. */
export async function batches(professorId) {
  const { rows } = await pool.query(
    `SELECT b.id, b.code, b.name, b.description, b.start_date, b.end_date, b.is_active,
            COALESCE((SELECT json_agg(json_build_object('id', c.id, 'title', c.title, 'code', c.code) ORDER BY c.title)
                        FROM batch_courses bc JOIN courses c ON c.id = bc.course_id WHERE bc.batch_id = b.id), '[]') AS courses,
            COALESCE((SELECT json_agg(json_build_object('id', u.id, 'full_name', u.full_name) ORDER BY u.full_name)
                        FROM batch_professors op JOIN users u ON u.id = op.professor_id
                       WHERE op.batch_id = b.id AND op.professor_id <> $1), '[]') AS co_professors,
            (SELECT count(*) FROM batch_students bs WHERE bs.batch_id = b.id) AS student_count,
            (SELECT count(*) FROM assignments a WHERE a.batch_id = b.id AND a.is_published) AS batch_assignment_count,
            (SELECT count(*) FROM assignment_submissions s JOIN assignments a ON a.id = s.assignment_id
              WHERE s.status IN ('submitted', 'in_review') AND enrolment_batch_id(s.student_id, a.course_id) = b.id) AS pending_reviews
       FROM batch_professors bp JOIN batches b ON b.id = bp.batch_id
      WHERE bp.professor_id = $1
      ORDER BY b.is_active DESC, b.start_date DESC NULLS LAST, b.name`,
    [professorId],
  );
  return rows;
}

const STUDENT_SORTS = { full_name: 'u.full_name', enrolled_at: 'e.enrolled_at', last_activity: 'last_activity', batch: 'eb.name' };

/** One row per enrolment the professor teaches, with its batch, progress counts and last activity. */
export async function listStudents(professorId, { page, pageSize, search, sort, order, courseId, status, batchId }) {
  const q = new SqlBuilder();
  const p = q.param(professorId);
  q.where(professorStudentPredicate('e.student_id', 'e.course_id', p));
  q.where(`e.status IN ('active', 'completed', 'suspended')`);
  q.search(search, ['u.full_name', 'sp.student_code', 'eb.name', 'eb.code']);
  if (courseId) q.where(`e.course_id = ${q.param(courseId)}`);
  if (status) q.where(`e.status = ${q.param(status)}`);
  if (batchId) q.where(`eb.id = ${q.param(batchId)}`);
  return paged(
    pool,
    `SELECT e.id AS enrolment_id, e.status, e.enrolled_at, e.completed_at,
            u.id AS student_id, u.full_name, u.is_active, sp.student_code,
            c.id AS course_id, c.title AS course_title,
            eb.id AS batch_id, eb.name AS batch_name, eb.code AS batch_code,
            ep.videos_total, ep.videos_done, ep.assignments_total, ep.assignments_done,
            GREATEST(e.enrolled_at,
                     (SELECT max(s.submitted_at) FROM assignment_submissions s JOIN assignments a ON a.id = s.assignment_id
                       WHERE s.student_id = u.id AND a.course_id = e.course_id),
                     (SELECT max(vp.updated_at) FROM video_progress vp JOIN videos v ON v.id = vp.video_id
                       WHERE vp.student_id = u.id AND v.course_id = e.course_id)) AS last_activity,
            count(*) OVER () AS total_count
       FROM course_enrolments e
       JOIN users u ON u.id = e.student_id
       LEFT JOIN student_profiles sp ON sp.user_id = u.id
       JOIN courses c ON c.id = e.course_id
       JOIN enrolment_progress ep ON ep.enrolment_id = e.id
       LEFT JOIN batches eb ON eb.id = enrolment_batch_id(e.student_id, e.course_id)
       ${q.whereClause()}
       ${orderBy(sort, order, STUDENT_SORTS, 'last_activity')}
       ${limitOffset(q, { page, pageSize })}`,
    q.params,
  );
}

const ASSIGNMENT_SORTS = { title: 'a.title', due_at: 'a.due_at', created_at: 'a.created_at', pending: 'pending_count' };

/**
 * Assignments the professor manages (drafts included) plus course-wide work their batches do. Counts cover only
 * the students they teach; with `batchId`, only that batch's work and students.
 */
export async function listAssignments(professorId, { page, pageSize, search, sort, order, courseId, published, batchId }) {
  const q = new SqlBuilder();
  const p = q.param(professorId);
  const b = batchId ? q.param(batchId) : null;
  q.where(professorAssignmentVisiblePredicate('a', p));
  q.search(search, ['a.title', 'c.title']);
  if (courseId) q.where(`a.course_id = ${q.param(courseId)}`);
  if (published !== undefined) q.where(`a.is_published = ${q.param(published)}`);
  if (b) q.where(assignmentInBatch('a', b));
  return paged(
    pool,
    `SELECT a.*, c.title AS course_title, m.title AS module_title, f.original_name AS attachment_name,
            ${AUDIENCE_COLUMNS}, ${professorAssignmentPredicate('a', p)} AS can_manage,
            ${countsFor(p, b)}, count(*) OVER () AS total_count
       FROM assignments a JOIN courses c ON c.id = a.course_id LEFT JOIN modules m ON m.id = a.module_id
       LEFT JOIN files f ON f.id = a.attachment_file_id
       ${AUDIENCE_JOIN}
       ${q.whereClause()}
       ${orderBy(sort, order, ASSIGNMENT_SORTS, 'due_at')}
       ${limitOffset(q, { page, pageSize })}`,
    q.params,
  );
}

export async function findAssignmentInScope(professorId, assignmentId, db = pool) {
  const { rows } = await db.query(
    `SELECT a.*, c.title AS course_title, m.title AS module_title,
            f.original_name AS attachment_name, f.size_bytes AS attachment_size,
            cb.full_name AS created_by_name, ${AUDIENCE_COLUMNS},
            ${professorAssignmentPredicate('a', '$2')} AS can_manage, ${countsFor('$2')}
       FROM assignments a JOIN courses c ON c.id = a.course_id
       LEFT JOIN modules m ON m.id = a.module_id
       LEFT JOIN files f ON f.id = a.attachment_file_id
       LEFT JOIN users cb ON cb.id = a.created_by
       ${AUDIENCE_JOIN}
      WHERE a.id = $1 AND ${professorAssignmentVisiblePredicate('a', '$2')}`,
    [assignmentId, professorId],
  );
  return rows[0] || null;
}

/**
 * Whether the professor sees the course at all, may place course-wide work in it (whole course or this module), and
 * teaches it through one of their batches.
 */
export async function placementScope(professorId, courseId, moduleId, db = pool) {
  const { rows } = await db.query(
    `SELECT ${professorCoursePredicate('$1::bigint', '$3::bigint')} AS teaches_course,
            ${professorPlacementPredicate('$1::bigint', '$2::bigint', '$3::bigint')} AS can_place,
            ${professorBatchCoursePredicate('$1::bigint', '$3::bigint')} AS teaches_through_batch`,
    [courseId, moduleId, professorId],
  );
  return rows[0];
}

/** A batch as seen by a professor placing work for it: do they teach it, and does it take the course? */
export async function batchPlacement(professorId, batchId, courseId, db = pool) {
  const { rows } = await db.query(
    `SELECT b.id, b.name, b.is_active, ${professorBatchPredicate('b.id', '$3::bigint')} AS teaches_batch,
            EXISTS (SELECT 1 FROM batch_courses bc WHERE bc.batch_id = b.id AND bc.course_id = $2) AS takes_course
       FROM batches b WHERE b.id = $1`,
    [batchId, courseId, professorId],
  );
  return rows[0] || null;
}

const MODULE_AVAILABLE_TO_BATCH = (moduleExpr, batchExpr) => `(
  NOT EXISTS (SELECT 1 FROM module_batches mb WHERE mb.module_id = ${moduleExpr})
  OR EXISTS (SELECT 1 FROM module_batches mb WHERE mb.module_id = ${moduleExpr} AND mb.batch_id = ${batchExpr}))`;

export async function moduleAvailableToBatch(moduleId, batchId, db = pool) {
  const { rows } = await db.query(`SELECT ${MODULE_AVAILABLE_TO_BATCH('$1::bigint', '$2::bigint')} AS ok`, [moduleId, batchId]);
  return rows[0].ok;
}

/**
 * Modules of a course the professor may put work in. For a batch: every module available to that batch. For
 * course-wide work: all of them for a course professor, else their own.
 */
export async function assignableModules(professorId, courseId, batchId = null) {
  const { rows } = batchId
    ? await pool.query(
        `SELECT m.id, m.title, m.position FROM modules m
          WHERE m.course_id = $1 AND ${MODULE_AVAILABLE_TO_BATCH('m.id', '$2')}
          ORDER BY m.position, m.id`,
        [courseId, batchId],
      )
    : await pool.query(
        `SELECT m.id, m.title, m.position FROM modules m
          WHERE m.course_id = $1 AND ${professorPlacementPredicate('m.course_id', 'm.id', '$2')}
          ORDER BY m.position, m.id`,
        [courseId, professorId],
      );
  return rows;
}

/**
 * Modules of active courses whose teaching status the professor keeps up to date: every module of a course they teach
 * as a whole, and the modules they are assigned to. Each with its number in the course, status, lesson count, the weeks
 * of its scheduled sessions and its module professors. `moduleId` narrows to one module (null when it is not theirs).
 */
export async function teachingModules(professorId, { moduleId = null } = {}, db = pool) {
  const { rows } = await db.query(
    `SELECT m.id, m.title, m.position, m.course_id, c.title AS course_title, c.code AS course_code, ${TEACHING_STATUS_COLUMNS},
            (SELECT count(*) FROM modules m2 WHERE m2.course_id = m.course_id AND (m2.position, m2.id) < (m.position, m.id)) + 1 AS number,
            (SELECT count(*) FROM lessons l WHERE l.module_id = m.id) AS lesson_count,
            COALESCE((SELECT array_agg(DISTINCT l.week_number ORDER BY l.week_number) FROM lessons l
                       WHERE l.module_id = m.id AND l.week_number IS NOT NULL), '{}') AS weeks,
            COALESCE((SELECT json_agg(u.full_name ORDER BY u.full_name)
                        FROM professor_module_assignments pma JOIN users u ON u.id = pma.professor_id
                       WHERE pma.module_id = m.id), '[]') AS professors
       FROM modules m JOIN courses c ON c.id = m.course_id
       ${TEACHING_STATUS_JOIN}
      WHERE c.is_active AND ${professorPlacementPredicate('m.course_id', 'm.id', '$1')} AND ($2::bigint IS NULL OR m.id = $2)
      ORDER BY c.title, c.id, m.position, m.id`,
    [professorId, moduleId],
  );
  return moduleId ? (rows[0] ?? null) : rows;
}

/** How many of `studentIds` belong to the batch and are enrolled in the course (selected recipients must all be). */
export async function countBatchStudentsInCourse(batchId, courseId, studentIds, db = pool) {
  const { rows } = await db.query(
    `SELECT count(*)::int AS n FROM batch_students bs
       JOIN course_enrolments e ON e.student_id = bs.student_id AND e.course_id = $2
      WHERE bs.batch_id = $1 AND bs.student_id = ANY($3::bigint[])`,
    [batchId, courseId, studentIds],
  );
  return rows[0].n;
}

export async function canReviewSubmission(professorId, submissionId) {
  const { rowCount } = await pool.query(
    `SELECT 1 FROM assignment_submissions s JOIN assignments a ON a.id = s.assignment_id
      WHERE s.id = $1 AND ${professorSubmissionPredicate('s', 'a', '$2')}`,
    [submissionId, professorId],
  );
  return rowCount > 0;
}

export async function upcomingDeadlines(professorId, limit = 5) {
  const { rows } = await pool.query(
    `SELECT a.id, a.title, a.due_at, c.title AS course_title, ab.name AS batch_name
       FROM assignments a JOIN courses c ON c.id = a.course_id ${AUDIENCE_JOIN}
      WHERE a.is_published AND a.due_at >= now() AND ${professorAssignmentVisiblePredicate('a', '$1')}
      ORDER BY a.due_at LIMIT $2`,
    [professorId, limit],
  );
  return rows;
}

/** Latest submissions, reviews and comments the professor may review, newest first. */
export async function recentActivity(professorId, limit = 6) {
  const { rows } = await pool.query(
    `SELECT * FROM (
       SELECT 'submitted' AS kind, s.submitted_at AS at, u.full_name AS student_name, a.title AS assignment_title, s.id AS submission_id, NULL AS detail
         FROM assignment_submissions s JOIN assignments a ON a.id = s.assignment_id JOIN users u ON u.id = s.student_id
        WHERE ${professorSubmissionPredicate('s', 'a', '$1')}
       UNION ALL
       SELECT r.decision, r.created_at, u.full_name, a.title, s.id, r.feedback
         FROM assignment_reviews r JOIN assignment_submissions s ON s.id = r.submission_id
         JOIN assignments a ON a.id = s.assignment_id JOIN users u ON u.id = s.student_id
        WHERE ${professorSubmissionPredicate('s', 'a', '$1')}
       UNION ALL
       SELECT 'comment', sc.created_at, u.full_name, a.title, s.id, sc.body
         FROM submission_comments sc JOIN assignment_submissions s ON s.id = sc.submission_id
         JOIN assignments a ON a.id = s.assignment_id JOIN users u ON u.id = s.student_id
        WHERE ${professorSubmissionPredicate('s', 'a', '$1')}
     ) events ORDER BY at DESC LIMIT $2`,
    [professorId, limit],
  );
  return rows;
}
