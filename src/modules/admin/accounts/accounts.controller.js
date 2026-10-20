import { send } from '../../../utils/http.js';
import * as service from './accounts.service.js';

/** Handlers shared by the student, professor and agent account routes. */
export const accountController = (role) => ({
  async update(req, res) {
    send(res, await service.updateManagedAccount(role, req.valid.params.userId, req.valid.body, req.user));
  },
  async setStatus(req, res) {
    send(res, await service.setAccountStatus(role, req.valid.params.userId, req.valid.body.isActive, req.user));
  },
  async setTemporaryPassword(req, res) {
    send(res, await service.setTemporaryPassword(role, req.valid.params.userId, req.valid.body.temporaryPassword, req.user));
  },
  async sendSetupEmail(req, res) {
    send(res, await service.sendAccountSetupEmail(role, req.valid.params.userId, req.user));
  },
});
