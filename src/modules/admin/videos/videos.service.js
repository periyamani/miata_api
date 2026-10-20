import { withTransaction } from '../../../config/db.js';
import { AppError, conflict, notFound } from '../../../utils/AppError.js';
import { logActivity } from '../../../services/activity.service.js';
import { notifyUsers } from '../../../services/notification.service.js';
import { deleteStoredFile, recordUpload } from '../../../services/storage.service.js';
import { videoStreamUrl } from '../../../services/videoAccess.service.js';
import { replaceAvailability } from '../../../repositories/batches.repository.js';
import { readMp4Duration } from '../../../utils/mp4.js';
import { assertAvailabilityBatches } from '../batches/batches.service.js';
import * as repo from './videos.repository.js';

const invalid = (field, message) => new AppError(422, 'VALIDATION_ERROR', message, { [field]: message });

/** Course → module → lesson must be consistent. A lesson implies its module. */
async function resolvePlacement(data, db) {
  const { rowCount } = await db.query('SELECT 1 FROM courses WHERE id = $1', [data.courseId]);
  if (!rowCount) throw invalid('courseId', 'Select a valid course');
  let { moduleId } = data;
  if (data.lessonId) {
    const { rows } = await db.query('SELECT l.module_id, m.course_id FROM lessons l JOIN modules m ON m.id = l.module_id WHERE l.id = $1', [
      data.lessonId,
    ]);
    if (rows[0]?.course_id !== data.courseId) throw invalid('lessonId', 'The lesson does not belong to the selected course');
    if (moduleId && moduleId !== rows[0].module_id) throw invalid('lessonId', 'The lesson does not belong to the selected module');
    moduleId = rows[0].module_id;
  }
  if (moduleId) {
    const { rows } = await db.query('SELECT course_id FROM modules WHERE id = $1', [moduleId]);
    if (rows[0]?.course_id !== data.courseId) throw invalid('moduleId', 'The module does not belong to the selected course');
  }
  return { ...data, moduleId };
}

/** Restrict the video to some batches (validated against its course); an empty list makes it available to every batch. */
async function saveAvailability(videoId, courseId, batchIds, db) {
  await replaceAvailability('video', videoId, await assertAvailabilityBatches(courseId, batchIds, db), db);
}

/** Tell the actively enrolled students who can watch it (batch availability applies). */
async function notifyPublished(video, db) {
  const { rows } = await db.query(
    `SELECT e.student_id FROM course_enrolments e
      WHERE e.course_id = $1 AND e.status = 'active' AND video_available_to($2, $3, e.student_id)`,
    [video.course_id, video.id, video.module_id],
  );
  await notifyUsers(
    rows.map((r) => r.student_id),
    { type: 'video_published', title: `New video: ${video.title}`, link: `/student/videos/${video.id}` },
    db,
  );
}

function withoutStorageKey(video) {
  const { storage_key: _key, ...rest } = video;
  return rest;
}

export const listVideos = (query) => repo.listVideos(query);

export async function getVideo(id) {
  const video = await repo.findVideo(id);
  if (!video) throw notFound('Video');
  return withoutStorageKey(video);
}

export async function uploadVideo(data, file, actor) {
  // Completion depends on duration, so prefer the duration stored in the file over the browser-reported value.
  const measured = file.canonicalMime === 'video/mp4' ? await readMp4Duration(file.path) : null;
  const durationSeconds = measured ? Math.max(1, Math.round(measured)) : data.durationSeconds;
  const video = await withTransaction(async (db) => {
    const placed = await resolvePlacement({ ...data, durationSeconds }, db);
    const stored = await recordUpload(file, 'video', actor.id, db);
    const created = await repo.insertVideo(placed, stored.id, actor.id, db);
    await saveAvailability(created.id, created.course_id, data.batchIds ?? [], db);
    if (created.is_published) await notifyPublished(created, db);
    await logActivity(
      {
        actorId: actor.id,
        action: 'video.uploaded',
        entityType: 'video',
        entityId: created.id,
        description: `Video "${created.title}" uploaded`,
        metadata: { courseId: created.course_id, sizeBytes: stored.size_bytes },
      },
      db,
    );
    return created;
  });
  return getVideo(video.id);
}

export async function updateVideo(id, data, actor) {
  await withTransaction(async (db) => {
    const existing = await repo.findVideo(id, db);
    if (!existing) throw notFound('Video');
    if (existing.course_id !== data.courseId && (await repo.hasProgress(id, db))) {
      throw conflict('Students have already watched this video, so it cannot be moved to another course');
    }
    const placed = await resolvePlacement(data, db);
    const updated = await repo.updateVideo(id, placed, db);
    // Kept as is when not sent; re-checked either way, since the course may have changed.
    await saveAvailability(id, updated.course_id, data.batchIds ?? existing.batches.map((b) => b.id), db);
    if (updated.is_published && !existing.is_published) await notifyPublished(updated, db);
    await logActivity(
      { actorId: actor.id, action: 'video.updated', entityType: 'video', entityId: id, description: `Video "${updated.title}" updated` },
      db,
    );
  });
  return getVideo(id);
}

export async function setPublished(id, isPublished, actor) {
  await withTransaction(async (db) => {
    const existing = await repo.findVideo(id, db);
    if (!existing) throw notFound('Video');
    const updated = await repo.setPublished(id, isPublished, db);
    if (isPublished && !existing.is_published) await notifyPublished(updated, db);
    await logActivity(
      {
        actorId: actor.id,
        action: isPublished ? 'video.published' : 'video.unpublished',
        entityType: 'video',
        entityId: id,
        description: `Video "${updated.title}" ${isPublished ? 'published' : 'unpublished'}`,
      },
      db,
    );
  });
  return getVideo(id);
}

export async function deleteVideo(id, actor) {
  const storageKey = await withTransaction(async (db) => {
    const video = await repo.findVideo(id, db);
    if (!video) throw notFound('Video');
    const key = await repo.deleteVideo(video, db);
    await logActivity(
      {
        actorId: actor.id,
        action: 'video.deleted',
        entityType: 'video',
        entityId: id,
        description: `Video "${video.title}" deleted`,
        metadata: { courseId: video.course_id },
      },
      db,
    );
    return key;
  });
  await deleteStoredFile(storageKey);
}

export async function previewUrl(id, user) {
  await getVideo(id);
  return videoStreamUrl(user, id);
}
