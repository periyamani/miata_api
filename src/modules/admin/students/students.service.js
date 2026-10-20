import { withTransaction } from '../../../config/db.js';
import { AppError, notFound } from '../../../utils/AppError.js';
import { logActivity } from '../../../services/activity.service.js';
import { notifyUsers } from '../../../services/notification.service.js';
import { attachProgress } from '../../../services/progress.service.js';
import { getCompletionPolicy, getFeeSettings } from '../../../services/settings.service.js';
import { studentAssignments } from '../../../repositories/assignments.repository.js';
import { studentBatch } from '../../../repositories/batches.repository.js';
import { feeTotals, studentPayments } from '../../../repositories/fees.repository.js';
import { getUserWithProfile } from '../../users/user.repository.js';
import { createManagedAccount } from '../accounts/accounts.service.js';
import { addStudentsWithin, removeStudentWithin } from '../batches/batches.service.js';
import { enrolWithin } from '../enrolments/enrolments.service.js';
import * as repo from './students.repository.js';

export const listStudents = (query) => repo.listStudents(query);

/**
 * Profile, status, access period, batch, enrolments with progress and fees, fee payments and the assignments set for the
 * student (as the student sees them).
 */
export async function getStudent(studentId) {
  const user = await getUserWithProfile(studentId);
  if (!user || user.role !== 'student') throw notFound('Student');
  const [status, access, referral, batch, enrolments, payments, assignments, activity, policy, { currency }] = await Promise.all([
    repo.studentStatus(studentId),
    repo.studentAccess(studentId),
    repo.studentReferral(studentId),
    studentBatch(studentId),
    repo.studentEnrolments(studentId),
    studentPayments(studentId),
    studentAssignments(studentId),
    repo.recentActivityFor(studentId),
    getCompletionPolicy(),
    getFeeSettings(),
  ]);
  return {
    ...user,
    status: status?.status,
    access,
    referral,
    batch,
    enrolments: attachProgress(enrolments, policy),
    fees: { currency, ...feeTotals(enrolments) },
    payments,
    assignments,
    activity,
  };
}

/** Put the student in a batch (moving them from their current one), or take them out of it (`batchId` null). */
export async function setBatch(studentId, batchId, actor) {
  await withTransaction(async (db) => {
    const { rows } = await db.query(
      `SELECT u.id, bs.batch_id FROM users u LEFT JOIN batch_students bs ON bs.student_id = u.id WHERE u.id = $1 AND u.role = 'student'`,
      [studentId],
    );
    if (!rows[0]) throw notFound('Student');
    if (batchId) await addStudentsWithin(db, batchId, [studentId], actor);
    else if (rows[0].batch_id) await removeStudentWithin(db, rows[0].batch_id, studentId, actor);
  });
  return getStudent(studentId);
}

async function findActiveAgent(agentId, db) {
  const { rows } = await db.query(
    `SELECT u.id, u.full_name, u.is_active, ap.referral_code FROM users u JOIN agent_profiles ap ON ap.user_id = u.id
      WHERE u.id = $1 AND u.role = 'agent'`,
    [agentId],
  );
  if (!rows[0]) throw new AppError(422, 'VALIDATION_ERROR', 'Select a valid agent', { agentId: 'This user is not an agent' });
  if (!rows[0].is_active) throw new AppError(422, 'VALIDATION_ERROR', 'This agent is deactivated', { agentId: 'Agent is deactivated' });
  return rows[0];
}

export async function createStudent(data, actor) {
  const student = await createManagedAccount('student', data, actor, async (user, db) => {
    if (data.agentId) {
      const agent = await findActiveAgent(data.agentId, db);
      await db.query(
        `INSERT INTO agent_referrals (agent_id, student_id, referral_code, source, created_by) VALUES ($1, $2, $3, 'admin', $4)`,
        [agent.id, user.id, agent.referral_code, actor.id],
      );
      await notifyUsers(
        [agent.id],
        {
          type: 'referral_registered',
          title: `New referral: ${user.full_name}`,
          body: 'Added by an administrator.',
          link: '/agent/students',
        },
        db,
      );
    }
    if (data.courseIds.length) await enrolWithin(db, { courseIds: data.courseIds, studentIds: [user.id] }, actor);
    if (data.batchId) await addStudentsWithin(db, data.batchId, [user.id], actor);
  });
  return { ...(await getStudent(student.id)), welcomeEmail: student.welcomeEmail };
}

/**
 * Attribute, re-attribute or remove a student's referral. Only admins can do this, and every change
 * is written to the activity log with the previous owner, so referral ownership is auditable.
 */
export async function setReferral(studentId, agentId, actor) {
  return withTransaction(async (db) => {
    const { rows: students } = await db.query(`SELECT id, full_name FROM users WHERE id = $1 AND role = 'student' FOR UPDATE`, [studentId]);
    const student = students[0];
    if (!student) throw notFound('Student');
    const { rows: existingRows } = await db.query(
      `SELECT r.*, ag.full_name AS agent_name FROM agent_referrals r JOIN users ag ON ag.id = r.agent_id WHERE r.student_id = $1 FOR UPDATE OF r`,
      [studentId],
    );
    const existing = existingRows[0];

    if (!agentId) {
      if (!existing) return { changed: false };
      await db.query('DELETE FROM agent_referrals WHERE id = $1', [existing.id]);
      await logActivity(
        {
          actorId: actor.id,
          action: 'referral.removed',
          entityType: 'user',
          entityId: studentId,
          description: `Referral of ${student.full_name} removed from ${existing.agent_name}`,
          metadata: { previousAgentId: existing.agent_id },
        },
        db,
      );
      return { changed: true };
    }

    const agent = await findActiveAgent(agentId, db);
    if (existing?.agent_id === agent.id) return { changed: false };
    if (existing) {
      await db.query(`UPDATE agent_referrals SET agent_id = $2, referral_code = $3, source = 'admin', created_by = $4 WHERE id = $1`, [
        existing.id,
        agent.id,
        agent.referral_code,
        actor.id,
      ]);
    } else {
      await db.query(
        `INSERT INTO agent_referrals (agent_id, student_id, referral_code, source, created_by) VALUES ($1, $2, $3, 'admin', $4)`,
        [agent.id, studentId, agent.referral_code, actor.id],
      );
    }
    await notifyUsers(
      [agent.id],
      { type: 'referral_registered', title: `Referral assigned: ${student.full_name}`, link: '/agent/students' },
      db,
    );
    await logActivity(
      {
        actorId: actor.id,
        action: existing ? 'referral.reassigned' : 'referral.assigned',
        entityType: 'user',
        entityId: studentId,
        description: existing
          ? `Referral of ${student.full_name} moved from ${existing.agent_name} to ${agent.full_name}`
          : `${student.full_name} attributed to ${agent.full_name}`,
        metadata: { previousAgentId: existing?.agent_id ?? null, agentId: agent.id },
      },
      db,
    );
    return { changed: true };
  });
}
