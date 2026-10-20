import { pool } from '../../../config/db.js';
import { availabilityColumn } from '../../../repositories/batches.repository.js';
import { limitOffset, orderBy, paged, SqlBuilder } from '../../../utils/sql.js';

/** Size and workload of a batch aliased `b`. Pending reviews: latest attempts awaiting review in the batch's courses. */
const BATCH_COUNTS = `
  (SELECT count(*) FROM batch_students bs WHERE bs.batch_id = b.id) AS student_count,
  (SELECT count(*) FROM batch_courses bc WHERE bc.batch_id = b.id) AS course_count,
  (SELECT count(*) FROM batch_professors bp WHERE bp.batch_id = b.id) AS professor_count,
  (SELECT count(*) FROM assignments a WHERE a.batch_id = b.id) AS batch_assignment_count,
  (SELECT count(*) FROM assignment_submissions s JOIN assignments a ON a.id = s.assignment_id
    WHERE s.status IN ('submitted', 'in_review') AND enrolment_batch_id(s.student_id, a.course_id) = b.id) AS pending_reviews`;

const BATCH_COURSES = `COALESCE((SELECT json_agg(json_build_object('id', c.id, 'title', c.title, 'code', c.code, 'is_active', c.is_active) ORDER BY c.title)
  FROM batch_courses bc JOIN courses c ON c.id = bc.course_id WHERE bc.batch_id = b.id), '[]') AS courses`;
const BATCH_PROFESSORS = `COALESCE((SELECT json_agg(json_build_object('id', u.id, 'full_name', u.full_name) ORDER BY u.full_name)
  FROM batch_professors bp JOIN users u ON u.id = bp.professor_id WHERE bp.batch_id = b.id), '[]') AS professors`;

const SORTS = { name: 'b.name', code: 'b.code', start_date: 'b.start_date', created_at: 'b.created_at', students: 'student_count' };

export async function listBatches({ page, pageSize, search, sort, order, status, courseId, professorId }) {
  const q = new SqlBuilder();
  q.search(search, ['b.name', 'b.code', 'b.description']);
  if (status) q.where(`b.is_active = ${q.param(status === 'active')}`);
  if (courseId) q.where(`EXISTS (SELECT 1 FROM batch_courses x WHERE x.batch_id = b.id AND x.course_id = ${q.param(courseId)})`);
  if (professorId)
    q.where(`EXISTS (SELECT 1 FROM batch_professors x WHERE x.batch_id = b.id AND x.professor_id = ${q.param(professorId)})`);
  return paged(
    pool,
    `SELECT b.*, ${BATCH_COUNTS}, ${BATCH_COURSES}, ${BATCH_PROFESSORS}, count(*) OVER () AS total_count
       FROM batches b ${q.whereClause()}
       ${orderBy(sort, order, SORTS, 'start_date')}
       ${limitOffset(q, { page, pageSize })}`,
    q.params,
  );
}

export async function findBatch(id, db = pool, { lock = false } = {}) {
  const { rows } = await db.query(`SELECT b.*, ${BATCH_COUNTS} FROM batches b WHERE b.id = $1 ${lock ? 'FOR UPDATE OF b' : ''}`, [id]);
  return rows[0] || null;
}

/** The batch's courses with how many of its students are enrolled and have completed each. */
export async function batchCourses(batchId, db = pool) {
  const { rows } = await db.query(
    `SELECT c.id, c.title, c.code, c.is_active, bc.added_at,
            (SELECT count(*) FROM modules m WHERE m.course_id = c.id) AS module_count,
            (SELECT count(*) FROM course_enrolments e JOIN batch_students bs ON bs.student_id = e.student_id AND bs.batch_id = $1
              WHERE e.course_id = c.id) AS enrolled_count,
            (SELECT count(*) FROM course_enrolments e JOIN batch_students bs ON bs.student_id = e.student_id AND bs.batch_id = $1
              WHERE e.course_id = c.id AND e.status = 'completed') AS completed_count
       FROM batch_courses bc JOIN courses c ON c.id = bc.course_id
      WHERE bc.batch_id = $1 ORDER BY c.title`,
    [batchId],
  );
  return rows;
}

