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

// Kept for completeness but no longer called anywhere in the app - the
// automated request/booking/cancellation/decline emails between suppliers
// and members were removed entirely (not just suppressed). Nothing calls
// this today; it's here only in case a future feature needs the same
// "silent unless TEST_MODE" behaviour.
async function sendEmail(to, subject, text) {
  const testMode = process.env.TEST_MODE === 'true';

  if (!testMode) {
    console.log(`\n[EMAIL - suppressed, TEST_MODE is not 'true']\nWould have gone to: ${to}\nSubject: ${subject}\n`);
    return;
  }

  const actualTo = process.env.TEST_EMAIL || 'mike@chardanit.co.uk';
  const actualSubject = `[TEST - would go to ${to}] ${subject}`;

  if (!transporter) {
    console.log(`\n[EMAIL - not sent, SMTP not configured]\nTo: ${actualTo}\nSubject: ${actualSubject}\n${text}\n`);
    return;
  }
  try {
    await transporter.sendMail({ from: process.env.SMTP_FROM, to: actualTo, subject: actualSubject, text });
  } catch (err) {
    console.error('Failed to send email to', actualTo, err.message);
  }
}

// The ONE email the app ever sends: a member explicitly asking for their own
// timetable. While testing (TEST_MODE=true), it's redirected to us marked as
// a test, exactly like sendEmail() above, so we can check formatting safely.
// Once live (TEST_MODE off), it genuinely goes to the address the member
// typed in - unlike sendEmail(), it is never silently suppressed, because
// this is a real feature someone is actively asking to use, not an
// automated notification.
async function sendTimetableEmail(to, subject, text) {
  const testMode = process.env.TEST_MODE === 'true';
  const actualTo = testMode ? (process.env.TEST_EMAIL || 'mike@chardanit.co.uk') : to;
  const actualSubject = testMode ? `[TEST - would go to ${to}] ${subject}` : subject;

  if (!transporter) {
    console.log(`\n[EMAIL - not sent, SMTP not configured]\nTo: ${actualTo}\nSubject: ${actualSubject}\n${text}\n`);
    return;
  }
  try {
    await transporter.sendMail({ from: process.env.SMTP_FROM, to: actualTo, subject: actualSubject, text });
  } catch (err) {
    console.error('Failed to send timetable email to', actualTo, err.message);
  }
}

module.exports = { sendEmail, sendTimetableEmail };
