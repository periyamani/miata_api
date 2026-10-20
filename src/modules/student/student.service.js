import { withTransaction } from '../../config/db.js';
import { AppError, notFound } from '../../utils/AppError.js';
import { addDays, today } from '../../utils/dates.js';
import { formatMoney } from '../../utils/money.js';
import { logActivity } from '../../services/activity.service.js';
import { evaluateCourseCompletion } from '../../services/completion.service.js';
import { notifyRole, notifyUsers, reviewersForSubmission } from '../../services/notification.service.js';
import { attachProgress, recordVideoHeartbeat } from '../../services/progress.service.js';
import { getCompletionPolicy, getFeeSettings } from '../../services/settings.service.js';
import { recordUpload } from '../../services/storage.service.js';
import { getAccessibleVideo, videoStreamUrl } from '../../services/videoAccess.service.js';
import { studentAssignments } from '../../repositories/assignments.repository.js';
import { studentBatch } from '../../repositories/batches.repository.js';
import { feeTotals, paymentProof, studentFees, studentPayments } from '../../repositories/fees.repository.js';
import * as submissions from '../../repositories/submissions.repository.js';
import { getAttachment } from '../admin/assignments/assignments.service.js';
import { upcomingForStudent } from '../meetings/meetings.service.js';
import * as repo from './student.repository.js';

const invalid = (field, message) => new AppError(422, 'VALIDATION_ERROR', message, { [field]: message });

function moduleStatus(progress) {
  if (!progress.items_total) return 'no_requirements';
  if (progress.items_done >= progress.items_total) return 'completed';
  return progress.items_done > 0 ? 'in_progress' : 'not_started';
}

const withModuleStatus = (rows, policy) =>
  attachProgress(
    rows.map((r) => ({ ...r, status: 'active' })),
    policy,
  ).map(({ status: _s, ...m }) => ({
    ...m,
    status: moduleStatus(m.progress),
  }));

async function requireCourseAccess(studentId, courseId) {
  const enrolment = await repo.accessibleEnrolment(studentId, courseId);
  if (!enrolment) throw notFound('Course');
  return enrolment;
}

// ─── Dashboard & courses ────────────────────────────────────────────────

export async function dashboard(student) {
  const policy = await getCompletionPolicy();
  const [enrolments, allVideos, modules, assignments, activity, batch, meetings, feeRows, feeSettings, accessEndsOn] = await Promise.all([
    repo.enrolments(student.id),
    repo.videos(student.id),
    repo.moduleProgress(student.id),
    studentAssignments(student.id, { onlyActiveCourses: true }),
    repo.recentActivity(student.id),
    studentBatch(student.id),
    upcomingForStudent(student.id, 4),
    studentFees(student.id),
    getFeeSettings(),
    repo.accessEndsOn(student.id),
  ]);
  const courses = attachProgress(enrolments, policy);
  return {
    batch, // the student's batch (null when not in one): its courses and professors
    stats: {
      total_videos: allVideos.length,
      watched_videos: allVideos.filter((v) => v.completed_at).length,
      total_modules: modules.length,
      pending_assignments: assignments.filter((a) => a.status === 'pending' || a.status === 'rework').length,
      completed_courses: courses.filter((c) => c.status === 'completed').length,
      total_courses: courses.length,
    },
    // "Continue learning": unwatched videos first, in course order.
    featuredVideos: [...allVideos.filter((v) => !v.completed_at), ...allVideos.filter((v) => v.completed_at)].slice(0, 4),
    modules: withModuleStatus(modules, policy).slice(0, 6),
    assignments: assignments.slice(0, 5),
    recentActivity: activity,
    courses, // active enrolments first (see repository ordering)
    upcomingMeetings: meetings, // online classes of the student's batch (or shared with them), next first
    fees: { currency: feeSettings.currency, ...feeTotals(feeRows) },
    accessEndsOn, // last day of access; the account is deactivated after it (null = no end)
  };
}

export async function courses(studentId) {
  const [rows, policy] = await Promise.all([repo.enrolments(studentId), getCompletionPolicy()]);
  return attachProgress(rows, policy);
}

