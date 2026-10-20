import { created, send } from '../../../utils/http.js';
import * as service from './teaching.service.js';

export async function assignToCourse(req, res) {
  created(res, await service.assign('course', req.valid.params.courseId, req.valid.body.professorId, req.user));
}

export async function unassignFromCourse(req, res) {
  await service.unassign('course', req.valid.params.courseId, req.valid.params.professorId, req.user);
  send(res, { deleted: true });
}

export async function assignToModule(req, res) {
  created(res, await service.assign('module', req.valid.params.moduleId, req.valid.body.professorId, req.user));
}

export async function unassignFromModule(req, res) {
  await service.unassign('module', req.valid.params.moduleId, req.valid.params.professorId, req.user);
  send(res, { deleted: true });
}
