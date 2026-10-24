import { pool } from '../../../config/db.js';

/** A module with its course's title and programme dates (which bound the weeks its topics can be taught in). */
export async function findModule(id, db = pool) {
  const { rows } = await db.query(
    `SELECT m.*, c.title AS course_title, c.start_date AS course_start_date, c.end_date AS course_end_date
       FROM modules m JOIN courses c ON c.id = m.course_id WHERE m.id = $1`,
    [id],
  );
  return rows[0] || null;
}

export async function findLesson(id, db = pool) {
  const { rows } = await db.query(
    `SELECT l.*, m.course_id, c.start_date AS course_start_date, c.end_date AS course_end_date
       FROM lessons l JOIN modules m ON m.id = l.module_id JOIN courses c ON c.id = m.course_id WHERE l.id = $1`,
    [id],
  );
  return rows[0] || null;
}

export async function insertModule(courseId, { title, description }, db) {
  const { rows } = await db.query(
    `INSERT INTO modules (course_id, title, description, position)
     VALUES ($1, $2, $3, (SELECT COALESCE(max(position), 0) + 1 FROM modules WHERE course_id = $1))
     RETURNING *`,
    [courseId, title, description],
  );
  return rows[0];
}

export async function updateModule(id, { title, description }, db) {
  const { rows } = await db.query('UPDATE modules SET title = $2, description = $3 WHERE id = $1 RETURNING *', [id, title, description]);
  return rows[0] || null;
}

/** Give a module the description it does not have yet (an import never overwrites what an admin entered). */
export async function fillModuleDescription(id, description, db) {
  const { rowCount } = await db.query('UPDATE modules SET description = $2 WHERE id = $1 AND description IS NULL AND $2::text IS NOT NULL', [
    id,
    description ?? null,
  ]);
  return rowCount > 0;
}

export async function deleteModule(id, db) {
  await db.query('DELETE FROM modules WHERE id = $1', [id]);
}

// A lesson is a curriculum topic, or — with a week_number and a course lecturer — a scheduled weekly session.
export async function insertLesson(moduleId, { title, content, durationMinutes, weekNumber = null, courseLecturerId = null }, db) {
  const { rows } = await db.query(
    `INSERT INTO lessons (module_id, title, content, duration_minutes, week_number, course_lecturer_id, position)
     VALUES ($1, $2, $3, $4, $5, $6, (SELECT COALESCE(max(position), 0) + 1 FROM lessons WHERE module_id = $1))
     RETURNING *`,
    [moduleId, title, content, durationMinutes, weekNumber, courseLecturerId],
  );
  return rows[0];
}

export async function updateLesson(id, { title, content, durationMinutes, weekNumber = null, courseLecturerId = null }, db) {
  const { rows } = await db.query(
    `UPDATE lessons SET title = $2, content = $3, duration_minutes = $4, week_number = $5, course_lecturer_id = $6
      WHERE id = $1 RETURNING *`,
    [id, title, content, durationMinutes, weekNumber, courseLecturerId],
  );
  return rows[0] || null;
}

/** Give a scheduled session its lecturer when it has none (an import never reassigns a session). */
export async function fillSessionLecturer(id, courseLecturerId, db) {
  const { rowCount } = await db.query('UPDATE lessons SET course_lecturer_id = $2 WHERE id = $1 AND course_lecturer_id IS NULL', [
    id,
    courseLecturerId,
  ]);
  return rowCount > 0;
}

/** Whether a course lecturer belongs to the module's course (a session can only be taught by one of its lecturers). */
export async function lecturerInCourse(courseLecturerId, courseId, db = pool) {
  const { rowCount } = await db.query('SELECT 1 FROM course_lecturers WHERE id = $1 AND course_id = $2', [courseLecturerId, courseId]);
  return rowCount > 0;
}

export async function deleteLesson(id, db) {
  await db.query('DELETE FROM lessons WHERE id = $1', [id]);
}

/** Ids of the children that currently belong to the parent (used to validate a reorder request). */
export async function childIds(table, parentColumn, parentId, db) {
  const { rows } = await db.query(`SELECT id FROM ${table} WHERE ${parentColumn} = $1`, [parentId]);
  return rows.map((r) => r.id);
}

export async function applyOrder(table, ids, db) {
  await db.query(
    `UPDATE ${table} AS t SET position = o.ord
       FROM unnest($1::bigint[]) WITH ORDINALITY AS o(id, ord)
      WHERE t.id = o.id`,
    [ids],
  );
}
