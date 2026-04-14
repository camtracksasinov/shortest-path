const { sendMail } = require('../emails/graph-mailer');
require('dotenv').config();

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'ulrich.kamsu@camtrack.net';

function nowCameroon() {
  return new Date().toLocaleString('fr-FR', { timeZone: 'Africa/Douala', hour12: false });
}
function nowMadagascar() {
  return new Date().toLocaleString('fr-FR', { timeZone: 'Indian/Antananarivo', hour12: false });
}

async function send(subject, html) {
  await sendMail({ to: ADMIN_EMAIL, subject, html });
}

// ── 1. Warning email — 30 min before execution ────────────────────────────────
async function sendWarningEmail(type, scheduledTimeMadagascar) {
  const label = type === 'report' ? '📊 Report' : '🔄 Routing';
  await send(
    `⚠️ ${label} — Starts in 30 minutes`,
    `<p>Hello,</p>
     <p>This is a <strong>30-minute warning</strong>.</p>
     <p>The <strong>${label}</strong> process is scheduled to start at
        <strong>${scheduledTimeMadagascar} (Madagascar)</strong>.</p>
     <table style="border-collapse:collapse;font-size:14px">
       <tr><td style="padding:4px 12px 4px 0"><strong>Madagascar</strong></td><td>${nowMadagascar()}</td></tr>
       <tr><td style="padding:4px 12px 4px 0"><strong>Cameroon</strong></td><td>${nowCameroon()}</td></tr>
     </table>
     <p>The server is running normally. ✅</p>`
  );
  console.log(`📧 Warning email sent (${type}) to ${ADMIN_EMAIL}`);
}

// ── 2. Start email ────────────────────────────────────────────────────────────
async function sendProcessStartEmail(type) {
  const label = type === 'report' ? '📊 Report' : '🔄 Routing';
  await send(
    `🚀 ${label} — Process Started`,
    `<p>Hello,</p>
     <p>The <strong>${label}</strong> process has just <strong>started</strong>.</p>
     <table style="border-collapse:collapse;font-size:14px">
       <tr><td style="padding:4px 12px 4px 0"><strong>Cameroon</strong></td><td>${nowCameroon()}</td></tr>
       <tr><td style="padding:4px 12px 4px 0"><strong>Madagascar</strong></td><td>${nowMadagascar()}</td></tr>
     </table>
     <p>You will receive a summary email once it completes.</p>`
  );
  console.log(`📧 Start email sent (${type}) to ${ADMIN_EMAIL}`);
}

// ── 3. End email — full resume ────────────────────────────────────────────────
// summary = { steps: [{ name, status: 'ok'|'skipped'|'error', detail }], files: [] }
async function sendProcessEndEmail(type, summary) {
  const label = type === 'report' ? '📊 Report' : '🔄 Routing';
  const allOk  = summary.steps.every(s => s.status !== 'error');
  const icon   = allOk ? '✅' : '⚠️';

  const stepRows = summary.steps.map(s => {
    const color  = s.status === 'ok' ? '#2e7d32' : s.status === 'skipped' ? '#e65100' : '#c62828';
    const badge  = s.status === 'ok' ? '✅ OK' : s.status === 'skipped' ? '⏭ Skipped' : '❌ Error';
    return `<tr>
      <td style="padding:6px 14px 6px 0;font-weight:bold">${s.name}</td>
      <td style="padding:6px 14px 6px 0;color:${color};font-weight:bold">${badge}</td>
      <td style="padding:6px 0;color:#555;font-size:13px">${s.detail || ''}</td>
    </tr>`;
  }).join('');

  const fileList = (summary.files || []).length
    ? `<p><strong>Files processed:</strong></p><ul>${summary.files.map(f => `<li>${f}</li>`).join('')}</ul>`
    : '';

  await send(
    `${icon} ${label} — Process Completed`,
    `<p>Hello,</p>
     <p>The <strong>${label}</strong> process has <strong>completed</strong>.</p>
     <table style="border-collapse:collapse;font-size:14px">
       <tr><td style="padding:4px 12px 4px 0"><strong>Cameroon</strong></td><td>${nowCameroon()}</td></tr>
       <tr><td style="padding:4px 12px 4px 0"><strong>Madagascar</strong></td><td>${nowMadagascar()}</td></tr>
     </table>
     <br>
     <p><strong>Step-by-step resume:</strong></p>
     <table style="border-collapse:collapse;font-size:14px;width:100%">
       <thead>
         <tr style="background:#f5f5f5">
           <th style="padding:6px 14px 6px 0;text-align:left">Step</th>
           <th style="padding:6px 14px 6px 0;text-align:left">Status</th>
           <th style="padding:6px 0;text-align:left">Detail</th>
         </tr>
       </thead>
       <tbody>${stepRows}</tbody>
     </table>
     ${fileList}
     <p style="margin-top:16px">${allOk ? 'All steps completed successfully. ✅' : '⚠️ Some steps encountered errors — check the server logs for details.'}</p>`
  );
  console.log(`📧 End email sent (${type}) to ${ADMIN_EMAIL}`);
}

module.exports = { sendWarningEmail, sendProcessStartEmail, sendProcessEndEmail };
