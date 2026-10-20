import { env } from '../../config/env.js';
import { withTransaction } from '../../config/db.js';
import { notFound } from '../../utils/AppError.js';
import { logger } from '../../utils/logger.js';
import { logActivity } from '../../services/activity.service.js';
import { sendEmail } from '../../services/email.service.js';
import { enquiryNotificationEmail } from '../../services/email.templates.js';
import { notifyRole } from '../../services/notification.service.js';
import * as repo from './enquiries.repository.js';

const STATUS_LABEL = { new: 'New', contacted: 'Contacted', follow_up: 'Follow-up', converted: 'Converted', closed: 'Closed' };

/** Send the admin notification email and store the real outcome on the enquiry (sent / failed / skipped). */
export async function deliverNotification(enquiry) {
  const result = await sendEmail({ to: env.smtp.enquiryRecipients, ...enquiryNotificationEmail(enquiry) });
  await repo.setEmailOutcome(enquiry.id, { status: result.status, error: result.error ?? null });
  return result;
}

/**
 * Store a website enquiry first (so nothing is lost if email is down), then notify admins in-app and by email.
 * Returns the stored enquiry and the delivery promise; the HTTP handler does not wait for SMTP.
 */
export async function submitWebsiteEnquiry(data, ip) {
  const enquiry = await withTransaction(async (db) => {
    const created = await repo.insertEnquiry(data, { source: 'website', ip }, db);
    await notifyRole(
      'admin',
      { type: 'enquiry_received', title: `New enquiry from ${created.name}`, body: created.subject, link: '/admin/enquiries' },
      db,
    );
    await logActivity(
      {
        action: 'enquiry.received',
        entityType: 'enquiry',
        entityId: created.id,
        description: `New website enquiry from ${created.name}`,
        ip,
      },
      db,
    );
    return created;
  });
  const delivery = deliverNotification(enquiry).catch((err) => {
    logger.error('Enquiry notification failed', { enquiryId: enquiry.id, error: err.message });
    return { status: 'failed' };
  });
  return { enquiry, delivery };
}

/** Enquiries taken by phone / in person. No notification email — the admin entering it already knows. */
export async function createManualEnquiry(data, actor) {
  return withTransaction(async (db) => {
    const created = await repo.insertEnquiry(data, { source: 'admin', createdBy: actor.id, emailStatus: 'skipped' }, db);
    await logActivity(
      {
        actorId: actor.id,
        action: 'enquiry.created',
        entityType: 'enquiry',
        entityId: created.id,
        description: `Enquiry from ${created.name} recorded`,
      },
      db,
    );
    return created;
  });
}

export const listEnquiries = (query) => repo.listEnquiries(query);
export const enquiryStatusCounts = () => repo.statusCounts();

export async function getEnquiry(id) {
  const enquiry = await repo.findEnquiry(id);
  if (!enquiry) throw notFound('Enquiry');
  return { ...enquiry, notes: await repo.enquiryNotes(id) };
}

/** Status changes are recorded as notes too, giving each enquiry a follow-up timeline. */
export async function updateEnquiry(id, changes, actor) {
  await withTransaction(async (db) => {
    const existing = await repo.findEnquiry(id, db);
    if (!existing) throw notFound('Enquiry');
    const updated = await repo.updateEnquiry(id, changes, db);
    if (changes.status && changes.status !== existing.status) {
      const text = `Status changed from ${STATUS_LABEL[existing.status]} to ${STATUS_LABEL[changes.status]}`;
      await repo.insertNote(id, actor.id, text, db);
      await logActivity(
        {
          actorId: actor.id,
          action: 'enquiry.status_changed',
          entityType: 'enquiry',
          entityId: id,
          description: `Enquiry from ${updated.name}: ${text.toLowerCase()}`,
        },
        db,
      );
    }
  });
  return getEnquiry(id);
}

export async function addNote(id, note, actor) {
  if (!(await repo.findEnquiry(id))) throw notFound('Enquiry');
  await repo.insertNote(id, actor.id, note);
  return getEnquiry(id);
}

export async function retryNotification(id) {
  const enquiry = await repo.findEnquiry(id);
  if (!enquiry) throw notFound('Enquiry');
  await deliverNotification(enquiry);
  return getEnquiry(id);
}
