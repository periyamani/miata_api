import { send } from '../../../utils/http.js';
import * as repo from './lookups.repository.js';

export async function courses(_req, res) {
  send(res, await repo.courses());
}

export async function batches(_req, res) {
  send(res, await repo.batches());
}

export async function curriculum(req, res) {
  send(res, await repo.curriculum(req.valid.params.courseId));
}

export const people = (role) => async (req, res) => {
  send(res, await repo.usersByRole(role, req.valid.query.search, req.valid.query.limit));
};

export async function search(req, res) {
  send(res, await repo.globalSearch(req.valid.query.q));
}
