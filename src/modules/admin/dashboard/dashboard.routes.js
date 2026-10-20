import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../../../middleware/validate.js';
import * as ctrl from './dashboard.controller.js';

const router = Router();

router.get('/dashboard', validate({ query: z.object({ months: z.coerce.number().int().min(3).max(24).default(6) }) }), ctrl.overview);

export default router;
