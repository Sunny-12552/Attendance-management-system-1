import 'dotenv/config';
import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import bcrypt from 'bcryptjs';
import Database from 'better-sqlite3';
import QRCode from 'qrcode';
import { google } from 'googleapis';
import { calendarDatesBetween, isCountedClassStatus, isHolidayDate, newestFirstDates, statusForUnmarkedDate } from './attendance-calendar.js';
import { bindDeviceToStudent } from './device-binding.js';
import { resolvePublicUrl as buildPublicUrl } from './public-url.js';
import {
  emailDeliveryErrorMessage,
  emailConfigurationMessage,
  isEmailConfigured,
  sendAccountStatusEmail,
  sendAbsenceNotification,
  sendAdminInvitation,
  sendAdminOtp,
  sendAttendanceNotification,
  sendAttendanceSummary,
  sendPasswordResetOtp,
  sendWelcomeEmail
} from './email-service.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const port = Number(process.env.PORT || 3000);
const httpsEnabled = process.env.HTTPS === 'true' && !!process.env.SSL_CERT_PATH && !!process.env.SSL_KEY_PATH;
const httpsOptions = httpsEnabled
  ? { key: fs.readFileSync(process.env.SSL_KEY_PATH, 'utf8'), cert: fs.readFileSync(process.env.SSL_CERT_PATH, 'utf8') }
  : null;
if (process.env.HTTPS === 'true' && !httpsEnabled) {
  console.warn('HTTPS requested but SSL_CERT_PATH/SSL_KEY_PATH are missing. Falling back to HTTP for local testing.');
}
const subjects = (process.env.SUBJECTS || 'AI-Native Full Stack,GenAI & Agentic AI,Python Full Stack,Java Full Stack,Data Science,MERN Stack Development,Frontend Development,Backend Development,DevOps & Cloud,Data Analytics').split(',').map((subject) => String(subject || '').trim().replace(/\s+/g, ' ')).filter(Boolean).slice(0, 10);
const batches = [...Array.from({ length: 10 }, (_, i) => `P${i + 1}`), ...Array.from({ length: 10 }, (_, i) => `J${i + 1}`), ...Array.from({ length: 10 }, (_, i) => `D${i + 1}`)];
const courseFor = (batch) => batch.startsWith('P') ? 'Python Full Stack' : batch.startsWith('J') ? 'Java Full Stack' : 'Data Science';
const sheetHeaders = ['Date', 'Time', 'Student Name', 'Batch', 'Course', 'Subject', 'Status', 'Attendance Source', 'Session ID'];
const sessions = new Map();
const studentRegistrationLocks = new Map();
const deviceAttendanceLocks = new Map();
const studentDeviceLocks = new Map();
const activeDeviceLockClaims = new Map();
const activeStudentDeviceLockClaims = new Map();
const DEVICE_LOCKS_PATH = process.env.DEVICE_LOCKS_PATH
  ? path.resolve(__dirname, process.env.DEVICE_LOCKS_PATH)
  : path.join(__dirname, '.device-locks.json');
const LEGACY_ADMIN_ACCOUNT_PATH = path.join(__dirname, '.admin-account.json');
const configuredSessionSecret = process.env.JWT_SECRET || process.env.SESSION_SECRET || '';
const sessionSecret = configuredSessionSecret || crypto.randomBytes(32).toString('hex');
const scrypt = promisify(crypto.scrypt);
const qrMinutes = Number(process.env.QR_MINUTES || Number.MAX_SAFE_INTEGER);
const minAttendancePercentage = Number(process.env.MIN_ATTENDANCE_PERCENTAGE || 75);
const databaseUrl = String(process.env.DATABASE_URL || './data/attendance.sqlite').trim();
const databasePath = path.resolve(__dirname, databaseUrl.replace(/^sqlite:/, ''));
let authDb = null;
const authRateLimits = new Map();
const dummyPasswordHash = bcrypt.hashSync(`invalid-password-${crypto.randomBytes(32).toString('hex')}`, 12);
const attendanceValidationRule = { condition: { type: 'ONE_OF_LIST', values: [{ userEnteredValue: 'Present' }, { userEnteredValue: 'Absent' }, { userEnteredValue: 'Holiday' }] }, showCustomUi: true, strict: false };
const holidays = new Set((process.env.HOLIDAYS || '').split(',').map((date) => date.trim()).filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date)));
const deviceLockMessage = 'Attendance Limit Reached. This device has already marked attendance for this subject.';
const deviceTokenPattern = /^[A-Za-z0-9._:-]{12,128}$/;

function ledgerSheetName(subject) { return `${subject} Ledger`; }

function resolvePublicUrl(req) {
  return buildPublicUrl(req, {
    configuredUrl: process.env.APP_URL,
    httpsEnabled: !!httpsOptions,
    port
  });
}

