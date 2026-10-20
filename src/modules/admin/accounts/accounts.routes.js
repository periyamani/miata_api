import { Router } from 'express';
import { validate } from '../../../middleware/validate.js';
import { accountController } from './accounts.controller.js';
import * as s from './accounts.schemas.js';

/**
 * Update / status / temporary-password routes, identical for students, professors and agents.
 * Mounted as router.use('/students', accountRoutes('student')). Create, list and detail routes live
 * in each role module because they differ per role.
 */
export function accountRoutes(role) {
  const ctrl = accountController(role);
  const router = Router();
  router.put('/:userId', validate({ params: s.userIdParams, body: s.updateSchemas[role] }), ctrl.update);
  router.patch('/:userId/status', validate({ params: s.userIdParams, body: s.statusSchema }), ctrl.setStatus);
  router.post(
    '/:userId/temporary-password',
    validate({ params: s.userIdParams, body: s.temporaryPasswordSchema }),
    ctrl.setTemporaryPassword,
  );
  router.post('/:userId/setup-email', validate({ params: s.userIdParams }), ctrl.sendSetupEmail);
  return router;
}
