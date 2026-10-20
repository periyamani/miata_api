import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../../middleware/validate.js';
import { id } from '../../validators/common.js';
import * as ctrl from './media.controller.js';

const router = Router();

router.get(
  '/videos/:videoId/stream',
  validate({ params: z.object({ videoId: id }), query: z.object({ token: z.string().min(20).max(2000) }) }),
  ctrl.streamVideo,
);

export default router;
