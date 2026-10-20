import { pool } from '../../config/db.js';
import { limitOffset, orderBy, paged, SqlBuilder } from '../../utils/sql.js';

const SORTS = { created_at: 'e.created_at', status: 'e.status', name: 'e.name', follow_up_on: 'e.follow_up_on' };

export async function insertEnquiry(data, { source, createdBy = null, ip = null, emailStatus = 'pending' }, db = pool) {
  const { rows } = await db.query(
    `INSERT INTO enquiries (name, email, phone, subject, message, course_interest, source, created_by, ip_address, email_status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
    [data.name, data.email, data.phone, data.subject, data.message, data.courseInterest, source, createdBy, ip, emailStatus],
  );
  return rows[0];
}

export async function setEmailOutcome(id, { status, error = null }) {
  await pool.query('UPDATE enquiries SET email_status = $2, email_error = $3 WHERE id = $1', [id, status, error]);
}

export async function listEnquiries({ page, pageSize, search, sort, order, status, source, from, to }) {
  const q = new SqlBuilder();
  q.search(search, ['e.name', 'e.email', 'e.phone', 'e.subject', 'e.course_interest']);
  if (status) q.where(`e.status = ${q.param(status)}`);
  if (source) q.where(`e.source = ${q.param(source)}`);
  if (from) q.where(`e.created_at >= ${q.param(from)}::date`);
  if (to) q.where(`e.created_at < ${q.param(to)}::date + 1`);
  return paged(
    pool,
    `SELECT e.id, e.name, e.email, e.phone, e.subject, e.course_interest, e.source, e.status, e.follow_up_on,
            e.email_status, e.created_at, e.updated_at, left(e.message, 160) AS message_preview,
            (SELECT count(*) FROM enquiry_notes n WHERE n.enquiry_id = e.id) AS note_count,
            count(*) OVER () AS total_count
       FROM enquiries e ${q.whereClause()}
       ${orderBy(sort, order, SORTS, 'created_at')}
       ${limitOffset(q, { page, pageSize })}`,
    q.params,
  );
}

export async function statusCounts() {
  const { rows } = await pool.query(
    `SELECT s.status, count(e.id) AS count
       FROM unnest(ARRAY['new', 'contacted', 'follow_up', 'converted', 'closed']) AS s(status)
       LEFT JOIN enquiries e ON e.status = s.status
      GROUP BY s.status`,
  );
  return Object.fromEntries(rows.map((r) => [r.status, r.count]));
}

export async function findEnquiry(id, db = pool) {
  const { rows } = await db.query('SELECT * FROM enquiries WHERE id = $1', [id]);
  return rows[0] || null;
}

export async function enquiryNotes(id) {
  const { rows } = await pool.query(
    `SELECT n.id, n.note, n.created_at, u.full_name AS author_name
       FROM enquiry_notes n LEFT JOIN users u ON u.id = n.author_id
      WHERE n.enquiry_id = $1 ORDER BY n.created_at DESC`,
    [id],
  );
  return rows;
}

export async function updateEnquiry(id, { status, followUpOn }, db) {
  const { rows } = await db.query(
    `UPDATE enquiries SET status = COALESCE($2, status),
            follow_up_on = CASE WHEN $4::boolean THEN $3::date ELSE follow_up_on END
      WHERE id = $1 RETURNING *`,
    [id, status ?? null, followUpOn ?? null, followUpOn !== undefined],
  );
  return rows[0] || null;
}

export async function insertNote(enquiryId, authorId, note, db = pool) {
  const { rows } = await db.query('INSERT INTO enquiry_notes (enquiry_id, author_id, note) VALUES ($1, $2, $3) RETURNING *', [
    enquiryId,
    authorId,
    note,
  ]);
  return rows[0];
}
