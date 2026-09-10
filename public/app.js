const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const token = params.get('session');
let config = { subjects: [], batches: [] };
let records = [];
let dashboardDate = '';

async function api(path, options = {}) {
  const response = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...options });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Something went wrong.');
  return data;
}
function show(id) { document.querySelectorAll('.view').forEach((view) => view.classList.add('hidden')); $(id).classList.remove('hidden'); document.body.classList.toggle('branded-page', id === 'login-view' || id === 'student-view'); }
function message(id, text = '') { $(id).textContent = text; }
function fillSelect(id, values, first = '') { const el = $(id); el.innerHTML = first + values.map((value) => `<option value="${value}">${value}</option>`).join(''); }
function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c])); }

async function loadConfig() { config = await api('/api/config'); fillSelect('student-batch', config.batches); fillSelect('attendance-check-batch', config.batches); fillSelect('subject', config.subjects); fillSelect('scope-batch', config.batches, '<option value="">All batches</option>'); fillSelect('correction-batch', config.batches); fillSelect('correction-subject', config.subjects); }
async function initStudent() {
  show('student-view');
  try { const session = await api(`/api/sessions/${encodeURIComponent(token)}`); attendedSubject = session.subject; $('session-summary').textContent = `${session.subject}${session.batch ? ` · ${session.batch} only` : ''}`; }
  catch (error) { $('session-summary').textContent = error.message; $('attendance-form').classList.add('hidden'); }
}
let attendedSubject = '';
function showAttendanceChecker(name, batch) { $('student-attendance').classList.remove('hidden'); $('attendance-check-name').value = name; $('attendance-check-batch').value = batch; }
$('attendance-form').addEventListener('submit', async (event) => { event.preventDefault(); message('student-message', 'Saving...'); const name = $('student-name').value; const batch = $('student-batch').value; try { const result = await api('/api/attendance', { method: 'POST', body: JSON.stringify({ token, name, batch }) }); attendedSubject = result.subject; $('attendance-form').classList.add('hidden'); $('confirmation').classList.remove('hidden'); $('confirmation').innerHTML = `<strong>Attendance marked successfully.</strong><br>${escapeHtml(result.name)} · ${escapeHtml(result.batch)} · ${escapeHtml(result.course)}<br>${escapeHtml(result.subject)} · ${escapeHtml(result.date)} · ${escapeHtml(result.status)}`; showAttendanceChecker(result.name, result.batch); } catch (error) { message('student-message', error.message); if (error.message.includes('already been marked')) showAttendanceChecker(name, batch); } });
$('student-attendance-form').addEventListener('submit', async (event) => { event.preventDefault(); const button = $('attendance-check-button'); button.disabled = true; button.textContent = 'Checking attendance...'; message('attendance-check-message'); $('student-attendance-result').classList.add('hidden'); try { const query = new URLSearchParams({ name: $('attendance-check-name').value, batch: $('attendance-check-batch').value, subject: attendedSubject }); const result = await api(`/api/student-attendance?${query}`); const percentage = `${Number(result.attendance.percentage).toFixed(2).replace(/\.00$/, '')}%`; const date = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' }).format(new Date(`${result.today.date}T00:00:00`)); const statusClass = result.today.status.toLowerCase().replace(' ', '-'); $('student-attendance-result').innerHTML = `<div class="attendance-result-head"><strong>Your Attendance</strong><span class="status-pill ${statusClass}">${escapeHtml(result.today.status)}</span></div><p><strong>Student:</strong> ${escapeHtml(result.student.name)}<br><strong>Batch:</strong> ${escapeHtml(result.student.batch)}</p><div class="today-status"><span>Today's Attendance</span><strong>${escapeHtml(date)}</strong><b class="${statusClass}">${result.today.status === 'Present' ? '✓ ' : result.today.status === 'Absent' ? '✕ ' : ''}${escapeHtml(result.today.status)}</b></div><div class="attendance-percentage"><span>Overall Attendance</span><strong>${percentage}</strong><small>${result.attendance.presentDays} Present / ${result.attendance.totalDays} Total Days</small></div>${result.lowAttendance ? `<div class="attendance-warning"><strong>⚠ Low Attendance</strong><span>Your attendance is below the required ${result.minimumRequired}%.</span><span>Current Attendance: ${percentage}</span><span>Please improve your attendance to avoid attendance shortage.</span></div>` : `<div class="attendance-good"><strong>✓ Attendance is Good</strong><span>Your current attendance is ${percentage}.</span></div>`}`; $('student-attendance-result').classList.remove('hidden'); } catch (error) { message('attendance-check-message', error.message); } finally { button.disabled = false; button.textContent = 'Check Attendance'; } });
$('login-form').addEventListener('submit', async (event) => { event.preventDefault(); message('login-message', 'Opening...'); try { await api('/api/login', { method: 'POST', body: JSON.stringify({ password: $('password').value }) }); await initDashboard(); } catch (error) { message('login-message', error.message); } });
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
$('logout').addEventListener('click', async () => { await api('/api/logout', { method: 'POST' }); $('logout').classList.add('hidden'); show('login-view'); });
$('session-form').addEventListener('submit', async (event) => { event.preventDefault(); message('session-message', 'Generating...'); try { const session = await api('/api/sessions', { method: 'POST', body: JSON.stringify({ subject: $('subject').value, batch: $('scope-batch').value }) }); $('qr-result').classList.remove('hidden'); $('qr-result').innerHTML = `<img src="${session.qr}" alt="Attendance QR code"><p><a href="${session.url}" target="_blank">Open student page ↗</a></p><button class="secondary" id="close-session" type="button">Close session and mark absences</button>`; $('close-session').addEventListener('click', async () => { $('close-session').disabled = true; $('close-session').textContent = 'Finalizing...'; try { const result = await api(`/api/sessions/${session.id}/close`, { method: 'POST' }); $('close-session').textContent = `Closed · ${result.added} absences added`; await refreshReport(); } catch (error) { $('close-session').disabled = false; $('close-session').textContent = error.message; } }); message('session-message'); } catch (error) { message('session-message', error.message); } });
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
async function refreshReport() { try { records = await api('/api/report'); const percentages = await api('/api/percentages'); const date = getServerDate(); updateDashboardDate(date); const today = records.filter((r) => r.date === date); $('total-count').textContent = today.length; $('present-count').textContent = today.filter((r) => r.status === 'Present').length; $('absent-count').textContent = today.filter((r) => r.status === 'Absent').length; const groupedRecords = buildDateGroupedRecords(records.slice().reverse()); $('records').innerHTML = groupedRecords.length ? groupedRecords.map(([day, dayRows]) => `
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
async function initDashboard() { show('dashboard-view'); $('logout').classList.remove('hidden'); await refreshReport(); }
setInterval(() => {
  if (!$('dashboard-view').classList.contains('hidden') && dashboardDate && getServerDate() !== dashboardDate) refreshReport();
}, 30000);
(async function boot() { await loadConfig(); if (token) return initStudent(); const me = await api('/api/me'); if (me.instructor) return initDashboard(); show('login-view'); })().catch((error) => { show('login-view'); message('login-message', error.message); });
