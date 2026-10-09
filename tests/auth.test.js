import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import Database from 'better-sqlite3';

function createSmtpSink() {
  const codes = [];
  const recipients = [];
  const messages = [];
  const server = net.createServer((socket) => {
    socket.write('220 attendance-test ESMTP\r\n');
    let incoming = '';
    let dataLines = [];
    let readingData = false;
    let authLoginStep = 0;
    socket.on('data', (chunk) => {
      incoming += chunk.toString('utf8');
      let lineEnd;
      while ((lineEnd = incoming.indexOf('\r\n')) >= 0) {
        const line = incoming.slice(0, lineEnd);
        incoming = incoming.slice(lineEnd + 2);
        if (readingData) {
          if (line === '.') {
            readingData = false;
            const code = dataLines.join('\n').match(/\b\d{6}\b/)?.[0];
            if (code) codes.push(code);
            messages.push(dataLines.join('\n'));
            dataLines = [];
            socket.write('250 2.0.0 queued\r\n');
          } else {
            dataLines.push(line.startsWith('..') ? line.slice(1) : line);
          }
          continue;
        }
        const command = line.toUpperCase();
        if (authLoginStep === 1) {
          authLoginStep = 2;
          socket.write('334 UGFzc3dvcmQ6\r\n');
        } else if (authLoginStep === 2) {
          authLoginStep = 0;
          socket.write('235 2.7.0 authenticated\r\n');
        } else if (command.startsWith('EHLO') || command.startsWith('HELO')) socket.write('250-attendance-test\r\n250-AUTH PLAIN LOGIN\r\n250 OK\r\n');
        else if (command.startsWith('AUTH PLAIN')) socket.write('235 2.7.0 authenticated\r\n');
        else if (command === 'AUTH LOGIN') {
          authLoginStep = 1;
          socket.write('334 VXNlcm5hbWU6\r\n');
        }
        else if (command.startsWith('RCPT TO:')) {
          recipients.push(line.match(/<([^>]+)>/)?.[1]?.toLowerCase());
          socket.write('250 2.1.0 accepted\r\n');
        } else if (command.startsWith('MAIL FROM:')) socket.write('250 2.1.0 accepted\r\n');
        else if (command === 'DATA') {
          readingData = true;
          socket.write('354 end with <CRLF>.<CRLF>\r\n');
        } else if (command === 'QUIT') socket.end('221 2.0.0 bye\r\n');
        else socket.write('250 2.0.0 ok\r\n');
      }
    });
  });
  return {
    codes,
    recipients,
    messages,
    server,
    async nextCode() {
      const end = Date.now() + 5000;
      while (Date.now() < end) {
        const code = codes.shift();
        if (code) return code;
        await delay(10);
      }
      throw new Error('Timed out waiting for a verification email.');
    }
  };
}

