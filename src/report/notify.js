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

// ── 1. Warning email — 15 min before execution ────────────────────────────────
// scheduledTimeMadagascar: e.g. '06h00 🌅 matin' or '13h00 🌇 après-midi'
async function sendWarningEmail(type, scheduledTimeMadagascar) {
  const label    = type === 'report' ? '📊 Report' : '🔄 Routing';
  const isMorning = scheduledTimeMadagascar.includes('matin');
  const isAfternoon = scheduledTimeMadagascar.includes('après-midi');
  const sessionLine = type === 'routing'
    ? `<p><strong>Session:</strong> ${
        isMorning   ? "🌅 Morning — processing <strong>today's</strong> delivery files" :
        isAfternoon ? "🌇 Afternoon — processing <strong>tomorrow's</strong> delivery files" :
                      ''
      }</p>`
    : '';

  await send(
    `⚠️ ${label} — Starts in 15 minutes (${scheduledTimeMadagascar.replace(/[🌅🌇]/g, '').trim()} Madagascar)`,
    `<p>Hello,</p>
     <p>This is a <strong>15-minute warning</strong>.</p>
     <p>The <strong>${label}</strong> process is scheduled to start at
        <strong>${scheduledTimeMadagascar} (Madagascar)</strong>.</p>
     ${sessionLine}
     <table style="border-collapse:collapse;font-size:14px">
       <tr><td style="padding:4px 12px 4px 0"><strong>Current time — Madagascar</strong></td><td>${nowMadagascar()}</td></tr>
       <tr><td style="padding:4px 12px 4px 0"><strong>Current time — Cameroon</strong></td><td>${nowCameroon()}</td></tr>
     </table>
     <p>The server is running normally. ✅</p>`
  );
  console.log(`📧 Warning email sent (${type}) to ${ADMIN_EMAIL}`);
}

// ── 2. Start email ────────────────────────────────────────────────────────────
// mode: 'morning' | 'afternoon' | undefined (for report)
async function sendProcessStartEmail(type, mode) {
  const label = type === 'report' ? '📊 Report' : '🔄 Routing';
  const sessionLine = type === 'routing' && mode
    ? `<p><strong>Session:</strong> ${
        mode === 'morning'
          ? "🌅 Morning — processing <strong>today's</strong> delivery files"
          : "🌇 Afternoon — processing <strong>tomorrow's</strong> delivery files"
      }</p>`
    : '';

  await send(
    `🚀 ${label} — Process Started`,
    `<p>Hello,</p>
     <p>The <strong>${label}</strong> process has just <strong>started</strong>.</p>
     ${sessionLine}
     <table style="border-collapse:collapse;font-size:14px">
       <tr><td style="padding:4px 12px 4px 0"><strong>Started at — Madagascar</strong></td><td>${nowMadagascar()}</td></tr>
       <tr><td style="padding:4px 12px 4px 0"><strong>Started at — Cameroon</strong></td><td>${nowCameroon()}</td></tr>
     </table>
     <p>You will receive a summary email once it completes.</p>`
  );
  console.log(`📧 Start email sent (${type}) to ${ADMIN_EMAIL}`);
}

// ── 3. End email — full resume ────────────────────────────────────────────────
// summary = { steps: [{ name, status: 'ok'|'skipped'|'error', detail }], files: [], mode? }
async function sendProcessEndEmail(type, summary) {
  const label  = type === 'report' ? '📊 Report' : '🔄 Routing';
  const allOk  = summary.steps.every(s => s.status !== 'error');
  const icon   = allOk ? '✅' : '⚠️';
  const sessionLine = type === 'routing' && summary.mode
    ? `<p><strong>Session:</strong> ${
        summary.mode === 'morning'
          ? "🌅 Morning — processed <strong>today's</strong> delivery files"
          : "🌇 Afternoon — processed <strong>tomorrow's</strong> delivery files"
      }</p>`
    : '';

  const stepRows = summary.steps.map(s => {
    const color = s.status === 'ok' ? '#2e7d32' : s.status === 'skipped' ? '#757575' : '#c62828';
    const badge = s.status === 'ok' ? '✅ OK'    : s.status === 'skipped' ? '⏭ Skipped' : '❌ Error';
    return `<tr>
      <td style="padding:6px 14px 6px 0;font-weight:bold">${s.name}</td>
      <td style="padding:6px 14px 6px 0;color:${color};font-weight:bold">${badge}</td>
      <td style="padding:6px 0;color:#555;font-size:13px">${s.detail || ''}</td>
    </tr>`;
  }).join('');

  const fileList = (summary.files || []).length
    ? `<p><strong>Files processed:</strong></p>
       <table style="border-collapse:collapse;font-size:13px;">
         <thead>
           <tr style="background:#f5f5f5">
             <th style="padding:5px 14px 5px 0;text-align:left">File</th>
             <th style="padding:5px 14px 5px 0;text-align:center">✅ Emails sent</th>
             <th style="padding:5px 0;text-align:center">❌ Failed</th>
           </tr>
         </thead>
         <tbody>${summary.files.map(f => {
           const name   = typeof f === 'object' ? f.name        : f;
           const sent   = typeof f === 'object' ? f.emailsSent  : '—';
           const failed = typeof f === 'object' ? f.emailsFailed : '—';
           const failColor = failed > 0 ? 'color:#c62828;font-weight:bold' : '';
           return `<tr>
             <td style="padding:5px 14px 5px 0">${name}</td>
             <td style="padding:5px 14px 5px 0;text-align:center;color:#2e7d32;font-weight:bold">${sent}</td>
             <td style="padding:5px 0;text-align:center;${failColor}">${failed}</td>
           </tr>`;
         }).join('')}</tbody>
       </table>`
    : '';

  await send(
    `${icon} ${label} — Process Completed`,
    `<p>Hello,</p>
     <p>The <strong>${label}</strong> process has <strong>completed</strong>.</p>
     ${sessionLine}
     <table style="border-collapse:collapse;font-size:14px">
       <tr><td style="padding:4px 12px 4px 0"><strong>Completed at — Madagascar</strong></td><td>${nowMadagascar()}</td></tr>
       <tr><td style="padding:4px 12px 4px 0"><strong>Completed at — Cameroon</strong></td><td>${nowCameroon()}</td></tr>
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

// ── 4. File error email — sent when a single file fails during processing ──────
async function sendFileErrorEmail(fileName, errorLog) {
  await send(
    `❌ Processing Error — ${fileName}`,
    `<p>Hello,</p>
     <p>An error occurred while processing the file <strong>${fileName}</strong>.</p>
     <table style="border-collapse:collapse;font-size:14px">
       <tr><td style="padding:4px 12px 4px 0"><strong>Time — Madagascar</strong></td><td>${nowMadagascar()}</td></tr>
       <tr><td style="padding:4px 12px 4px 0"><strong>Time — Cameroon</strong></td><td>${nowCameroon()}</td></tr>
     </table>
     <br>
     <p><strong>Error log:</strong></p>
     <pre style="background:#fbe9e7;border:1px solid #ef9a9a;padding:12px;border-radius:4px;font-size:13px;white-space:pre-wrap;word-break:break-all">${errorLog.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</pre>
     <p>The process has continued with the remaining files. Please check the server logs for more details.</p>`
  );
  console.log(`📧 Error email sent for ${fileName} to ${ADMIN_EMAIL}`);
}

module.exports = { sendWarningEmail, sendProcessStartEmail, sendProcessEndEmail, sendFileErrorEmail };
