const nodemailer = require('nodemailer');
require('dotenv').config();

const ADMIN_EMAIL = 'peroldulrich@icloud.com';

const transporter = nodemailer.createTransport({
  host: process.env.EMAIL_HOST || 'smtp.gmail.com',
  port: process.env.EMAIL_PORT || 587,
  secure: false,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASSWORD
  }
});

async function send(subject, html) {
  await transporter.sendMail({
    from: process.env.EMAIL_FROM || process.env.EMAIL_USER,
    to: ADMIN_EMAIL,
    subject,
    html
  });
}

async function sendCheckupEmail() {
  const now = new Date().toLocaleString();
  await send(
    '✅ Scheduler Checkup — System OK',
    `<p>Hello,</p>
     <p>This is your scheduled <strong>22:30 checkup</strong>.</p>
     <p>The report scheduler is running normally on the server.</p>
     <p><strong>Time:</strong> ${now}</p>
     <p>The Wialon report generation will start shortly.</p>`
  );
  console.log('📧 Checkup email sent to', ADMIN_EMAIL);
}

async function sendStartEmail() {
  const now = new Date().toLocaleString();
  await send(
    '🚀 Wialon Report — Generation Started',
    `<p>Hello,</p>
     <p>The Wialon report generation has <strong>started</strong>.</p>
     <p><strong>Time:</strong> ${now}</p>
     <p>You will receive a confirmation email once it is uploaded successfully.</p>`
  );
  console.log('📧 Start email sent to', ADMIN_EMAIL);
}

async function sendConfirmationEmail(uploadedFiles) {
  const now = new Date().toLocaleString();
  const fileList = uploadedFiles.map(f => `<li>${f}</li>`).join('');
  await send(
    '✅ Wialon Report — Generated & Uploaded Successfully',
    `<p>Hello,</p>
     <p>The Wialon report has been <strong>generated and uploaded</strong> to the SFTP /OUT folder successfully.</p>
     <p><strong>Completed at:</strong> ${now}</p>
     <p><strong>Files uploaded:</strong></p>
     <ul>${fileList}</ul>
     <p>All done! ✅</p>`
  );
  console.log('📧 Confirmation email sent to', ADMIN_EMAIL);
}

module.exports = { sendCheckupEmail, sendStartEmail, sendConfirmationEmail };
