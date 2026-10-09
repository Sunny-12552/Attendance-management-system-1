import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildAccountStatusEmail,
  buildAbsenceNotificationEmail,
  buildAdminInvitationEmail,
  buildAdminOtpEmail,
  buildAttendanceNotificationEmail,
  buildAttendanceSummaryEmail,
  buildPasswordResetEmail,
  buildWelcomeEmail,
  emailConfigurationMessage,
  emailDeliveryErrorMessage,
  isEmailConfigured,
  sendEmail
} from '../email-service.js';

test('admin email templates include dynamic, safely rendered verification details', () => {
  const verification = buildAdminOtpEmail({
    name: 'Asha <Admin>',
    email: 'asha@example.test',
    role: 'ADMIN',
    otp: '123456',
    expiryMinutes: 10
  });
  assert.match(verification.subject, /Verify Your Account/);
  assert.match(verification.text, /Asha <Admin>/);
  assert.match(verification.html, /Asha &lt;Admin&gt;/);
  assert.match(verification.html, /asha@example\.test/);
  assert.match(verification.html, /ADMIN/);
  assert.match(verification.html, /123456/);
  assert.match(verification.html, /valid for 10 minutes/);
  assert.match(verification.html, /<table role="presentation"/);

  const invitation = buildAdminInvitationEmail({
    name: 'Priya Sharma',
    email: 'priya@example.test',
    role: 'ADMIN',
    otp: '456789'
  });
  assert.match(invitation.subject, /Invitation/);
  assert.match(invitation.html, /Priya Sharma/);
  assert.match(invitation.html, /priya@example\.test/);
  assert.match(invitation.html, /456789/);

  const reset = buildPasswordResetEmail({ name: 'Asha', otp: '654321', expiryMinutes: 10 });
  assert.match(reset.subject, /Password Reset OTP/);
  assert.match(reset.html, /654321/);
  assert.match(reset.text, /ignore this message/);
});

test('account status and welcome templates use the supplied account details', () => {
  const welcome = buildWelcomeEmail({ name: 'Sam', email: 'sam@example.test', role: 'ADMIN' });
  assert.match(welcome.html, /Sam/);
  assert.match(welcome.html, /sam@example\.test/);
  assert.match(welcome.html, /successfully verified/);

  const activated = buildAccountStatusEmail({
    name: 'Sam', email: 'sam@example.test', role: 'ADMIN', active: true
  });
  const deactivated = buildAccountStatusEmail({
    name: 'Sam', email: 'sam@example.test', role: 'ADMIN', active: false
  });
  assert.match(activated.subject, /Activated/);
  assert.match(deactivated.subject, /Deactivated/);
  assert.match(deactivated.text, /no longer be able to sign in/);
});

test('attendance templates render actual attendance and per-subject summary values', () => {
  const present = buildAttendanceNotificationEmail({
    studentName: 'Nila Rao',
    studentId: 'STU-000023',
    subject: 'Python Full Stack',
    date: '2026-10-08',
    time: '09:15:30',
    facultyName: 'Faculty One',
    status: 'Present'
  });
  for (const value of ['Nila Rao', 'STU-000023', 'Python Full Stack', '2026-10-08', '09:15:30', 'Faculty One', 'Present']) {
    assert.ok(present.text.includes(value), `attendance email should include ${value}`);
  }

  const absent = buildAbsenceNotificationEmail({
    studentName: 'Nila Rao',
    subject: 'Java Full Stack',
    date: '2026-10-08',
    facultyName: 'Faculty Two'
  });
  assert.match(absent.subject, /Java Full Stack/);
  assert.match(absent.html, /Nila Rao/);
  assert.match(absent.html, /Faculty Two/);
  assert.match(absent.html, /Absent/);

  const summary = buildAttendanceSummaryEmail({
    studentName: 'Nila Rao',
    totalClasses: 12,
    presentCount: 9,
    absentCount: 3,
    attendancePercentage: '75.00',
    subjectSummary: [
      { subject: 'Python Full Stack', total: 8, present: 6, percentage: '75.00' },
      { subject: 'Java Full Stack', total: 4, present: 3, percentage: '75.00' }
    ]
  });
  for (const value of ['12', '9', '3', '75.00%', 'Python Full Stack', 'Java Full Stack']) {
    assert.ok(summary.text.includes(value), `summary email should include ${value}`);
  }
});

test('SMTP configuration and delivery errors are safe for API responses', async () => {
  const keys = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASSWORD', 'SMTP_FROM', 'SMTP_SECURE'];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    for (const key of keys) delete process.env[key];
    assert.equal(isEmailConfigured(), false);
    assert.equal(emailConfigurationMessage(), 'Email service is not configured. Please configure SMTP settings.');
    await assert.rejects(
      sendEmail('student@example.test', { subject: 'Test', text: 'Test', html: '<p>Test</p>' }),
      (error) => error.code === 'EMAIL_NOT_CONFIGURED'
        && error.message === emailConfigurationMessage()
    );

    process.env.SMTP_HOST = '127.0.0.1';
    process.env.SMTP_PORT = '1';
    process.env.SMTP_USER = 'private-test-user';
    process.env.SMTP_PASSWORD = 'private-test-password';
    process.env.SMTP_FROM = 'sender@example.test';
    process.env.SMTP_SECURE = 'false';
    process.env.SMTP_HOST = 'smtp.gmail.com';
    assert.match(
      emailDeliveryErrorMessage({ code: 'EMAIL_AUTH_FAILED' }),
      /use a Google App Password as SMTP_PASSWORD/i
    );
    assert.doesNotMatch(
      emailDeliveryErrorMessage({ code: 'EMAIL_AUTH_FAILED' }),
      /private-test-password|smtp\.gmail\.com/
    );
    process.env.SMTP_HOST = '127.0.0.1';
    await assert.rejects(
      sendEmail('student@example.test', { subject: 'Test', text: 'Test', html: '<p>Test</p>' }),
      (error) => error.code === 'EMAIL_DELIVERY_FAILED'
        && error.message === 'Unable to send email.'
        && !error.message.includes(process.env.SMTP_PASSWORD)
    );
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});