app.use(express.json({ limit: '20kb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.enable('trust proxy');

function sign(value) {
  return crypto.createHmac('sha256', sessionSecret).update(value).digest('hex');
}
function hashDeviceToken(deviceToken) {
  return crypto.createHash('sha256').update(String(deviceToken).trim()).digest('hex');
}
function isValidDeviceToken(deviceToken) {
  return typeof deviceToken === 'string' && deviceTokenPattern.test(deviceToken.trim());
}
function getDeviceLockKey(date, deviceToken, qrSessionId) {
  return `${String(date || '').trim()}|${String(qrSessionId || '').trim()}|${hashDeviceToken(deviceToken)}`;
}
function getStudentDeviceLockKey(name, batch) {
  return crypto.createHash('sha256')
    .update(`${normalizeName(name).toLowerCase()}|${String(batch || '').trim()}`)
    .digest('hex');
}
async function loadDeviceLocksFromDisk() {
  try {
    const raw = await fs.promises.readFile(DEVICE_LOCKS_PATH, 'utf8');
    const parsed = JSON.parse(raw || '{}');
    const savedDeviceLocks = parsed.deviceAttendanceLocks || parsed;
    for (const [key, value] of Object.entries(savedDeviceLocks || {})) {
      if (!value || typeof value !== 'object') continue;
      const parts = key.split('|');
      const qrSessionId = String(value.qrSessionId || parts[1] || '').trim();
      const deviceTokenHash = value.deviceTokenHash || parts[2] || '';
      if (!qrSessionId || !deviceTokenHash) continue;
      deviceAttendanceLocks.set(key, { ...value, qrSessionId, deviceTokenHash });
    }
    for (const [key, value] of Object.entries(parsed.studentDeviceLocks || {})) {
      if (value && typeof value.deviceTokenHash === 'string') studentDeviceLocks.set(key, value);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn('Unable to read device-lock store:', error.message);
  }
}
async function persistDeviceLocks() {
  await fs.promises.writeFile(DEVICE_LOCKS_PATH, JSON.stringify({
    deviceAttendanceLocks: Object.fromEntries(deviceAttendanceLocks),
    studentDeviceLocks: Object.fromEntries(studentDeviceLocks)
  }, null, 2), 'utf8');
}
async function isDeviceSessionAttendanceLocked(date, deviceToken, qrSessionId) {
  if (!isValidDeviceToken(deviceToken)) return true;
  return deviceAttendanceLocks.has(getDeviceLockKey(date, deviceToken, qrSessionId));
}
async function claimDeviceSessionAttendanceLock({ date, deviceToken, qrSessionId, subject, studentIdentifier }) {
  if (!isValidDeviceToken(deviceToken)) {
    return { allowed: false, reason: 'Unable to identify this device. Please refresh the page and try again.' };
  }

  const key = getDeviceLockKey(date, deviceToken, qrSessionId);
  const pending = activeDeviceLockClaims.get(key);
  if (pending) {
    await pending;
    return { allowed: false, reason: deviceLockMessage };
  }

  const attempt = (async () => {
    if (deviceAttendanceLocks.has(key)) {
      return { allowed: false, reason: deviceLockMessage };
    }
    const record = { date: String(date || '').trim(), qrSessionId: String(qrSessionId || '').trim(), subject: normalizeSubjectName(subject), deviceTokenHash: hashDeviceToken(deviceToken), studentIdentifier: String(studentIdentifier || '').trim(), createdAt: Date.now() };
    deviceAttendanceLocks.set(key, record);
    await persistDeviceLocks();
    return { allowed: true, record };
  })();

  activeDeviceLockClaims.set(key, attempt);
  try {
    return await attempt;
  } finally {
    activeDeviceLockClaims.delete(key);
  }
}
async function releaseDeviceSessionAttendanceLock(date, deviceToken, qrSessionId) {
  if (!isValidDeviceToken(deviceToken)) return false;
  const key = getDeviceLockKey(date, deviceToken, qrSessionId);
  if (!deviceAttendanceLocks.has(key)) return false;
  deviceAttendanceLocks.delete(key);
  await persistDeviceLocks();
  return true;
}
async function claimStudentDeviceLock(name, batch, deviceToken) {
  if (!isValidDeviceToken(deviceToken)) {
    return { allowed: false, reason: 'Unable to identify this device. Please refresh the page and try again.' };
  }
  const key = getStudentDeviceLockKey(name, batch);
  const deviceTokenHash = hashDeviceToken(deviceToken);
  const pending = activeStudentDeviceLockClaims.get(key);
  if (pending) await pending;

  const existing = studentDeviceLocks.get(key);
  if (existing) {
    return existing.deviceTokenHash === deviceTokenHash
      ? { allowed: true, newlyBound: false }
      : { allowed: false, reason: 'This student account is already linked to a different device. Use the device first used to mark attendance.' };
  }

  const attempt = (async () => {
    const binding = bindDeviceToStudent(studentDeviceLocks, key, deviceTokenHash);
    if (!binding.allowed) {
      return {
        ...binding,
        reason: 'This student account is already linked to a different device. Use the device first used to mark attendance.'
      };
    }
    if (!binding.newlyBound) return binding;
    try {
      await persistDeviceLocks();
    } catch (error) {
      studentDeviceLocks.delete(key);
      throw error;
    }
    return binding;
  })();
  activeStudentDeviceLockClaims.set(key, attempt);
  try {
    return await attempt;
  } finally {
    if (activeStudentDeviceLockClaims.get(key) === attempt) activeStudentDeviceLockClaims.delete(key);
  }
}
async function releaseStudentDeviceLock(name, batch, deviceToken) {
  if (!isValidDeviceToken(deviceToken)) return false;
  const key = getStudentDeviceLockKey(name, batch);
  if (studentDeviceLocks.get(key)?.deviceTokenHash !== hashDeviceToken(deviceToken)) return false;
  studentDeviceLocks.delete(key);
  await persistDeviceLocks();
  return true;
}
function instructorCookie(adminId) {
  const sessionId = crypto.randomBytes(32).toString('base64url');
  const expiresAt = Date.now() + 8 * 60 * 60 * 1000;
  authDb.prepare('INSERT INTO auth_sessions (token_hash, admin_id, expires_at, created_at) VALUES (?, ?, ?, ?)').run(
    crypto.createHash('sha256').update(sessionId).digest('hex'),
    adminId,
    expiresAt,
    new Date().toISOString()
  );
  return `${sessionId}.${sign(sessionId)}`;
}
function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}
function isValidEmail(email) {
  return typeof email === 'string' && email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}
function initializeAuthDatabase() {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  authDb = new Database(databasePath);
  authDb.pragma('journal_mode = WAL');
  authDb.pragma('foreign_keys = ON');
  authDb.pragma('busy_timeout = 5000');
  const schemaVersion = authDb.pragma('user_version', { simple: true });
  if (schemaVersion > 2) throw new Error(`Unsupported attendance auth database version ${schemaVersion}.`);
  if (schemaVersion < 1) {
    const migrate = authDb.transaction(() => {
      authDb.exec(`
        CREATE TABLE admins (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          email TEXT NOT NULL COLLATE NOCASE UNIQUE,
          password_hash TEXT,
          role TEXT NOT NULL DEFAULT 'ADMIN' CHECK (role = 'ADMIN'),
          is_verified INTEGER NOT NULL DEFAULT 0 CHECK (is_verified IN (0, 1)),
          is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          last_login TEXT
        );
        CREATE TABLE otp_verifications (
          id TEXT PRIMARY KEY,
          admin_id TEXT NOT NULL UNIQUE REFERENCES admins(id) ON DELETE CASCADE,
          purpose TEXT NOT NULL CHECK (purpose IN ('verify', 'invite', 'reset')),
          otp_hash TEXT NOT NULL,
          expires_at INTEGER NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 0,
          last_sent_at INTEGER NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE TABLE auth_sessions (
          token_hash TEXT PRIMARY KEY,
          admin_id TEXT NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
          expires_at INTEGER NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX auth_sessions_admin_idx ON auth_sessions(admin_id);
        CREATE INDEX otp_verifications_expiry_idx ON otp_verifications(expires_at);
      `);
      authDb.pragma('user_version = 1');
    });
    migrate();
  }
  if (schemaVersion < 2) {
    const hasVerificationFlag = authDb.pragma('table_info(otp_verifications)').some((column) => column.name === 'verified');
    const migrateOtpVerificationState = authDb.transaction(() => {
      if (!hasVerificationFlag) {
        authDb.exec('ALTER TABLE otp_verifications ADD COLUMN verified INTEGER NOT NULL DEFAULT 0 CHECK (verified IN (0, 1))');
      }
      authDb.pragma('user_version = 2');
    });
    migrateOtpVerificationState();
  }
  migrateLegacyAdminAccount();
}
function migrateLegacyAdminAccount() {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(LEGACY_ADMIN_ACCOUNT_PATH, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw new Error(`Unable to read legacy admin account: ${error.message}`);
  }
  if (!data || !isValidEmail(normalizeEmail(data.email)) || typeof data.salt !== 'string' || typeof data.passwordHash !== 'string') {
    throw new Error('The legacy admin account file has an invalid format.');
  }
  const now = new Date().toISOString();
  authDb.prepare(`
    INSERT OR IGNORE INTO admins
      (id, name, email, password_hash, role, is_verified, is_active, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'ADMIN', 1, 1, ?, ?)
  `).run(crypto.randomUUID(), String(data.name || 'Admin'), normalizeEmail(data.email), `scrypt$${data.salt}$${data.passwordHash}`, now, now);
}
function validPassword(password) {
  return typeof password === 'string' && password.length >= 8 && password.length <= 128;
}
function passwordDigest(password) {
  return crypto.createHash('sha256').update(password, 'utf8').digest('hex');
}
async function hashPassword(password) {
  return `bcrypt-sha256:${await bcrypt.hash(passwordDigest(password), 12)}`;
}
async function verifyStoredPassword(password, storedHash) {
  if (storedHash.startsWith('bcrypt-sha256:')) return bcrypt.compare(passwordDigest(password), storedHash.slice('bcrypt-sha256:'.length));
  return bcrypt.compare(password, storedHash);
}
function rateLimit(key, maximum, windowMs) {
  const now = Date.now();
  const recent = (authRateLimits.get(key) || []).filter((timestamp) => now - timestamp < windowMs);
  if (authRateLimits.size > 5000) {
    for (const [storedKey, timestamps] of authRateLimits) {
      const active = timestamps.filter((timestamp) => now - timestamp < 60 * 60 * 1000);
      if (active.length) authRateLimits.set(storedKey, active);
      else authRateLimits.delete(storedKey);
    }
  }
  if (recent.length >= maximum) {
    authRateLimits.set(key, recent);
    return false;
  }
  recent.push(now);
  authRateLimits.set(key, recent);
  return true;
}
function rateLimitKey(req, operation, email = '') {
  return `${operation}:${req.ip}:${normalizeEmail(email)}`;
}
async function createOtp(adminId, purpose) {
  const code = crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
  const otpHash = await bcrypt.hash(code, 10);
  const expiresAt = Date.now() + 10 * 60 * 1000;
  const createdAt = new Date().toISOString();
  authDb.prepare(`
    INSERT INTO otp_verifications (id, admin_id, purpose, otp_hash, expires_at, attempts, last_sent_at, created_at)
    VALUES (?, ?, ?, ?, ?, 0, ?, ?)
    ON CONFLICT(admin_id) DO UPDATE SET
      id = excluded.id,
      purpose = excluded.purpose,
      otp_hash = excluded.otp_hash,
      expires_at = excluded.expires_at,
      attempts = 0,
      last_sent_at = excluded.last_sent_at,
      created_at = excluded.created_at
  `).run(crypto.randomUUID(), adminId, purpose, otpHash, expiresAt, Date.now(), createdAt);
  try {
    const admin = authDb.prepare('SELECT name, email, role FROM admins WHERE id = ?').get(adminId);
    const emailDetails = {
      to: admin.email,
      name: admin.name,
      email: admin.email,
      role: admin.role,
      otp: code,
      expiryMinutes: 10
    };
    if (purpose === 'reset') await sendPasswordResetOtp(emailDetails);
    else if (purpose === 'invite') await sendAdminInvitation(emailDetails);
    else await sendAdminOtp(emailDetails);
  } catch (error) {
    authDb.prepare('DELETE FROM otp_verifications WHERE admin_id = ?').run(adminId);
    throw error;
  }
}
function sessionAdmin(req) {
  const raw = req.headers.cookie?.match(/(?:^|; )instructor=([^;]+)/)?.[1];
  if (!raw) return null;
  const lastDot = raw.lastIndexOf('.');
  if (lastDot <= 0) return null;
  const sessionId = raw.slice(0, lastDot);
  const received = Buffer.from(raw.slice(lastDot + 1));
  const expected = Buffer.from(sign(sessionId));
  if (received.length !== expected.length || !crypto.timingSafeEqual(received, expected)) return null;
  return authDb.prepare(`
    SELECT admins.id, admins.name, admins.email, admins.role
    FROM auth_sessions
    JOIN admins ON admins.id = auth_sessions.admin_id
    WHERE auth_sessions.token_hash = ? AND auth_sessions.expires_at > ?
      AND admins.is_verified = 1 AND admins.is_active = 1 AND admins.role = 'ADMIN'
  `).get(crypto.createHash('sha256').update(sessionId).digest('hex'), Date.now()) || null;
}
function requireInstructor(req, res, next) {
  const admin = sessionAdmin(req);
  if (!admin) return res.status(401).json({ error: 'Admin login required.' });
  req.admin = admin;
  next();
}
function normalizeName(name) {
  return String(name || '').trim().replace(/\s+/g, ' ');
}
function normalizeSubjectName(subject) {
  return String(subject || '').trim().replace(/\s+/g, ' ');
}
function resolveSubjectSheetTitle(subject) {
  const requested = normalizeSubjectName(subject);
  if (!requested) return requested;
  const exactMatches = subjects.filter((entry) => normalizeSubjectName(entry) === requested);
  if (exactMatches.length) return exactMatches[0];
  const normalizedRequested = requested.toLowerCase();
  const partialMatches = subjects.filter((entry) => normalizeSubjectName(entry).toLowerCase() === normalizedRequested || normalizeSubjectName(entry).toLowerCase().includes(normalizedRequested) || normalizedRequested.includes(normalizeSubjectName(entry).toLowerCase()));
  if (partialMatches.length) return partialMatches[0];
  return requested;
}
function serverDateParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: process.env.TIMEZONE || 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).formatToParts(date);
  return Object.fromEntries(parts.filter((p) => p.type !== 'literal').map((p) => [p.type, p.value]));
}
function serverNow() {
  const p = serverDateParts();
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}:${p.second}` };
}
function sessionToken(id) { return `${id}.${sign(id)}`; }
function readSession(token) {
  if (!token) return null;
  const dot = token.lastIndexOf('.');
  const id = token.slice(0, dot);
  if (dot < 1 || token.slice(dot + 1) !== sign(id)) return null;
  const session = sessions.get(id);
  return session ? session : null;
}
function isSessionActive(session) {
  return !!session && session.status === 'active' && session.expiresAt > Date.now();
}
function bad(res, status, error) { return res.status(status).json({ error }); }

let sheets;
let layoutPromise;
function getSheets() {
  if (sheets) return sheets;
  if (!process.env.GOOGLE_SPREADSHEET_ID) throw new Error('Google Sheets is not configured.');
  const credentials = process.env.GOOGLE_SERVICE_ACCOUNT_FILE
    ? JSON.parse(fs.readFileSync(process.env.GOOGLE_SERVICE_ACCOUNT_FILE, 'utf8'))
    : process.env.GOOGLE_SERVICE_ACCOUNT_JSON
      ? JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON)
      : null;
  if (!credentials) throw new Error('Google service-account credentials are not configured.');
  const auth = new google.auth.GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  sheets = google.sheets({ version: 'v4', auth });
  return sheets;
}
async function retrySheetsQuota(request) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await request();
    } catch (error) {
      const status = error.response?.status || error.code;
      const errorDetails = `${error.message || ''} ${JSON.stringify(error.response?.data || {})}`;
      const isQuotaLimit = [403, 429].includes(Number(status))
        && /quota|rate.?limit|resource_exhausted/i.test(errorDetails);
      if (!isQuotaLimit || attempt >= 3) throw error;
      const retryAfterHeader = error.response?.headers?.['retry-after']
        || error.response?.headers?.get?.('retry-after');
      const retryAfterMs = Number(retryAfterHeader) * 1000;
      const waitMs = Number.isFinite(retryAfterMs) && retryAfterMs > 0
        ? Math.max(retryAfterMs, 15_000)
        : 15_000 * (attempt + 1);
      console.warn(`Google Sheets read quota reached; retrying in ${Math.ceil(waitMs / 1000)} seconds.`);
      await delay(waitMs);
    }
  }
}
function readSheetsBatch(ranges) {
  return retrySheetsQuota(() => getSheets().spreadsheets.values.batchGet({
    spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID,
    ranges
  }));
}
function readSheetsMetadata(fields) {
  return retrySheetsQuota(() => getSheets().spreadsheets.get({
    spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID,
    fields
  }));
}
async function ensureSheetLayout() {
  if (layoutPromise) return layoutPromise;
  layoutPromise = (async () => {
    const service = getSheets();
    const metadata = await readSheetsMetadata('sheets.properties.title,sheets.properties.sheetId');
    const sheetIds = new Map(metadata.data.sheets.map((sheet) => [sheet.properties.title, sheet.properties.sheetId]));
    const existing = new Set(metadata.data.sheets.map((sheet) => sheet.properties.title));
    const required = ['Students', 'Percentage', ...subjects];
    const renameRequests = [];
    const usedLegacyTitles = new Set();
    for (let i = 0; i < subjects.length; i += 1) {
      const desiredTitle = subjects[i];
      if (existing.has(desiredTitle)) continue;

      const legacyCandidates = [`Subject ${i + 1}`, `Sheet${i + 1}`, 'Sheet1'];
      const legacyTitle = legacyCandidates.find((candidate) => existing.has(candidate) && !usedLegacyTitles.has(candidate) && candidate !== desiredTitle);
      if (!legacyTitle) continue;

      const sheetId = sheetIds.get(legacyTitle);
      if (sheetId !== undefined) {
        renameRequests.push({ updateSheetProperties: { properties: { sheetId, title: desiredTitle }, fields: 'title' } });
        usedLegacyTitles.add(legacyTitle);
      }
    }
    if (renameRequests.length) {
      await service.spreadsheets.batchUpdate({ spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID, requestBody: { requests: renameRequests } });
    }
    const updatedMetadata = await readSheetsMetadata('sheets.properties.title');
    const refreshedExisting = new Set(updatedMetadata.data.sheets.map((sheet) => sheet.properties.title));
    const missing = required.filter((title) => !refreshedExisting.has(title));
    if (missing.length) {
      await service.spreadsheets.batchUpdate({ spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID, requestBody: { requests: missing.map((title) => ({ addSheet: { properties: { title } } })) } });
    }
    const headers = [
      ['Students', ['Student ID', 'Student Name', 'Batch', 'Email']],
      ['Percentage', ['Student Name', 'Batch', 'Course', 'Subject', 'Attended Classes', 'Total Classes', 'Subject Percentage', 'Full-Course / Overall Percentage']],
      ...subjects.map((subject) => [subject, ['Student ID', 'Student Name', 'Batch']])
    ];
    await service.spreadsheets.values.batchUpdate({ spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID, requestBody: { valueInputOption: 'USER_ENTERED', data: headers.map(([title, values]) => ({ range: `'${title}'!A1`, values: [values] })) } });
  })();
  return layoutPromise;
}
async function styleAttendanceSheets() {
  const metadata = await readSheetsMetadata('sheets.properties.title,sheets.properties.sheetId');
  const ranges = new Map(metadata.data.sheets.map((entry) => [entry.properties.title, entry.properties.sheetId]));
  const sheetTitles = [['Students', 4], ...subjects.map((subject) => [subject, 26])];
  const requests = [];
  for (const [title, endColumnIndex] of sheetTitles) {
    const sheetId = ranges.get(title);
    if (sheetId === undefined) continue;
    const bodyRange = { sheetId, startRowIndex: 1, endRowIndex: 1000, startColumnIndex: 0, endColumnIndex };
    requests.push({
      repeatCell: {
        range: bodyRange,
        cell: {
          userEnteredFormat: {
            backgroundColor: { red: 1, green: 1, blue: 1 },
            textFormat: { foregroundColor: { red: 0.09, green: 0.2, blue: 0.2 }, bold: false },
            verticalAlignment: 'MIDDLE',
            borders: { bottom: { style: 'SOLID', color: { red: 0.88, green: 0.91, blue: 0.9 } } }
          }
        },
        fields: 'userEnteredFormat(backgroundColor,textFormat,verticalAlignment,borders)'
      }
    });
    requests.push({
      updateDimensionProperties: {
        range: { sheetId, dimension: 'ROWS', startIndex: 1, endIndex: 1000 },
        properties: { pixelSize: 30 },
        fields: 'pixelSize'
      }
    });
  }
  if (!requests.length) return;
  await getSheets().spreadsheets.batchUpdate({
    spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID,
    requestBody: { requests }
  });
}
async function ensureAttendanceCalendar(date = serverNow().date) {
  await ensureSheetLayout();
  const ranges = subjects.map((subject) => `'${subject}'!A1:ZZ10000`);
  const result = await readSheetsBatch(ranges);
  const matrices = new Map(subjects.map((subject, index) => [
    subject,
    result.data.valueRanges[index]?.values || [['Student ID', 'Student Name', 'Batch']]
  ]));
  const recordedDates = [...matrices.values()].flatMap((matrix) =>
    (matrix[0] || []).slice(3).map((value) => String(value || '').trim()).filter((value) => /^\d{4}-\d{2}-\d{2}$/.test(value) && value <= date)
  );
  const firstDate = recordedDates.length ? recordedDates.sort()[0] : date;
  const calendarDates = calendarDatesBetween(firstDate, date);
  const metadata = await readSheetsMetadata('sheets.properties.title,sheets.properties.sheetId');
  const sheetIds = new Map(metadata.data.sheets.map((sheet) => [sheet.properties.title, sheet.properties.sheetId]));
  const requests = [];
  const headerUpdates = [];

  for (const subject of subjects) {
    const matrix = matrices.get(subject) || [];
    const header = matrix[0] || [];
    const existingDates = new Set(header.slice(3).map((value) => String(value || '').trim()));
    const missingDates = calendarDates.filter((calendarDate) => !existingDates.has(calendarDate));
    if (missingDates.length) {
      const sheetId = sheetIds.get(subject);
      if (sheetId === undefined) throw new Error(`Subject sheet not found: ${subject}`);
      const destinationStart = Math.max(3, header.length);
      const destinationEnd = destinationStart + missingDates.length;
      const dateIndexes = header.map((value, index) =>
        index >= 3 && /^\d{4}-\d{2}-\d{2}$/.test(String(value || '').trim()) ? index : -1
      ).filter((index) => index >= 0);
      const requestsForColumns = [{
        insertDimension: {
          range: { sheetId, dimension: 'COLUMNS', startIndex: destinationStart, endIndex: destinationEnd },
          inheritFromBefore: false
        }
      }];
      if (dateIndexes.length) {
        const sourceIndex = dateIndexes[dateIndexes.length - 1];
        for (let offset = 0; offset < missingDates.length; offset += 1) {
          const destinationIndex = destinationStart + offset;
          requestsForColumns.push({
            copyPaste: {
              source: { sheetId, startRowIndex: 0, endRowIndex: 1000, startColumnIndex: sourceIndex, endColumnIndex: sourceIndex + 1 },
              destination: { sheetId, startRowIndex: 0, endRowIndex: 1000, startColumnIndex: destinationIndex, endColumnIndex: destinationIndex + 1 },
              pasteType: 'PASTE_FORMAT'
            }
          });
        }
      }
      requestsForColumns.push(
        {
          updateDimensionProperties: {
            range: { sheetId, dimension: 'COLUMNS', startIndex: destinationStart, endIndex: destinationEnd },
            properties: { pixelSize: 100 },
            fields: 'pixelSize'
          }
        },
        {
          setDataValidation: {
            range: { sheetId, startRowIndex: 1, endRowIndex: Math.max(matrix.length, 1000), startColumnIndex: destinationStart, endColumnIndex: destinationEnd },
            rule: attendanceValidationRule
          }
        },
        ...[
          ['Present', { red: 0.86, green: 0.95, blue: 0.88 }],
          ['Absent', { red: 0.98, green: 0.88, blue: 0.86 }],
          ['Holiday', { red: 0.86, green: 0.92, blue: 0.98 }]
        ].map(([status, backgroundColor]) => ({
          addConditionalFormatRule: {
            rule: {
              ranges: [{ sheetId, startRowIndex: 1, endRowIndex: 1000, startColumnIndex: destinationStart, endColumnIndex: destinationEnd }],
              booleanRule: {
                condition: { type: 'TEXT_EQ', values: [{ userEnteredValue: status }] },
                format: { backgroundColor }
              }
            },
            index: 0
          }
        }))
      );
      requests.push(...requestsForColumns);
      headerUpdates.push({
        range: `'${subject}'!${columnName(destinationStart)}1`,
        values: [missingDates]
      });
    }
  }

  if (requests.length) {
    await getSheets().spreadsheets.batchUpdate({
      spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID,
      requestBody: { requests }
    });
  }
  if (headerUpdates.length) {
    await getSheets().spreadsheets.values.batchUpdate({
      spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID,
      requestBody: { valueInputOption: 'USER_ENTERED', data: headerUpdates }
    });
  }

  const refreshed = await readSheetsBatch(ranges);
  const dateUpdates = [];
  for (const [index, subject] of subjects.entries()) {
    const matrix = refreshed.data.valueRanges[index]?.values || [];
    const header = matrix[0] || [];
    const dateColumns = new Map();
    for (let columnIndex = 3; columnIndex < header.length; columnIndex += 1) {
      const currentDate = String(header[columnIndex] || '').trim();
      if (/^\d{4}-\d{2}-\d{2}$/.test(currentDate)) dateColumns.set(currentDate, columnIndex);
    }
    const orderedDates = newestFirstDates(dateColumns.keys());
    const defaultStatuses = new Map(orderedDates.map((currentDate) => [
      currentDate,
      statusForUnmarkedDate(
        matrix.slice(1)
          .filter((row) => normalizeName(row[1]) && String(row[2] || '').trim())
          .map((row) => row[dateColumns.get(currentDate)]),
        isHolidayDate(currentDate, holidays)
      )
    ]));
    const values = [orderedDates];
    for (let rowIndex = 1; rowIndex < matrix.length; rowIndex += 1) {
      const row = matrix[rowIndex] || [];
      values.push(orderedDates.map((currentDate) => {
        const status = String(row[dateColumns.get(currentDate)] || '').trim();
        if (!normalizeName(row[1]) || !String(row[2] || '').trim()) return status;
        if (isHolidayDate(currentDate, holidays)) return 'Holiday';
        if (status && status !== 'Not Marked') return status;
        return defaultStatuses.get(currentDate) || '';
      }));
    }
    const currentDates = header.slice(3).map((value) => String(value || '').trim());
    const datesInOrder = currentDates.length === orderedDates.length
      && currentDates.every((currentDate, dateIndex) => currentDate === orderedDates[dateIndex]);
    const statusesMatch = values.slice(1).every((rowValues, rowIndex) =>
      rowValues.every((value, dateIndex) =>
        String(value || '').trim() === String(matrix[rowIndex + 1]?.[dateColumns.get(orderedDates[dateIndex])] || '').trim()
      )
    );
    if (!datesInOrder || !statusesMatch) {
      dateUpdates.push({
        range: `'${subject}'!D1`,
        values
      });
    }
  }
  if (dateUpdates.length) {
    await getSheets().spreadsheets.values.batchUpdate({
      spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID,
      requestBody: { valueInputOption: 'USER_ENTERED', data: dateUpdates }
    });
  }
}
async function syncAttendanceValidation() {
  const metadata = await readSheetsMetadata('sheets.properties.title,sheets.properties.sheetId');
  const matrixRanges = subjects.map((subject) => `'${subject}'!A1:ZZ10000`);
  const matrixResponse = await readSheetsBatch(matrixRanges);
  const matrices = new Map(matrixResponse.data.valueRanges.map((range, index) => [subjects[index], range.values || []]));
  const requests = [];
  for (const sheet of metadata.data.sheets) {
    if (!subjects.includes(sheet.properties.title)) continue;
    const values = matrices.get(sheet.properties.title) || [];
    const headers = values[0] || [];
    const dateIndexes = headers.map((value, index) => index >= 3 && /^\d{4}-\d{2}-\d{2}$/.test(String(value || '').trim()) ? index : -1).filter((index) => index >= 0);
    for (const dateIndex of dateIndexes) {
      requests.push({
        setDataValidation: {
          range: { sheetId: sheet.properties.sheetId, startRowIndex: 1, endRowIndex: 1000, startColumnIndex: dateIndex, endColumnIndex: dateIndex + 1 },
          rule: attendanceValidationRule
        }
      });
    }
  }
  for (let index = 0; index < requests.length; index += 500) await getSheets().spreadsheets.batchUpdate({ spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID, requestBody: { requests: requests.slice(index, index + 500) } });
}
function columnName(index) {
  let value = '';
  let current = index + 1;
  while (current > 0) {
    const remainder = (current - 1) % 26;
    value = String.fromCharCode(65 + remainder) + value;
    current = Math.floor((current - 1) / 26);
  }
  return value;
}
async function copyDateColumnFormatting(subject, sourceIndex, destinationIndex, insertColumn = false, validationEndRow = 1000, knownSheetId = null) {
  const targetSheet = resolveSubjectSheetTitle(subject);
  let sheetId = knownSheetId;
  if (sheetId === null) {
    const metadata = await readSheetsMetadata('sheets.properties');
    const sheet = metadata.data.sheets.find((entry) => entry.properties.title === targetSheet);
    if (!sheet) throw new Error(`Subject sheet not found: ${targetSheet}`);
    sheetId = sheet.properties.sheetId;
  }
  await getSheets().spreadsheets.batchUpdate({
    spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID,
    requestBody: {
      requests: [
        ...(insertColumn ? [{ insertDimension: { range: { sheetId, dimension: 'COLUMNS', startIndex: destinationIndex, endIndex: destinationIndex + 1 }, inheritFromBefore: false } }] : []),
        {
          copyPaste: {
            source: { sheetId, startRowIndex: 0, endRowIndex: 1000, startColumnIndex: sourceIndex, endColumnIndex: sourceIndex + 1 },
            destination: { sheetId, startRowIndex: 0, endRowIndex: 1000, startColumnIndex: destinationIndex, endColumnIndex: destinationIndex + 1 },
            pasteType: 'PASTE_FORMAT'
          }
        },
        {
          updateDimensionProperties: {
            range: { sheetId, dimension: 'COLUMNS', startIndex: destinationIndex, endIndex: destinationIndex + 1 },
            properties: { pixelSize: 100 },
            fields: 'pixelSize'
          }
        },
        {
          setBasicFilter: {
            filter: { range: { sheetId, startRowIndex: 0, endRowIndex: 1000, startColumnIndex: 0, endColumnIndex: 26 } }
          }
        },
        {
          setDataValidation: {
            range: { sheetId, startRowIndex: 1, endRowIndex: validationEndRow, startColumnIndex: destinationIndex, endColumnIndex: destinationIndex + 1 },
            rule: attendanceValidationRule
          }
        },
        ...['Present', 'Absent', 'Late', 'Leave', 'Holiday'].map((status) => ({
          addConditionalFormatRule: {
            rule: {
              ranges: [{ sheetId, startRowIndex: 1, endRowIndex: 1000, startColumnIndex: destinationIndex, endColumnIndex: destinationIndex + 1 }],
              booleanRule: { condition: { type: 'TEXT_EQ', values: [{ userEnteredValue: status }] }, format: { backgroundColor: status === 'Present' ? { red: 0.86, green: 0.95, blue: 0.88 } : status === 'Absent' ? { red: 0.98, green: 0.88, blue: 0.86 } : status === 'Late' ? { red: 1, green: 0.93, blue: 0.76 } : status === 'Leave' ? { red: 1, green: 0.96, blue: 0.78 } : { red: 0.86, green: 0.92, blue: 0.98 } } }
            },
            index: 0
          }
        }))
      ]
    }
  });
}
async function addAttendanceValidationToRow(subject, rowIndex, dateIndexes) {
  const targetSheet = resolveSubjectSheetTitle(subject);
  const metadata = await getSheets().spreadsheets.get({ spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID, fields: 'sheets.properties.title,sheets.properties.sheetId' });
  const sheet = metadata.data.sheets.find((entry) => entry.properties.title === targetSheet);
  if (!sheet) return;
  await getSheets().spreadsheets.batchUpdate({
    spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID,
    requestBody: {
      requests: dateIndexes.map((dateIndex) => ({
        setDataValidation: {
          range: { sheetId: sheet.properties.sheetId, startRowIndex: rowIndex, endRowIndex: rowIndex + 1, startColumnIndex: dateIndex, endColumnIndex: dateIndex + 1 },
          rule: attendanceValidationRule
        }
      }))
    }
  });
}
async function appendRow(subject, values) {
  const targetSheet = resolveSubjectSheetTitle(subject);
  await ensureSheetLayout();
  const result = await getSheets().spreadsheets.values.get({ spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID, range: `'${targetSheet}'!A1:ZZ10000` });
  const matrix = result.data.values || [['Student ID', 'Student Name', 'Batch']];
  const header = matrix[0].length >= 3 ? [...matrix[0]] : ['Student ID', 'Student Name', 'Batch'];
  const date = String(values[0] || '').trim();
  let dateIndex = header.indexOf(date);
  const newDateColumn = dateIndex < 3;
  if (dateIndex < 3) {
    dateIndex = 3;
  }
  const name = normalizeName(values[2]);
  const batch = String(values[3] || '').trim();
  const registeredStudent = (await getStudents()).find((entry) => entry.name.toLowerCase() === name.toLowerCase() && entry.batch === batch);
  const rowIndex = registeredStudent?.id
    ? matrix.findIndex((row, index) => index > 0 && String(row[0] || '').trim() === registeredStudent.id)
    : matrix.findIndex((row, index) => index > 0 && normalizeName(row[1]).toLowerCase() === name.toLowerCase() && String(row[2] || '').trim() === batch);
  const targetRow = rowIndex >= 1 ? rowIndex : matrix.length;
  if (newDateColumn) {
    await copyDateColumnFormatting(targetSheet, 4, dateIndex, true, Math.max(matrix.length, targetRow + 1));
    await getSheets().spreadsheets.values.update({ spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID, range: `'${targetSheet}'!${columnName(dateIndex)}1`, valueInputOption: 'USER_ENTERED', requestBody: { values: [[date]] } });
  }
  await getSheets().spreadsheets.values.update({
    spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID,
    range: `'${targetSheet}'!A${targetRow + 1}:C${targetRow + 1}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[registeredStudent?.id || matrix[targetRow]?.[0] || '', name, batch]] }
  });
  const attendanceUpdates = [{
    range: `'${targetSheet}'!${columnName(dateIndex)}${targetRow + 1}`,
    values: [[values[6] || 'Absent']]
  }];
  if (rowIndex < 1) {
    const existingDateIndexes = header.map((value, index) => index >= 3 && /^\d{4}-\d{2}-\d{2}$/.test(String(value || '').trim()) ? index : -1).filter((index) => index >= 0);
    const validationDateIndexes = [...existingDateIndexes.map((index) => newDateColumn ? index + 1 : index), dateIndex];
    await addAttendanceValidationToRow(targetSheet, targetRow, [...new Set(validationDateIndexes)]);
    for (const existingDateIndex of existingDateIndexes) {
      const existingDate = String(header[existingDateIndex] || '').trim();
      if (existingDate >= date || existingDate > serverNow().date) continue;
      attendanceUpdates.push({
        range: `'${targetSheet}'!${columnName(newDateColumn ? existingDateIndex + 1 : existingDateIndex)}${targetRow + 1}`,
        values: [[isHolidayDate(existingDate, holidays) ? 'Holiday' : 'Absent']]
      });
    }
  }
  await getSheets().spreadsheets.values.batchUpdate({ spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID, requestBody: { valueInputOption: 'USER_ENTERED', data: attendanceUpdates } });
}
async function readRows(tab) {
  await ensureSheetLayout();
  const normalized = String(tab || '').trim();
  if (!normalized) return [];

  const resolvedTab = normalized === 'Students' || normalized === 'Percentage' ? normalized : resolveSubjectSheetTitle(normalized);
  if (resolvedTab === 'Students' || resolvedTab === 'Percentage') return (await getSheets().spreadsheets.values.get({
    spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID,
    range: `'${resolvedTab}'!A1:K10000`
  })).data.values || [];

  const result = await getSheets().spreadsheets.values.get({
    spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID,
    range: `'${resolvedTab}'!A1:ZZ10000`
  });
  if (!subjects.includes(resolvedTab)) return result.data.values || [];
  const matrix = result.data.values || [];
  const rows = [sheetHeaders];
  for (const row of matrix.slice(1)) {
    for (let index = 3; index < (matrix[0] || []).length; index += 1) {
      if (row[index]) rows.push([matrix[0][index], '', row[1], row[2], courseFor(row[2]), normalized, row[index], 'Matrix', '']);
    }
  }
  return rows;
}
async function getStudents() {
  const rows = await readRows('Students');
  return rows.slice(1).map((r) => ({
    id: String(r[0] || '').trim(),
    name: normalizeName(r[1] || r[0]),
    batch: String(r[2] || r[1] || '').trim(),
    course: courseFor(String(r[2] || r[1] || '').trim()),
    email: normalizeEmail(r[3] || '')
  })).filter((s) => s.name && batches.includes(s.batch));
}
async function registerStudent(name, batch, email = '') {
  const normalizedName = normalizeName(name);
  const normalizedEmail = normalizeEmail(email);
  const key = `${normalizedName.toLowerCase()}|${batch}`;
  if (studentRegistrationLocks.has(key)) return studentRegistrationLocks.get(key);

  const registration = (async () => {
    const existing = (await getStudents()).find((student) => student.name.toLowerCase() === normalizedName.toLowerCase() && student.batch === batch);
    if (existing) {
      if (!existing.email && normalizedEmail) {
        const rows = await readRows('Students');
        const rowIndex = rows.findIndex((row, index) => index > 0
          && normalizeName(row[1]).toLowerCase() === normalizedName.toLowerCase()
          && String(row[2] || '').trim() === batch);
        if (rowIndex > 0) {
          await getSheets().spreadsheets.values.update({
            spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID,
            range: `Students!D${rowIndex + 1}`,
            valueInputOption: 'USER_ENTERED',
            requestBody: { values: [[normalizedEmail]] }
          });
          existing.email = normalizedEmail;
        }
      }
      return existing;
    }

    await getSheets().spreadsheets.values.append({
      spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID,
      range: 'Students!A:D',
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      includeValuesInResponse: false,
      requestBody: {
        values: [[`=IF(OR(INDEX(B:B,ROW())="",INDEX(C:C,ROW())=""),"","STU-"&TEXT(ROW()-1,"000000"))`, normalizedName, batch, normalizedEmail]]
      }
    });

    const registered = (await getStudents()).find((student) => student.name.toLowerCase() === normalizedName.toLowerCase() && student.batch === batch);
    if (!registered) throw new Error('Unable to register the student in the Students sheet.');
    await syncRosterToSubjectSheets();
    return registered;
  })();
  studentRegistrationLocks.set(key, registration);
  try {
    return await registration;
  } finally {
    studentRegistrationLocks.delete(key);
  }
}
async function getSubjectStudents(subject) {
  const result = await getSheets().spreadsheets.values.get({ spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID, range: `'${subject}'!A1:ZZ10000` });
  return (result.data.values || []).slice(1).map((row) => ({
    id: String(row[0] || '').trim(),
    name: normalizeName(row[1]),
    batch: String(row[2] || '').trim(),
    course: courseFor(String(row[2] || '').trim())
  })).filter((student) => student.name && batches.includes(student.batch));
}
async function syncAllSubjectStudentIds() {
  await ensureSheetLayout();
  const ranges = ['Students!A:D', ...subjects.map((subject) => `'${subject}'!A1:ZZ10000`)];
  const result = await readSheetsBatch(ranges);
  const studentsMatrix = result.data.valueRanges[0]?.values || [['Student ID', 'Student Name', 'Batch', 'Email']];
  const subjectMatrices = new Map(subjects.map((subject, index) => [
    subject,
    result.data.valueRanges[index + 1]?.values || []
  ]));
  const roster = new Map();
  for (const row of studentsMatrix.slice(1)) {
    const name = normalizeName(row[1]);
    const batch = String(row[2] || '').trim();
    if (!name || !batches.includes(batch)) continue;
    roster.set(`${name.toLowerCase()}|${batch}`, {
      id: String(row[0] || '').trim(),
      name,
      batch
    });
  }

  const missingStudents = new Map();
  for (const [subject, matrix] of subjectMatrices) {
    for (const row of matrix.slice(1)) {
      const name = normalizeName(row[1]);
      const batch = String(row[2] || '').trim();
      const hasAttendance = row.slice(3).some((value) => String(value || '').trim());
      if (!name || !batches.includes(batch) || !hasAttendance) continue;
      const key = `${name.toLowerCase()}|${batch}`;
      if (!roster.has(key) && !missingStudents.has(key)) missingStudents.set(key, { name, batch });
    }
  }

  if (missingStudents.size) {
    const additions = [...missingStudents.values()];
    const firstStudentRow = studentsMatrix.length + 1;
    await getSheets().spreadsheets.values.append({
      spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID,
      range: 'Students!A:D',
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      includeValuesInResponse: false,
      requestBody: {
        values: additions.map((student, index) => [
          `=IF(OR(INDEX(B:B,ROW())="",INDEX(C:C,ROW())=""),"","STU-"&TEXT(ROW()-1,"000000"))`,
          student.name,
          student.batch,
          ''
        ])
      }
    });
    additions.forEach((student, index) => {
      roster.set(`${student.name.toLowerCase()}|${student.batch}`, {
        ...student,
        id: `STU-${String(firstStudentRow + index - 1).padStart(6, '0')}`
      });
    });
  }

  const updates = [];
  for (const [subject, matrix] of subjectMatrices) {
    for (let rowIndex = 1; rowIndex < matrix.length; rowIndex += 1) {
      const row = matrix[rowIndex];
      const name = normalizeName(row[1]);
      const batch = String(row[2] || '').trim();
      const hasAttendance = row.slice(3).some((value) => String(value || '').trim());
      if (!name || !batches.includes(batch) || !hasAttendance) continue;
      const student = roster.get(`${name.toLowerCase()}|${batch}`);
      if (student?.id && student.id !== String(row[0] || '').trim()) {
        updates.push({
          range: `'${subject}'!A${rowIndex + 1}`,
          values: [[student.id]]
        });
      }
    }
  }
  if (updates.length) {
    await getSheets().spreadsheets.values.batchUpdate({
      spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID,
      requestBody: { valueInputOption: 'USER_ENTERED', data: updates }
    });
  }
}
async function syncRosterToSubjectSheets() {
  const students = await getStudents();
  const ranges = subjects.map((subject) => `'${subject}'!A1:ZZ10000`);
  const result = await readSheetsBatch(ranges);
  for (const [index, subject] of subjects.entries()) {
    const matrix = result.data.valueRanges[index]?.values || [];
    const existing = new Set(matrix.slice(1).map((row) =>
      `${normalizeName(row[1]).toLowerCase()}|${String(row[2] || '').trim()}`
    ));
    const missing = students.filter((student) =>
      !existing.has(`${student.name.toLowerCase()}|${student.batch}`)
    );
    if (!missing.length) continue;
    await getSheets().spreadsheets.values.append({
      spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID,
      range: `'${subject}'!A:C`,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      includeValuesInResponse: false,
      requestBody: {
        values: missing.map((student) => [student.id, student.name, student.batch])
      }
    });
  }
}
async function findExisting(subject, date, name, batch) {
  const rows = await readRows(subject);
  return rows.slice(1).some((r) => {
    const rowDate = String(r[0] || '').trim();
    const rowName = normalizeName(r[2]);
    const rowBatch = String(r[3] || '').trim();
    const rowId = String(r[1] || '').trim();
    const normalizedName = normalizeName(name);
    const sameDate = rowDate === date;
    const sameName = rowName.toLowerCase() === normalizedName.toLowerCase();
    const sameBatch = rowBatch === batch;
    const sameStudentId = !!rowId && rowId === batch;
    return sameDate && sameName && sameBatch && !sameStudentId
      && (isCountedClassStatus(r[6]) || r[6] === 'Holiday');
  });
}
async function syncPercentage() {
  const all = [];
  for (const subject of subjects) {
    const rows = await readRows(subject);
    rows.slice(1).forEach((r) => all.push({ date: r[0], name: normalizeName(r[2]), batch: r[3], course: r[4], subject, status: r[6] }));
  }
  const identities = new Map();
  const classDates = new Map();
  for (const row of all) {
    if (!row.name || !row.batch || !row.date || !isCountedClassStatus(row.status)) continue;
    const identity = `${row.name.toLowerCase()}|${row.batch}|${row.subject}`;
    if (!identities.has(identity)) identities.set(identity, { name: row.name, batch: row.batch, course: row.course, subject: row.subject, attended: 0 });
    if (row.status === 'Present') identities.get(identity).attended += 1;
    classDates.set(`${row.batch}|${row.subject}|${row.date}`, true);
  }
  const overall = new Map();
  const output = [['Student Name', 'Batch', 'Course', 'Subject', 'Attended Classes', 'Total Classes', 'Subject Percentage', 'Full-Course / Overall Percentage']];
  for (const item of identities.values()) {
    const total = [...classDates.keys()].filter((key) => key.startsWith(`${item.batch}|${item.subject}|`)).length;
    const key = `${item.name.toLowerCase()}|${item.batch}`;
    if (!overall.has(key)) overall.set(key, { attended: 0, total: 0 });
    overall.get(key).attended += item.attended;
    overall.get(key).total += total;
    output.push([item.name, item.batch, item.course, item.subject, item.attended, total, total ? `${((item.attended / total) * 100).toFixed(2)}%` : '0.00%', '']);
  }
  for (let i = 1; i < output.length; i += 1) {
    const totals = overall.get(`${output[i][0].toLowerCase()}|${output[i][1]}`);
    output[i][7] = totals.total ? `${((totals.attended / totals.total) * 100).toFixed(2)}%` : '0.00%';
  }
  await getSheets().spreadsheets.values.clear({ spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID, range: 'Percentage!A:H' });
  await getSheets().spreadsheets.values.update({ spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID, range: 'Percentage!A1', valueInputOption: 'USER_ENTERED', requestBody: { values: output } });
}