export async function batchProfessors(batchId, db = pool) {
  const { rows } = await db.query(
    `SELECT u.id, u.full_name, u.email, u.is_active, pp.employee_code, pp.specialization, bp.assigned_at
       FROM batch_professors bp JOIN users u ON u.id = bp.professor_id
       LEFT JOIN professor_profiles pp ON pp.user_id = u.id
      WHERE bp.batch_id = $1 ORDER BY u.full_name`,
    [batchId],
  );
  return rows;
}

/** Published work assigned to a student aliased `u` in the courses of batch `$1` (enrolled, active or completed). */
const ASSIGNED_TO_STUDENT = `
  FROM assignments a
  JOIN batch_courses bc ON bc.batch_id = $1 AND bc.course_id = a.course_id
  JOIN course_enrolments e ON e.course_id = a.course_id AND e.student_id = u.id AND e.status IN ('active', 'completed')
  LEFT JOIN LATERAL (SELECT s.status FROM assignment_submissions s WHERE s.assignment_id = a.id AND s.student_id = u.id
                      ORDER BY s.attempt_no DESC LIMIT 1) ls ON TRUE
 WHERE a.is_published AND assignment_assigned_to(a.id, a.batch_id, a.module_id, u.id)`;

const STUDENT_SORTS = { full_name: 'u.full_name', added_at: 'bs.added_at', student_code: 'sp.student_code' };

/** Students of the batch with their assignment tracking (the service adds course progress). */
export async function batchStudents(batchId, { page, pageSize, search, sort, order }) {
  const q = new SqlBuilder();
  q.param(batchId); // $1, used by ASSIGNED_TO_STUDENT
  q.where('bs.batch_id = $1');
  q.search(search, ['u.full_name', 'u.email', 'sp.student_code']);
  return paged(
    pool,
    `SELECT u.id, u.full_name, u.email, u.is_active, sp.student_code, bs.added_at,
            (SELECT count(*) ${ASSIGNED_TO_STUDENT}) AS assignments_total,
            (SELECT count(*) ${ASSIGNED_TO_STUDENT} AND ls.status IS NOT NULL) AS assignments_submitted,
            (SELECT count(*) ${ASSIGNED_TO_STUDENT} AND ls.status IN ('submitted', 'in_review')) AS assignments_pending_review,
            (SELECT count(*) ${ASSIGNED_TO_STUDENT} AND ls.status = 'rework') AS assignments_rework,
            (SELECT count(*) ${ASSIGNED_TO_STUDENT} AND ls.status = 'completed') AS assignments_completed,
            (SELECT count(*) ${ASSIGNED_TO_STUDENT} AND ls.status IS NULL AND a.due_at < now()) AS assignments_overdue,
            count(*) OVER () AS total_count
       FROM batch_students bs
       JOIN users u ON u.id = bs.student_id
       LEFT JOIN student_profiles sp ON sp.user_id = u.id
       ${q.whereClause()}
       ${orderBy(sort, order, STUDENT_SORTS, 'added_at')}
       ${limitOffset(q, { page, pageSize })}`,
    q.params,
  );
}

