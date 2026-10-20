import { pool } from '../config/db.js';

// Batch lookups shared by the student portal, profiles, video management and the admin batch module.

// Material that can be restricted to batches; the name selects the <kind>_batches table (never user input).
const KINDS = new Set(['module', 'video']);
const kindTable = (kind) => {
  if (!KINDS.has(kind)) throw new Error(`Unknown availability kind "${kind}"`);
  return `${kind}_batches`;
};

/** The student's batch with its courses and active professors, or null when the student is not in a batch. */
export async function studentBatch(studentId, db = pool) {
  const { rows } = await db.query(
    `SELECT b.id, b.code, b.name, b.description, b.start_date, b.end_date, b.is_active, bs.added_at,
            COALESCE((SELECT json_agg(json_build_object('id', c.id, 'title', c.title, 'code', c.code) ORDER BY c.title)
                        FROM batch_courses bc JOIN courses c ON c.id = bc.course_id WHERE bc.batch_id = b.id), '[]') AS courses,
            COALESCE((SELECT json_agg(json_build_object('id', u.id, 'full_name', u.full_name) ORDER BY u.full_name)
                        FROM batch_professors bp JOIN users u ON u.id = bp.professor_id
                       WHERE bp.batch_id = b.id AND u.is_active), '[]') AS professors
       FROM batch_students bs JOIN batches b ON b.id = bs.batch_id
      WHERE bs.student_id = $1`,
    [studentId],
  );
  return rows[0] || null;
}

/**
 * The batches a module or video is restricted to, as a JSON column ([] = available to every batch).
 * `kind` is 'module' or 'video'; `idExpr` the SQL expression of its id.
 */
export const availabilityColumn = (kind, idExpr) => `COALESCE((
  SELECT json_agg(json_build_object('id', ab.id, 'code', ab.code, 'name', ab.name) ORDER BY ab.name)
    FROM ${kindTable(kind)} x JOIN batches ab ON ab.id = x.batch_id WHERE x.${kind}_id = ${idExpr}), '[]')`;

/** Selected batches that do not take the course (restricting material to them would be meaningless). */
export async function batchesOutsideCourse(courseId, batchIds, db = pool) {
  if (!batchIds.length) return [];
  const { rows } = await db.query(
    `SELECT b.id, b.name FROM batches b
      WHERE b.id = ANY($2::bigint[])
        AND NOT EXISTS (SELECT 1 FROM batch_courses bc WHERE bc.batch_id = b.id AND bc.course_id = $1)`,
    [courseId, batchIds],
  );
  const known = await db.query('SELECT count(*)::int AS n FROM batches WHERE id = ANY($1::bigint[])', [batchIds]);
  if (known.rows[0].n !== new Set(batchIds).size) return [{ id: null, name: 'an unknown batch' }, ...rows];
  return rows;
}

/** Replace the batches a module or video is restricted to (an empty list makes it available to every batch). */
export async function replaceAvailability(kind, id, batchIds, db) {
  await db.query(`DELETE FROM ${kindTable(kind)} WHERE ${kind}_id = $1`, [id]);
  if (batchIds.length) {
    await db.query(`INSERT INTO ${kindTable(kind)} (${kind}_id, batch_id) SELECT $1, unnest($2::bigint[]) ON CONFLICT DO NOTHING`, [
      id,
      batchIds,
    ]);
  }
}

/** Batched enrolments (the student's batch takes the course) of the given batches, with the raw progress counts. */
export async function batchEnrolments(batchIds, db = pool) {
  if (!batchIds.length) return [];
  const { rows } = await db.query(
    `SELECT bs.batch_id, e.id AS enrolment_id, e.student_id, e.course_id, e.status,
            ep.videos_total, ep.videos_done, ep.assignments_total, ep.assignments_done
       FROM batch_students bs
       JOIN batch_courses bc ON bc.batch_id = bs.batch_id
       JOIN course_enrolments e ON e.student_id = bs.student_id AND e.course_id = bc.course_id
       JOIN enrolment_progress ep ON ep.enrolment_id = e.id
      WHERE bs.batch_id = ANY($1::bigint[])`,
    [batchIds],
  );
  return rows;
}
