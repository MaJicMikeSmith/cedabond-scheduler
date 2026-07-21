const express = require('express');
const db = require('../db');
const { requireRole } = require('../middleware/requireAuth');
const { recordEvent } = require('../lib/sync');
const { sendEmail } = require('../lib/email');

const router = express.Router();
router.use(requireRole('supplier'));

// List all attending member companies, and whether this supplier has already
// sent them a request. Day/window is now per-attendee, not per-company, so
// suppliers see the company list only here - individual attendee schedules
// are private to that attendee until they book (visible in /schedule below).
router.get('/members', (req, res) => {
  const supplierId = req.session.user.id;
  const members = db.prepare(`
    SELECT m.id, m.name, m.company, m.email,
           r.status AS request_status,
           (SELECT COUNT(*) FROM bookings b
              JOIN attendees a ON a.id = b.attendee_id
              WHERE a.member_id = m.id AND b.supplier_id = ? AND b.cancelled_at IS NULL) AS booking_count
    FROM members m
    LEFT JOIN meeting_requests r ON r.member_id = m.id AND r.supplier_id = ?
    ORDER BY m.name
  `).all(supplierId, supplierId);
  res.json(members);
});

// Send a meeting request to a member.
router.post('/requests', async (req, res) => {
  const supplierId = req.session.user.id;
  const { member_id } = req.body;
  const member = db.prepare('SELECT * FROM members WHERE id = ?').get(member_id);
  if (!member) return res.status(404).json({ error: 'Member not found' });

  const existing = db.prepare('SELECT * FROM meeting_requests WHERE supplier_id = ? AND member_id = ?')
    .get(supplierId, member_id);
  if (existing) return res.status(409).json({ error: 'A request already exists for this member' });

  const supplier = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(supplierId);
  const result = db.prepare('INSERT INTO meeting_requests (supplier_id, member_id) VALUES (?, ?)')
    .run(supplierId, member_id);

  recordEvent('request', {
    request_id: result.lastInsertRowid,
    supplier_id: supplierId, supplier_name: supplier.name,
    member_id, member_name: member.name
  }, { memberId: member_id });

  await sendEmail(member.email, `${supplier.name} would like to meet you at the exhibition`,
    `Hi ${member.name},\n\n${supplier.name} has requested a meeting with you at the exhibition. ` +
    `Log in to your member portal to view their available time slots and book one:\n${process.env.APP_BASE_URL}/member/\n`);

  res.json({ ok: true });
});

// This supplier's full slot schedule across both days.
router.get('/schedule', (req, res) => {
  const supplierId = req.session.user.id;
  const slots = db.prepare(`
    SELECT s.id, s.start_time, s.end_time, s.status, d.label AS day_label, d.date AS day_date,
           b.id AS booking_id, a.name AS attendee_name, m.company AS member_company
    FROM slots s
    JOIN exhibition_days d ON d.id = s.day_id
    LEFT JOIN bookings b ON b.slot_id = s.id AND b.cancelled_at IS NULL
    LEFT JOIN attendees a ON a.id = b.attendee_id
    LEFT JOIN members m ON m.id = a.member_id
    WHERE s.supplier_id = ?
    ORDER BY d.date, s.start_time
  `).all(supplierId);
  res.json(slots);
});

// Block a slot (e.g. lunch break) - only allowed while it's currently available.
router.post('/slots/:id/block', (req, res) => {
  const supplierId = req.session.user.id;
  const slot = db.prepare('SELECT * FROM slots WHERE id = ? AND supplier_id = ?').get(req.params.id, supplierId);
  if (!slot) return res.status(404).json({ error: 'Slot not found' });
  if (slot.status !== 'available') return res.status(409).json({ error: `Slot is currently ${slot.status}` });

  db.prepare("UPDATE slots SET status = 'blocked' WHERE id = ?").run(slot.id);
  recordEvent('slot_block', { slot_id: slot.id }, { supplierId });
  res.json({ ok: true });
});

// Release a previously blocked slot back to available.
router.post('/slots/:id/unblock', (req, res) => {
  const supplierId = req.session.user.id;
  const slot = db.prepare('SELECT * FROM slots WHERE id = ? AND supplier_id = ?').get(req.params.id, supplierId);
  if (!slot) return res.status(404).json({ error: 'Slot not found' });
  if (slot.status !== 'blocked') return res.status(409).json({ error: `Slot is currently ${slot.status}` });

  db.prepare("UPDATE slots SET status = 'available' WHERE id = ?").run(slot.id);
  recordEvent('slot_unblock', { slot_id: slot.id }, { supplierId });
  res.json({ ok: true });
});

module.exports = router;
