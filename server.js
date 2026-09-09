import 'dotenv/config';
import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import { google } from 'googleapis';

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
const subjects = (process.env.SUBJECTS || 'AI-Native Full Stack,GenAI & Agentic AI,Python Full Stack,Java Full Stack,Data Science,MERN Stack Development,Frontend Development,Backend Development,DevOps & Cloud,Data Analytics').split(',').map((subject) => subject.trim()).filter(Boolean).slice(0, 10);
const batches = [...Array.from({ length: 10 }, (_, i) => `P${i + 1}`), ...Array.from({ length: 10 }, (_, i) => `J${i + 1}`), ...Array.from({ length: 10 }, (_, i) => `D${i + 1}`)];
const courseFor = (batch) => batch.startsWith('P') ? 'Python Full Stack' : batch.startsWith('J') ? 'Java Full Stack' : 'Data Science';
const sheetHeaders = ['Date', 'Time', 'Student Name', 'Batch', 'Course', 'Subject', 'Status', 'Attendance Source', 'Session ID'];
const sessions = new Map();
const instructors = new Map();
const sessionSecret = process.env.SESSION_SECRET || 'development-secret-change-me';
const qrMinutes = Number(process.env.QR_MINUTES || Number.MAX_SAFE_INTEGER);
const minAttendancePercentage = Number(process.env.MIN_ATTENDANCE_PERCENTAGE || 75);
const attendanceValidationRule = { condition: { type: 'ONE_OF_LIST', values: [{ userEnteredValue: 'Present' }, { userEnteredValue: 'Absent' }, { userEnteredValue: 'Holiday' }] }, showCustomUi: true, strict: false };
const holidays = new Set((process.env.HOLIDAYS || '').split(',').map((date) => date.trim()).filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date)));

function ledgerSheetName(subject) { return `${subject} Ledger`; }

function resolvePublicUrl(req) {
  const configured = (process.env.APP_URL || '').trim();
  if (configured) return configured.replace(/\/$/, '');

  const forwardedProto = Array.isArray(req?.headers['x-forwarded-proto'])
    ? req.headers['x-forwarded-proto'][0]
    : req?.headers['x-forwarded-proto'];
  const forwardedHost = Array.isArray(req?.headers['x-forwarded-host'])
    ? req.headers['x-forwarded-host'][0]
    : req?.headers['x-forwarded-host'];

  const proto = forwardedProto || (httpsOptions ? 'https' : 'http');
  const host = forwardedHost || req?.headers.host || `localhost:${port}`;
  return `${proto}://${host}`;
}

