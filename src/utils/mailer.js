import nodemailer from 'nodemailer';

/**
 * Outbound mail (Nodemailer) — used for the admin login OTP. Same SMTP mailbox as
 * the booking app (SMTP_* env; Gmail needs an App Password).
 *
 * When SMTP is not configured the transporter is null and admin login degrades to
 * single-step (with a server-side warning) instead of locking everyone out.
 */
const HOST = process.env.SMTP_HOST;
const PORT = Number(process.env.SMTP_PORT) || 587;
const USER = process.env.SMTP_USER;
const PASS = process.env.SMTP_PASS;

let transporter = null;
if (HOST && USER && PASS) {
  transporter = nodemailer.createTransport({
    host: HOST,
    port: PORT,
    secure: process.env.SMTP_SECURE === 'true' || PORT === 465,
    auth: { user: USER, pass: PASS },
  });
  console.log(`[rgaccount-api] Mailer ready (${HOST}:${PORT})`);
} else {
  console.warn('[rgaccount-api] SMTP not configured — admin login OTP is DISABLED until SMTP_HOST/SMTP_USER/SMTP_PASS are set');
}

export const mailerEnabled = () => !!transporter;

/** Send the 6-digit login code. Throws on delivery failure (caller surfaces 502). */
export async function sendLoginOtpEmail({ to, name, otp, minutes }) {
  const brand = '#1d4ed8';
  await transporter.sendMail({
    from: process.env.SMTP_FROM || `"DG Account ERP" <${USER}>`,
    to,
    subject: `${otp} is your DG Account sign-in code`,
    text: `Hello ${name || ''}\n\nYour DG Account sign-in verification code is: ${otp}\nIt expires in ${minutes} minutes.\n\nIf you did not try to sign in, please change your password immediately.`,
    html: `
      <div style="font-family:Arial,Helvetica,sans-serif;max-width:440px;margin:0 auto;padding:24px;border:1px solid #e2e8f0;border-radius:12px">
        <h2 style="color:${brand};margin:0 0 4px">DG Account</h2>
        <p style="color:#64748b;font-size:12px;margin:0 0 20px">Accounting ERP — sign-in verification</p>
        <p style="color:#0f172a;font-size:14px">Hello ${name || 'Admin'},</p>
        <p style="color:#0f172a;font-size:14px">Use this code to finish signing in:</p>
        <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:10px;text-align:center;padding:16px;margin:16px 0">
          <span style="font-size:32px;letter-spacing:10px;font-weight:bold;color:${brand}">${otp}</span>
        </div>
        <p style="color:#64748b;font-size:12px">The code expires in <b>${minutes} minutes</b> and works only once.</p>
        <p style="color:#94a3b8;font-size:11px;margin-top:20px">Didn't try to sign in? Change your password immediately and inform your administrator.</p>
      </div>`,
  });
}

/** Compliance reminders share the configured SMTP transport but use a separate,
 * plain operational template. Throws on delivery failure so the scheduler can
 * persist a retryable FAILED notification log row. */
export async function sendComplianceReminderEmail({
  to, name, title, message, dueDate, siteName, actionUrl,
}) {
  if (!transporter) throw new Error('SMTP is not configured');
  const safe = (value) => String(value || '').replace(/[<>&"]/g, (char) => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;',
  }[char]));
  await transporter.sendMail({
    from: process.env.SMTP_FROM || `"DG Account ERP" <${USER}>`,
    to,
    subject: String(title || 'Compliance reminder'),
    text: `${message}\n${dueDate ? `Due: ${dueDate}\n` : ''}${siteName ? `Site: ${siteName}\n` : ''}${actionUrl || ''}`,
    html: `
      <div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:auto;padding:24px;border:1px solid #e2e8f0;border-radius:14px">
        <p style="margin:0;color:#2563eb;font-size:12px;font-weight:bold;letter-spacing:.08em;text-transform:uppercase">DG Account Compliance</p>
        <h2 style="margin:8px 0 12px;color:#0f172a">${safe(title)}</h2>
        <p style="color:#334155;line-height:1.6">${safe(message)}</p>
        ${dueDate ? `<p style="color:#475569"><b>Due:</b> ${safe(dueDate)}</p>` : ''}
        ${siteName ? `<p style="color:#475569"><b>Site:</b> ${safe(siteName)}</p>` : ''}
        ${actionUrl ? `<a href="${safe(actionUrl)}" style="display:inline-block;margin-top:14px;background:#2563eb;color:white;text-decoration:none;padding:10px 16px;border-radius:9px">Open in DG Account</a>` : ''}
      </div>`,
  });
}

