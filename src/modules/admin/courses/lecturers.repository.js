import { pool } from '../../../config/db.js';

// A course's lecturers (course_lecturers, migration 016): who teaches its weekly sessions and when. A lecturer may be
// linked to a professor account; `course_allocated` tells whether that professor is also assigned to the course
// (professor_course_assignments), the allocation that lets them manage its assignments.

const COLUMNS = `cl.*, u.full_name AS professor_name, u.email AS professor_email, u.is_active AS professor_active,
  EXISTS (SELECT 1 FROM professor_course_assignments pca WHERE pca.course_id = cl.course_id AND pca.professor_id = cl.professor_id)
    AS course_allocated,
  s.first_week, s.last_week, COALESCE(s.session_count, 0) AS session_count`;
const FROM = `FROM course_lecturers cl
  LEFT JOIN users u ON u.id = cl.professor_id
  LEFT JOIN LATERAL (SELECT min(l.week_number) AS first_week, max(l.week_number) AS last_week, count(*) AS session_count
                       FROM lessons l WHERE l.course_lecturer_id = cl.id AND l.week_number IS NOT NULL) s ON TRUE`;

/** The course's lecturers in timetable order, with their linked account and the weeks they teach. */
export async function courseLecturers(courseId, db = pool) {
  const { rows } = await db.query(`SELECT ${COLUMNS} ${FROM} WHERE cl.course_id = $1 ORDER BY cl.position, cl.id`, [courseId]);
  return rows;
}

export async function findLecturer(id, db = pool) {
  const { rows } = await db.query(
    `SELECT ${COLUMNS}, c.title AS course_title ${FROM} JOIN courses c ON c.id = cl.course_id WHERE cl.id = $1`,
    [id],
  );
  return rows[0] || null;
}

export async function nameTaken(courseId, lecturerName, exceptId, db = pool) {
  const { rowCount } = await db.query(
    'SELECT 1 FROM course_lecturers WHERE course_id = $1 AND lower(lecturer_name) = lower($2) AND id IS DISTINCT FROM $3',
    [courseId, lecturerName, exceptId],
  );
  return rowCount > 0;
}

const values = (d) => [
  d.lecturerName,
  d.professorId ?? null,
  d.allocation ?? null,
  d.deliveryDay ?? null,
  d.startTime ?? null,
  d.endTime ?? null,
  d.sessionMinutes ?? null,
];

export async function insertLecturer(courseId, data, db) {
  const { rows } = await db.query(
    `INSERT INTO course_lecturers (course_id, lecturer_name, professor_id, allocation, delivery_day, start_time, end_time, session_minutes,
                                   position)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, (SELECT COALESCE(max(position), 0) + 1 FROM course_lecturers WHERE course_id = $1))
     RETURNING *`,
    [courseId, ...values(data)],
  );
  return rows[0];
}

export async function updateLecturer(id, data, db) {
  const { rows } = await db.query(
    `UPDATE course_lecturers SET lecturer_name = $2, professor_id = $3, allocation = $4, delivery_day = $5, start_time = $6,
            end_time = $7, session_minutes = $8
      WHERE id = $1 RETURNING *`,
    [id, ...values(data)],
  );
  return rows[0] || null;
}

/** Fill in what a lecturer does not have yet (an import never overwrites what an admin entered). */
export async function fillLecturer(id, { professorId, allocation, deliveryDay, sessionMinutes }, db) {
  const { rowCount } = await db.query(
    `UPDATE course_lecturers SET professor_id = COALESCE(professor_id, $2), allocation = COALESCE(allocation, $3),
            delivery_day = COALESCE(delivery_day, $4), session_minutes = COALESCE(session_minutes, $5)
      WHERE id = $1
        AND ((professor_id IS NULL AND $2::bigint IS NOT NULL) OR allocation IS NULL OR delivery_day IS NULL OR session_minutes IS NULL)`,
    [id, professorId ?? null, allocation ?? null, deliveryDay ?? null, sessionMinutes ?? null],
  );
  return rowCount > 0;
}

export async function deleteLecturer(id, db) {
  await db.query('DELETE FROM course_lecturers WHERE id = $1', [id]);
}

export async function findProfessor(id, db = pool) {
  const { rows } = await db.query(`SELECT id, full_name, is_active FROM users WHERE id = $1 AND role = 'professor'`, [id]);
  return rows[0] || null;
}

/** Active professor accounts, to match lecturers by name. */
export async function professorAccounts(db = pool) {
  const { rows } = await db.query(`SELECT id, full_name FROM users WHERE role = 'professor' AND is_active ORDER BY id`);
  return rows;
}

/**
 * Module assignments the timetable implies but that do not exist yet: the professor linked to a lecturer, for each module
 * in which the lecturer teaches a weekly session.
 */
export async function missingModuleAssignments(courseId, db = pool) {
  const { rows } = await db.query(
    `SELECT DISTINCT cl.professor_id, l.module_id, m.position, cl.position AS lecturer_position,
            m.title AS module_title, u.full_name AS professor_name
       FROM lessons l
       JOIN course_lecturers cl ON cl.id = l.course_lecturer_id
       JOIN modules m ON m.id = l.module_id
       JOIN users u ON u.id = cl.professor_id AND u.is_active
      WHERE cl.course_id = $1 AND l.week_number IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM professor_module_assignments pma WHERE pma.professor_id = cl.professor_id AND pma.module_id = l.module_id)
      ORDER BY m.position, cl.position`,
    [courseId],
  );
  return rows;
}

/** Module professors of the course who are not one of its lecturers (kept, but reported: the timetable does not name them). */
export async function nonLecturerModuleProfessors(courseId, db = pool) {
  const { rows } = await db.query(
    `SELECT m.title AS module_title, u.full_name AS professor_name
       FROM professor_module_assignments pma
       JOIN modules m ON m.id = pma.module_id
       JOIN users u ON u.id = pma.professor_id
      WHERE m.course_id = $1
        AND NOT EXISTS (SELECT 1 FROM course_lecturers cl WHERE cl.course_id = m.course_id AND cl.professor_id = pma.professor_id)
      ORDER BY m.position, u.full_name`,
    [courseId],
  );
  return rows;
}
