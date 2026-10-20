import { pool } from '../config/db.js';
import { professorCoursePredicate, studentCoursePredicate } from '../repositories/scope.js';
import { notFound } from '../utils/AppError.js';
import { MEDIA_TOKEN_TTL_SECONDS, signMediaToken } from './token.service.js';

const VIDEO_SQL = `
  SELECT v.*, f.storage_key, f.mime_type, f.original_name, f.size_bytes,
         c.title AS course_title, c.is_active AS course_active, m.title AS module_title, l.title AS lesson_title
    FROM videos v
    JOIN files f ON f.id = v.file_id
    JOIN courses c ON c.id = v.course_id
    LEFT JOIN modules m ON m.id = v.module_id
    LEFT JOIN lessons l ON l.id = v.lesson_id
   WHERE v.id = $1`;

/**
 * Load a video only if `user` may watch it: admins always; professors for courses in their scope (including through
 * a batch); students only when published, they are enrolled in the (active) course and it is available to their batch.
 * Out-of-scope videos look exactly like missing ones (404), so ids cannot be probed.
 */
export async function getAccessibleVideo(user, videoId) {
  const { rows } = await pool.query(VIDEO_SQL, [videoId]);
  const video = rows[0];
  if (!video) throw notFound('Video');
  if (user.role === 'admin') return video;

  let predicate = null;
  let params = [video.course_id, user.id];
  if (user.role === 'professor') predicate = professorCoursePredicate('$1', '$2');
  if (user.role === 'student' && video.is_published) {
    predicate = `${studentCoursePredicate('$1', '$2')} AND video_available_to($3::bigint, $4::bigint, $2)`;
    params = [...params, video.id, video.module_id];
  }
  if (!predicate) throw notFound('Video');

  const { rows: allowed } = await pool.query(`SELECT ${predicate} AS ok`, params);
  if (!allowed[0].ok) throw notFound('Video');
  return video;
}

/** A short-lived signed URL for <video src>, issued only after getAccessibleVideo succeeded. */
export function videoStreamUrl(user, videoId) {
  const token = signMediaToken(user, videoId);
  return {
    url: `/api/media/videos/${videoId}/stream?token=${encodeURIComponent(token)}`,
    expires_at: new Date(Date.now() + MEDIA_TOKEN_TTL_SECONDS * 1000).toISOString(),
  };
}
