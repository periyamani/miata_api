import { pool } from '../../../config/db.js';
import { availabilityColumn } from '../../../repositories/batches.repository.js';
import { limitOffset, orderBy, paged, SqlBuilder } from '../../../utils/sql.js';

const COLUMNS = `v.*, c.title AS course_title, m.title AS module_title, l.title AS lesson_title,
  f.original_name AS file_name, f.size_bytes AS file_size, f.mime_type,
  u.full_name AS uploaded_by_name,
  ${availabilityColumn('video', 'v.id')} AS batches,
  (SELECT count(*) FROM video_progress vp WHERE vp.video_id = v.id AND vp.completed_at IS NOT NULL) AS completed_views`;

const FROM = `FROM videos v
  JOIN courses c ON c.id = v.course_id
  JOIN files f ON f.id = v.file_id
  LEFT JOIN modules m ON m.id = v.module_id
  LEFT JOIN lessons l ON l.id = v.lesson_id
  LEFT JOIN users u ON u.id = v.uploaded_by`;

const SORTS = { title: 'v.title', created_at: 'v.created_at', position: 'v.position' };

/** All videos, or with `batchId` those the batch has: in its courses and not restricted (directly or by module) to other batches. */
export async function listVideos({ page, pageSize, search, sort, order, courseId, moduleId, batchId, published }) {
  const q = new SqlBuilder();
  q.search(search, ['v.title', 'c.title', 'm.title']);
  if (courseId) q.where(`v.course_id = ${q.param(courseId)}`);
  if (moduleId) q.where(`v.module_id = ${q.param(moduleId)}`);
  if (published !== undefined) q.where(`v.is_published = ${q.param(published)}`);
  if (batchId) {
    const b = q.param(batchId);
    q.where(`EXISTS (SELECT 1 FROM batch_courses bc WHERE bc.batch_id = ${b} AND bc.course_id = v.course_id)`);
    q.where(`(NOT EXISTS (SELECT 1 FROM video_batches vb WHERE vb.video_id = v.id)
              OR EXISTS (SELECT 1 FROM video_batches vb WHERE vb.video_id = v.id AND vb.batch_id = ${b}))`);
    q.where(`(v.module_id IS NULL OR NOT EXISTS (SELECT 1 FROM module_batches mb WHERE mb.module_id = v.module_id)
              OR EXISTS (SELECT 1 FROM module_batches mb WHERE mb.module_id = v.module_id AND mb.batch_id = ${b}))`);
  }
  return paged(
    pool,
    `SELECT ${COLUMNS}, count(*) OVER () AS total_count ${FROM} ${q.whereClause()}
     ${orderBy(sort, order, SORTS, 'created_at')} ${limitOffset(q, { page, pageSize })}`,
    q.params,
  );
}

export async function findVideo(id, db = pool) {
  const { rows } = await db.query(`SELECT ${COLUMNS}, f.storage_key ${FROM} WHERE v.id = $1`, [id]);
  return rows[0] || null;
}

export async function insertVideo(data, fileId, userId, db) {
  const { rows } = await db.query(
    `INSERT INTO videos (course_id, module_id, lesson_id, file_id, title, description, duration_seconds, position,
                         is_required, is_published, published_at, uploaded_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, CASE WHEN $10 THEN now() END, $11) RETURNING *`,
    [
      data.courseId,
      data.moduleId,
      data.lessonId,
      fileId,
      data.title,
      data.description,
      data.durationSeconds,
      data.position,
      data.isRequired,
      data.isPublished,
      userId,
    ],
  );
  return rows[0];
}

export async function updateVideo(id, data, db) {
  const { rows } = await db.query(
    `UPDATE videos SET course_id = $2, module_id = $3, lesson_id = $4, title = $5, description = $6,
            duration_seconds = $7, position = $8, is_required = $9, is_published = $10,
            published_at = CASE WHEN $10 AND published_at IS NULL THEN now() WHEN NOT $10 THEN NULL ELSE published_at END
      WHERE id = $1 RETURNING *`,
    [
      id,
      data.courseId,
      data.moduleId,
      data.lessonId,
      data.title,
      data.description,
      data.durationSeconds,
      data.position,
      data.isRequired,
      data.isPublished,
    ],
  );
  return rows[0] || null;
}

export async function setPublished(id, isPublished, db) {
  const { rows } = await db.query(
    `UPDATE videos SET is_published = $2,
            published_at = CASE WHEN $2 AND published_at IS NULL THEN now() WHEN NOT $2 THEN NULL ELSE published_at END
      WHERE id = $1 RETURNING *`,
    [id, isPublished],
  );
  return rows[0] || null;
}

export async function hasProgress(id, db) {
  const { rowCount } = await db.query('SELECT 1 FROM video_progress WHERE video_id = $1 LIMIT 1', [id]);
  return rowCount > 0;
}

/** Deletes the video and its file row; returns the storage key so the bytes can be removed after commit. */
export async function deleteVideo(video, db) {
  await db.query('DELETE FROM videos WHERE id = $1', [video.id]);
  await db.query('DELETE FROM files WHERE id = $1', [video.file_id]);
  return video.storage_key;
}
