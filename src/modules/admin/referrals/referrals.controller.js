import { sendCsv } from '../../../utils/csv.js';
import { send, sendPage } from '../../../utils/http.js';
import * as service from './referrals.service.js';

export async function list(req, res) {
  sendPage(res, await service.listReferrals(req.valid.query), req.valid.query);
}

export async function report(_req, res) {
  send(res, await service.referralReport());
}

export async function exportCsv(req, res) {
  const date = new Date().toISOString().slice(0, 10);
  sendCsv(res, `miata-referrals-${date}.csv`, await service.referralCsv(req.valid.query));
}