async function jsonRequest(baseUrl, route, { method = 'GET', body, cookie } = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(cookie ? { cookie } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  return {
    status: response.status,
    body: await response.json().catch(() => ({})),
    cookie: response.headers.get('set-cookie')?.split(';')[0]
  };
}

test('admins sign up, verify by OTP, invite accounts, and persist secure sessions', async (t) => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'attendance-auth-'));
  const databasePath = path.join(temporaryDirectory, 'auth.sqlite');
  const smtp = createSmtpSink();
  await new Promise((resolve) => smtp.server.listen(0, '127.0.0.1', resolve));
  const smtpPort = smtp.server.address().port;
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = databasePath;
  process.env.JWT_SECRET = crypto.randomBytes(32).toString('hex');
  process.env.SMTP_HOST = '127.0.0.1';
  process.env.SMTP_PORT = String(smtpPort);
  process.env.SMTP_SECURE = 'false';
  process.env.SMTP_USER = 'test-smtp-user';
  process.env.SMTP_PASSWORD = 'test-smtp-password';
  process.env.SMTP_FROM = 'attendance-test@example.test';

  const { app, initializeAuthDatabase, closeAuthDatabase } = await import('../server.js');
  initializeAuthDatabase();
  let server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  let baseUrl = `http://127.0.0.1:${server.address().port}`;
  let inspectionDb;
  const stopServer = async () => {
    if (!server.listening) return;
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  };
  t.after(async () => {
    await stopServer();
    inspectionDb?.close();
    closeAuthDatabase();
    await new Promise((resolve) => smtp.server.close(resolve));
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    for (const key of ['NODE_ENV', 'DATABASE_URL', 'JWT_SECRET', 'SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASSWORD', 'SMTP_FROM']) {
      delete process.env[key];
    }
  });

  let status = await jsonRequest(baseUrl, '/api/auth/status');
  assert.equal(status.body.firstAdminSetupRequired, true);
  const initialAdmin = {
    name: 'First Administrator',
    email: 'admin-one@example.test',
    password: 'FirstAdminPassword!',
    confirmPassword: 'FirstAdminPassword!',
    role: 'SUPER_ADMIN'
  };
  let result = await jsonRequest(baseUrl, '/api/auth/signup', { method: 'POST', body: initialAdmin });
  assert.equal(result.status, 201);
  assert.equal(result.body.otpPurpose, 'verify');
  assert.equal(Object.hasOwn(result.body, 'code'), false);
  const firstCode = await smtp.nextCode();
  assert.ok(smtp.recipients.includes(initialAdmin.email), 'the OTP is delivered to the registering admin email');
  assert.equal(JSON.stringify(result.body).includes(firstCode), false);
  assert.equal((await jsonRequest(baseUrl, '/api/auth/status')).body.firstAdminSetupRequired, false);
  result = await jsonRequest(baseUrl, '/api/auth/signup', {
    method: 'POST',
    body: {
      name: 'Uninvited Account',
      email: 'uninvited@example.test',
      password: 'UninvitedPassword!',
      confirmPassword: 'UninvitedPassword!'
    }
  });
  assert.equal(result.status, 403, 'new accounts must require an invitation after first-admin signup starts');
  assert.match(smtp.messages[0], /Attendance Management System - Verify Your Account/i);
  assert.match(smtp.messages[0], /First Administrator/);
  assert.match(smtp.messages[0], /admin-one@example\.test/);
  assert.match(smtp.messages[0], /ADMIN/);
  assert.match(smtp.messages[0], /valid for 10 minutes/i);
  assert.match(smtp.messages[0], /Content-Type: text\/html/i, 'auth email must include the shared HTML template');
  inspectionDb = new Database(databasePath);
  const pendingFirst = inspectionDb.prepare('SELECT password_hash FROM admins WHERE email = ?').get(initialAdmin.email);
  const firstOtpHash = inspectionDb.prepare('SELECT otp_hash FROM otp_verifications WHERE admin_id = (SELECT id FROM admins WHERE email = ?)').get(initialAdmin.email).otp_hash;
  assert.notEqual(pendingFirst.password_hash, initialAdmin.password);
  assert.notEqual(firstOtpHash, firstCode);
  result = await jsonRequest(baseUrl, '/api/auth/resend-otp', {
    method: 'POST',
    body: { purpose: 'verify', email: initialAdmin.email }
  });
  assert.equal(result.status, 429, 'OTP resend must enforce a cooldown');

  result = await jsonRequest(baseUrl, '/api/auth/login', { method: 'POST', body: { email: initialAdmin.email, password: initialAdmin.password } });
  assert.equal(result.status, 401, 'unverified accounts must not log in');
  result = await jsonRequest(baseUrl, '/api/auth/verify-otp', {
    method: 'POST',
    body: { purpose: 'verify', email: initialAdmin.email, code: (Number(firstCode) + 1).toString().padStart(6, '0') }
  });
  assert.equal(result.status, 400, 'wrong OTP must be rejected');

  inspectionDb.prepare('UPDATE otp_verifications SET expires_at = ?, last_sent_at = 0').run(Date.now() - 1);
  result = await jsonRequest(baseUrl, '/api/auth/verify-otp', {
    method: 'POST',
    body: { purpose: 'verify', email: initialAdmin.email, code: firstCode }
  });
  assert.equal(result.status, 400, 'expired OTP must be rejected');
  result = await jsonRequest(baseUrl, '/api/auth/resend-otp', {
    method: 'POST',
    body: { purpose: 'verify', email: initialAdmin.email }
  });
  assert.equal(result.status, 200);
  const freshFirstCode = await smtp.nextCode();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    result = await jsonRequest(baseUrl, '/api/auth/verify-otp', {
      method: 'POST',
      body: { purpose: 'verify', email: initialAdmin.email, code: (Number(freshFirstCode) + 1).toString().padStart(6, '0') }
    });
    assert.equal(result.status, 400);
  }
  result = await jsonRequest(baseUrl, '/api/auth/verify-otp', {
    method: 'POST',
    body: { purpose: 'verify', email: initialAdmin.email, code: freshFirstCode }
  });
  assert.equal(result.status, 400, 'five wrong codes must exhaust the OTP');
  inspectionDb.prepare('UPDATE otp_verifications SET last_sent_at = 0').run();
  result = await jsonRequest(baseUrl, '/api/auth/resend-otp', {
    method: 'POST',
    body: { purpose: 'verify', email: initialAdmin.email }
  });
  assert.equal(result.status, 200);
  const verifiedFirstCode = await smtp.nextCode();
  result = await jsonRequest(baseUrl, '/api/auth/verify-otp', {
    method: 'POST',
    body: { purpose: 'verify', email: initialAdmin.email, code: verifiedFirstCode }
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.emailNotification, 'sent');
  const welcomeMessage = smtp.messages.find((mail) => mail.includes('Subject: Welcome to the Attendance Management System'));
  assert.ok(welcomeMessage);
  assert.match(welcomeMessage, /admin-one@example\.test/);
  assert.equal(inspectionDb.pragma('user_version', { simple: true }), 2);

  const firstLogin = await jsonRequest(baseUrl, '/api/auth/login', {
    method: 'POST',
    body: { email: initialAdmin.email, password: initialAdmin.password }
  });
  assert.equal(firstLogin.status, 200);
  const firstCookie = firstLogin.cookie;
  assert.ok(firstCookie);
  const storedFirst = inspectionDb.prepare('SELECT password_hash, role, is_verified FROM admins WHERE email = ?').get(initialAdmin.email);
  assert.equal(storedFirst.role, 'ADMIN');
  assert.equal(storedFirst.is_verified, 1);
  assert.match(storedFirst.password_hash, /^bcrypt-sha256:\$2[aby]\$/);
  assert.notEqual(storedFirst.password_hash, initialAdmin.password);
  assert.equal(inspectionDb.prepare('SELECT COUNT(*) AS count FROM otp_verifications WHERE admin_id = (SELECT id FROM admins WHERE email = ?)').get(initialAdmin.email).count, 0);
  assert.equal((await jsonRequest(baseUrl, '/api/admins')).status, 401, 'admin management requires a session');

  result = await jsonRequest(baseUrl, '/api/admins/invite', {
    method: 'POST',
    cookie: firstCookie,
    body: { name: 'Second Administrator', email: 'admin-two@example.test', role: 'SUPER_ADMIN' }
  });
  assert.equal(result.status, 201);
  const inviteCode = await smtp.nextCode();
  assert.ok(smtp.recipients.includes('admin-two@example.test'), 'the invitation OTP goes to the invited admin email');
  const invitationMessage = smtp.messages.find((mail) => mail.includes('You have been invited as an administrator'));
  assert.ok(invitationMessage);
  assert.match(invitationMessage, /Second Administrator/);
  assert.match(invitationMessage, /Assigned Role|ADMIN/);
  inspectionDb.prepare('UPDATE otp_verifications SET last_sent_at = 0 WHERE admin_id = (SELECT id FROM admins WHERE email = ?)').run('admin-two@example.test');
  result = await jsonRequest(baseUrl, '/api/auth/resend-otp', {
    method: 'POST',
    body: { purpose: 'invite', email: 'admin-two@example.test' }
  });
  assert.equal(result.status, 200);
  const refreshedInviteCode = await smtp.nextCode();
  result = await jsonRequest(baseUrl, '/api/auth/verify-otp', {
    method: 'POST',
    body: { purpose: 'invite', email: 'admin-two@example.test', code: inviteCode }
  });
  assert.equal(result.status, 400, 'resending must invalidate the previous OTP');
  result = await jsonRequest(baseUrl, '/api/auth/signup', {
    method: 'POST',
    body: {
      name: 'Second Administrator',
      email: 'admin-two@example.test',
      password: 'SecondAdminPassword!',
      confirmPassword: 'SecondAdminPassword!',
      role: 'SUPER_ADMIN'
    }
  });
  assert.equal(result.status, 201);
  assert.equal(result.body.otpPurpose, 'invite');
  result = await jsonRequest(baseUrl, '/api/auth/verify-otp', {
    method: 'POST',
    body: { purpose: 'invite', email: 'admin-two@example.test', code: (Number(refreshedInviteCode) + 1).toString().padStart(6, '0') }
  });
  assert.equal(result.status, 400, 'wrong invitation OTP must be rejected');
  result = await jsonRequest(baseUrl, '/api/auth/verify-otp', {
    method: 'POST',
    body: { purpose: 'invite', email: 'admin-two@example.test', code: refreshedInviteCode }
  });
  assert.equal(result.status, 200);

  const secondAdmin = inspectionDb.prepare('SELECT password_hash, role, is_verified FROM admins WHERE email = ?').get('admin-two@example.test');
  assert.equal(secondAdmin.role, 'ADMIN');
  assert.equal(secondAdmin.is_verified, 1);
  assert.match(secondAdmin.password_hash, /^bcrypt-sha256:\$2[aby]\$/);
  result = await jsonRequest(baseUrl, '/api/auth/login', {
    method: 'POST',
    body: { email: 'admin-two@example.test', password: initialAdmin.password }
  });
  assert.equal(result.status, 401, 'admins must have independent passwords');
  const secondLogin = await jsonRequest(baseUrl, '/api/auth/login', {
    method: 'POST',
    body: { email: 'admin-two@example.test', password: 'SecondAdminPassword!' }
  });
  assert.equal(secondLogin.status, 200);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    result = await jsonRequest(baseUrl, '/api/auth/login', {
      method: 'POST',
      body: { email: 'unknown-admin@example.test', password: 'WrongPassword123!' }
    });
    assert.equal(result.status, 401);
  }
  result = await jsonRequest(baseUrl, '/api/auth/login', {
    method: 'POST',
    body: { email: 'unknown-admin@example.test', password: 'WrongPassword123!' }
  });
  assert.equal(result.status, 429, 'login attempts must be rate limited');
  result = await jsonRequest(baseUrl, '/api/admins/invite', {
    method: 'POST',
    cookie: firstCookie,
    body: { name: 'Second Administrator', email: 'admin-two@example.test' }
  });
  assert.equal(result.status, 409, 'duplicate email invitations must be rejected');
  result = await jsonRequest(baseUrl, '/api/auth/signup', {
    method: 'POST',
    body: initialAdmin
  });
  assert.equal(result.status, 409, 'duplicate signup emails must be rejected');

  await stopServer();
  closeAuthDatabase();
  initializeAuthDatabase();
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  result = await jsonRequest(baseUrl, '/api/me', { cookie: firstCookie });
  assert.equal(result.body.instructor, true, 'database sessions must survive application restart');
  assert.equal(inspectionDb.prepare('SELECT COUNT(*) AS count FROM admins').get().count, 2);

  result = await jsonRequest(baseUrl, `/api/admins/${encodeURIComponent(inspectionDb.prepare('SELECT id FROM admins WHERE email = ?').get('admin-two@example.test').id)}/status`, {
    method: 'PATCH',
    cookie: firstCookie,
    body: { active: false, role: 'SUPER_ADMIN' }
  });
  assert.equal(result.status, 200);
  result = await jsonRequest(baseUrl, '/api/auth/login', {
    method: 'POST',
    body: { email: 'admin-two@example.test', password: 'SecondAdminPassword!' }
  });
  assert.equal(result.status, 401, 'deactivated admins cannot log in');
  result = await jsonRequest(baseUrl, '/api/me', { cookie: secondLogin.cookie });
  assert.equal(result.body.instructor, false, 'deactivation invalidates existing sessions');
  result = await jsonRequest(baseUrl, `/api/admins/${encodeURIComponent(inspectionDb.prepare('SELECT id FROM admins WHERE email = ?').get(initialAdmin.email).id)}/status`, {
    method: 'PATCH',
    cookie: firstCookie,
    body: { active: false }
  });
  assert.equal(result.status, 400, 'the last active verified admin cannot be deactivated');

  result = await jsonRequest(baseUrl, '/api/auth/resend-otp', {
    method: 'POST',
    body: { purpose: 'reset', email: initialAdmin.email }
  });
  assert.equal(result.status, 200);
  const resetCode = await smtp.nextCode();
  result = await jsonRequest(baseUrl, '/api/auth/verify-otp', {
    method: 'POST',
    body: {
      purpose: 'reset',
      email: initialAdmin.email,
      code: resetCode,
      password: 'UpdatedFirstAdminPassword!',
      confirmPassword: 'UpdatedFirstAdminPassword!'
    }
  });
  assert.equal(result.status, 200);
  assert.equal((await jsonRequest(baseUrl, '/api/me', { cookie: firstCookie })).body.instructor, false, 'password reset revokes sessions');
  assert.equal((await jsonRequest(baseUrl, '/api/auth/login', {
    method: 'POST',
    body: { email: initialAdmin.email, password: initialAdmin.password }
  })).status, 401);
  assert.equal((await jsonRequest(baseUrl, '/api/auth/login', {
    method: 'POST',
    body: { email: initialAdmin.email, password: 'UpdatedFirstAdminPassword!' }
  })).status, 200);
});