app.use(express.json({ limit: '20kb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.enable('trust proxy');

function sign(value) {
  return crypto.createHmac('sha256', sessionSecret).update(value).digest('hex');
}
function instructorCookie() {
  const value = `${Date.now()}.${crypto.randomBytes(16).toString('hex')}`;
  instructors.set(value, Date.now() + 8 * 60 * 60 * 1000);
  return `${value}.${sign(value)}`;
}
function isInstructor(req) {
  const raw = req.headers.cookie?.match(/(?:^|; )instructor=([^;]+)/)?.[1];
  if (!raw) return false;
  const lastDot = raw.lastIndexOf('.');
  const value = raw.slice(0, lastDot);
  const received = Buffer.from(raw.slice(lastDot + 1));
  const expected = Buffer.from(sign(value));
  return lastDot > 0 && received.length === expected.length && crypto.timingSafeEqual(received, expected) && instructors.get(value) > Date.now();
}
function requireInstructor(req, res, next) {
  if (!isInstructor(req)) return res.status(401).json({ error: 'Instructor login required.' });
  next();
}
function normalizeName(name) {
  return String(name || '').trim().replace(/\s+/g, ' ');
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
async function ensureSheetLayout() {
  if (layoutPromise) return layoutPromise;
  layoutPromise = (async () => {
    const service = getSheets();
    const metadata = await service.spreadsheets.get({ spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID, fields: 'sheets.properties.title,sheets.properties.sheetId' });
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
    const updatedMetadata = await service.spreadsheets.get({ spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID, fields: 'sheets.properties.title' });
    const refreshedExisting = new Set(updatedMetadata.data.sheets.map((sheet) => sheet.properties.title));
    const missing = required.filter((title) => !refreshedExisting.has(title));
    if (missing.length) {
      await service.spreadsheets.batchUpdate({ spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID, requestBody: { requests: missing.map((title) => ({ addSheet: { properties: { title } } })) } });
    }
    const headers = [
      ['Students', ['Student ID', 'Student Name', 'Batch']],
      ['Percentage', ['Student Name', 'Batch', 'Course', 'Subject', 'Attended Classes', 'Total Classes', 'Subject Percentage', 'Full-Course / Overall Percentage']],
      ...subjects.map((subject) => [subject, ['Student ID', 'Student Name', 'Batch']])
    ];
    await service.spreadsheets.values.batchUpdate({ spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID, requestBody: { valueInputOption: 'USER_ENTERED', data: headers.map(([title, values]) => ({ range: `'${title}'!A1`, values: [values] })) } });
  })();
  return layoutPromise;
}
async function syncSubjectMatrix(subject) {
  const result = await getSheets().spreadsheets.values.get({ spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID, range: `'${subject}'!A1:ZZ10000` });
  if (!(result.data.values || []).length) {
    await getSheets().spreadsheets.values.update({ spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID, range: `'${subject}'!A1`, valueInputOption: 'USER_ENTERED', requestBody: { values: [['Student ID', 'Student Name', 'Batch']] } });
  }
}
async function syncAllSubjectMatrices() {
  await ensureSheetLayout();
  await Promise.all(subjects.map((subject) => syncSubjectMatrix(subject)));
}
async function syncAttendanceValidation() {
  const metadata = await getSheets().spreadsheets.get({ spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID, fields: 'sheets.properties.title,sheets.properties.sheetId' });
  const requests = [];
  for (const sheet of metadata.data.sheets) {
    if (!subjects.includes(sheet.properties.title)) continue;
    const values = (await getSheets().spreadsheets.values.get({ spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID, range: `'${sheet.properties.title}'!A1:ZZ10000` })).data.values || [];
    const headers = values[0] || [];
    const dateIndexes = headers.map((value, index) => index >= 3 && /^\d{4}-\d{2}-\d{2}$/.test(String(value || '').trim()) ? index : -1).filter((index) => index >= 0);
    const studentRows = values.slice(1).map((row, index) => index + 1).filter((rowIndex) => {
      const row = values[rowIndex];
      return String(row?.[1] || '').trim() && String(row?.[2] || '').trim();
    });
    for (const dateIndex of dateIndexes) {
      for (const rowIndex of studentRows) {
        requests.push({ setDataValidation: { range: { sheetId: sheet.properties.sheetId, startRowIndex: rowIndex, endRowIndex: rowIndex + 1, startColumnIndex: dateIndex, endColumnIndex: dateIndex + 1 }, rule: attendanceValidationRule } });
      }
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
async function copyDateColumnFormatting(subject, sourceIndex, destinationIndex, insertColumn = false, validationEndRow = 1000) {
  const metadata = await getSheets().spreadsheets.get({
    spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID,
    fields: 'sheets.properties'
  });
  const sheet = metadata.data.sheets.find((entry) => entry.properties.title === subject);
  if (!sheet) throw new Error(`Subject sheet not found: ${subject}`);
  const sheetId = sheet.properties.sheetId;
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
  const metadata = await getSheets().spreadsheets.get({ spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID, fields: 'sheets.properties.title,sheets.properties.sheetId' });
  const sheet = metadata.data.sheets.find((entry) => entry.properties.title === subject);
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
  await ensureSheetLayout();
  const result = await getSheets().spreadsheets.values.get({ spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID, range: `'${subject}'!A1:ZZ10000` });
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
    await copyDateColumnFormatting(subject, 4, dateIndex, true, Math.max(matrix.length, targetRow + 1));
    await getSheets().spreadsheets.values.update({ spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID, range: `'${subject}'!${columnName(dateIndex)}1`, valueInputOption: 'USER_ENTERED', requestBody: { values: [[date]] } });
  }
  if (rowIndex < 1) {
    await getSheets().spreadsheets.values.update({ spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID, range: `'${subject}'!A${targetRow + 1}:C${targetRow + 1}`, valueInputOption: 'USER_ENTERED', requestBody: { values: [[registeredStudent?.id || '', name, batch]] } });
  }
  const attendanceUpdates = [{
    range: `'${subject}'!${columnName(dateIndex)}${targetRow + 1}`,
    values: [[values[6] || 'Absent']]
  }];
  if (rowIndex < 1) {
    const existingDateIndexes = header.map((value, index) => index >= 3 && /^\d{4}-\d{2}-\d{2}$/.test(String(value || '').trim()) ? index : -1).filter((index) => index >= 0);
    const validationDateIndexes = [...existingDateIndexes.map((index) => newDateColumn ? index + 1 : index), dateIndex];
    await addAttendanceValidationToRow(subject, targetRow, [...new Set(validationDateIndexes)]);
    for (const existingDateIndex of existingDateIndexes) {
      const existingDate = String(header[existingDateIndex] || '').trim();
      if (existingDate >= date || existingDate > serverNow().date) continue;
      attendanceUpdates.push({
        range: `'${subject}'!${columnName(newDateColumn ? existingDateIndex + 1 : existingDateIndex)}${targetRow + 1}`,
        values: [[holidays.has(existingDate) ? 'Holiday' : 'Absent']]
      });
    }
  }
  await getSheets().spreadsheets.values.batchUpdate({ spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID, requestBody: { valueInputOption: 'USER_ENTERED', data: attendanceUpdates } });
}
async function readRows(tab) {
  await ensureSheetLayout();
  const normalized = String(tab || '').trim();
  if (!normalized) return [];

  if (normalized === 'Students' || normalized === 'Percentage') return (await getSheets().spreadsheets.values.get({
    spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID,
    range: `'${normalized}'!A1:K10000`
  })).data.values || [];

  const result = await getSheets().spreadsheets.values.get({
    spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID,
    range: `'${normalized}'!A1:ZZ10000`
  });
  if (!subjects.includes(normalized)) return result.data.values || [];
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
    course: courseFor(String(r[2] || r[1] || '').trim())
  })).filter((s) => s.name && batches.includes(s.batch));
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
    return sameDate && sameName && sameBatch && !sameStudentId;
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
    if (!row.name || !row.batch || !row.date) continue;
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

app.post('/api/login', (req, res) => {
  if (!process.env.INSTRUCTOR_PASSWORD || req.body.password !== process.env.INSTRUCTOR_PASSWORD) return bad(res, 401, 'Incorrect instructor password.');
  res.setHeader('Set-Cookie', `instructor=${instructorCookie()}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`);
  res.json({ ok: true });
});
app.post('/api/logout', (req, res) => { res.setHeader('Set-Cookie', 'instructor=; Max-Age=0; HttpOnly; SameSite=Strict; Path=/'); res.json({ ok: true }); });
app.get('/api/me', (req, res) => res.json({ instructor: isInstructor(req) }));
app.get('/api/config', (req, res) => res.json({ subjects, batches }));

app.post('/api/sessions', requireInstructor, async (req, res) => {
  const { subject, batch } = req.body;
  if (!subjects.includes(subject)) return bad(res, 400, 'Invalid subject.');
  if (batch && !batches.includes(batch)) return bad(res, 400, 'Invalid batch.');
  const now = Date.now();
  const id = crypto.randomUUID();
  const session = { id, subject, batch: batch || null, createdAt: now, expiresAt: now + qrMinutes * 60 * 1000, status: 'active' };
  sessions.set(id, session);
  const token = sessionToken(id);
  const baseUrl = resolvePublicUrl(req);
  const url = `${baseUrl}/?session=${encodeURIComponent(token)}`;
  res.json({ ...session, url, qr: await QRCode.toDataURL(url) });
});
app.get('/api/sessions/:token', (req, res) => {
  const session = readSession(req.params.token);
  if (!session) return bad(res, 410, 'This QR code is invalid. Please scan a valid QR code.');
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
      if (!session.batch || student.batch === session.batch) roster.set(`${student.name.toLowerCase()}|${student.batch}`, student);
    }
    const eligible = [...roster.values()];
    const rows = await readRows(session.subject);
    const existing = new Set(rows.slice(1).filter((r) => r[0] === date && r[3]).map((r) => `${r[2].toLowerCase()}|${r[3]}`));
    let added = 0;
    for (const student of eligible) {
      const key = `${student.name.toLowerCase()}|${student.batch}`;
      if (!existing.has(key)) {
        const status = holidays.has(date) ? 'Holiday' : 'Absent';
        await appendRow(session.subject, [date, status === 'Absent' ? '-' : '', student.name, student.batch, student.course, session.subject, status, 'Session close', session.id]);
        added += 1;
      }
    }
      await syncPercentage();
    session.closedAt = Date.now();
    session.status = 'closed';
    res.json({ ok: true, added });
  } catch (error) { console.error(error); bad(res, 500, 'Unable to finalize absent students.'); }
});

app.post('/api/attendance', async (req, res) => {
  const session = readSession(req.body.token);
  if (!session) return bad(res, 410, 'This QR code is invalid. Please scan a valid QR code.');
  const name = normalizeName(req.body.name);
  const batch = String(req.body.batch || '');
  if (!/^(?=.{3,}$)[A-Za-z]+(?: [A-Za-z]+)*$/.test(name)) return bad(res, 400, 'Name must contain at least 3 alphabetic characters and spaces only.');
  if (!batches.includes(batch) || (session.batch && session.batch !== batch)) return bad(res, 400, 'Please select a valid batch.');
  const course = courseFor(batch);
  const now = serverNow();
  try {
    if (await findExisting(session.subject, now.date, name, batch)) return bad(res, 409, 'Your attendance for this subject has already been marked today.');
    await appendRow(session.subject, [now.date, now.time, name, batch, course, session.subject, 'Present', 'QR', session.id]);
    await syncPercentage();
    res.json({ date: now.date, time: now.time, name, batch, course, subject: session.subject, status: 'Present' });
  } catch (error) { console.error(error); bad(res, 500, "We couldn't save your attendance right now. Please try again."); }
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
      const result = await getSheets().spreadsheets.values.get({
        spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID,
        range: `'${currentSubject}'!A1:ZZ10000`
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

app.get('/api/report', requireInstructor, async (req, res) => {
  try {
    const rows = [];
    for (const subject of subjects) {
      const values = await readRows(subject);
      values.slice(1).forEach((r) => rows.push({ date: r[0], time: r[1], name: r[2], batch: r[3], course: r[4], subject, status: r[6], source: r[7] }));
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
        const subjectRows = rows.filter((row) => row.name.toLowerCase() === student.name.toLowerCase() && row.batch === student.batch && row.subject === subject);
        const dates = new Set(rows.filter((row) => row.batch === student.batch && row.subject === subject && row.date).map((row) => row.date));
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
  try {
    const row = [date, status === 'Absent' ? '-' : serverNow().time, normalizeName(name), batch, courseFor(batch), subject, status, 'Instructor correction', 'manual'];
    await appendRow(subject, row);
    await syncPercentage();
    res.json({ ok: true, date });
  } catch (error) { console.error(error); bad(res, 500, 'Unable to save the correction.'); }
});
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
const server = httpsOptions ? https.createServer(httpsOptions, app) : app;
server.listen(port, '0.0.0.0', () => {
  console.log(`QR attendance running at ${resolvePublicUrl()}`);
  syncAllSubjectMatrices().catch((error) => console.error('Unable to sync subject matrices:', error.message));
  syncAttendanceValidation().catch((error) => console.error('Unable to sync attendance selectors:', error.message));
});


// http://192.168.1.10:3000  This is wifi mobile ip address.  You can use this to access the app from your mobile device on the same network.