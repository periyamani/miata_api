import { sendCsv } from '../../utils/csv.js';
import { created, send, sendPage } from '../../utils/http.js';
import * as service from './agent.service.js';

export async function dashboard(req, res) {
  send(res, await service.dashboard(req.user.id, req.valid.query.months));
}

export async function students(req, res) {
  sendPage(res, await service.listStudents(req.user.id, req.valid.query), req.valid.query);
}

export async function student(req, res) {
  send(res, await service.getStudent(req.user.id, req.valid.params.studentId));
}

export async function stats(req, res) {
  send(res, await service.stats(req.user.id, req.valid.query.months));
}

export async function exportStudents(req, res) {
  const date = new Date().toISOString().slice(0, 10);
  sendCsv(res, `my-referred-students-${date}.csv`, await service.studentsCsv(req.user.id, req.valid.query));
}

export async function applyOptions(_req, res) {
  send(res, await service.applyOptions());
}

export async function apply(req, res) {
  created(res, await service.applyForStudent(req.user, req.valid.body));
}
