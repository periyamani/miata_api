import { created, send } from '../../../utils/http.js';
import * as service from './enrolments.service.js';

export async function enrolInCourse(req, res) {
  created(res, await service.enrol({ courseIds: [req.valid.params.courseId], studentIds: req.valid.body.studentIds }, req.user));
}

export async function enrolStudent(req, res) {
  created(res, await service.enrol({ courseIds: req.valid.body.courseIds, studentIds: [req.valid.params.studentId] }, req.user));
}

export async function updateStatus(req, res) {
  send(res, await service.updateStatus(req.valid.params.enrolmentId, req.valid.body.status, req.user));
}

export async function remove(req, res) {
  await service.remove(req.valid.params.enrolmentId, req.user);
  send(res, { deleted: true });
}

export async function updateSchedule(req, res) {
  send(res, await service.updateSchedule(req.valid.params.enrolmentId, req.valid.body, req.user));
}

export async function updateFee(req, res) {
  send(res, await service.updateFee(req.valid.params.enrolmentId, req.valid.body, req.user));
}