/** Per course of the batch: modules and videos with the batches each is restricted to, and whether this batch has it. */
export async function batchMaterials(batchId) {
  const { rows: modules } = await pool.query(
    `SELECT m.id, m.course_id, m.title, m.position,
            (SELECT count(*) FROM lessons l WHERE l.module_id = m.id) AS lesson_count,
            ${availabilityColumn('module', 'm.id')} AS batches,
            (NOT EXISTS (SELECT 1 FROM module_batches mb WHERE mb.module_id = m.id)
             OR EXISTS (SELECT 1 FROM module_batches mb WHERE mb.module_id = m.id AND mb.batch_id = $1)) AS available
       FROM modules m JOIN batch_courses bc ON bc.course_id = m.course_id AND bc.batch_id = $1
      ORDER BY m.position, m.id`,
    [batchId],
  );
  const { rows: videos } = await pool.query(
    `SELECT v.id, v.course_id, v.module_id, m.title AS module_title, v.title, v.duration_seconds, v.is_published, v.is_required,
            ${availabilityColumn('video', 'v.id')} AS batches,
            ((NOT EXISTS (SELECT 1 FROM video_batches vb WHERE vb.video_id = v.id)
              OR EXISTS (SELECT 1 FROM video_batches vb WHERE vb.video_id = v.id AND vb.batch_id = $1))
             AND (v.module_id IS NULL OR NOT EXISTS (SELECT 1 FROM module_batches mb WHERE mb.module_id = v.module_id)
                  OR EXISTS (SELECT 1 FROM module_batches mb WHERE mb.module_id = v.module_id AND mb.batch_id = $1))) AS available
       FROM videos v JOIN batch_courses bc ON bc.course_id = v.course_id AND bc.batch_id = $1
       LEFT JOIN modules m ON m.id = v.module_id
      ORDER BY m.position NULLS LAST, v.position, v.id`,
    [batchId],
  );
  return { modules, videos };
}

// ─── Writes ─────────────────────────────────────────────────────────────

export async function codeTaken(code, exceptId, db = pool) {
  const { rowCount } = await db.query('SELECT 1 FROM batches WHERE code = $1 AND id IS DISTINCT FROM $2', [code, exceptId]);
  return rowCount > 0;
}

export async function insertBatch(data, userId, db) {
  const { rows } = await db.query(
    `INSERT INTO batches (code, name, description, start_date, end_date, is_active, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [data.code, data.name, data.description, data.startDate, data.endDate, data.isActive, userId],
  );
  return rows[0];
}

export async function updateBatch(id, data, db) {
  const { rows } = await db.query(
    `UPDATE batches SET code = $2, name = $3, description = $4, start_date = $5, end_date = $6, is_active = $7
      WHERE id = $1 RETURNING *`,
    [id, data.code, data.name, data.description, data.startDate, data.endDate, data.isActive],
  );
  return rows[0] || null;
}

export async function setBatchActive(id, isActive, db) {
  const { rows } = await db.query('UPDATE batches SET is_active = $2 WHERE id = $1 RETURNING *', [id, isActive]);
  return rows[0] || null;
}

/** What still refers to a batch (a batch is deleted only when nothing does). */
export async function batchReferences(id, db) {
  const { rows } = await db.query(
    `SELECT (SELECT count(*) FROM batch_students WHERE batch_id = $1)::int AS students,
            (SELECT count(*) FROM assignments WHERE batch_id = $1)::int AS assignments,
            ((SELECT count(*) FROM module_batches WHERE batch_id = $1) + (SELECT count(*) FROM video_batches WHERE batch_id = $1))::int AS materials`,
    [id],
  );
  return rows[0];
}

export async function deleteBatch(id, db) {
  await db.query('DELETE FROM batches WHERE id = $1', [id]);
}

export async function batchStudentIds(batchId, db) {
  const { rows } = await db.query('SELECT student_id FROM batch_students WHERE batch_id = $1', [batchId]);
  return rows.map((r) => r.student_id);
}

export async function activeCourseIds(batchId, db) {
  const { rows } = await db.query(
    'SELECT c.id FROM batch_courses bc JOIN courses c ON c.id = bc.course_id WHERE bc.batch_id = $1 AND c.is_active',
    [batchId],
  );
  return rows.map((r) => r.id);
}

export async function professorIds(batchId, db) {
  const { rows } = await db.query('SELECT professor_id FROM batch_professors WHERE batch_id = $1', [batchId]);
  return rows.map((r) => r.professor_id);
}
