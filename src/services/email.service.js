import nodemailer from 'nodemailer';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

const transporter = env.smtp.host
  ? nodemailer.createTransport({
      host: env.smtp.host,
      port: env.smtp.port,
      secure: env.smtp.secure,
      auth: env.smtp.user ? { user: env.smtp.user, pass: env.smtp.password } : undefined,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
    })
  : null;

export const isEmailConfigured = () => Boolean(transporter && env.smtp.from);

/**
 * Send an email. Never throws: returns { status: 'sent' | 'failed' | 'skipped', error? }
 * so callers can record the real outcome instead of assuming success.
 */
export async function sendEmail({ to, subject, text, html }) {
  const recipients = Array.isArray(to) ? to.filter(Boolean) : [to].filter(Boolean);
  if (!isEmailConfigured()) return { status: 'skipped', error: 'SMTP is not configured' };
  if (!recipients.length) return { status: 'skipped', error: 'No recipient configured (ENQUIRY_NOTIFY_EMAIL)' };
  try {
    await transporter.sendMail({ from: env.smtp.from, to: recipients.join(', '), subject, text, html });
    return { status: 'sent' };
  } catch (err) {
    logger.error('Email delivery failed', { subject, error: err.message });
    return { status: 'failed', error: err.message.slice(0, 500) };
  }
}

/** Verify SMTP credentials at startup (logged only — the API keeps working without email). */
export async function verifyEmailTransport() {
  if (!transporter) {
    logger.warn('SMTP is not configured — emails will be recorded as "skipped". Set SMTP_* in miata-api/.env.');
    return false;
  }
  try {
    await transporter.verify();
    logger.info('SMTP connection verified');
    return true;
  } catch (err) {
    logger.error('SMTP verification failed — emails will fail until this is fixed', { error: err.message });
    return false;
  }
}
