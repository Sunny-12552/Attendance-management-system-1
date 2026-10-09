const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const token = params.get('session');
const DEVICE_TOKEN_KEY = 'attendance-device-token';
let config = { subjects: [], batches: [] };
let records = [];
let dashboardDate = '';

function generateDeviceToken() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return `dev-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}
function getDeviceToken() {
  const existing = localStorage.getItem(DEVICE_TOKEN_KEY);
  if (existing && /^[A-Za-z0-9._:-]{12,128}$/.test(existing)) return existing;
  const next = generateDeviceToken();
  localStorage.setItem(DEVICE_TOKEN_KEY, next);
  return next;
}
const deviceToken = getDeviceToken();

async function api(path, options = {}) {
  const response = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...options });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Something went wrong.');
  return data;
}
function show(id) { document.querySelectorAll('.view').forEach((view) => view.classList.add('hidden')); $(id).classList.remove('hidden'); }
function message(id, text = '') { $(id).textContent = text; }
function fillSelect(id, values, first = '') { const el = $(id); el.innerHTML = first + values.map((value) => `<option value="${value}">${value}</option>`).join(''); }
function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c])); }

async function loadConfig() { config = await api('/api/config'); fillSelect('student-batch', config.batches); fillSelect('attendance-check-batch', config.batches); fillSelect('subject', config.subjects); fillSelect('scope-batch', config.batches, '<option value="">All batches</option>'); fillSelect('correction-batch', config.batches); fillSelect('correction-subject', config.subjects); fillSelect('summary-email-batch', config.batches); }
async function initStudent() {
  show('student-view');
  try { const session = await api(`/api/sessions/${encodeURIComponent(token)}`); attendedSubject = session.subject; $('session-summary').textContent = `${session.subject}${session.batch ? ` · ${session.batch} only` : ''}`; }
  catch (error) { $('session-summary').textContent = error.message; $('attendance-form').classList.add('hidden'); }
}
let attendedSubject = '';
function showAttendanceChecker(name, batch) { $('student-attendance').classList.remove('hidden'); $('attendance-check-name').value = name; $('attendance-check-batch').value = batch; }
function redirectAfterDeviceBlock() {
  message('student-message', 'Attendance Limit Reached. This device has already marked attendance for this subject.');
  setTimeout(() => {
    window.location.href = '/';
  }, 1200);
}

$('attendance-form').addEventListener('submit', async (event) => { event.preventDefault(); message('student-message', 'Saving...'); const name = $('student-name').value; const batch = $('student-batch').value; try { const result = await api('/api/attendance', { method: 'POST', body: JSON.stringify({ token, name, batch, email: $('student-email').value, deviceToken }) }); attendedSubject = result.subject; $('attendance-form').classList.add('hidden'); $('confirmation').classList.remove('hidden'); const emailMessage = result.emailNotification === 'sent' ? '<br>Attendance confirmation sent to your email.' : result.emailNotification === 'failed' ? '<br>Attendance was recorded, but the confirmation email could not be sent.' : result.emailNotification === 'not-configured' ? '<br>Email updates are temporarily unavailable; attendance was recorded.' : ''; $('confirmation').innerHTML = `<strong>Attendance marked successfully.</strong><br>${escapeHtml(result.name)} · ${escapeHtml(result.batch)} · ${escapeHtml(result.course)}<br>${escapeHtml(result.subject)} · ${escapeHtml(result.date)} · ${escapeHtml(result.status)}${emailMessage}`; showAttendanceChecker(result.name, result.batch); } catch (error) { message('student-message', error.message); if (error.message.includes('Attendance Limit Reached')) return redirectAfterDeviceBlock(); if (error.message.includes('already been marked')) showAttendanceChecker(name, batch); } });
$('student-attendance-form').addEventListener('submit', async (event) => { event.preventDefault(); const button = $('attendance-check-button'); button.disabled = true; button.textContent = 'Checking attendance...'; message('attendance-check-message'); $('student-attendance-result').classList.add('hidden'); try { const query = new URLSearchParams({ name: $('attendance-check-name').value, batch: $('attendance-check-batch').value, subject: attendedSubject }); const result = await api(`/api/student-attendance?${query}`); const percentage = `${Number(result.attendance.percentage).toFixed(2).replace(/\.00$/, '')}%`; const date = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' }).format(new Date(`${result.today.date}T00:00:00`)); const statusClass = result.today.status.toLowerCase().replace(' ', '-'); $('student-attendance-result').innerHTML = `<div class="attendance-result-head"><strong>Your Attendance</strong><span class="status-pill ${statusClass}">${escapeHtml(result.today.status)}</span></div><p><strong>Student:</strong> ${escapeHtml(result.student.name)}<br><strong>Batch:</strong> ${escapeHtml(result.student.batch)}</p><div class="today-status"><span>Today's Attendance</span><strong>${escapeHtml(date)}</strong><b class="${statusClass}">${result.today.status === 'Present' ? '✓ ' : result.today.status === 'Absent' ? '✕ ' : ''}${escapeHtml(result.today.status)}</b></div><div class="attendance-percentage"><span>Overall Attendance</span><strong>${percentage}</strong><small>${result.attendance.presentDays} Present / ${result.attendance.totalDays} Total Days</small></div>${result.lowAttendance ? `<div class="attendance-warning"><strong>⚠ Low Attendance</strong><span>Your attendance is below the required ${result.minimumRequired}%.</span><span>Current Attendance: ${percentage}</span><span>Please improve your attendance to avoid attendance shortage.</span></div>` : `<div class="attendance-good"><strong>✓ Attendance is Good</strong><span>Your current attendance is ${percentage}.</span></div>`}`; $('student-attendance-result').classList.remove('hidden'); } catch (error) { message('attendance-check-message', error.message); } finally { button.disabled = false; button.textContent = 'Check Attendance'; } });
function showAuthForm(id) {
  ['login-form', 'registration-form', 'recovery-form'].forEach((formId) => $(formId).classList.toggle('hidden', formId !== id));
}
function setCredentialStage(containerId, enabled) {
  const container = $(containerId);
  container.classList.toggle('hidden', !enabled);
  container.querySelectorAll('input').forEach((input) => { input.disabled = !enabled; });
}
let registrationCodeRequested = false;
let registrationOtpPurpose = 'verify';
let recoveryCodeRequested = false;
let otpCountdownTimer = null;
function startOtpCountdown(messageId, resendButtonId, seconds = 60, statusText = 'Verification code sent. It expires in 10 minutes.') {
  const button = $(resendButtonId);
  let remaining = seconds;
  button.disabled = true;
  button.textContent = `Resend code in ${remaining}s`;
  if (otpCountdownTimer) clearInterval(otpCountdownTimer);
  otpCountdownTimer = setInterval(() => {
    remaining -= 1;
    if (remaining <= 0) {
      clearInterval(otpCountdownTimer);
      otpCountdownTimer = null;
      button.disabled = false;
      button.textContent = 'Resend verification code';
      return;
    }
    button.textContent = `Resend code in ${remaining}s`;
  }, 1000);
  message(messageId, statusText);
}

