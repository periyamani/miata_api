import { pool } from '../../../config/db.js';

export async function stats() {
  const { rows } = await pool.query(`
    SELECT
      (SELECT count(*) FROM users WHERE role = 'student') AS total_students,
      (SELECT count(*) FROM users WHERE role = 'student' AND created_at >= date_trunc('month', now())) AS new_students_this_month,
      (SELECT count(*) FROM users WHERE role = 'professor') AS total_professors,
      (SELECT count(*) FROM users WHERE role = 'agent') AS total_agents,
      (SELECT count(*) FROM courses) AS total_courses,
      (SELECT count(*) FROM courses WHERE is_active) AS active_courses,
      (SELECT count(*) FROM batches) AS total_batches,
      (SELECT count(*) FROM batches WHERE is_active) AS active_batches,
      (SELECT count(*) FROM assignment_submissions WHERE status IN ('submitted', 'in_review')) AS pending_assignments,
      (SELECT count(*) FROM enquiries WHERE status = 'new') AS new_enquiries,
      (SELECT count(*) FROM fee_payments WHERE status = 'pending') AS pending_payments`);
  return rows[0];
}

/** Activity per calendar month for the last `months` months (zero-filled). */
export async function monthlyOverview(months = 6) {
  const { rows } = await pool.query(
    `WITH series AS (
       SELECT generate_series(date_trunc('month', now()) - make_interval(months => $1 - 1),
                              date_trunc('month', now()), interval '1 month') AS month
     )
     SELECT to_char(s.month, 'YYYY-MM') AS month,
            (SELECT count(*) FROM course_enrolments e WHERE date_trunc('month', e.enrolled_at) = s.month) AS enrolments,
            (SELECT count(*) FROM users u WHERE u.role = 'student' AND date_trunc('month', u.created_at) = s.month) AS registrations,
            (SELECT count(*) FROM enquiries q WHERE date_trunc('month', q.created_at) = s.month) AS enquiries,
            (SELECT count(*) FROM course_enrolments e WHERE date_trunc('month', e.completed_at) = s.month) AS completions
       FROM series s ORDER BY s.month`,
    [months],
  );
  return rows;
}

export async function completionBreakdown() {
  const { rows } = await pool.query(`
    SELECT count(*) FILTER (WHERE e.status = 'completed') AS completed,
           count(*) FILTER (WHERE e.status = 'active' AND ep.videos_done + ep.assignments_done > 0) AS in_progress,
           count(*) FILTER (WHERE e.status = 'active' AND ep.videos_done + ep.assignments_done = 0) AS not_started,
           count(*) FILTER (WHERE e.status = 'suspended') AS suspended
      FROM course_enrolments e JOIN enrolment_progress ep ON ep.enrolment_id = e.id`);
  return rows[0];
}

export async function coursesOverview(limit = 8) {
  const { rows } = await pool.query(
    `SELECT c.id, c.title, c.code, c.is_active,
            count(e.id) AS students,
            count(e.id) FILTER (WHERE e.status = 'completed') AS completed,
            (SELECT count(*) FROM professor_course_assignments p WHERE p.course_id = c.id) AS professors,
            (SELECT count(*) FROM modules m WHERE m.course_id = c.id) AS modules
       FROM courses c LEFT JOIN course_enrolments e ON e.course_id = c.id
      GROUP BY c.id ORDER BY students DESC, c.title LIMIT $1`,
    [limit],
  );
  return rows;
}

export async function recentEnquiries(limit = 5) {
  const { rows } = await pool.query(
    `SELECT id, name, email, subject, course_interest, status, created_at FROM enquiries ORDER BY created_at DESC LIMIT $1`,
    [limit],
  );
  return rows;
}

export async function recentActivity(limit = 8) {
  const { rows } = await pool.query(
    `SELECT a.id, a.action, a.description, a.entity_type, a.entity_id, a.created_at, u.full_name AS actor_name, u.role AS actor_role
       FROM activity_logs a LEFT JOIN users u ON u.id = a.actor_id
      WHERE a.action NOT LIKE 'auth.%'
      ORDER BY a.created_at DESC LIMIT $1`,
    [limit],
  );
  return rows;
}
