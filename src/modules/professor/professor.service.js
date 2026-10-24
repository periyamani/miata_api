import { withTransaction } from '../../config/db.js';
import { AppError, conflict, forbidden, notFound } from '../../utils/AppError.js';
import { logActivity } from '../../services/activity.service.js';
import { evaluateCourseCompletion } from '../../services/completion.service.js';
import { notifyUsers } from '../../services/notification.service.js';
import { attachProgress, progressByGroup } from '../../services/progress.service.js';
import { getCompletionPolicy } from '../../services/settings.service.js';
import { deleteStoredFile, recordUpload } from '../../services/storage.service.js';
import * as assignments from '../../repositories/assignments.repository.js';
import { batchEnrolments } from '../../repositories/batches.repository.js';
import { setTeachingStatus } from '../../repositories/moduleStatus.repository.js';
import * as submissions from '../../repositories/submissions.repository.js';
import { upcomingForProfessor } from '../meetings/meetings.service.js';
import * as repo from './professor.repository.js';

const invalid = (field, message) => new AppError(422, 'VALIDATION_ERROR', message, { [field]: message });

export async function dashboard(professorId) {
  const [stats, students, assignmentRows, deadlines, activity, batchRows, meetings] = await Promise.all([
    repo.dashboardStats(professorId),
    repo.listStudents(professorId, { page: 1, pageSize: 5, order: 'desc' }),
    repo.listAssignments(professorId, { page: 1, pageSize: 5, sort: 'created_at', order: 'desc', published: true }),
    repo.upcomingDeadlines(professorId),
    repo.recentActivity(professorId),
    batches(professorId),
    upcomingForProfessor(professorId, 4),
  ]);
  return {
    stats,
    batches: batchRows,
    recentStudents: students.rows,
    recentAssignments: assignmentRows.rows,
    upcomingDeadlines: deadlines,
    recentActivity: activity,
    upcomingMeetings: meetings,
  };
}

export const courses = (professorId) => repo.assignedCourses(professorId);

/** The professor's batches, each with its students' average progress across the batch's courses. */
export async function batches(professorId) {
  const rows = await repo.batches(professorId);
  const [enrolments, policy] = await Promise.all([batchEnrolments(rows.map((b) => b.id)), getCompletionPolicy()]);
  const progress = progressByGroup(enrolments, policy, 'batch_id');
  return rows.map((b) => ({ ...b, progress: progress[b.id] ?? { enrolments: 0, completed: 0, average_percent: 0 } }));
}

export async function listStudents(professorId, query) {
  const [result, policy] = await Promise.all([repo.listStudents(professorId, query), getCompletionPolicy()]);
  return { ...result, rows: attachProgress(result.rows, policy) };
}

export const listAssignments = (professorId, query) => repo.listAssignments(professorId, query);

export async function getAssignment(professorId, assignmentId) {
  const assignment = await repo.findAssignmentInScope(professorId, assignmentId);
  if (!assignment) throw notFound('Assignment');
  return assignment;
}

export async function assignableModules(professorId, courseId, batchId = null) {
  const { teaches_course: teaches } = await repo.placementScope(professorId, courseId, null);
  if (!teaches) throw notFound('Course');
  if (batchId) {
    const batch = await repo.batchPlacement(professorId, batchId, courseId);
    if (!batch?.teaches_batch || !batch.takes_course) throw notFound('Batch');
  }
  return repo.assignableModules(professorId, courseId, batchId);
}

// ─── Module status ──────────────────────────────────────────────────────
// The professors who teach a module (its course's professors, or its own) keep its teaching status up to date.

const MODULE_STATUS_LABELS = { not_started: 'Not Started', in_progress: 'In Progress', completed: 'Completed' };

export const teachingModules = (professorId) => repo.teachingModules(professorId);

