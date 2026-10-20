import { withTransaction } from '../../config/db.js';
import { AppError, conflict, notFound } from '../../utils/AppError.js';
import { logger } from '../../utils/logger.js';
import { logActivity } from '../../services/activity.service.js';
import { claimForRetry, queueEmails, sendQueued } from '../../services/emailDelivery.service.js';
import { meetingEmail, meetingWhen } from '../../services/email.templates.js';
import { notifyUsers } from '../../services/notification.service.js';
import * as repo from './meetings.repository.js';

// Online classes: a professor shares a Google Meet / Zoom link with one of their batches (every student of the
// batch) or with selected students of that batch. Students are told by e-mail and in-app when a class is scheduled,
// changed or cancelled — each person once per change (email_deliveries dedupe keys include the meeting revision).

const invalid = (field, message) => new AppError(422, 'VALIDATION_ERROR', message, { [field]: message });
const STUDENT_LINK = '/student/meetings';

/** Google Meet or Zoom from the link; null when the link is neither (or not https). */
export function meetingPlatform(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.pathname.length < 2) return null;
  const host = parsed.hostname.toLowerCase();
  if (host === 'meet.google.com') return 'google_meet';
  if (host === 'zoom.us' || host.endsWith('.zoom.us')) return 'zoom';
  return null;
}

async function assertBatch(professorId, { batchId, audience, studentIds }, db) {
  const scope = await repo.batchScope(professorId, batchId, db);
  if (!scope?.teaches) throw invalid('batchId', 'You can only schedule classes for batches you are assigned to');
  if (!scope.is_active) throw invalid('batchId', 'This batch is inactive');
  if (audience === 'selected') {
    const outside = await repo.outsideBatch(batchId, studentIds, db);
    if (outside.length) throw invalid('studentIds', 'Select students who belong to this batch');
  }
}

function assertFuture(startsAt) {
  if (new Date(startsAt).getTime() <= Date.now()) throw invalid('startsAt', 'Choose a date and time in the future');
}

const hasEnded = (meeting) => new Date(meeting.ends_at).getTime() <= Date.now();

/** What students would notice: the keys are used in the "What changed" line of the update e-mail. */
function detailChanges(existing, data) {
  const changes = [];
  if (existing.title !== data.title) changes.push('title');
  if (existing.batch_id !== data.batchId) changes.push('batch');
  if (new Date(existing.starts_at).getTime() !== new Date(data.startsAt).getTime()) changes.push('time');
  if (existing.duration_minutes !== data.durationMinutes) changes.push('duration');
  if (existing.meeting_url !== data.meetingUrl) changes.push('link');
  if ((existing.description ?? null) !== data.description) changes.push('description');
  return changes;
}

// Both lists are free of duplicates (participants are a primary key; the request schema dedupes studentIds).
const sameIds = (a, b) => a.length === b.length && a.every((id) => b.includes(id));

/**
 * Queue one e-mail per (kind, student) for the meeting's current revision, inside the transaction, and add the matching
 * in-app notifications. Returns the queued items, to send once the transaction commits.
 */
async function queueNotifications(meeting, plan, db) {
  const items = [];
  for (const { kind, users, changes = [], title } of plan) {
    if (!users.length) continue;
    await notifyUsers(
      users.map((u) => u.id),
      { type: kind, title, body: `${meeting.batch_name} · ${meetingWhen(meeting).short}`, link: STUDENT_LINK },
      db,
    );
    for (const user of users) {
      items.push({
        dedupeKey: `meeting:${meeting.id}:r${meeting.revision}:${kind}:user:${user.id}`,
        kind,
        user,
        meetingId: meeting.id,
        message: meetingEmail(kind, { meeting, student: user, changes }),
      });
    }
  }
  return queueEmails(items, db);
}

/** E-mails go out after the response (like enquiry notifications); outcomes land in email_deliveries. */
function sendInBackground(queued, meetingId) {
  return sendQueued(queued).catch((err) => {
    logger.error('Meeting e-mails could not be sent', { meetingId, error: err.message });
    return { sent: 0, failed: queued.length, skipped: 0 };
  });
}

const count = (plan) => Object.fromEntries(plan.map(({ kind, users }) => [kind.replace('meeting_', ''), users.length]));

