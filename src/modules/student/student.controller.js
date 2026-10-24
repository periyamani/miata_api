import { created, send } from '../../utils/http.js';
import { sendStoredFile } from '../../services/storage.service.js';
import { studentTimetables } from '../admin/courses/timetable.service.js';
import * as service from './student.service.js';

export async function dashboard(req, res) {
  send(res, await service.dashboard(req.user));
}

export async function courses(req, res) {
  send(res, await service.courses(req.user.id));
}

export async function course(req, res) {
  send(res, await service.courseDetail(req.user.id, req.valid.params.courseId));
}

export async function modules(req, res) {
  send(res, await service.modules(req.user.id, req.valid.query.courseId ?? null));
}

export async function videos(req, res) {
  send(res, await service.videos(req.user.id, req.valid.query));
}

export async function video(req, res) {
  send(res, await service.video(req.user, req.valid.params.videoId));
}

export async function videoProgress(req, res) {
  send(res, await service.recordProgress(req.user, req.valid.params.videoId, req.valid.body.position));
}

export async function assignments(req, res) {
  send(res, await service.assignments(req.user.id, req.valid.query));
}

export async function assignment(req, res) {
  send(res, await service.assignment(req.user.id, req.valid.params.assignmentId));
}

export async function assignmentAttachment(req, res) {
  await sendStoredFile(res, await service.assignmentAttachment(req.user.id, req.valid.params.assignmentId));
}

export async function submit(req, res) {
  created(res, await service.submit(req.user, req.valid.params.assignmentId, req.file, req.valid.body.notes));
}

export async function submissions(req, res) {
  send(res, await service.submissionHistory(req.user.id));
}

export async function submissionFile(req, res) {
  await sendStoredFile(res, await service.submissionFile(req.user.id, req.valid.params.submissionId));
}

export async function comment(req, res) {
  created(res, await service.comment(req.user, req.valid.params.submissionId, req.valid.body.body));
}

export async function progress(req, res) {
  send(res, await service.progress(req.user.id));
}

export async function completion(req, res) {
  send(res, await service.completion(req.user.id));
}

export async function fees(req, res) {
  send(res, await service.fees(req.user.id));
}

export async function submitPayment(req, res) {
  created(res, await service.submitPayment(req.user, req.file, req.valid.body));
}

export async function paymentProof(req, res) {
  await sendStoredFile(res, await service.paymentProofFile(req.user.id, req.valid.params.paymentId), { inline: true });
}

/** Weekly timetables of the student's courses (sessions of the modules available to them). */
export async function timetable(req, res) {
  send(res, await studentTimetables(req.user.id));
}
