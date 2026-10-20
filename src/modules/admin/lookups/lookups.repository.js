import { pool } from '../../../config/db.js';
import { escapeLike } from '../../../utils/sql.js';

// Small id/name lists for form selects, plus the header's global search.

export async function courses() {
  const { rows } = await pool.query('SELECT id, title, code, is_active FROM courses ORDER BY is_active DESC, title');
  return rows;
}

/** Batches for selects, with the courses each takes (so forms can offer only the batches of a course). */
export async function batches() {
  const { rows } = await pool.query(
    `SELECT b.id, b.name, b.code, b.is_active,
            COALESCE((SELECT json_agg(bc.course_id ORDER BY bc.course_id) FROM batch_courses bc WHERE bc.batch_id = b.id), '[]') AS course_ids
       FROM batches b ORDER BY b.is_active DESC, b.name`,
  );
  return rows;
}

export async function curriculum(courseId) {
  const { rows } = await pool.query(
    `SELECT m.id, m.title, m.position,
            COALESCE((SELECT json_agg(json_build_object('id', l.id, 'title', l.title) ORDER BY l.position, l.id)
                        FROM lessons l WHERE l.module_id = m.id), '[]') AS lessons
       FROM modules m WHERE m.course_id = $1 ORDER BY m.position, m.id`,
    [courseId],
  );
  return rows;
}

export async function usersByRole(role, search, limit) {
  const { rows } = await pool.query(
    `SELECT u.id, u.full_name, u.email, u.is_active,
            COALESCE(sp.student_code, pp.employee_code, ap.referral_code) AS code, sb.name AS batch_name
       FROM users u
       LEFT JOIN student_profiles sp ON sp.user_id = u.id
       LEFT JOIN professor_profiles pp ON pp.user_id = u.id
       LEFT JOIN agent_profiles ap ON ap.user_id = u.id
       LEFT JOIN batch_students sbs ON sbs.student_id = u.id
       LEFT JOIN batches sb ON sb.id = sbs.batch_id
      WHERE u.role = $1
        AND ($2::text IS NULL OR u.full_name ILIKE $2 OR u.email ILIKE $2
             OR COALESCE(sp.student_code, pp.employee_code, ap.referral_code) ILIKE $2)
      ORDER BY u.is_active DESC, u.full_name LIMIT $3`,
    [role, search ? `%${escapeLike(search)}%` : null, limit],
  );
  return rows;
}

export async function globalSearch(term) {
  const pattern = `%${escapeLike(term)}%`;
  const [people, courseRows, batchRows] = await Promise.all([
    pool.query(
      `SELECT * FROM (
         SELECT u.id, u.full_name AS title, u.email AS subtitle, u.role,
                row_number() OVER (PARTITION BY u.role ORDER BY u.full_name) AS rn
           FROM users u
           LEFT JOIN student_profiles sp ON sp.user_id = u.id
          WHERE u.role IN ('student', 'professor', 'agent')
            AND (u.full_name ILIKE $1 OR u.email ILIKE $1 OR sp.student_code ILIKE $1)
       ) t WHERE rn <= 5`,
      [pattern],
    ),
    pool.query('SELECT id, title, code AS subtitle FROM courses WHERE title ILIKE $1 OR code ILIKE $1 ORDER BY title LIMIT 5', [pattern]),
    pool.query('SELECT id, name AS title, code AS subtitle FROM batches WHERE name ILIKE $1 OR code ILIKE $1 ORDER BY name LIMIT 5', [
      pattern,
    ]),
  ]);
  const byRole = (role) => people.rows.filter((r) => r.role === role).map(({ rn: _rn, ...r }) => r);
  return {
    students: byRole('student'),
    professors: byRole('professor'),
    agents: byRole('agent'),
    courses: courseRows.rows,
    batches: batchRows.rows,
  };
}