// ─── Professor ──────────────────────────────────────────────────────────

export const listMeetings = (professorId, query) => repo.listMeetings(query, { professorId });

export async function getMeeting(meetingId, { professorId = null } = {}) {
  const meeting = await repo.findMeeting(meetingId, { professorId });
  if (!meeting) throw notFound('Meeting');
  const [recipients, participantIds] = await Promise.all([repo.recipientsWithEmail(meetingId), repo.participantIds(meetingId)]);
  // Professors see who was e-mailed and whether it arrived, not the students' addresses.
  return { ...meeting, participantIds, recipients: professorId ? recipients.map(({ email: _e, ...r }) => r) : recipients };
}

export async function batchStudents(professorId, batchId) {
  const scope = await repo.batchScope(professorId, batchId);
  if (!scope?.teaches) throw notFound('Batch');
  return repo.batchStudents(batchId);
}

export async function createMeeting(professor, data) {
  const { meetingId, queued, plan } = await withTransaction(async (db) => {
    await assertBatch(professor.id, data, db);
    assertFuture(data.startsAt);
    const id = await repo.insertMeeting({ ...data, platform: meetingPlatform(data.meetingUrl) }, professor.id, db);
    if (data.audience === 'selected') await repo.replaceParticipants(id, data.studentIds, db);
    const meeting = await repo.findMeeting(id, {}, db);
    const steps = [{ kind: 'meeting_scheduled', users: await repo.recipients(id, db), title: `Online class scheduled: ${meeting.title}` }];
    const items = await queueNotifications(meeting, steps, db);
    await logActivity(
      {
        actorId: professor.id,
        action: 'meeting.created',
        entityType: 'meeting',
        entityId: id,
        description: `${professor.full_name} scheduled online class "${meeting.title}" for ${meeting.batch_name}`,
        metadata: { batchId: meeting.batch_id, audience: meeting.audience, recipients: steps[0].users.length },
      },
      db,
    );
    return { meetingId: id, queued: items, plan: steps };
  });
  const delivery = sendInBackground(queued, meetingId);
  return { meeting: { ...(await getMeeting(meetingId, { professorId: professor.id })), notified: count(plan) }, delivery };
}

/**
 * Save changes and tell exactly the people affected: students added to the audience get the invitation, students no
 * longer in it are told the class is no longer scheduled for them (without the new details), and students who stay are
 * told about changed details. Saving without changes sends nothing.
 */
export async function updateMeeting(professor, meetingId, data) {
  const result = await withTransaction(async (db) => {
    const existing = await repo.findMeeting(meetingId, { professorId: professor.id, lock: true }, db);
    if (!existing) throw notFound('Meeting');
    if (existing.status === 'cancelled') throw conflict('This class has been cancelled and can no longer be changed');
    await assertBatch(professor.id, data, db);

    const changes = detailChanges(existing, data);
    const oldParticipants = await repo.participantIds(meetingId, db);
    const sameAudience = existing.audience === data.audience && (data.audience === 'batch' || sameIds(oldParticipants, data.studentIds));
    if (!changes.length && sameAudience) return { unchanged: true, plan: [], queued: [] };
    if (changes.includes('time')) assertFuture(data.startsAt);
    else if (hasEnded(existing)) throw conflict('This class has already taken place. Change its date and time to reuse it.');

    const before = await repo.recipients(meetingId, db);
    await repo.updateMeeting(meetingId, { ...data, platform: meetingPlatform(data.meetingUrl) }, db);
    await repo.replaceParticipants(meetingId, data.audience === 'selected' ? data.studentIds : [], db);
    const meeting = await repo.findMeeting(meetingId, {}, db);
    const after = await repo.recipients(meetingId, db);

    const beforeIds = new Set(before.map((u) => u.id));
    const afterIds = new Set(after.map((u) => u.id));
    const steps = [
      { kind: 'meeting_scheduled', users: after.filter((u) => !beforeIds.has(u.id)), title: `Online class scheduled: ${meeting.title}` },
      {
        kind: 'meeting_cancelled',
        users: before.filter((u) => !afterIds.has(u.id)),
        title: `"${existing.title}" is no longer scheduled for you`,
      },
      ...(changes.length
        ? [
            {
              kind: 'meeting_updated',
              users: after.filter((u) => beforeIds.has(u.id)),
              changes,
              title: `Online class updated: ${meeting.title}`,
            },
          ]
        : []),
    ];
    // Students who are no longer invited must not receive the new details or link: their notice uses the old ones.
    const removedStep = steps[1];
    const queued = [
      ...(await queueNotifications(
        meeting,
        steps.filter((s) => s !== removedStep),
        db,
      )),
      ...(await queueNotifications({ ...existing, revision: meeting.revision }, [removedStep], db)),
    ];
    await logActivity(
      {
        actorId: professor.id,
        action: 'meeting.updated',
        entityType: 'meeting',
        entityId: meetingId,
        description: `${professor.full_name} updated online class "${meeting.title}"`,
        metadata: { changes, added: steps[0].users.length, removed: removedStep.users.length },
      },
      db,
    );
    return { plan: steps, queued };
  });
  const delivery = sendInBackground(result.queued, meetingId);
  const meeting = await getMeeting(meetingId, { professorId: professor.id });
  return { meeting: { ...meeting, unchanged: Boolean(result.unchanged), notified: count(result.plan) }, delivery };
}

