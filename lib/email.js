const nodemailer = require('nodemailer');

let transporter = null;
if (process.env.SMTP_HOST) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined
  });
}

async function sendEmail(to, subject, text) {
  if (!transporter) {
    // No SMTP configured yet - log so nothing is silently lost during testing.
    console.log(`\n[EMAIL - not sent, SMTP not configured]\nTo: ${to}\nSubject: ${subject}\n${text}\n`);
    return;
  }
  try {
    await transporter.sendMail({ from: process.env.SMTP_FROM, to, subject, text });
  } catch (err) {
    console.error('Failed to send email to', to, err.message);
  }
}

module.exports = { sendEmail };
