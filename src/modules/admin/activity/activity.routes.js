import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../../../middleware/validate.js';
import { sendPage } from '../../../utils/http.js';
import { id, listQuery } from '../../../validators/common.js';
import { listActivity } from './activity.repository.js';

const listSchema = listQuery(['created_at'], {
  action: z
    .string()
    .trim()
    .regex(/^[a-z_.]{1,60}$/)
    .optional(),
  actorId: id.optional(),
  entityType: z
    .string()
    .trim()
    .regex(/^[a-z_]{1,30}$/)
    .optional(),
  entityId: id.optional(),
});

const router = Router();

// Read-only listing: the handler is a direct repository call, so no separate controller/service.
router.get('/activity', validate({ query: listSchema }), async (req, res) => {
  sendPage(res, await listActivity(req.valid.query), req.valid.query);
});

export default router;