export async function cancelMeeting(professor, meetingId, reason) {
  const queued = await withTransaction(async (db) => {
    const existing = await repo.findMeeting(meetingId, { professorId: professor.id, lock: true }, db);
    if (!existing) throw notFound('Meeting');
    if (existing.status === 'cancelled') throw conflict('This class is already cancelled');
    if (hasEnded(existing)) throw conflict('This class has already taken place');
    const users = await repo.recipients(meetingId, db);
    await repo.cancelMeeting(meetingId, reason, db);
    const meeting = await repo.findMeeting(meetingId, {}, db);
    const items = await queueNotifications(
      meeting,
      [{ kind: 'meeting_cancelled', users, title: `Online class cancelled: ${meeting.title}` }],
      db,
    );
    await logActivity(
      {
        actorId: professor.id,
        action: 'meeting.cancelled',
        entityType: 'meeting',
        entityId: meetingId,
        description: `${professor.full_name} cancelled online class "${meeting.title}"`,
        metadata: { reason, recipients: users.length },
      },
      db,
    );
    return items;
  });
  const delivery = sendInBackground(queued, meetingId);
  return { meeting: { ...(await getMeeting(meetingId, { professorId: professor.id })), notified: { cancelled: queued.length } }, delivery };
}

/** Retry e-mails that failed or were skipped (e.g. SMTP was down or not configured). Waits for the outcome. */
export async function resendEmails(professor, meetingId) {
  const meeting = await repo.findMeeting(meetingId, { professorId: professor.id });
  if (!meeting) throw notFound('Meeting');
  if (meeting.status === 'scheduled' && hasEnded(meeting)) throw conflict('This class has already taken place');

  const claimed = await claimForRetry(await repo.retryableDeliveries(meetingId));
  const users = await repo.usersByIds(claimed.map((d) => d.user_id));
  const summary = await sendQueued(
    claimed.map((d) => ({
      id: d.id,
      user: users.get(d.user_id),
      message: meetingEmail(d.kind, { meeting, student: users.get(d.user_id) }),
    })),
  );
  if (claimed.length) {
    await logActivity({
      actorId: professor.id,
      action: 'meeting.emails_resent',
      entityType: 'meeting',
      entityId: meetingId,
      description: `${professor.full_name} resent ${claimed.length} e-mail(s) for online class "${meeting.title}"`,
      metadata: summary,
    });
  }
  return { retried: claimed.length, ...summary, meeting: await getMeeting(meetingId, { professorId: professor.id }) };
}

// ─── Student & admin ────────────────────────────────────────────────────

export const studentMeetings = (studentId, when) => repo.studentMeetings(studentId, { when });
export const upcomingForStudent = (studentId, limit) => repo.studentMeetings(studentId, { when: 'upcoming', limit });
export const upcomingForProfessor = async (professorId, limit) =>
  (await repo.listMeetings({ page: 1, pageSize: limit, sort: 'starts_at', order: 'asc', when: 'upcoming' }, { professorId })).rows;

export const adminListMeetings = (query) => repo.listMeetings(query);
