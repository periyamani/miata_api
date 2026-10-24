import { created, send, sendPage } from '../../utils/http.js';
import { sendStoredFile } from '../../services/storage.service.js';
import { getAttachment } from '../admin/assignments/assignments.service.js';
import { professorTimetables } from '../admin/courses/timetable.service.js';
import * as service from './professor.service.js';

export async function dashboard(req, res) {
  send(res, await service.dashboard(req.user.id));
}

export async function courses(req, res) {
  send(res, await service.courses(req.user.id));
}

export async function courseModules(req, res) {
  send(res, await service.assignableModules(req.user.id, req.valid.params.courseId, req.valid.query.batchId));
}

export async function modules(req, res) {
  send(res, await service.teachingModules(req.user.id));
}

export async function setModuleStatus(req, res) {
  send(res, await service.setModuleStatus(req.user, req.valid.params.moduleId, req.valid.body.status));
}

export async function batches(req, res) {
  send(res, await service.batches(req.user.id));
}

export async function students(req, res) {
  sendPage(res, await service.listStudents(req.user.id, req.valid.query), req.valid.query);
}

export async function assignments(req, res) {
  sendPage(res, await service.listAssignments(req.user.id, req.valid.query), req.valid.query);
}

export async function assignment(req, res) {
  send(res, await service.getAssignment(req.user.id, req.valid.params.assignmentId));
}

export async function createAssignment(req, res) {
  created(res, await service.createAssignment(req.user, req.valid.body, req.file));
}

export async function updateAssignment(req, res) {
  send(res, await service.updateAssignment(req.user, req.valid.params.assignmentId, req.valid.body, req.file));
}

export async function deleteAssignment(req, res) {
  await service.deleteAssignment(req.user, req.valid.params.assignmentId);
  send(res, { deleted: true });
}

export async function assignmentAttachment(req, res) {
  await service.getAssignment(req.user.id, req.valid.params.assignmentId); // scope check
  await sendStoredFile(res, await getAttachment(req.valid.params.assignmentId));
}

export async function submissions(req, res) {
  sendPage(res, await service.listSubmissions(req.user.id, req.valid.query), req.valid.query);
}

export async function submission(req, res) {
  send(res, await service.getSubmission(req.user.id, req.valid.params.submissionId));
}

export async function submissionFile(req, res) {
  await sendStoredFile(res, await service.getSubmissionFile(req.user.id, req.valid.params.submissionId));
}

export async function startReview(req, res) {
  send(res, await service.startReview(req.user, req.valid.params.submissionId));
}

export async function comment(req, res) {
  send(res, await service.addComment(req.user, req.valid.params.submissionId, req.valid.body.body), { status: 201 });
}

export async function review(req, res) {
  send(res, await service.review(req.user, req.valid.params.submissionId, req.valid.body));
}

/** Weekly timetables of the courses the professor lectures in or teaches. */
export async function timetable(req, res) {
  send(res, await professorTimetables(req.user.id));
}
