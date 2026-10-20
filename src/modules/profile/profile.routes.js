import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { validate } from '../../middleware/validate.js';
import { changePassword } from '../auth/auth.controller.js';
import { changePasswordSchema } from './profile.schemas.js';
import * as ctrl from './profile.controller.js';

const router = Router();
router.use(authenticate);

router.get('/', ctrl.getProfile);
router.patch('/', ctrl.updateProfile);
router.post('/password', validate({ body: changePasswordSchema }), changePassword);

export default router;
