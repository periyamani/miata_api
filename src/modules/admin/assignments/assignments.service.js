import { notFound } from '../../../utils/AppError.js';
import * as submissions from '../../../repositories/submissions.repository.js';
import * as repo from './assignments.repository.js';

// Admins monitor assignments and submissions read-only. Professors create, edit, publish and review them
// (modules/professor), within the courses and modules they teach.

export const listAssignments = (query) => repo.listAssignments(query);

export async function getAssignment(id) {
  const assignment = await repo.findAssignment(id);
  if (!assignment) throw notFound('Assignment');
  return assignment;
}

export async function getAttachment(assignmentId) {
  const file = await repo.attachmentFile(assignmentId);
  if (!file) throw notFound('Attachment');
  return file;
}

// ─── Submissions ────────────────────────────────────────────────────────

export const listSubmissions = (query) => submissions.listSubmissions(query);

export async function getSubmission(id) {
  const submission = await submissions.findSubmission(id);
  if (!submission) throw notFound('Submission');
  return submissions.submissionThread(submission);
}

export async function getSubmissionFile(id) {
  const file = await submissions.fileForSubmission(id);
  if (!file) throw notFound('Submission');
  return file;
}
