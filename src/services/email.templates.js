import { env } from '../config/env.js';

const escapeHtml = (s = '') =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const layout = (title, bodyHtml) => `<!doctype html>
<html><body style="margin:0;background:#f4f7fb;font-family:Arial,Helvetica,sans-serif;color:#1f2a44">
  <table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
    <table width="560" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px;overflow:hidden">
      <tr><td style="background:#0e2a54;color:#fff;padding:20px 28px;font-size:20px;font-weight:bold">MIATA</td></tr>
      <tr><td style="padding:28px">
        <h2 style="margin:0 0 16px;font-size:18px;color:#0e2a54">${escapeHtml(title)}</h2>
        ${bodyHtml}
      </td></tr>
      <tr><td style="padding:16px 28px;background:#f4f7fb;font-size:12px;color:#6b7a90">
        Medical Imaging Accredited Training Academy · Level 3, Queen St, Melbourne VIC 3000
      </td></tr>
    </table>
  </td></tr></table>
</body></html>`;

const button = (href, label) =>
  `<p style="margin:24px 0"><a href="${escapeHtml(href)}" style="background:#1d519b;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:bold">${escapeHtml(label)}</a></p>`;

export function enquiryNotificationEmail(enquiry) {
  const rows = [
    ['Name', enquiry.name],
    ['Email', enquiry.email],
    ['Phone', enquiry.phone || '—'],
    ['Subject', enquiry.subject || '—'],
    ['Course interest', enquiry.course_interest || '—'],
  ];
  const text = `New enquiry #${enquiry.id}\n\n${rows.map(([k, v]) => `${k}: ${v}`).join('\n')}\n\n${enquiry.message}\n\nManage: ${env.frontendUrl}/admin/enquiries`;
  const html = layout(
    `New enquiry #${enquiry.id}`,
    `<table cellpadding="6" style="font-size:14px">${rows
      .map(([k, v]) => `<tr><td style="color:#6b7a90">${k}</td><td><strong>${escapeHtml(v)}</strong></td></tr>`)
      .join('')}</table>
     <p style="white-space:pre-wrap;font-size:14px;line-height:1.6;border-left:3px solid #c9a033;padding-left:12px">${escapeHtml(enquiry.message)}</p>
     ${button(`${env.frontendUrl}/admin/enquiries`, 'Open enquiries')}`,
  );
  return { subject: `New MIATA enquiry from ${enquiry.name}`, text, html };
}

export function passwordResetEmail(user, link, { reason } = {}) {
  const intro =
    reason === 'course_completed'
      ? 'Congratulations on completing your course! For your security, please set a new password before signing in again.'
      : 'We received a request to reset the password for your MIATA account.';
  const text = `Hello ${user.full_name},\n\n${intro}\n\nReset your password (link valid for 30 minutes, single use):\n${link}\n\nIf you did not request this, you can ignore this email.`;
  const html = layout(
    'Reset your password',
    `<p style="font-size:14px;line-height:1.6">Hello ${escapeHtml(user.full_name)},</p>
     <p style="font-size:14px;line-height:1.6">${escapeHtml(intro)}</p>
     ${button(link, 'Set a new password')}
     <p style="font-size:12px;color:#6b7a90">This link is valid for 30 minutes and can be used once. If you did not request it, ignore this email.</p>`,
  );
  return { subject: 'Reset your MIATA password', text, html };
}

const detailTable = (rows) =>
  `<table cellpadding="6" style="font-size:14px">${rows
    .map(
      ([k, v]) => `<tr><td style="color:#6b7a90;vertical-align:top">${escapeHtml(k)}</td><td><strong>${escapeHtml(v)}</strong></td></tr>`,
    )
    .join('')}</table>`;
const detailText = (rows) => rows.map(([k, v]) => `  ${k}: ${v}`).join('\n');
const paragraph = (s) => `<p style="font-size:14px;line-height:1.6">${escapeHtml(s)}</p>`;

/**
 * Welcome / set-up e-mail for an admin-created account. It carries a single-use set-password link, never a password.
 * `details`: [[label, value]] account details (name, e-mail, role, ID, courses).
 */
export function welcomeEmail(user, { setupLink, validHours, details, resend = false }) {
  const loginUrl = `${env.frontendUrl}/login/${user.role}`;
  const intro = resend
    ? 'Here is a new link to set the password for your MIATA account.'
    : `Your MIATA ${user.role} account has been created. Set your password to start using it.`;
  const validity = `This link is valid for ${validHours} hours and can be used once.`;
  const signIn = `Then sign in at ${loginUrl} with your e-mail address and the password you chose.`;
  const expired = 'If the link has expired, use "Forgot password" on the sign-in page to get a new one.';
  const never = 'For your security, MIATA never sends passwords by e-mail.';
  const text = `Hello ${user.full_name},\n\n${intro}\n\nAccount details\n${detailText(details)}\n\nSet your password (valid for ${validHours} hours, single use):\n${setupLink}\n\n${signIn}\n${expired}\n\n${never}`;
  const html = layout(
    resend ? 'Set your MIATA password' : 'Welcome to MIATA',
    `${paragraph(`Hello ${user.full_name},`)}
     ${paragraph(intro)}
     ${detailTable(details)}
     ${button(setupLink, 'Set your password')}
     <p style="font-size:12px;color:#6b7a90">${escapeHtml(validity)} ${escapeHtml(expired)}</p>
     <p style="font-size:14px;line-height:1.6">Then sign in at <a href="${escapeHtml(loginUrl)}">${escapeHtml(loginUrl)}</a> with your e-mail address and the password you chose.</p>
     <p style="font-size:12px;color:#6b7a90">${escapeHtml(never)}</p>`,
  );
  return { subject: resend ? 'Set your MIATA password' : 'Your MIATA account is ready', text, html };
}