const escapeHtml = (value) => String(value || '').replace(/[<>&"']/g, (char) => ({
  '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;',
}[char]));

const readableReminder = (type) => ({
  DAY_BEFORE: { subjectLead: 'Reminder:', highlight: 'TOMORROW', copy: 'is tomorrow' },
  EVENT_DAY: { subjectLead: 'Today:', highlight: 'TODAY', copy: 'is today' },
  THIRTY_MINUTES_BEFORE: { subjectLead: 'Starting in 30 minutes:', highlight: 'STARTS SOON', copy: 'starts in 30 minutes' },
}[type] || { subjectLead: 'Reminder:', highlight: 'REMINDER', copy: 'is coming up' });

/** Branded event reminder. A deterministic Message-ID lets capable SMTP
 * providers suppress a retry of the same claimed database job. */
export async function sendEventReminderEmail({
  to, name, reminderType, event, formattedDate, formattedTime, actionUrl, messageId,
}) {
  if (!transporter) throw new Error('SMTP is not configured');
  const wording = readableReminder(reminderType);
  const subject = `${wording.subjectLead} ${event.title}${reminderType === 'DAY_BEFORE' ? ' is tomorrow' : ''}`;
  const details = [
    ['Event', event.title], ['Date', formattedDate], ['Time', formattedTime || 'All day'],
    ['Site / Project', event.siteName], ['Location', event.location],
    ['Description / Notes', event.description],
    ['Assigned users', (event.assignedNames || []).join(', ')],
  ].filter(([, value]) => value);
  const info = await transporter.sendMail({
    from: process.env.SMTP_FROM || `"DG Account ERP" <${USER}>`,
    to,
    subject,
    messageId,
    text: [
      `Hello ${name || 'there'},`, '', `${event.title} ${wording.copy}.`,
      ...details.map(([label, value]) => `${label}: ${value}`), '', actionUrl || '',
    ].join('\n'),
    html: `
      <div style="background:#f8fafc;padding:28px 12px;font-family:Arial,Helvetica,sans-serif;color:#0f172a">
        <div style="max-width:600px;margin:auto;background:#fff;border:1px solid #e2e8f0;border-radius:16px;overflow:hidden">
          <div style="padding:22px 26px;border-bottom:1px solid #e2e8f0">
            <div style="color:#2563eb;font-size:12px;font-weight:700;letter-spacing:.1em">DG ACCOUNT ERP</div>
            <div style="margin-top:14px;display:inline-block;background:#eff6ff;color:#1d4ed8;border-radius:999px;padding:6px 10px;font-size:11px;font-weight:700;letter-spacing:.08em">${wording.highlight}</div>
            <h1 style="font-size:22px;line-height:1.3;margin:12px 0 0">${escapeHtml(event.title)}</h1>
            ${reminderType === 'THIRTY_MINUTES_BEFORE' && formattedTime ? `<p style="margin:8px 0 0;color:#475569;font-size:14px">Starts at <strong>${escapeHtml(formattedTime)}</strong></p>` : ''}
          </div>
          <div style="padding:20px 26px">
            <p style="margin:0 0 18px;color:#475569;font-size:14px">Hello ${escapeHtml(name || 'there')}, this is your scheduled event reminder.</p>
            <table role="presentation" style="width:100%;border-collapse:collapse;font-size:13px">
              ${details.map(([label, value]) => `<tr><td style="width:138px;padding:8px 10px 8px 0;color:#64748b;vertical-align:top">${escapeHtml(label)}</td><td style="padding:8px 0;font-weight:600;line-height:1.45">${escapeHtml(value)}</td></tr>`).join('')}
            </table>
            ${actionUrl ? `<a href="${escapeHtml(actionUrl)}" style="display:inline-block;margin-top:20px;background:#2563eb;color:#fff;text-decoration:none;padding:11px 16px;border-radius:9px;font-size:13px;font-weight:700">Open in ERP</a>` : ''}
          </div>
          <div style="padding:13px 26px;background:#f8fafc;color:#94a3b8;font-size:11px">Sent automatically by the DG Account reminder engine.</div>
        </div>
      </div>`,
  });
  return { messageId: info.messageId || messageId };
}