export async function courseDetail(studentId, courseId) {
  const enrolment = await requireCourseAccess(studentId, courseId);
  const policy = await getCompletionPolicy();
  const [course, modules, videos, assignments, moduleRows] = await Promise.all([
    repo.course(studentId, courseId),
    repo.modulesWithLessons(studentId, courseId),
    repo.videos(studentId, { courseId }),
    studentAssignments(studentId, { courseId }),
    repo.moduleProgress(studentId, courseId),
  ]);
  const statusById = Object.fromEntries(withModuleStatus(moduleRows, policy).map((m) => [m.id, m]));
  const [enrolmentWithProgress] = attachProgress([enrolment], policy);
  return {
    ...course,
    enrolment: enrolmentWithProgress,
    modules: modules.map((m) => ({
      ...m,
      status: statusById[m.id]?.status,
      progress: statusById[m.id]?.progress,
      videos: videos.filter((v) => v.module_id === m.id),
      assignments: assignments.filter((a) => a.module_id === m.id),
    })),
    // Content attached to the course but not to a module.
    generalVideos: videos.filter((v) => !v.module_id),
    generalAssignments: assignments.filter((a) => !a.module_id),
  };
}

export async function modules(studentId, courseId) {
  const [rows, policy] = await Promise.all([repo.moduleProgress(studentId, courseId), getCompletionPolicy()]);
  return withModuleStatus(rows, policy);
}

// ─── Videos ─────────────────────────────────────────────────────────────

export const videos = (studentId, filters) => repo.videos(studentId, filters);

export async function video(student, videoId) {
  const v = await getAccessibleVideo(student, videoId);
  const [progress, siblings] = await Promise.all([
    repo.videoProgress(student.id, videoId),
    repo.videos(student.id, { courseId: v.course_id }),
  ]);
  const index = siblings.findIndex((s) => s.id === videoId);
  const { storage_key: _key, file_id: _file, uploaded_by: _by, ...safe } = v;
  return {
    ...safe,
    progress,
    stream: videoStreamUrl(student, videoId),
    previous: siblings[index - 1] ? { id: siblings[index - 1].id, title: siblings[index - 1].title } : null,
    next: siblings[index + 1] ? { id: siblings[index + 1].id, title: siblings[index + 1].title } : null,
  };
}

/**
 * Playback heartbeat. Watch time is credited server-side; when a video crosses the threshold the
 * completion policy is evaluated, which may complete the course and end this session.
 */
export async function recordProgress(student, videoId, position) {
  const v = await getAccessibleVideo(student, videoId);
  const policy = await getCompletionPolicy();
  const progress = await recordVideoHeartbeat({ studentId: student.id, video: v, position, thresholdPercent: policy.videoWatchThreshold });
  let completion = { completed: false, sessionEnded: false, resetRequired: false };
  if (progress.just_completed) {
    await logActivity({
      actorId: student.id,
      action: 'video.completed',
      entityType: 'video',
      entityId: videoId,
      description: `${student.full_name} completed video "${v.title}"`,
    });
    completion = await evaluateCourseCompletion(student.id, v.course_id);
  }
  return {
    watched_seconds: progress.watched_seconds,
    last_position: progress.last_position,
    completed_at: progress.completed_at,
    video_completed: Boolean(progress.completed_at),
    course_completed: completion.completed,
    session_ended: completion.sessionEnded,
    password_reset_required: completion.resetRequired,
  };
}

// ─── Assignments & submissions ──────────────────────────────────────────

export const assignments = (studentId, filters) => studentAssignments(studentId, filters);

/** Whether the student may (re)submit now, with a reason when not. */
function submissionState(assignment, latest) {
  if (assignment.enrolment_status !== 'active') return { can_submit: false, reason: 'This course is completed — submissions are closed.' };
  if (!latest) return { can_submit: true, reason: null };
  if (latest.status === 'rework') return { can_submit: true, reason: 'Rework requested — upload a revised file.' };
  if (latest.status === 'completed') return { can_submit: false, reason: 'This assignment has been marked Completed.' };
  return { can_submit: false, reason: 'Your submission is awaiting review.' };
}