export async function setModuleStatus(professor, moduleId, status) {
  await withTransaction(async (db) => {
    const module = await repo.teachingModules(professor.id, { moduleId }, db);
    if (!module) throw notFound('Module');
    if (module.teaching_status === status) return;
    await setTeachingStatus(moduleId, status, professor.id, db);
    await logActivity(
      {
        actorId: professor.id,
        action: `module.${status}`,
        entityType: 'module',
        entityId: moduleId,
        description: `${professor.full_name} marked module "${module.title}" (${module.course_title}) as ${MODULE_STATUS_LABELS[status]}`,
        metadata: { courseId: module.course_id, from: module.teaching_status, to: status },
      },
      db,
    );
  });
  return repo.teachingModules(professor.id, { moduleId });
}

// ─── Assignment authoring ───────────────────────────────────────────────
// Professors create, edit, publish ("assign") and delete assignments, but only where they also review:
//   course-wide work: anywhere in a course they teach as a whole, or inside a module they are assigned to;
//   batch work: in any course of a batch they are assigned to, for the whole batch or selected students of it.

async function assertPlacement(professorId, { courseId, moduleId, batchId, studentIds }, db) {
  const { rowCount } = await db.query('SELECT 1 FROM courses WHERE id = $1', [courseId]);
  if (!rowCount) throw invalid('courseId', 'Select a valid course');
  if (moduleId) {
    const { rows } = await db.query('SELECT course_id FROM modules WHERE id = $1', [moduleId]);
    if (rows[0]?.course_id !== courseId) throw invalid('moduleId', 'The module does not belong to the selected course');
  }
  const scope = await repo.placementScope(professorId, courseId, moduleId, db);
  if (!scope.teaches_course) throw invalid('courseId', 'You can only add assignments to courses you teach');

  if (!batchId) {
    if (studentIds.length) throw invalid('studentIds', 'Choose a batch to assign work to selected students');
    if (scope.can_place) return;
    if (scope.teaches_through_batch) {
      throw invalid('batchId', 'You teach this course through a batch. Choose the batch to assign this work to.');
    }
    throw invalid('moduleId', moduleId ? 'You can only add assignments to modules you teach' : 'Select one of the modules you teach');
  }

  const batch = await repo.batchPlacement(professorId, batchId, courseId, db);
  if (!batch?.teaches_batch) throw invalid('batchId', 'You can only assign work to batches you teach');
  if (!batch.is_active) throw invalid('batchId', `"${batch.name}" is inactive. Activate it before assigning new work.`);
  if (!batch.takes_course) throw invalid('courseId', `"${batch.name}" does not take this course`);
  if (moduleId && !(await repo.moduleAvailableToBatch(moduleId, batchId, db))) {
    throw invalid('moduleId', 'This module is not available to the selected batch');
  }
  if (studentIds.length && (await repo.countBatchStudentsInCourse(batchId, courseId, studentIds, db)) !== studentIds.length) {
    throw invalid('studentIds', 'Select students of this batch who are enrolled in the course');
  }
}

/** Notify the students an assignment has just been assigned to (on publishing, or when its audience grows). */
async function notifyNewlyAssigned(assignment, previousStudentIds, db) {
  if (!assignment.is_published) return;
  const before = new Set(previousStudentIds);
  const added = (await assignments.audienceStudentIds(assignment.id, db)).filter((id) => !before.has(id));
  await notifyUsers(
    added,
    { type: 'assignment_published', title: `New assignment: ${assignment.title}`, link: `/student/assignments/${assignment.id}` },
    db,
  );
}

/** Course-wide work that a professor reviews through a batch is visible to them, but only its own professors change it. */
function assertManages(existing) {
  if (!existing) throw notFound('Assignment');
  if (!existing.can_manage) {
    throw forbidden('This course-wide assignment is managed by the course professors. You review it for your batch.');
  }
}

/** Delete a file row and return its storage key, so the bytes can be removed after the transaction commits. */
async function detachFile(fileId, db) {
  if (!fileId) return null;
  const { rows } = await db.query('DELETE FROM files WHERE id = $1 RETURNING storage_key', [fileId]);
  return rows[0]?.storage_key ?? null;
}

