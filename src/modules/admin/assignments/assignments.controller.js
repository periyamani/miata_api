import { send, sendPage } from '../../../utils/http.js';
import { forbidden } from '../../../utils/AppError.js';
import { sendStoredFile } from '../../../services/storage.service.js';
import * as service from './assignments.service.js';

export async function list(req, res) {
  sendPage(res, await service.listAssignments(req.valid.query), req.valid.query);
}

export async function get(req, res) {
  send(res, await service.getAssignment(req.valid.params.assignmentId));
}

export async function attachment(req, res) {
  await sendStoredFile(res, await service.getAttachment(req.valid.params.assignmentId));
}

/** Answers the former admin write routes, so an outdated client gets a clear reason instead of a 404. */
export function professorsOnly() {
  throw forbidden('Assignments are created, edited and reviewed by professors. Admin access is read-only.');
}

export async function listSubmissions(req, res) {
  sendPage(res, await service.listSubmissions(req.valid.query), req.valid.query);
}

export async function getSubmission(req, res) {
  send(res, await service.getSubmission(req.valid.params.submissionId));
}

export async function submissionFile(req, res) {
  await sendStoredFile(res, await service.getSubmissionFile(req.valid.params.submissionId));
}