export async function assignment(studentId, assignmentId) {
  const a = await repo.findPublishedAssignment(studentId, assignmentId);
  if (!a) throw notFound('Assignment');
  const latest = await repo.latestAttempt(studentId, assignmentId);
  let thread = { attempts: [], reviews: [], comments: [] };
  if (latest) {
    const s = await submissions.findSubmission(latest.id);
    const full = await submissions.submissionThread(s);
    thread = { attempts: full.attempts, reviews: full.reviews, comments: full.comments };
  }
  const { attachment_file_id: _f, ...rest } = a;
  return {
    ...rest,
    has_attachment: Boolean(a.attachment_file_id),
    status: latest?.status ?? 'pending',
    latest_submission_id: latest?.id ?? null,
    is_overdue: Boolean(a.due_at && new Date(a.due_at) < new Date() && !latest),
    ...submissionState(a, latest),
    ...thread,
  };
}

export async function assignmentAttachment(studentId, assignmentId) {
  if (!(await repo.findPublishedAssignment(studentId, assignmentId))) throw notFound('Assignment');
  return getAttachment(assignmentId);
}

/**
 * Submit attempt 1, or a new attempt after "Rework Required". Late submissions are accepted and
 * shown as late (the due date is visible to the professor).
 */
export async function submit(student, assignmentId, file, notes) {
  const a = await repo.findPublishedAssignment(student.id, assignmentId);
  if (!a) throw notFound('Assignment');
  const submission = await withTransaction(async (db) => {
    // Lock the student's attempts for this assignment so two parallel uploads cannot both become attempt N.
    await db.query('SELECT pg_advisory_xact_lock($1, $2)', [student.id, assignmentId]);
    const latest = await repo.latestAttempt(student.id, assignmentId, db);
    const state = submissionState(a, latest);
    if (!state.can_submit) throw new AppError(409, 'SUBMISSION_NOT_ALLOWED', state.reason);
    const stored = await recordUpload(file, 'submission', student.id, db);
    const created = await repo.insertSubmission(
      { assignmentId, studentId: student.id, attemptNo: (latest?.attempt_no ?? 0) + 1, fileId: stored.id, notes },
      db,
    );
    const professorIds = await reviewersForSubmission(created.id, db);
    await notifyUsers(
      professorIds,
      {
        type: 'submission_received',
        title: `${student.full_name} submitted "${a.title}"`,
        body: created.attempt_no > 1 ? `Resubmission (attempt ${created.attempt_no})` : null,
        link: `/professor/reviews/${created.id}`,
      },
      db,
    );
    await logActivity(
      {
        actorId: student.id,
        action: created.attempt_no > 1 ? 'submission.resubmitted' : 'submission.created',
        entityType: 'submission',
        entityId: created.id,
        description: `${student.full_name} submitted "${a.title}" (attempt ${created.attempt_no})`,
        metadata: { assignmentId },
      },
      db,
    );
    return created;
  });
  return assignment(student.id, submission.assignment_id);
}

export const submissionHistory = (studentId) => repo.submissionHistory(studentId);

export async function submissionFile(studentId, submissionId) {
  if (!(await repo.ownsSubmission(studentId, submissionId))) throw notFound('Submission');
  return submissions.fileForSubmission(submissionId);
}

export async function comment(student, submissionId, body) {
  if (!(await repo.ownsSubmission(student.id, submissionId))) throw notFound('Submission');
  const s = await submissions.findSubmission(submissionId);
  await withTransaction(async (db) => {
    await db.query('INSERT INTO submission_comments (submission_id, author_id, body) VALUES ($1, $2, $3)', [
      submissionId,
      student.id,
      body,
    ]);
    const professorIds = await reviewersForSubmission(submissionId, db);
    await notifyUsers(
      professorIds,
      {
        type: 'submission_comment',
        title: `${student.full_name} commented on "${s.assignment_title}"`,
        body: body.slice(0, 140),
        link: `/professor/reviews/${submissionId}`,
      },
      db,
    );
    await logActivity(
      {
        actorId: student.id,
        action: 'submission.commented',
        entityType: 'submission',
        entityId: submissionId,
        description: `${student.full_name} commented on "${s.assignment_title}"`,
      },
      db,
    );
  });
  return assignment(student.id, s.assignment_id);
}

// ─── Progress & completion ──────────────────────────────────────────────

