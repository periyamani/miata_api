import { created, send, sendPage } from '../../../utils/http.js';
import * as service from './professors.service.js';

export async function list(req, res) {
  sendPage(res, await service.listProfessors(req.valid.query), req.valid.query);
}

export async function get(req, res) {
  send(res, await service.getProfessor(req.valid.params.userId));
}

export async function create(req, res) {
  created(res, await service.createProfessor(req.valid.body, req.user));
}