export async function createAssignment(professor, data, file) {
  const created = await withTransaction(async (db) => {
    await assertPlacement(professor.id, data, db);
    const attachment = file ? await recordUpload(file, 'attachment', professor.id, db) : null;
    const row = await assignments.insertAssignment(data, attachment?.id ?? null, professor.id, db);
    if (data.batchId) await assignments.replaceRecipients(row.id, data.studentIds, db);
    await notifyNewlyAssigned(row, [], db);
    await logActivity(
      {
        actorId: professor.id,
        action: 'assignment.created',
        entityType: 'assignment',
        entityId: row.id,
        description: `${professor.full_name} created assignment "${row.title}"${row.is_published ? '' : ' (draft)'}`,
        metadata: { courseId: row.course_id, batchId: row.batch_id, studentIds: data.studentIds },
      },
      db,
    );
    return row;
  });
  return getAssignment(professor.id, created.id);
}

export async function updateAssignment(professor, id, data, file) {
  let staleKey = null;
  await withTransaction(async (db) => {
    const existing = await repo.findAssignmentInScope(professor.id, id, db);
    assertManages(existing);
    if (await assignments.hasSubmissions(id, db)) {
      if (existing.course_id !== data.courseId) throw conflict('An assignment with submissions cannot be moved to another course');
      if (existing.batch_id !== data.batchId) throw conflict('An assignment with submissions cannot be moved to another batch');
    }
    await assertPlacement(professor.id, data, db);
    const previousStudentIds = existing.is_published ? await assignments.audienceStudentIds(id, db) : [];

    let attachmentId = existing.attachment_file_id;
    if (file) attachmentId = (await recordUpload(file, 'attachment', professor.id, db)).id;
    else if (data.removeAttachment) attachmentId = null;

    const updated = await assignments.updateAssignment(id, data, attachmentId, db);
    await assignments.replaceRecipients(id, data.batchId ? data.studentIds : [], db);
    if (attachmentId !== existing.attachment_file_id) staleKey = await detachFile(existing.attachment_file_id, db);
    await notifyNewlyAssigned(updated, previousStudentIds, db);
    await logActivity(
      {
        actorId: professor.id,
        action: 'assignment.updated',
        entityType: 'assignment',
        entityId: id,
        description: `${professor.full_name} updated assignment "${updated.title}"`,
      },
      db,
    );
  });
  if (staleKey) await deleteStoredFile(staleKey);
  return getAssignment(professor.id, id);
}

/** Assignments with submissions are part of student records: they can be unpublished, not deleted. */
export async function deleteAssignment(professor, id) {
  let staleKey = null;
  await withTransaction(async (db) => {
    const existing = await repo.findAssignmentInScope(professor.id, id, db);
    assertManages(existing);
    if (await assignments.hasSubmissions(id, db))
      throw conflict('This assignment already has submissions. Unpublish it instead of deleting it.');
    await assignments.deleteAssignment(id, db);
    staleKey = await detachFile(existing.attachment_file_id, db);
    await logActivity(
      {
        actorId: professor.id,
        action: 'assignment.deleted',
        entityType: 'assignment',
        entityId: id,
        description: `${professor.full_name} deleted assignment "${existing.title}"`,
      },
      db,
    );
  });
  if (staleKey) await deleteStoredFile(staleKey);
}

export const listSubmissions = (professorId, query) => submissions.listSubmissions(query, { scopeProfessorId: professorId });

/** Out-of-scope submissions are reported as missing so their existence is not revealed. */
async function requireSubmission(professorId, submissionId) {
  if (!(await repo.canReviewSubmission(professorId, submissionId))) throw notFound('Submission');
  return submissions.findSubmission(submissionId);
}

export async function getSubmission(professorId, submissionId) {
  return submissions.submissionThread(await requireSubmission(professorId, submissionId));
}

export async function getSubmissionFile(professorId, submissionId) {
  await requireSubmission(professorId, submissionId);
  return submissions.fileForSubmission(submissionId);
}

