import { created, send, sendPage } from '../../../utils/http.js';
import * as service from './batches.service.js';

export async function list(req, res) {
  sendPage(res, await service.listBatches(req.valid.query), req.valid.query);
}

export async function get(req, res) {
  send(res, await service.getBatch(req.valid.params.batchId));
}

export async function create(req, res) {
  created(res, await service.createBatch(req.valid.body, req.user));
}

export async function update(req, res) {
  send(res, await service.updateBatch(req.valid.params.batchId, req.valid.body, req.user));
}

export async function setStatus(req, res) {
  send(res, await service.setBatchStatus(req.valid.params.batchId, req.valid.body.isActive, req.user));
}

export async function remove(req, res) {
  await service.deleteBatch(req.valid.params.batchId, req.user);
  send(res, { deleted: true });
}

export async function students(req, res) {
  sendPage(res, await service.listBatchStudents(req.valid.params.batchId, req.valid.query), req.valid.query);
}

export async function addStudents(req, res) {
  send(res, await service.addStudents(req.valid.params.batchId, req.valid.body.studentIds, req.user));
}

export async function removeStudent(req, res) {
  await service.removeStudent(req.valid.params.batchId, req.valid.params.studentId, req.user);
  send(res, { removed: true });
}

export async function addCourse(req, res) {
  created(res, await service.addCourse(req.valid.params.batchId, req.valid.body.courseId, req.user));
}

export async function removeCourse(req, res) {
  await service.removeCourse(req.valid.params.batchId, req.valid.params.courseId, req.user);
  send(res, { removed: true });
}

export async function assignProfessor(req, res) {
  created(res, await service.assignProfessor(req.valid.params.batchId, req.valid.body.professorId, req.user));
}

export async function unassignProfessor(req, res) {
  await service.unassignProfessor(req.valid.params.batchId, req.valid.params.professorId, req.user);
  send(res, { removed: true });
}

export async function materials(req, res) {
  send(res, await service.materials(req.valid.params.batchId));
}

export async function moduleAvailability(req, res) {
  send(res, await service.setAvailability('module', req.valid.params.moduleId, req.valid.body.batchIds, req.user));
}

export async function videoAvailability(req, res) {
  send(res, await service.setAvailability('video', req.valid.params.videoId, req.valid.body.batchIds, req.user));
}
