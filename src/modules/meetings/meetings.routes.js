import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../../middleware/validate.js';
import { id, listQuery, optionalText, requiredText } from '../../validators/common.js';
import * as ctrl from './meetings.controller.js';
import { meetingPlatform } from './meetings.service.js';

// Online classes. Each router is mounted inside its role namespace (behind authenticate + authorize):
//   /api/professor — organisers manage their own meetings
//   /api/student   — meetings of the student's batch, or shared with them
//   /api/admin     — read-only monitoring

const meetingParams = z.object({ meetingId: id });
const when = z.enum(['upcoming', 'past', 'cancelled']).optional();

const meetingSchema = z
  .object({
    batchId: id,
    title: requiredText(200, 'Title'),
    description: optionalText(2000),
    meetingUrl: z
      .string({ error: 'Meeting link is required' })
      .trim()
      .min(1, 'Meeting link is required')
      .max(500)
      .refine((v) => meetingPlatform(v), 'Use a Google Meet (https://meet.google.com/…) or Zoom (https://zoom.us/j/…) link'),
    startsAt: z.iso.datetime({ offset: true, error: 'Choose the date and time of the class' }),
    durationMinutes: z.coerce.number().int().min(15, 'At least 15 minutes').max(480, 'At most 8 hours').default(60),
    audience: z.enum(['batch', 'selected']).default('batch'),
    studentIds: z
      .array(id)
      .max(500)
      .default([])
      .transform((ids) => [...new Set(ids)]),
  })
  .refine((v) => v.audience === 'batch' || v.studentIds.length > 0, { message: 'Select at least one student', path: ['studentIds'] });

const sortKeys = ['starts_at', 'title', 'created_at'];

export const professorMeetingRoutes = Router()
  .get('/meetings', validate({ query: listQuery(sortKeys, { when, batchId: id.optional() }) }), ctrl.professorList)
  .post('/meetings', validate({ body: meetingSchema }), ctrl.create)
  .get('/meetings/:meetingId', validate({ params: meetingParams }), ctrl.professorGet)
  .put('/meetings/:meetingId', validate({ params: meetingParams, body: meetingSchema }), ctrl.update)
  .post('/meetings/:meetingId/cancel', validate({ params: meetingParams, body: z.object({ reason: optionalText(500) }) }), ctrl.cancel)
  .post('/meetings/:meetingId/resend', validate({ params: meetingParams }), ctrl.resend)
  .get('/meetings/batches/:batchId/students', validate({ params: z.object({ batchId: id }) }), ctrl.batchStudents);

export const studentMeetingRoutes = Router().get(
  '/meetings',
  validate({ query: z.object({ when: z.enum(['upcoming', 'past']).default('upcoming') }) }),
  ctrl.studentList,
);

export const adminMeetingRoutes = Router()
  .get('/meetings', validate({ query: listQuery(sortKeys, { when, batchId: id.optional(), professorId: id.optional() }) }), ctrl.adminList)
  .get('/meetings/:meetingId', validate({ params: meetingParams }), ctrl.adminGet);
