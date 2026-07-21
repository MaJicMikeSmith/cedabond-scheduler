const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const { recordEvent } = require('../lib/sync');
const { sendEmail } = require('../lib/email');

const router = express.Router();

// PUBLIC routes - no login required. Gated instead by knowing the member's
// external_id + invite_token pair, which only comes from the email FileMaker
// sent (or a colleague forwarding that link). The invite_token is durable -
// it does not get consumed/cleared, so the same link works for any number
// of people at that company, at any time.

function getMemberByInvite(externalId, token) {
  const member = db.prepare('SELECT * FROM members WHERE external_id = ?').get(externalId);
  if (!member || !token || member.invite_token !== token) return null;
  return member;
}

// Confirm the link is valid and return the company name for display.
router.get('/:externalId', (req, res) => {
  const member = getMemberByInvite(req.params.externalId, req.query.token);
  if (!member) return res.status(404).json({ error: 'Invalid or expired invite link' });
  res.json({ company: member.company || member.name });
});

// The exhibition's day(s), so the form can offer day checkboxes.
router.get('/:externalId/days', (req, res) => {
  const member = getMemberByInvite(req.params.externalId, req.query.token);
  if (!member) return res.status(404).json({ error: 'Invalid or expired invite link' });
  const days = db.prepare('SELECT id, label, date FROM exhibition_days ORDER BY date').all();
  res.json(days);
});

// Add an attendee under this member company. Anyone with the link can do
// this, any number of times - that's the whole point (colleagues forward it).
router.post('/:externalId/attendees', async (req, res) => {
  const token = req.query.token || req.body.token;
  const member = getMemberByInvite(req.params.externalId, token);
  if (!member) return res.status(404).json({ error: 'Invalid or expired invite link' });

  const { name, job_description, email, phone, arrival, departure, day_ids } = req.body;
  if (!name || !email) return res.status(400).json({ error: 'Name and email are required' });

  const existing = db.prepare('SELECT id FROM attendees WHERE email = ?').get(email.toLowerCase());
  if (existing) return res.status(409).json({ error: 'An attendee with this email is already registered' });

  const setupToken = crypto.randomBytes(20).toString('hex');
  const tx = db.transaction(() => {
    const result = db.prepare(`
      INSERT INTO attendees (member_id, name, job_description, email, phone, arrival, departure, setup_token)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(member.id, name, job_description || null, email.toLowerCase(), phone || null, arrival || null, departure || null, setupToken);
    const attendeeId = result.lastInsertRowid;
    for (const dayId of (day_ids || [])) {
      db.prepare('INSERT OR IGNORE INTO attendee_days (attendee_id, day_id) VALUES (?, ?)').run(attendeeId, dayId);
    }
    return attendeeId;
  });
  const attendeeId = tx();

  // Fetch the FileMaker external_id of each selected day, so FileMaker's pull
  // script can match them back to its own Exhibition_Day records directly.
  const days = db.prepare(`
    SELECT d.external_id FROM attendee_days ad
    JOIN exhibition_days d ON d.id = ad.day_id
    WHERE ad.attendee_id = ?
  `).all(attendeeId);

  recordEvent('attendee_added', {
    attendee_id: attendeeId,
    member_external_id: member.external_id,
    name, job_description: job_description || null, email: email.toLowerCase(), phone: phone || null,
    arrival: arrival || null, departure: departure || null,
    day_external_ids: days.map(d => d.external_id)
  });

  await sendEmail(email, 'Set up your Cedabond Exhibition account',
    `Hi ${name},\n\nYou're registered to attend the Cedabond exhibition on behalf of ${member.company || member.name}. ` +
    `Set your password here to book and manage your own meetings:\n` +
    `${process.env.APP_BASE_URL}/set-password.html?type=attendee&token=${setupToken}\n`);

  res.json({ ok: true, attendee_id: attendeeId });
});

module.exports = router;
