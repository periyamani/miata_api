import { send } from '../../../utils/http.js';
import { sendStoredFile } from '../../../services/storage.service.js';
import * as service from './payments.service.js';

/** Paginated like every list, with the fee currency in `meta` (it applies to every amount). */
export async function list(req, res) {
  const { rows, total, currency } = await service.listPayments(req.valid.query);
  const { page, pageSize } = req.valid.query;
  send(res, rows, { meta: { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)), currency } });
}

export async function stats(_req, res) {
  send(res, await service.stats());
}

export async function get(req, res) {
  send(res, await service.getPayment(req.valid.params.paymentId));
}

export async function proof(req, res) {
  await sendStoredFile(res, await service.proofFile(req.valid.params.paymentId), { inline: true });
}

export async function setStatus(req, res) {
  send(res, await service.setStatus(req.valid.params.paymentId, req.valid.body, req.user));
}
