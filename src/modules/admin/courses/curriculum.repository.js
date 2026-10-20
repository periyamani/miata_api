import { pool } from '../../../config/db.js';

export async function findModule(id, db = pool) {
  const { rows } = await db.query(
    'SELECT m.*, c.title AS course_title FROM modules m JOIN courses c ON c.id = m.course_id WHERE m.id = $1',
    [id],
  );
  return rows[0] || null;
}

export async function findLesson(id, db = pool) {
  const { rows } = await db.query('SELECT l.*, m.course_id FROM lessons l JOIN modules m ON m.id = l.module_id WHERE l.id = $1', [id]);
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

export async function deleteModule(id, db) {
  await db.query('DELETE FROM modules WHERE id = $1', [id]);
}

export async function insertLesson(moduleId, { title, content, durationMinutes }, db) {
  const { rows } = await db.query(
    `INSERT INTO lessons (module_id, title, content, duration_minutes, position)
     VALUES ($1, $2, $3, $4, (SELECT COALESCE(max(position), 0) + 1 FROM lessons WHERE module_id = $1))
     RETURNING *`,
    [moduleId, title, content, durationMinutes],
  );
  return rows[0];
}

export async function updateLesson(id, { title, content, durationMinutes }, db) {
  const { rows } = await db.query('UPDATE lessons SET title = $2, content = $3, duration_minutes = $4 WHERE id = $1 RETURNING *', [
    id,
    title,
    content,
    durationMinutes,
  ]);
  return rows[0] || null;
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
