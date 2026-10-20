import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../../middleware/authenticate.js';
import { validate } from '../../middleware/validate.js';
import { boolish, idParam } from '../../validators/common.js';
import * as ctrl from './notifications.controller.js';

const listSchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(15),
  unreadOnly: boolish.default(false),
});

const router = Router();
router.use(authenticate);

router.get('/', validate({ query: listSchema }), ctrl.list);
router.patch('/:id/read', validate({ params: idParam }), ctrl.markRead);
router.post('/read-all', ctrl.markAllRead);

export default router;