export async function startReview(professor, submissionId) {
  await requireSubmission(professor.id, submissionId);
  await withTransaction(async (db) => {
    const { rowCount } = await db.query(`UPDATE assignment_submissions SET status = 'in_review' WHERE id = $1 AND status = 'submitted'`, [
      submissionId,
    ]);
    if (rowCount) {
      await logActivity(
        {
          actorId: professor.id,
          action: 'submission.review_started',
          entityType: 'submission',
          entityId: submissionId,
          description: `${professor.full_name} started reviewing submission #${submissionId}`,
        },
        db,
      );
    }
  });
  return getSubmission(professor.id, submissionId);
}

export async function addComment(professor, submissionId, body) {
  const submission = await requireSubmission(professor.id, submissionId);
  await withTransaction(async (db) => {
    await db.query('INSERT INTO submission_comments (submission_id, author_id, body) VALUES ($1, $2, $3)', [
      submissionId,
      professor.id,
      body,
    ]);
    await notifyUsers(
      [submission.student_id],
      {
        type: 'submission_comment',
        title: `New comment on "${submission.assignment_title}"`,
        body: body.slice(0, 140),
        link: `/student/assignments/${submission.assignment_id}`,
      },
      db,
    );
    await logActivity(
      {
        actorId: professor.id,
        action: 'submission.commented',
        entityType: 'submission',
        entityId: submissionId,
        description: `${professor.full_name} commented on ${submission.student_name}'s "${submission.assignment_title}"`,
      },
      db,
    );
  });
  return getSubmission(professor.id, submissionId);
}

/**
 * Mark the latest attempt Completed or Rework Required. A "completed" decision may satisfy the
 * course completion policy, so completion is evaluated afterwards (outside this transaction).
 */
export async function review(professor, submissionId, { decision, feedback }) {
  await requireSubmission(professor.id, submissionId);
  const submission = await withTransaction(async (db) => {
    const { rows } = await db.query(
      `SELECT s.*, a.title AS assignment_title, a.course_id,
              (SELECT max(attempt_no) FROM assignment_submissions s2 WHERE s2.assignment_id = s.assignment_id AND s2.student_id = s.student_id) AS latest_attempt
         FROM assignment_submissions s JOIN assignments a ON a.id = s.assignment_id
        WHERE s.id = $1 FOR UPDATE OF s`,
      [submissionId],
    );
    const s = rows[0];
    if (s.attempt_no !== s.latest_attempt)
      throw new AppError(409, 'CONFLICT', 'A newer attempt exists. Review the latest submission instead.');
    if (!['submitted', 'in_review'].includes(s.status)) throw new AppError(409, 'CONFLICT', 'This submission has already been reviewed');

    await db.query('UPDATE assignment_submissions SET status = $2, reviewed_at = now(), reviewed_by = $3 WHERE id = $1', [
      submissionId,
      decision,
      professor.id,
    ]);
    await db.query('INSERT INTO assignment_reviews (submission_id, professor_id, decision, feedback) VALUES ($1, $2, $3, $4)', [
      submissionId,
      professor.id,
      decision,
      feedback,
    ]);
    await notifyUsers(
      [s.student_id],
      {
        type: decision === 'completed' ? 'submission_completed' : 'submission_rework',
        title: decision === 'completed' ? `"${s.assignment_title}" marked Completed` : `Rework requested on "${s.assignment_title}"`,
        body: feedback ? feedback.slice(0, 140) : null,
        link: `/student/assignments/${s.assignment_id}`,
      },
      db,
    );
    await logActivity(
      {
        actorId: professor.id,
        action: `submission.${decision}`,
        entityType: 'submission',
        entityId: submissionId,
        description: `${professor.full_name} marked "${s.assignment_title}" attempt ${s.attempt_no} as ${decision === 'completed' ? 'Completed' : 'Rework Required'}`,
        metadata: { studentId: s.student_id },
      },
      db,
    );
    return s;
  });

  const completion =
    decision === 'completed'
      ? await evaluateCourseCompletion(submission.student_id, submission.course_id, { actorId: professor.id })
      : { completed: false };
  return { submission: await getSubmission(professor.id, submissionId), courseCompleted: completion.completed };
}
