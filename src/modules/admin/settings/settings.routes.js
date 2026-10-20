import { Router } from 'express';
import { validate } from '../../../middleware/validate.js';
import { completionPolicySchema, feeSettingsSchema } from '../../../services/settings.service.js';
import * as ctrl from './settings.controller.js';

const router = Router();

router.get('/settings', ctrl.get);
router.put('/settings/completion-policy', validate({ body: completionPolicySchema }), ctrl.updateCompletionPolicy);
router.put('/settings/fees', validate({ body: feeSettingsSchema }), ctrl.updateFeeSettings);

export default router;
