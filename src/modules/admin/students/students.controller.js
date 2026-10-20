import { created, send, sendPage } from '../../../utils/http.js';
import * as service from './students.service.js';

export async function list(req, res) {
  sendPage(res, await service.listStudents(req.valid.query), req.valid.query);
}

export async function get(req, res) {
  send(res, await service.getStudent(req.valid.params.userId));
}

export async function create(req, res) {
  created(res, await service.createStudent(req.valid.body, req.user));
}

export async function setReferral(req, res) {
  send(res, await service.setReferral(req.valid.params.userId, req.valid.body.agentId, req.user));
}

export async function setBatch(req, res) {
  send(res, await service.setBatch(req.valid.params.userId, req.valid.body.batchId, req.user));
}