$('login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  message('login-message', 'Opening...');
  try {
    await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: $('login-email').value, password: $('password').value }) });
    await initDashboard();
  } catch (error) { message('login-message', error.message); }
});
$('show-registration-link').addEventListener('click', () => {
  showAuthForm('registration-form');
  message('registration-message');
});
$('resume-signup-link').addEventListener('click', async () => {
  const emailField = $('registration-email');
  if (!emailField.value || !emailField.checkValidity()) {
    message('registration-message', 'Enter the email address used when signing up.');
    emailField.focus();
    return;
  }
  try {
    const result = await api('/api/auth/resend-otp', {
      method: 'POST',
      body: JSON.stringify({ purpose: 'verify', email: emailField.value })
    });
    registrationOtpPurpose = result.purpose || 'verify';
    registrationCodeRequested = true;
    $('registration-email').value = emailField.value;
    $('registration-details').classList.add('hidden');
    $('registration-details').querySelectorAll('input').forEach((input) => { input.disabled = true; });
    setCredentialStage('registration-credentials', true);
    $('registration-resend').classList.remove('hidden');
    $('registration-form').querySelector('button.primary').textContent = 'Verify email';
    showAuthForm('registration-form');
    startOtpCountdown('registration-message', 'registration-resend', 60, 'If this email has a pending signup, a code may have been sent. If you have not submitted signup yet, complete Create admin account first. Check your spam or junk folder.');
  } catch (error) { message('registration-message', error.message); }
});
$('forgot-password-link').addEventListener('click', () => {
  $('recovery-email').value = $('login-email').value;
  showAuthForm('recovery-form');
  message('recovery-message');
});
document.querySelectorAll('.auth-back-link').forEach((button) => button.addEventListener('click', () => showAuthForm('login-form')));
$('registration-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = $('registration-form').querySelector('button.primary');
  button.disabled = true;
  try {
    const email = $('registration-email').value;
    if (!registrationCodeRequested) {
      const signupResult = await api('/api/auth/signup', {
        method: 'POST',
        body: JSON.stringify({
          name: $('registration-name').value,
          email,
          password: $('registration-password').value,
          confirmPassword: $('registration-confirm-password').value
        })
      });
      registrationCodeRequested = true;
      registrationOtpPurpose = signupResult.otpPurpose;
      setCredentialStage('registration-credentials', true);
      $('registration-details').classList.add('hidden');
      $('registration-details').querySelectorAll('input').forEach((input) => { input.disabled = true; });
      $('registration-resend').classList.remove('hidden');
      button.textContent = 'Verify email';
      startOtpCountdown(
        'registration-message',
        'registration-resend',
        60,
        signupResult.otpPurpose === 'invite'
          ? 'Use the code from your admin invitation email. It expires 10 minutes after it was sent.'
          : 'Verification code sent. It expires in 10 minutes.'
      );
    } else {
      const verification = await api('/api/auth/verify-otp', {
        method: 'POST',
        body: JSON.stringify({
          purpose: registrationOtpPurpose,
          email,
          code: $('registration-otp').value
        })
      });
      registrationCodeRequested = false;
      setCredentialStage('registration-credentials', false);
      $('registration-details').classList.remove('hidden');
      $('registration-details').querySelectorAll('input').forEach((input) => { input.disabled = false; });
      $('registration-resend').classList.add('hidden');
      button.textContent = 'Create account →';
      $('login-email').value = email;
      $('password').value = '';
      showAuthForm('login-form');
      message('login-message', verification.emailNotification === 'failed'
        ? 'Email verified. Sign in with your email and password; the welcome email could not be sent.'
        : 'Email verified. Sign in with your email and password.');
    }
  } catch (error) { message('registration-message', error.message); }
  finally { button.disabled = false; }
});
$('recovery-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = $('recovery-form').querySelector('button.primary');
  button.disabled = true;
  try {
    const email = $('recovery-email').value;
    if (!recoveryCodeRequested) {
      await api('/api/auth/resend-otp', { method: 'POST', body: JSON.stringify({ purpose: 'reset', email }) });
      recoveryCodeRequested = true;
      setCredentialStage('recovery-credentials', true);
      $('recovery-resend').classList.remove('hidden');
      button.textContent = 'Change password';
      startOtpCountdown('recovery-message', 'recovery-resend', 60, 'If this email belongs to an active admin account, a code will be sent. Codes expire after 10 minutes.');
    } else {
      await api('/api/auth/verify-otp', {
        method: 'POST',
        body: JSON.stringify({
          purpose: 'reset',
          email,
          code: $('recovery-otp').value,
          password: $('recovery-password').value,
          confirmPassword: $('recovery-confirm-password').value
        })
      });
      $('login-email').value = email;
      $('password').value = '';
      recoveryCodeRequested = false;
      setCredentialStage('recovery-credentials', false);
      $('recovery-resend').classList.add('hidden');
      button.textContent = 'Send verification code →';
      showAuthForm('login-form');
      message('login-message', 'Password changed. Sign in with your new password.');
    }
  } catch (error) { message('recovery-message', error.message); }
  finally { button.disabled = false; }
});
$('registration-resend').addEventListener('click', async () => {
  const button = $('registration-resend');
  button.disabled = true;
  try {
    await api('/api/auth/resend-otp', { method: 'POST', body: JSON.stringify({ purpose: registrationOtpPurpose, email: $('registration-email').value }) });
    startOtpCountdown('registration-message', 'registration-resend');
  } catch (error) { button.disabled = false; message('registration-message', error.message); }
});
$('recovery-resend').addEventListener('click', async () => {
  const button = $('recovery-resend');
  button.disabled = true;
  try {
    await api('/api/auth/resend-otp', { method: 'POST', body: JSON.stringify({ purpose: 'reset', email: $('recovery-email').value }) });
    startOtpCountdown('recovery-message', 'recovery-resend');
  } catch (error) { button.disabled = false; message('recovery-message', error.message); }
});
setCredentialStage('registration-credentials', false);
setCredentialStage('recovery-credentials', false);
const attendanceResultObserver = new MutationObserver(() => {
  const resultCard = $('student-attendance-result');
  const details = resultCard.querySelector('p');
  if (!details || details.dataset.idAdded === 'true') return;
  const query = new URLSearchParams({ name: $('attendance-check-name').value, batch: $('attendance-check-batch').value, subject: attendedSubject });
  api(`/api/student-attendance?${query}`).then((result) => {
    details.innerHTML = `<strong>Student:</strong> ${escapeHtml(result.student.name)}<br><strong>Student ID:</strong> ${escapeHtml(result.student.id || 'Not assigned')}<br><strong>Batch:</strong> ${escapeHtml(result.student.batch)}`;
    details.dataset.idAdded = 'true';
  }).catch(() => {});
});
attendanceResultObserver.observe($('student-attendance-result'), { childList: true });
$('logout').addEventListener('click', async () => { await api('/api/auth/logout', { method: 'POST' }); $('logout').classList.add('hidden'); show('login-view'); });
$('session-form').addEventListener('submit', async (event) => { event.preventDefault(); message('session-message', 'Generating...'); try { const session = await api('/api/sessions', { method: 'POST', body: JSON.stringify({ subject: $('subject').value, batch: $('scope-batch').value }) }); $('qr-result').classList.remove('hidden'); $('qr-result').innerHTML = `<img src="${session.qr}" alt="Attendance QR code"><p><a href="${escapeHtml(session.url)}" target="_blank" rel="noopener noreferrer">Open student page ↗</a></p><p class="muted">Phone scanning requires the phone to be on the same Wi-Fi network. For other networks, configure a public HTTPS APP_URL.</p><button class="secondary" id="close-session" type="button">Close session and mark absences</button>`; $('close-session').addEventListener('click', async () => { $('close-session').disabled = true; $('close-session').textContent = 'Finalizing...'; try { const result = await api(`/api/sessions/${session.id}/close`, { method: 'POST' }); $('close-session').textContent = `Closed · ${result.added} absences added`; const notifications = result.emailNotifications; if (notifications.failed || notifications.skipped) message('session-message', `Absences finalized. Email notifications: ${notifications.sent} sent, ${notifications.failed} failed, ${notifications.skipped} skipped.`); await refreshReport(); } catch (error) { $('close-session').disabled = false; $('close-session').textContent = error.message; } }); message('session-message'); } catch (error) { message('session-message', error.message); } });
function formatReportDate(date) {
  if (!date) return 'Unknown date';
  const safeDate = new Date(`${date}T00:00:00`);
  return new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }).format(safeDate);
}
function formatSectionLabel(batch) {
  if (!batch) return 'General';
  const prefix = batch.charAt(0).toUpperCase();
  const map = { P: 'P - Python', J: 'J - Java', D: 'D - Data Science' };
  return map[prefix] || `${prefix} - ${batch}`;
}
function buildDateGroupedRecords(rows) {
  const grouped = new Map();
  for (const row of rows) {
    const key = row.date || 'Unknown date';
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(row);
  }
  return [...grouped.entries()].sort(([a], [b]) => new Date(`${b}T00:00:00`) - new Date(`${a}T00:00:00`));
}
function getServerDate() { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date()); }
function updateDashboardDate(date) {
  dashboardDate = date;
  $('dashboard-date').textContent = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', dateStyle: 'full' }).format(new Date(`${date}T00:00:00`));
}
async function refreshReport() { try { records = await api('/api/report'); const percentages = await api('/api/percentages'); const date = getServerDate(); updateDashboardDate(date); const today = records.filter((r) => r.date === date); const presentToday = today.filter((r) => r.status === 'Present').length; const absentToday = today.filter((r) => r.status === 'Absent').length; $('total-count').textContent = presentToday + absentToday; $('present-count').textContent = presentToday; $('absent-count').textContent = absentToday; const groupedRecords = buildDateGroupedRecords(records.slice().reverse()); $('records').innerHTML = groupedRecords.length ? groupedRecords.map(([day, dayRows]) => `
        <tr class="date-group-row"><td colspan="5"><div class="date-group-header">${escapeHtml(formatReportDate(day))}</div></td></tr>
        ${dayRows.map((r) => `<tr><td>${escapeHtml(r.date)}</td><td>${escapeHtml(r.name)}</td><td>${escapeHtml(r.batch)}</td><td>${escapeHtml(r.subject)}</td><td class="status ${r.status.toLowerCase()}">${escapeHtml(r.status)}</td></tr>`).join('')}
      `).join('') : '<tr><td colspan="5">No records yet.</td></tr>';
    const groupedPercentages = new Map();
    for (const row of percentages.filter((r) => r.total > 0)) {
      const label = formatSectionLabel(row.batch);
      if (!groupedPercentages.has(label)) groupedPercentages.set(label, []);
      groupedPercentages.get(label).push(row);
    }
    $('percentages').innerHTML = groupedPercentages.size ? [...groupedPercentages.entries()].map(([sectionLabel, sectionRows]) => `
        <tr class="section-group-row"><td colspan="7"><div class="section-group-header">${escapeHtml(sectionLabel)}</div></td></tr>
        ${sectionRows.map((r) => `<tr><td>${escapeHtml(r.name)}</td><td>${escapeHtml(r.batch)}</td><td>${escapeHtml(r.subject)}</td><td>${r.attended}</td><td>${r.total}</td><td class="status">${r.subjectPercentage}%</td><td class="status">${r.overallPercentage}%</td></tr>`).join('')}
      `).join('') : '<tr><td colspan="7">No conducted classes yet.</td></tr>'; } catch (error) { message('session-message', error.message); } }
