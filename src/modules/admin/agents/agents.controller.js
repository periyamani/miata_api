import { created, send, sendPage } from '../../../utils/http.js';
import * as service from './agents.service.js';

export async function list(req, res) {
  sendPage(res, await service.listAgents(req.valid.query), req.valid.query);
}

export async function get(req, res) {
  send(res, await service.getAgent(req.valid.params.userId));
}

export async function referrals(req, res) {
  sendPage(res, await service.listAgentReferrals(req.valid.params.userId, req.valid.query), req.valid.query);
}

export async function create(req, res) {
  created(res, await service.createAgent(req.valid.body, req.user));
}

export async function regenerateCode(req, res) {
  send(res, await service.regenerateReferralCode(req.valid.params.userId, req.user));
}