app.post('/api/auth/signup', async (req, res) => {
  const name = String(req.body.name || '').trim().replace(/\s+/g, ' ');
  const email = normalizeEmail(req.body.email);
  const password = req.body.password;
  if (!rateLimit(`signup-ip:${req.ip}`, 20, 60 * 60 * 1000) || !rateLimit(rateLimitKey(req, 'signup', email), 5, 60 * 60 * 1000)) {
    return bad(res, 429, 'Too many signup attempts. Try again later.');
  }
  if (!/^[\p{L}\p{M}][\p{L}\p{M} .'-]{1,99}$/u.test(name) || !isValidEmail(email)) return bad(res, 400, 'Enter a valid full name and email address.');
  if (!validPassword(password) || password !== req.body.confirmPassword) return bad(res, 400, 'Enter matching passwords of at least 8 characters.');

  const existing = authDb.prepare('SELECT id, password_hash, is_verified FROM admins WHERE email = ? COLLATE NOCASE').get(email);
  if (existing?.is_verified) return bad(res, 409, 'An account with this email already exists.');
  if (existing && existing.password_hash) return bad(res, 409, 'Signup has already started for this email. Request a new verification code.');
  const hasAdmins = authDb.prepare('SELECT 1 AS present FROM admins LIMIT 1').get();
  if (hasAdmins && !existing) return bad(res, 403, 'New admin accounts are invitation-only. Ask an active admin to invite you.');

  const passwordHash = await hashPassword(password);
  const now = new Date().toISOString();
  let adminId = existing?.id;
  try {
    const createAccount = authDb.transaction(() => {
      if (adminId) {
        const updated = authDb.prepare("UPDATE admins SET name = ?, password_hash = ?, updated_at = ? WHERE id = ? AND is_verified = 0 AND password_hash IS NULL")
          .run(name, passwordHash, now, adminId);
        if (updated.changes !== 1) throw new Error('This invitation has already been used. Request a new invitation.');
      } else {
        if (!hasAdmins && authDb.prepare('SELECT 1 AS present FROM admins LIMIT 1').get()) {
          const error = new Error('The first admin account has already been created. Ask an active admin for an invitation.');
          error.code = 'FIRST_ADMIN_ALREADY_CREATED';
          throw error;
        }
        if (hasAdmins && !authDb.prepare('SELECT 1 AS present FROM admins WHERE email = ? COLLATE NOCASE').get(email)) {
          const error = new Error('New admin accounts are invitation-only. Ask an active admin to invite you.');
          error.code = 'ADMIN_INVITATION_REQUIRED';
          throw error;
        }
        adminId = crypto.randomUUID();
        authDb.prepare(`
          INSERT INTO admins (id, name, email, password_hash, role, is_verified, is_active, created_at, updated_at)
          VALUES (?, ?, ?, ?, 'ADMIN', 0, 1, ?, ?)
        `).run(adminId, name, email, passwordHash, now, now);
      }
    });
    createAccount();
    const otpPurpose = existing ? 'invite' : 'verify';
    if (!existing) await createOtp(adminId, otpPurpose);
    res.status(201).json({ ok: true, requiresOtp: true, otpPurpose });
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') return bad(res, 409, 'An account with this email already exists.');
    if (error.code === 'FIRST_ADMIN_ALREADY_CREATED' || error.code === 'ADMIN_INVITATION_REQUIRED') {
      return bad(res, 403, error.message);
    }
    if (!existing && adminId) authDb.prepare('DELETE FROM admins WHERE id = ? AND is_verified = 0').run(adminId);
    if (existing && adminId) authDb.prepare("UPDATE admins SET name = '', password_hash = NULL, updated_at = ? WHERE id = ? AND is_verified = 0")
      .run(new Date().toISOString(), adminId);
    console.error('Unable to create admin signup:', error.message);
    bad(res, 503, emailDeliveryErrorMessage(error));
  }
});
app.post('/api/auth/resend-otp', async (req, res) => {
  const email = normalizeEmail(req.body.email);
  let purpose = String(req.body.purpose || 'verify');
  if (!['verify', 'invite', 'reset'].includes(purpose) || !isValidEmail(email)) return bad(res, 400, 'Enter a valid email address.');
  if (!rateLimit(`otp-ip:${req.ip}`, 10, 60 * 60 * 1000) || !rateLimit(rateLimitKey(req, 'otp-email', email), 5, 60 * 60 * 1000)) {
    return bad(res, 429, 'Too many verification requests. Try again later.');
  }
  const admin = authDb.prepare('SELECT id, is_verified, is_active, password_hash FROM admins WHERE email = ? COLLATE NOCASE').get(email);
  if (!admin) return res.json({ ok: true });
  const activeChallenge = authDb.prepare('SELECT purpose FROM otp_verifications WHERE admin_id = ?').get(admin.id);
  if (purpose === 'verify' && activeChallenge?.purpose === 'invite') purpose = 'invite';
  const validPurpose = (purpose === 'reset' && admin.is_verified && admin.is_active)
    || (purpose === 'verify' && !admin.is_verified && !!admin.password_hash)
    || (purpose === 'invite' && !admin.is_verified);
  if (!validPurpose) return res.json({ ok: true });

  const previous = authDb.prepare('SELECT last_sent_at FROM otp_verifications WHERE admin_id = ?').get(admin.id);
  if (previous && Date.now() - previous.last_sent_at < 60_000) return bad(res, 429, 'Please wait one minute before requesting another code.');
  try {
    await createOtp(admin.id, purpose);
    res.json({ ok: true, purpose });
  } catch (error) {
    console.error('Unable to send admin verification email:', error.message);
    bad(res, 503, emailDeliveryErrorMessage(error));
  }
});
app.post('/api/auth/verify-otp', async (req, res) => {
  const email = normalizeEmail(req.body.email);
  const code = String(req.body.code || '').trim();
  const purpose = String(req.body.purpose || 'verify');
  if (!isValidEmail(email) || !/^\d{6}$/.test(code) || !['verify', 'invite', 'reset'].includes(purpose)) {
    return bad(res, 400, 'Enter a valid email and six-digit verification code.');
  }
  if (!rateLimit(`verify-ip:${req.ip}`, 20, 60 * 60 * 1000)) return bad(res, 429, 'Too many code attempts. Try again later.');
  const admin = authDb.prepare('SELECT * FROM admins WHERE email = ? COLLATE NOCASE').get(email);
  const challenge = admin && authDb.prepare('SELECT * FROM otp_verifications WHERE admin_id = ? AND purpose = ?').get(admin.id, purpose);
  if (!admin || !challenge || challenge.expires_at <= Date.now()) {
    if (challenge) authDb.prepare('DELETE FROM otp_verifications WHERE id = ?').run(challenge.id);
    return bad(res, 400, 'The verification code is invalid or expired. Request a new one.');
  }
  if (challenge.attempts >= 5) {
    authDb.prepare('DELETE FROM otp_verifications WHERE id = ?').run(challenge.id);
    return bad(res, 400, 'Too many incorrect codes. Request a new one.');
  }
  if (!(await bcrypt.compare(code, challenge.otp_hash))) {
    authDb.prepare('UPDATE otp_verifications SET attempts = attempts + 1 WHERE id = ?').run(challenge.id);
    return bad(res, 400, 'The verification code is incorrect.');
  }

  const isSignup = purpose !== 'reset' && !admin.is_verified && !!admin.password_hash
    && (purpose === 'verify' || purpose === 'invite');
  const isReset = purpose === 'reset' && !!admin.is_verified && !!admin.is_active;
  if (!isSignup && !isReset) return bad(res, 400, 'The verification request is no longer valid.');
  let passwordHash = admin.password_hash;
  let name = admin.name;
  if (isReset) {
    if (!validPassword(req.body.password) || req.body.password !== req.body.confirmPassword) {
      return bad(res, 400, 'Enter matching passwords of at least 8 characters.');
    }
    passwordHash = await hashPassword(req.body.password);
  }

  const now = new Date().toISOString();
  const completeVerification = authDb.transaction(() => {
    authDb.prepare('UPDATE otp_verifications SET verified = 1 WHERE id = ?').run(challenge.id);
    authDb.prepare('DELETE FROM otp_verifications WHERE id = ?').run(challenge.id);
    authDb.prepare(`
      UPDATE admins SET name = ?, password_hash = ?, is_verified = 1, updated_at = ?
      WHERE id = ? AND role = 'ADMIN'
    `).run(name, passwordHash, now, admin.id);
    if (isReset) authDb.prepare('DELETE FROM auth_sessions WHERE admin_id = ?').run(admin.id);
  });
  completeVerification();
  let emailNotification = 'not-requested';
  if (isSignup) {
    if (!isEmailConfigured()) emailNotification = 'not-configured';
    else {
      try {
        await sendWelcomeEmail({ to: admin.email, name, email: admin.email, role: admin.role });
        emailNotification = 'sent';
      } catch {
        emailNotification = 'failed';
      }
    }
  }
  res.json({ ok: true, emailNotification });
});
app.post('/api/auth/login', async (req, res) => {
  const email = normalizeEmail(req.body.email);
  const ipKey = `login-ip:${req.ip}`;
  const emailKey = rateLimitKey(req, 'login-email', email);
  if (!rateLimit(ipKey, 30, 15 * 60 * 1000) || !rateLimit(emailKey, 8, 15 * 60 * 1000)) {
    return bad(res, 429, 'Too many login attempts. Try again in 15 minutes.');
  }
  const admin = isValidEmail(email) && validPassword(req.body.password)
    ? authDb.prepare('SELECT * FROM admins WHERE email = ? COLLATE NOCASE').get(email)
    : null;
  let passwordMatches = false;
  if (admin?.password_hash?.startsWith('scrypt$')) {
    const [, salt, expectedHex] = admin.password_hash.split('$');
    const candidate = await scrypt(req.body.password, salt, 64);
    const expected = Buffer.from(expectedHex, 'hex');
    passwordMatches = candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
    if (passwordMatches) {
      const migratedHash = await hashPassword(req.body.password);
      authDb.prepare('UPDATE admins SET password_hash = ?, updated_at = ? WHERE id = ?').run(migratedHash, new Date().toISOString(), admin.id);
    }
  } else if (admin?.password_hash) {
    passwordMatches = await verifyStoredPassword(req.body.password, admin.password_hash);
  } else {
    await bcrypt.compare(passwordDigest(String(req.body.password || '')), dummyPasswordHash);
  }
  if (!admin || !passwordMatches || !admin.is_verified || !admin.is_active || admin.role !== 'ADMIN') {
    return bad(res, 401, 'Invalid email or password, or account is not verified or active.');
  }
  authRateLimits.delete(ipKey);
  authRateLimits.delete(emailKey);
  authDb.prepare('UPDATE admins SET last_login = ? WHERE id = ?').run(new Date().toISOString(), admin.id);
  const cookie = instructorCookie(admin.id);
  res.setHeader('Set-Cookie', `instructor=${cookie}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`);
  res.json({ ok: true });
});
app.post('/api/auth/logout', (req, res) => {
  const raw = req.headers.cookie?.match(/(?:^|; )instructor=([^;]+)/)?.[1];
  const sessionId = raw?.slice(0, raw.lastIndexOf('.'));
  if (sessionId) authDb.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').run(crypto.createHash('sha256').update(sessionId).digest('hex'));
  res.setHeader('Set-Cookie', 'instructor=; Max-Age=0; HttpOnly; SameSite=Strict; Path=/');
  res.json({ ok: true });
});
app.get('/api/me', (req, res) => {
  const admin = sessionAdmin(req);
  res.json({ instructor: !!admin, admin: admin ? { id: admin.id, name: admin.name, email: admin.email, role: admin.role } : null });
});
app.get('/api/auth/status', (req, res) => {
  const hasAdmins = !!authDb.prepare('SELECT 1 AS present FROM admins LIMIT 1').get();
  res.json({
    firstAdminSetupRequired: !hasAdmins,
    inviteOnly: hasAdmins
  });
});
app.get('/api/admins', requireInstructor, (req, res) => {
  const admins = authDb.prepare(`
    SELECT id, name, email, role, is_verified AS isVerified, is_active AS isActive,
      created_at AS createdAt, updated_at AS updatedAt, last_login AS lastLogin
    FROM admins ORDER BY created_at
  `).all().map((admin) => ({
    ...admin,
    isVerified: !!admin.isVerified,
    isActive: !!admin.isActive
  }));
  res.json(admins);
});
app.post('/api/admins/invite', requireInstructor, async (req, res) => {
  const name = String(req.body.name || '').trim().replace(/\s+/g, ' ');
  const email = normalizeEmail(req.body.email);
  if (!/^[\p{L}\p{M}][\p{L}\p{M} .'-]{1,99}$/u.test(name) || !isValidEmail(email)) return bad(res, 400, 'Enter a valid full name and email address.');
  if (!rateLimit(`invite:${req.ip}:${req.admin.id}`, 20, 60 * 60 * 1000)) return bad(res, 429, 'Too many invitations. Try again later.');
  if (authDb.prepare('SELECT 1 AS present FROM admins WHERE email = ? COLLATE NOCASE').get(email)) {
    return bad(res, 409, 'An admin account or invitation already exists for this email.');
  }
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  authDb.prepare(`
    INSERT INTO admins (id, name, email, password_hash, role, is_verified, is_active, created_at, updated_at)
    VALUES (?, ?, ?, NULL, 'ADMIN', 0, 1, ?, ?)
  `).run(id, name, email, now, now);
  try {
    await createOtp(id, 'invite');
    res.status(201).json({ ok: true });
  } catch (error) {
    authDb.prepare('DELETE FROM admins WHERE id = ? AND is_verified = 0').run(id);
    console.error('Unable to send admin invitation:', error.message);
    bad(res, 503, emailDeliveryErrorMessage(error));
  }
});
app.patch('/api/admins/:id/status', requireInstructor, async (req, res) => {
  const { active } = req.body;
  if (typeof active !== 'boolean') return bad(res, 400, 'Admin status must be active or inactive.');
  const target = authDb.prepare('SELECT id, name, email, role, is_active FROM admins WHERE id = ?').get(req.params.id);
  if (!target || target.role !== 'ADMIN') return bad(res, 404, 'Admin account not found.');
  if (!active && target.id === req.admin.id) return bad(res, 400, 'You cannot deactivate your own admin account.');
  if (!active && target.is_active) {
    const activeCount = authDb.prepare("SELECT COUNT(*) AS count FROM admins WHERE role = 'ADMIN' AND is_active = 1 AND is_verified = 1").get().count;
    if (activeCount <= 1) return bad(res, 400, 'The last active verified admin cannot be deactivated.');
  }
  const transaction = authDb.transaction(() => {
    authDb.prepare('UPDATE admins SET is_active = ?, updated_at = ? WHERE id = ?').run(active ? 1 : 0, new Date().toISOString(), target.id);
    if (!active) authDb.prepare('DELETE FROM auth_sessions WHERE admin_id = ?').run(target.id);
  });
  transaction();
  let emailNotification = 'not-configured';
  if (isEmailConfigured()) {
    try {
      await sendAccountStatusEmail({
        to: target.email,
        name: target.name,
        email: target.email,
        role: target.role,
        active
      });
      emailNotification = 'sent';
    } catch {
      emailNotification = 'failed';
    }
  }
  res.json({ ok: true, emailNotification });
});
app.get('/api/config', (req, res) => res.json({ subjects, batches }));
app.get('/api/config', (req, res) => res.json({ subjects, batches }));

app.post('/api/sessions', requireInstructor, async (req, res) => {
  const { subject, batch } = req.body;
  if (!subjects.includes(subject)) return bad(res, 400, 'Invalid subject.');
  if (batch && !batches.includes(batch)) return bad(res, 400, 'Invalid batch.');
  try {
    const now = Date.now();
    const id = crypto.randomUUID();
    const session = { id, subject, batch: batch || null, facultyName: req.admin.name, createdAt: now, expiresAt: now + qrMinutes * 60 * 1000, status: 'active' };
    const token = sessionToken(id);
    const baseUrl = resolvePublicUrl(req);
    const url = `${baseUrl}/?session=${encodeURIComponent(token)}`;
    const qr = await QRCode.toDataURL(url, {
      width: 500,
      margin: 4,
      errorCorrectionLevel: 'M'
    });
    sessions.set(id, session);
    res.json({ ...session, url, qr });
  } catch (error) {
    console.error('Unable to generate attendance QR:', error.message);
    const message = error.message.startsWith('No LAN IPv4') || error.message.startsWith('APP_URL')
      ? error.message
      : 'Unable to generate the attendance QR code. Check APP_URL and network settings.';
    bad(res, 503, message);
  }
});
app.get('/api/sessions/:token', (req, res) => {
  const session = readSession(req.params.token);
  if (!isSessionActive(session)) return bad(res, 410, 'This QR code is invalid or expired. Please scan a valid QR code.');
  res.json({ subject: session.subject, batch: session.batch, expiresAt: session.expiresAt, valid: true });
});
app.post('/api/sessions/:id/close', requireInstructor, async (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return bad(res, 404, 'Attendance session not found.');
  if (session.closedAt) return res.json({ ok: true, added: 0 });
  try {
    const date = serverNow().date;
    const roster = new Map();
    for (const student of [...await getStudents(), ...await getSubjectStudents(session.subject)]) {
      if (!session.batch || student.batch === session.batch) {
        const key = `${student.name.toLowerCase()}|${student.batch}`;
        const previous = roster.get(key);
        roster.set(key, { ...previous, ...student, email: student.email || previous?.email || '' });
      }
    }
    const eligible = [...roster.values()];
    const rows = await readRows(session.subject);
    const dateRows = rows.slice(1).filter((row) =>
      row[0] === date && row[3] && (!session.batch || row[3] === session.batch)
    );
    const existing = new Set(dateRows
      .filter((row) => isCountedClassStatus(row[6]) || row[6] === 'Holiday')
      .map((row) => `${row[2].toLowerCase()}|${row[3]}`));
    const classMarked = dateRows.some((row) => isCountedClassStatus(row[6]));
    let added = 0;
    let emailSent = 0;
    let emailFailed = 0;
    let emailSkipped = 0;
    for (const student of eligible) {
      const key = `${student.name.toLowerCase()}|${student.batch}`;
      if (isHolidayDate(date, holidays) && !existing.has(key)) {
        await appendRow(session.subject, [date, '', student.name, student.batch, student.course, session.subject, 'Holiday', 'Session close', session.id]);
        added += 1;
      } else if (classMarked && !existing.has(key)) {
        const status = isHolidayDate(date, holidays) ? 'Holiday' : 'Absent';
        await appendRow(session.subject, [date, status === 'Absent' ? '-' : '', student.name, student.batch, student.course, session.subject, status, 'Session close', session.id]);
        added += 1;
        if (status === 'Absent' && student.email) {
          if (!isEmailConfigured()) emailSkipped += 1;
          else {
            try {
              await sendAbsenceNotification({
                to: student.email,
                studentName: student.name,
                subject: session.subject,
                date,
                facultyName: session.facultyName
              });
              emailSent += 1;
            } catch {
              emailFailed += 1;
            }
          }
        }
      }
    }
    await syncPercentage();
    session.closedAt = Date.now();
    session.status = 'closed';
    res.json({
      ok: true,
      added,
      emailNotifications: {
        sent: emailSent,
        failed: emailFailed,
        skipped: emailSkipped,
        status: emailFailed ? 'failed' : emailSkipped ? 'not-configured' : 'complete'
      }
    });
  } catch (error) { console.error(error); bad(res, 500, 'Unable to finalize absent students.'); }
});

app.post('/api/attendance', async (req, res) => {
  const session = readSession(req.body.token);
  if (!isSessionActive(session)) return bad(res, 410, 'This QR code is invalid or expired. Please scan a valid QR code.');
  const name = normalizeName(req.body.name);
  const batch = String(req.body.batch || '');
  const email = normalizeEmail(req.body.email);
  const deviceToken = String(req.body.deviceToken || '').trim();
  if (!/^(?=.{3,}$)[A-Za-z]+(?: [A-Za-z]+)*$/.test(name)) return bad(res, 400, 'Name must contain at least 3 alphabetic characters and spaces only.');
  if (!batches.includes(batch) || (session.batch && session.batch !== batch)) return bad(res, 400, 'Please select a valid batch.');
  if (email && !isValidEmail(email)) return bad(res, 400, 'Enter a valid email address or leave the email field blank.');
  if (!isValidDeviceToken(deviceToken)) return bad(res, 400, 'Unable to identify this device. Please refresh the page and try again.');
  const course = courseFor(batch);
  const now = serverNow();
  if (isHolidayDate(now.date, holidays)) return bad(res, 409, 'Attendance cannot be marked on Sundays or configured holidays.');
  if (await isDeviceSessionAttendanceLocked(now.date, deviceToken, session.id)) return bad(res, 409, deviceLockMessage);
  let lockGranted = false;
  let studentDeviceLockGranted = false;
  let attendanceSaved = false;
  try {
    if (await findExisting(session.subject, now.date, name, batch)) return bad(res, 409, 'Your attendance for this subject has already been marked today.');
    const lock = await claimDeviceSessionAttendanceLock({ date: now.date, deviceToken, qrSessionId: session.id, subject: session.subject, studentIdentifier: `${name}|${batch}` });
    if (!lock.allowed) return bad(res, 409, lock.reason);
    lockGranted = true;
    const studentDeviceLock = await claimStudentDeviceLock(name, batch, deviceToken);
    if (!studentDeviceLock.allowed) {
      await releaseDeviceSessionAttendanceLock(now.date, deviceToken, session.id);
      lockGranted = false;
      return bad(res, 409, studentDeviceLock.reason);
    }
    studentDeviceLockGranted = studentDeviceLock.newlyBound;
    const student = await registerStudent(name, batch, email);
    await appendRow(session.subject, [now.date, now.time, name, batch, course, session.subject, 'Present', 'QR', session.id]);
    attendanceSaved = true;
    await syncPercentage();
    let emailNotification = 'not-requested';
    if (student.email) {
      if (!isEmailConfigured()) emailNotification = 'not-configured';
      else {
        try {
          await sendAttendanceNotification({
            to: student.email,
            studentName: student.name,
            studentId: student.id,
            subject: session.subject,
            date: now.date,
            time: now.time,
            facultyName: session.facultyName,
            status: 'Present'
          });
          emailNotification = 'sent';
        } catch {
          emailNotification = 'failed';
        }
      }
    }
    res.json({ date: now.date, time: now.time, name, batch, course, subject: session.subject, status: 'Present', emailNotification });
  } catch (error) {
    if (lockGranted) await releaseDeviceSessionAttendanceLock(now.date, deviceToken, session.id);
    if (studentDeviceLockGranted && !attendanceSaved) await releaseStudentDeviceLock(name, batch, deviceToken);
    console.error(error);
    bad(res, 500, "We couldn't save your attendance right now. Please try again.");
  }
});

app.get('/api/student-attendance', async (req, res) => {
  const name = normalizeName(req.query.name);
  const batch = String(req.query.batch || '').trim();
  const subject = String(req.query.subject || '').trim();
  if (!name || !batches.includes(batch) || (subject && !subjects.includes(subject))) return bad(res, 400, 'Please provide a valid student name, batch, and subject.');

  try {
    const targetSubjects = subject ? [subject] : subjects;
    const today = serverNow().date;
    const attendance = [];
    let student = null;
    for (const currentSubject of targetSubjects) {
      const targetSheet = resolveSubjectSheetTitle(currentSubject);
      const result = await getSheets().spreadsheets.values.get({
        spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID,
        range: `'${targetSheet}'!A1:ZZ10000`
      });
      const matrix = result.data.values || [];
      const header = matrix[0] || [];
      const row = matrix.slice(1).find((candidate) => normalizeName(candidate[1]).toLowerCase() === name.toLowerCase() && String(candidate[2] || '').trim() === batch);
      if (!row) continue;
      student = { id: String(row[0] || '').trim(), name: normalizeName(row[1]), batch };
      for (let index = 3; index < header.length; index += 1) {
        const date = String(header[index] || '').trim();
        const status = String(row[index] || '').trim();
        if (/^\d{4}-\d{2}-\d{2}$/.test(date) && date <= today && ['Present', 'Absent'].includes(status)) {
          attendance.push({ date, status, subject: currentSubject });
        }
      }
    }
    if (!student) return bad(res, 404, 'Student not found. Please check your name and batch.');
    const presentDays = attendance.filter((record) => record.status === 'Present').length;
    const totalDays = attendance.length;
    const percentage = totalDays ? Number(((presentDays / totalDays) * 100).toFixed(2)) : 0;
    const todayRecords = attendance.filter((record) => record.date === today);
    const todayStatus = todayRecords.some((record) => record.status === 'Present')
      ? 'Present'
      : todayRecords.some((record) => record.status === 'Absent') ? 'Absent' : 'Not Marked';
    res.json({
      student,
      today: { date: today, status: todayStatus },
      attendance: { presentDays, totalDays, percentage },
      noRecords: totalDays === 0,
      lowAttendance: percentage < minAttendancePercentage,
      minimumRequired: minAttendancePercentage
    });
  } catch (error) {
    console.error(error);
    bad(res, 500, 'Unable to retrieve attendance right now. Please try again later.');
  }
});

app.post('/api/attendance/email-summary', requireInstructor, async (req, res) => {
  const name = normalizeName(req.body.name);
  const batch = String(req.body.batch || '').trim();
  if (!name || !batches.includes(batch)) return bad(res, 400, 'Enter a valid student name and batch.');
  if (!rateLimit(`summary:${req.admin.id}`, 20, 60 * 60 * 1000)) return bad(res, 429, 'Too many attendance summary emails. Try again later.');
  if (!isEmailConfigured()) return bad(res, 503, emailConfigurationMessage());

  try {
    const student = (await getStudents()).find((entry) =>
      entry.name.toLowerCase() === name.toLowerCase() && entry.batch === batch
    );
    if (!student) return bad(res, 404, 'Student not found in the roster.');
    if (!student.email) return bad(res, 400, 'This student does not have an email address in the roster.');

    const today = serverNow().date;
    const subjectSummary = [];
    for (const subject of subjects) {
      const rows = await readRows(subject);
      const records = rows.slice(1).filter((row) =>
        normalizeName(row[2]).toLowerCase() === student.name.toLowerCase()
        && String(row[3] || '').trim() === student.batch
        && row[0] <= today
        && ['Present', 'Absent'].includes(String(row[6] || '').trim())
      );
      const present = records.filter((row) => row[6] === 'Present').length;
      const total = records.length;
      if (total) {
        subjectSummary.push({
          subject,
          present,
          total,
          percentage: (present / total * 100).toFixed(2)
        });
      }
    }
    const presentCount = subjectSummary.reduce((total, row) => total + row.present, 0);
    const totalClasses = subjectSummary.reduce((total, row) => total + row.total, 0);
    const absentCount = totalClasses - presentCount;
    const attendancePercentage = totalClasses ? (presentCount / totalClasses * 100).toFixed(2) : '0.00';
    await sendAttendanceSummary({
      to: student.email,
      studentName: student.name,
      totalClasses,
      presentCount,
      absentCount,
      attendancePercentage,
      subjectSummary
    });
    res.json({ ok: true, emailNotification: 'sent' });
  } catch (error) {
    console.error('Unable to send attendance summary:', error.message);
    bad(res, 503, error.code === 'EMAIL_AUTH_FAILED'
      ? emailDeliveryErrorMessage(error)
      : error.code === 'EMAIL_NOT_CONFIGURED'
        ? emailConfigurationMessage()
        : 'Unable to send the attendance summary. Please try again later.');
  }
});

app.get('/api/report', requireInstructor, async (req, res) => {
  try {
    const rows = [];
    for (const subject of subjects) {
      const values = await readRows(subject);
      values.slice(1).filter((row) => row[6] !== 'Not Marked').forEach((r) => rows.push({ date: r[0], time: r[1], name: r[2], batch: r[3], course: r[4], subject, status: r[6], source: r[7] }));
    }
    res.json(rows);
  } catch (error) { console.error(error); bad(res, 500, 'Unable to load attendance from Google Sheets.'); }
});
app.get('/api/percentages', requireInstructor, async (req, res) => {
  try {
    const students = await getStudents();
    const rows = [];
    for (const subject of subjects) {
      const values = await readRows(subject);
      values.slice(1).forEach((r) => rows.push({ date: r[0], name: normalizeName(r[2]), batch: r[3], course: r[4], subject, status: r[6] }));
    }
    const knownStudents = new Map(students.map((student) => [`${student.name.toLowerCase()}|${student.batch}`, student]));
    for (const row of rows) {
      const key = `${row.name.toLowerCase()}|${row.batch}`;
      if (row.name && row.batch && !knownStudents.has(key)) knownStudents.set(key, { name: row.name, batch: row.batch, course: row.course || courseFor(row.batch) });
    }
    const reportStudents = [...knownStudents.values()];
    const result = [];
    const overall = new Map();
    for (const student of reportStudents) {
      for (const subject of subjects) {
        const subjectRows = rows.filter((row) =>
          row.name.toLowerCase() === student.name.toLowerCase()
          && row.batch === student.batch
          && row.subject === subject
          && isCountedClassStatus(row.status)
        );
        const dates = new Set(rows
          .filter((row) => row.batch === student.batch && row.subject === subject && row.date && isCountedClassStatus(row.status))
          .map((row) => row.date));
        const attended = subjectRows.filter((row) => row.status === 'Present').length;
        const total = dates.size;
        const key = `${student.name.toLowerCase()}|${student.batch}`;
        if (!overall.has(key)) overall.set(key, { attended: 0, total: 0 });
        overall.get(key).attended += attended;
        overall.get(key).total += total;
        result.push({ name: student.name, batch: student.batch, course: student.course, subject, attended, total, subjectPercentage: total ? ((attended / total) * 100).toFixed(2) : '0.00' });
      }
    }
    res.json(result.map((entry) => { const totals = overall.get(`${entry.name.toLowerCase()}|${entry.batch}`); return { ...entry, overallPercentage: totals.total ? ((totals.attended / totals.total) * 100).toFixed(2) : '0.00' }; }));
  } catch (error) { console.error(error); bad(res, 500, 'Unable to calculate attendance percentages.'); }
});
app.post('/api/correct', requireInstructor, async (req, res) => {
  const { subject, name, batch, status, date: requestedDate } = req.body;
  const today = serverNow().date;
  const date = String(requestedDate || today).trim();
  const validDate = /^\d{4}-\d{2}-\d{2}$/.test(date) && !Number.isNaN(Date.parse(`${date}T00:00:00Z`)) && date <= today;
  if (!subjects.includes(subject) || !batches.includes(batch) || !['Present', 'Absent'].includes(status) || !validDate) return bad(res, 400, 'Choose a valid date up to today.');
  if (isHolidayDate(date, holidays)) return bad(res, 400, 'Attendance cannot be corrected on Sundays or configured holidays.');
  try {
    const row = [date, status === 'Absent' ? '-' : serverNow().time, normalizeName(name), batch, courseFor(batch), subject, status, 'Instructor correction', 'manual'];
    await appendRow(subject, row);
    await ensureAttendanceCalendar();
    await syncPercentage();
    res.json({ ok: true, date });
  } catch (error) { console.error(error); bad(res, 500, 'Unable to save the correction.'); }
});
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
const isDirectExecution = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
if (isDirectExecution) {
  const server = httpsOptions ? https.createServer(httpsOptions, app) : app;
  Promise.resolve()
    .then(() => {
      if (process.env.NODE_ENV === 'production' && (configuredSessionSecret.length < 32 || /^(replace|change-me|your-)/i.test(configuredSessionSecret))) {
        throw new Error('Set JWT_SECRET to a random value of at least 32 characters before running in production.');
      }
      if (!configuredSessionSecret) console.warn('JWT_SECRET is unset; sessions will be invalidated when the app restarts.');
      if (!isEmailConfigured()) console.warn(emailConfigurationMessage());
      initializeAuthDatabase();
      return loadDeviceLocksFromDisk();
    })
    .then(() => {
      server.once('error', (error) => {
        if (error.code === 'EADDRINUSE') {
          console.error(`Port ${port} is already in use. Use the running app at http://localhost:${port}, stop its server with Ctrl+C in its terminal, or set PORT to another available port.`);
        } else {
          console.error('Unable to start the attendance application:', error.message);
        }
        closeAuthDatabase();
        process.exitCode = 1;
      });
      server.listen(port, '0.0.0.0', () => {
        try {
          console.log(`QR attendance running at ${resolvePublicUrl()}`);
        } catch (error) {
          console.warn('Unable to determine a phone-accessible QR URL:', error.message);
        }
        ensureSheetLayout()
          .then(() => styleAttendanceSheets())
          .then(() => syncAllSubjectStudentIds())
          .then(() => syncRosterToSubjectSheets())
          .then(() => ensureAttendanceCalendar())
          .then(() => syncAttendanceValidation())
          .then(() => syncPercentage())
          .catch((error) => console.error('Unable to sync subject matrices:', error.message));
      });
    })
    .catch((error) => {
      console.error('Unable to initialize the attendance application:', error.message);
      process.exitCode = 1;
    });
}

export {
  hashDeviceToken,
  isValidDeviceToken,
  isDeviceSessionAttendanceLocked,
  claimDeviceSessionAttendanceLock,
  releaseDeviceSessionAttendanceLock,
  loadDeviceLocksFromDisk,
  persistDeviceLocks
};

let sheetDate = serverNow().date;
const dateColumnInterval = setInterval(() => {
  const currentDate = serverNow().date;
  if (currentDate === sheetDate) return;
  sheetDate = currentDate;
  ensureAttendanceCalendar(currentDate)
    .then(() => syncAttendanceValidation())
    .catch((error) => console.error('Unable to add new date columns:', error.message));
}, 60000);
dateColumnInterval.unref();

function closeAuthDatabase() {
  if (!authDb) return;
  authDb.close();
  authDb = null;
}

export { app, initializeAuthDatabase, closeAuthDatabase };