$('open-records').addEventListener('click', async () => { show('records-view'); await refreshReport(); });
$('open-percentages').addEventListener('click', async () => { show('percentage-view'); await refreshReport(); });
document.querySelectorAll('.back-dashboard').forEach((button) => button.addEventListener('click', () => show('dashboard-view')));
$('refresh-records').addEventListener('click', refreshReport);
$('refresh-percentages').addEventListener('click', refreshReport);
$('correction-form').addEventListener('submit', async (event) => { event.preventDefault(); message('correction-message', 'Saving...'); try { const date = $('correction-date').value; await api('/api/correct', { method: 'POST', body: JSON.stringify({ name: $('correction-name').value, batch: $('correction-batch').value, subject: $('correction-subject').value, status: $('correction-status').value, date: date || undefined }) }); message('correction-message', date ? `Correction saved for ${date}.` : 'Today\'s correction saved.'); await refreshReport(); } catch (error) { message('correction-message', error.message); } });
async function refreshAdmins() {
  try {
    const [admins, me] = await Promise.all([api('/api/admins'), api('/api/me')]);
    $('admin-accounts').innerHTML = admins.length ? admins.map((admin) => {
      const status = !admin.isVerified ? 'Invitation pending' : admin.isActive ? 'Active' : 'Inactive';
      const action = admin.id === me.admin?.id
        ? '<span>Current account</span>'
        : admin.isVerified
          ? `<button class="secondary admin-status-button" data-admin-id="${escapeHtml(admin.id)}" data-active="${!admin.isActive}" type="button">${admin.isActive ? 'Deactivate' : 'Activate'}</button>`
          : `<button class="link-button admin-resend-button" data-email="${escapeHtml(admin.email)}" type="button">Resend invitation</button>`;
      return `<tr><td>${escapeHtml(admin.name || '—')}</td><td>${escapeHtml(admin.email)}</td><td>${status}</td><td>${escapeHtml(admin.lastLogin || 'Never')}</td><td>${action}</td></tr>`;
    }).join('') : '<tr><td colspan="5">No admin accounts.</td></tr>';
  } catch (error) {
    $('admin-accounts').innerHTML = '<tr><td colspan="5">Unable to load admin accounts.</td></tr>';
    message('admin-invite-message', error.message);
  }
}
$('admin-invite-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = $('admin-invite-form').querySelector('button[type="submit"]');
  button.disabled = true;
  message('admin-invite-message', 'Sending invitation...');
  try {
    await api('/api/admins/invite', { method: 'POST', body: JSON.stringify({ name: $('admin-invite-name').value, email: $('admin-invite-email').value }) });
    $('admin-invite-name').value = '';
    $('admin-invite-email').value = '';
    message('admin-invite-message', 'Invitation sent. The new admin should finish signup using the invited email.');
    await refreshAdmins();
  } catch (error) { message('admin-invite-message', error.message); }
  finally { button.disabled = false; }
});
$('summary-email-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = $('summary-email-form').querySelector('button[type="submit"]');
  button.disabled = true;
  message('summary-email-message', 'Preparing attendance summary...');
  try {
    await api('/api/attendance/email-summary', {
      method: 'POST',
      body: JSON.stringify({ name: $('summary-email-name').value, batch: $('summary-email-batch').value })
    });
    message('summary-email-message', 'Attendance summary sent to the student email saved in the roster.');
  } catch (error) {
    message('summary-email-message', error.message);
  } finally {
    button.disabled = false;
  }
});
$('admin-accounts').addEventListener('click', async (event) => {
  const statusButton = event.target.closest('.admin-status-button');
  const resendButton = event.target.closest('.admin-resend-button');
  if (statusButton) {
    statusButton.disabled = true;
    try {
      const result = await api(`/api/admins/${encodeURIComponent(statusButton.dataset.adminId)}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ active: statusButton.dataset.active === 'true' })
      });
      if (result.emailNotification === 'failed' || result.emailNotification === 'not-configured') {
        message('admin-invite-message', result.emailNotification === 'failed'
          ? 'Account status updated, but the status email could not be sent.'
          : 'Account status updated. Email service is not configured.');
      }
      await refreshAdmins();
    } catch (error) { message('admin-invite-message', error.message); statusButton.disabled = false; }
  } else if (resendButton) {
    resendButton.disabled = true;
    try {
      await api('/api/auth/resend-otp', { method: 'POST', body: JSON.stringify({ purpose: 'invite', email: resendButton.dataset.email }) });
      message('admin-invite-message', 'Invitation code sent again.');
    } catch (error) { message('admin-invite-message', error.message); }
    finally { resendButton.disabled = false; }
  }
});
async function initDashboard() { show('dashboard-view'); $('logout').classList.remove('hidden'); await Promise.all([refreshReport(), refreshAdmins()]); }
setInterval(() => {
  if (!$('dashboard-view').classList.contains('hidden') && dashboardDate && getServerDate() !== dashboardDate) refreshReport();
}, 30000);
(async function boot() { await loadConfig(); if (token) return initStudent(); const me = await api('/api/me'); if (me.instructor) return initDashboard(); $('show-registration-link').classList.remove('hidden'); show('login-view'); })().catch((error) => { show('login-view'); message('login-message', error.message); });
