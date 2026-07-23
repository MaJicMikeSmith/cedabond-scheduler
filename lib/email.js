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
  const testMode = process.env.TEST_MODE === 'true';
  const actualTo = testMode ? (process.env.TEST_EMAIL || 'mike@chardanit.co.uk') : to;
  const actualSubject = testMode ? `[TEST - would go to ${to}] ${subject}` : subject;

  if (!transporter) {
    // No SMTP configured yet - log so nothing is silently lost during testing.
    console.log(`\n[EMAIL - not sent, SMTP not configured]\nTo: ${actualTo}\nSubject: ${actualSubject}\n${text}\n`);
    return;
  }
  try {
    await transporter.sendMail({ from: process.env.SMTP_FROM, to: actualTo, subject: actualSubject, text });
  } catch (err) {
    console.error('Failed to send email to', actualTo, err.message);
  }
}
module.exports = { sendEmail };