// ─── Online classes ─────────────────────────────────────────────────────

export const PLATFORM_LABEL = { google_meet: 'Google Meet', zoom: 'Zoom' };
const CHANGE_LABEL = {
  title: 'Title',
  batch: 'Batch',
  time: 'Date and time',
  duration: 'Duration',
  link: 'Meeting link',
  description: 'Description',
};

const zoned = (options) => new Intl.DateTimeFormat('en-AU', { timeZone: env.timeZone, ...options });

/** Date and time of a meeting in the configured time zone (APP_TIMEZONE), e.g. "Tuesday 20 October 2026", "10:00 am – 11:00 am GMT+5:30". */
export function meetingWhen({ starts_at: startsAt, duration_minutes: minutes }) {
  const start = new Date(startsAt);
  const end = new Date(start.getTime() + minutes * 60_000);
  return {
    date: zoned({ weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(start),
    time: `${zoned({ hour: 'numeric', minute: '2-digit' }).format(start)} – ${zoned({ hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(end)}`,
    short: zoned({ weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).format(start),
  };
}

/**
 * Invitation, update or cancellation of an online class, for one student. A meeting_cancelled e-mail for a meeting that
 * is still scheduled tells a student who was removed from its audience that the class is no longer scheduled for them.
 * Cancellation e-mails never contain the meeting link.
 */
export function meetingEmail(kind, { meeting, student, changes = [] }) {
  const when = meetingWhen(meeting);
  const platform = PLATFORM_LABEL[meeting.platform];
  const cancelled = kind === 'meeting_cancelled';
  const removed = cancelled && meeting.status !== 'cancelled';
  const copy = {
    meeting_scheduled: ['Online class scheduled', `${meeting.professor_name} has scheduled an online class for your batch.`],
    meeting_updated: [
      'Online class updated',
      `${meeting.professor_name} has changed the details of an online class. Please use the details below.`,
    ],
    meeting_cancelled: removed
      ? [
          'Online class no longer scheduled for you',
          `${meeting.professor_name} has changed who is invited to this online class, and it is no longer scheduled for you.`,
        ]
      : ['Online class cancelled', `${meeting.professor_name} has cancelled this online class.`],
  }[kind];
  const [heading, intro] = copy;

  const rows = [
    ['Class', meeting.title],
    ['Batch', meeting.batch_name],
    ['Professor', meeting.professor_name],
    ['Date', when.date],
    ['Time', when.time],
    ['Duration', `${meeting.duration_minutes} minutes`],
    ...(cancelled
      ? []
      : [
          ['Platform', platform],
          ['Meeting link', meeting.meeting_url],
        ]),
    ...(cancelled && !removed && meeting.cancel_reason ? [['Reason', meeting.cancel_reason]] : []),
  ];
  const changed = kind === 'meeting_updated' && changes.length ? `What changed: ${changes.map((c) => CHANGE_LABEL[c]).join(', ')}.` : null;
  const description = !cancelled && meeting.description ? meeting.description : null;
  const portal = `${env.frontendUrl}/student/meetings`;

  const text = [
    `Hello ${student.full_name},`,
    intro,
    changed,
    detailText(rows),
    description && `About this class:\n${description}`,
    cancelled ? null : `Join on ${platform}: ${meeting.meeting_url}`,
    `Your online classes in MIATA: ${portal}`,
  ]
    .filter(Boolean)
    .join('\n\n');
  const html = layout(
    heading,
    `${paragraph(`Hello ${student.full_name},`)}
     ${paragraph(intro)}
     ${changed ? `<p style="font-size:14px;line-height:1.6;color:#b45309"><strong>${escapeHtml(changed)}</strong></p>` : ''}
     ${detailTable(rows)}
     ${description ? `<p style="white-space:pre-wrap;font-size:14px;line-height:1.6;border-left:3px solid #c9a033;padding-left:12px">${escapeHtml(description)}</p>` : ''}
     ${cancelled ? '' : button(meeting.meeting_url, `Join on ${platform}`)}
     <p style="font-size:12px;color:#6b7a90">See all your online classes in <a href="${escapeHtml(portal)}">MIATA</a>.</p>`,
  );
  return { subject: `${heading}: ${meeting.title} (${when.short})`, text, html };
}