export async function progress(studentId) {
  const [rows, moduleRows, policy] = await Promise.all([repo.enrolments(studentId), repo.moduleProgress(studentId), getCompletionPolicy()]);
  const moduleList = withModuleStatus(moduleRows, policy);
  return attachProgress(rows, policy).map((c) => ({ ...c, modules: moduleList.filter((m) => m.course_id === c.course_id) }));
}

export async function completion(studentId) {
  const [rows, policy] = await Promise.all([repo.enrolments(studentId), getCompletionPolicy()]);
  return {
    policy: {
      requireAllVideos: policy.requireAllVideos,
      requireAllAssignments: policy.requireAllAssignments,
      videoWatchThreshold: policy.videoWatchThreshold,
      logoutOnCompletion: policy.logoutOnCompletion,
      passwordResetOnCompletion: policy.passwordResetOnCompletion,
    },
    courses: attachProgress(rows, policy),
  };
}

// ─── Fees & payments ────────────────────────────────────────────────────

/** Fee position per course and in total, the transfer instructions, and every payment the student has reported. */
export async function fees(studentId) {
  const [courses, payments, settings] = await Promise.all([studentFees(studentId), studentPayments(studentId), getFeeSettings()]);
  return {
    currency: settings.currency,
    paymentInstructions: settings.paymentInstructions,
    totals: feeTotals(courses),
    courses,
    payments,
  };
}

/**
 * Report a fee payment with its proof (screenshot or receipt). It counts as paid once an admin approves it. The amount
 * may not exceed what is still open: the balance less payments already awaiting verification.
 */
export async function submitPayment(student, file, { courseId, amount, paidOn, method, reference, notes }) {
  // One day of slack: a student ahead of APP_TIMEZONE may already be on the next calendar day.
  if (paidOn > addDays(today(), 1)) throw invalid('paidOn', 'The payment date cannot be in the future');
  const payment = await withTransaction(async (db) => {
    // Locking the enrolment serialises a student's submissions, so the open amount cannot be exceeded by parallel uploads.
    const { rows: enrolments } = await db.query(
      `SELECT e.id, c.title FROM course_enrolments e JOIN courses c ON c.id = e.course_id
        WHERE e.student_id = $1 AND e.course_id = $2 FOR UPDATE OF e`,
      [student.id, courseId],
    );
    const enrolment = enrolments[0];
    if (!enrolment) throw invalid('courseId', 'Select one of your courses');
    const { rows: feeRows } = await db.query('SELECT payable, balance, pending FROM enrolment_fees WHERE enrolment_id = $1', [
      enrolment.id,
    ]);
    const { currency } = await getFeeSettings(db);
    const open = Math.round((feeRows[0].balance - feeRows[0].pending) * 100) / 100;
    if (feeRows[0].payable <= 0) {
      throw invalid('courseId', 'There is no fee to pay for this course. Please contact MIATA if you think this is wrong.');
    }
    if (amount > open) {
      throw invalid(
        'amount',
        open > 0
          ? `The most you can report for this course now is ${formatMoney(open, currency)} (balance less payments awaiting verification)`
          : 'Nothing is left to pay for this course once the payments awaiting verification are approved',
      );
    }

    const proof = await recordUpload(file, 'payment_proof', student.id, db);
    const { rows } = await db.query(
      `INSERT INTO fee_payments (enrolment_id, amount, paid_on, method, reference, notes, proof_file_id, submitted_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [enrolment.id, amount, paidOn, method, reference, notes, proof.id, student.id],
    );
    const id = rows[0].id;
    await logActivity(
      {
        actorId: student.id,
        action: 'payment.submitted',
        entityType: 'payment',
        entityId: id,
        description: `${student.full_name} reported a payment of ${formatMoney(amount, currency)} for ${enrolment.title}`,
        metadata: { enrolmentId: enrolment.id, amount },
      },
      db,
    );
    await notifyRole(
      'admin',
      {
        type: 'payment_submitted',
        title: `Payment to verify: ${formatMoney(amount, currency)} from ${student.full_name}`,
        body: enrolment.title,
        link: `/admin/payments/${id}`,
      },
      db,
    );
    return id;
  });
  return (await studentPayments(student.id)).find((p) => p.id === payment);
}

export async function paymentProofFile(studentId, paymentId) {
  const file = await paymentProof(paymentId, studentId);
  if (!file) throw notFound('Payment');
  return file;
}
