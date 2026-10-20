import { z } from 'zod';
import { boolish, id, idList, listQuery, optionalId, optionalText, requiredText } from '../../../validators/common.js';

const placement = {
  courseId: id,
  moduleId: optionalId,
  lessonId: optionalId,
};

const details = {
  title: requiredText(200, 'Title'),
  description: optionalText(5000),
  // Read from the file's metadata in the browser at upload time; editable by the admin.
  durationSeconds: z.coerce
    .number({ error: 'Duration is required' })
    .int()
    .min(1, 'Duration is required')
    .max(24 * 3600),
  position: z.coerce.number().int().min(0).max(10000).default(0),
  isRequired: boolish.default(true),
  isPublished: boolish.default(false),
  // Batches the video is restricted to; empty = every student of the course. Omitted on update = unchanged.
  batchIds: idList(100).optional(),
};

export const uploadVideoSchema = z.object({ ...placement, ...details });
export const updateVideoSchema = z.object({ ...placement, ...details });
export const publishSchema = z.object({ isPublished: z.boolean() });

export const listVideosQuery = listQuery(['title', 'created_at', 'position'], {
  courseId: id.optional(),
  moduleId: id.optional(),
  batchId: id.optional(),
  published: boolish.optional(),
});

export const videoIdParams = z.object({ videoId: id });
