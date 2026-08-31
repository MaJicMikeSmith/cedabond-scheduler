const express = require('express');
const db = require('../db');
const { requireRole } = require('../middleware/requireAuth');
const { recordEvent } = require('../lib/sync');
const { sendTimetableEmail } = require('../lib/email');

const router = express.Router();
router.use(requireRole('member'));

function getMember(id) {
  return db.prepare('SELECT * FROM members WHERE id = ?').get(id);
}

// Requests sent to this member company - anyone with the shared password sees
// the same list, and any of them may respond and book to fulfil it.
router.get('/requests', (req, res) => {
  try {
    const memberId = req.session.user.id;
    const requests = db.prepare(`
      SELECT r.id, r.status, r.created_at, s.id AS supplier_id, s.name AS supplier_name,
             d.date AS booked_date, sl.start_time AS booked_start_time, sl.end_time AS booked_end_time
      FROM meeting_requests r
      JOIN suppliers s ON s.id = r.supplier_id
      LEFT JOIN bookings b ON b.request_id = r.id AND b.cancelled_at IS NULL
      LEFT JOIN slots sl ON sl.id = b.slot_id
      LEFT JOIN exhibition_days d ON d.id = sl.day_id
      WHERE r.member_id = ?
      ORDER BY (d.date IS NULL), d.date, sl.start_time, r.created_at
    `).all(memberId);
    res.json(requests);
  } catch (err) {
    console.error('member requests error:', err);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
});

// Suppliers who have requested a meeting with this member - not the full
// supplier list. A member can only browse/book suppliers that requested them.
router.get('/suppliers', (req, res) => {
  try {
    const memberId = req.session.user.id;
    const suppliers = db.prepare(`
      SELECT DISTINCT s.id, s.name, s.company
      FROM suppliers s
      JOIN meeting_requests r ON r.supplier_id = s.id
      WHERE r.member_id = ? AND r.status IN ('pending', 'booked')
      ORDER BY s.name
    `).all(memberId);
    res.json(suppliers);
  } catch (err) {
    console.error('member suppliers list error:', err);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
});

// A supplier's slots, restricted to whichever day(s) any of this company's
// attendees are present for (the union across all of them).
router.get('/suppliers/:id/slots', (req, res) => {
  try {
    const slots = db.prepare(`
      SELECT s.id, s.start_time, s.end_time, s.status,
             d.id AS day_id, d.label AS day_label, d.date AS day_date,
             b.member_id AS booked_by_member_id
      FROM slots s
      JOIN exhibition_days d ON d.id = s.day_id
      LEFT JOIN bookings b ON b.slot_id = s.id AND b.cancelled_at IS NULL
      WHERE s.supplier_id = ?
      ORDER BY d.date, s.start_time
    `).all(req.params.id);

    res.json(slots);
  } catch (err) {
    console.error('member slots error:', err);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
});

// This company's current (non-cancelled) bookings.
router.get('/bookings', (req, res) => {
  try {
    const memberId = req.session.user.id;
    const bookings = db.prepare(`
      SELECT b.id, b.created_at, sl.start_time, sl.end_time, d.label AS day_label, d.date AS day_date,
             s.id AS supplier_id, s.name AS supplier_name, s.company AS supplier_company
      FROM bookings b
      JOIN slots sl ON sl.id = b.slot_id
      JOIN exhibition_days d ON d.id = sl.day_id
      JOIN suppliers s ON s.id = b.supplier_id
      WHERE b.member_id = ? AND b.cancelled_at IS NULL
      ORDER BY d.date, sl.start_time
    `).all(memberId);
    res.json(bookings);
  } catch (err) {
    console.error('member bookings list error:', err);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
});

// Book a slot - either to fulfil an existing request, or ad-hoc. Belongs to
// the company as a whole, not whoever happens to be logged in at the time.
router.post('/bookings', async (req, res) => {
  try {
    const memberId = req.session.user.id;
    const { slot_id, request_id, confirm_cancel_booking_id } = req.body;
    const member = getMember(memberId);

    const slot = db.prepare('SELECT * FROM slots WHERE id = ?').get(slot_id);
    if (!slot) return res.status(404).json({ error: 'Slot not found' });
    if (slot.status !== 'available') return res.status(409).json({ error: 'That slot is no longer available' });

    let request = null;
    if (request_id) {
      request = db.prepare('SELECT * FROM meeting_requests WHERE id = ? AND member_id = ? AND supplier_id = ?')
        .get(request_id, memberId, slot.supplier_id);
      if (!request) return res.status(400).json({ error: 'Request not found for this supplier/company' });
    }

    // The company can't double-book itself - same supplier twice, or two
    // suppliers overlapping in time.
    const conflicts = db.prepare(`
      SELECT b.id AS booking_id, sl.id AS slot_id, sl.start_time, sl.end_time, s.id AS supplier_id, s.name AS supplier_name, s.email AS supplier_email
      FROM bookings b
      JOIN slots sl ON sl.id = b.slot_id
      JOIN suppliers s ON s.id = b.supplier_id
      WHERE b.member_id = ? AND b.cancelled_at IS NULL AND sl.day_id = ?
        AND (b.supplier_id = ? OR (sl.start_time < ? AND sl.end_time > ?))
    `).all(memberId, slot.day_id, slot.supplier_id, slot.end_time, slot.start_time);

    if (conflicts.length && !confirm_cancel_booking_id) {
      const first = conflicts[0];
      const extra = conflicts.length > 1 ? ` (and ${conflicts.length - 1} other booking${conflicts.length > 2 ? 's' : ''})` : '';
      return res.status(409).json({
        conflict: true,
        booking_id: first.booking_id,
        message: `You already have a meeting with ${first.supplier_name} at ${first.start_time}-${first.end_time} today${extra}. ` +
          `Booking this one will cancel ${conflicts.length > 1 ? 'those meetings' : 'that meeting'} if it's still due to take place. Book anyway?`
      });
    }

    const tx = db.transaction(() => {
      const current = db.prepare('SELECT status FROM slots WHERE id = ?').get(slot_id);
      if (current.status !== 'available') return null;
      for (const c of conflicts) {
        db.prepare("UPDATE bookings SET cancelled_at = datetime('now') WHERE id = ?").run(c.booking_id);
        db.prepare("UPDATE slots SET status = 'available' WHERE id = ?").run(c.slot_id);
      }
      const result = db.prepare(`
        INSERT INTO bookings (slot_id, member_id, supplier_id, request_id, source)
        VALUES (?, ?, ?, ?, ?)
      `).run(slot_id, memberId, slot.supplier_id, request_id || null, request_id ? 'request' : 'adhoc');
      db.prepare("UPDATE slots SET status = 'booked' WHERE id = ?").run(slot_id);
      if (request) db.prepare("UPDATE meeting_requests SET status = 'booked' WHERE id = ?").run(request_id);
      return result.lastInsertRowid;
    });
    const bookingId = tx();
    if (bookingId === null) return res.status(409).json({ error: 'That slot is no longer available' });

    const companyLabel = member.company || member.name;

    for (const conflict of conflicts) {
      recordEvent('cancellation', {
        booking_id: conflict.booking_id, start_time: conflict.start_time, end_time: conflict.end_time,
        supplier_name: conflict.supplier_name, member_id: memberId, member_name: companyLabel
      }, { memberId });
    }

    const supplier = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(slot.supplier_id);
    recordEvent('booking', {
      booking_id: bookingId, slot_id, start_time: slot.start_time, end_time: slot.end_time,
      supplier_id: slot.supplier_id, supplier_name: supplier.name,
      member_id: memberId, member_name: companyLabel,
      source: request_id ? 'request' : 'adhoc'
    }, { supplierId: slot.supplier_id, memberId });

    res.json({ ok: true, booking_id: bookingId });
  } catch (err) {
    console.error('member booking error:', err);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
});

// Cancel a booking - immediately frees the slot for anyone else to take.
router.post('/bookings/:id/cancel', async (req, res) => {
  try {
    const memberId = req.session.user.id;
    const booking = db.prepare('SELECT * FROM bookings WHERE id = ? AND member_id = ? AND cancelled_at IS NULL')
      .get(req.params.id, memberId);
    if (!booking) return res.status(404).json({ error: 'Booking not found' });

    const slot = db.prepare('SELECT * FROM slots WHERE id = ?').get(booking.slot_id);

    const tx = db.transaction(() => {
      db.prepare("UPDATE bookings SET cancelled_at = datetime('now') WHERE id = ?").run(booking.id);
      db.prepare("UPDATE slots SET status = 'available' WHERE id = ?").run(slot.id);
      if (booking.request_id) db.prepare("UPDATE meeting_requests SET status = 'pending' WHERE id = ?").run(booking.request_id);
    });
    tx();

    const member = getMember(memberId);
    const companyLabel = member.company || member.name;
    const supplier = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(booking.supplier_id);
    recordEvent('cancellation', {
      booking_id: booking.id, slot_id: slot.id, start_time: slot.start_time, end_time: slot.end_time,
      supplier_id: booking.supplier_id, supplier_name: supplier.name,
      member_id: memberId, member_name: companyLabel
    }, { supplierId: booking.supplier_id, memberId });

    res.json({ ok: true });
  } catch (err) {
    console.error('member cancel booking error:', err);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
});

// Decline a pending request - frees up a space in the supplier's 40-member
// cap since declined requests don't count as active. Can't decline one
// that's already been booked.
router.post('/requests/:id/decline', async (req, res) => {
  try {
    const memberId = req.session.user.id;
    const request = db.prepare('SELECT * FROM meeting_requests WHERE id = ? AND member_id = ?')
      .get(req.params.id, memberId);
    if (!request) return res.status(404).json({ error: 'Request not found' });
    if (request.status !== 'pending') {
      return res.status(409).json({ error: `This request is already ${request.status} and can't be declined` });
    }

    db.prepare("UPDATE meeting_requests SET status = 'declined' WHERE id = ?").run(request.id);

    const member = getMember(memberId);
    const companyLabel = member.company || member.name;
    const supplier = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(request.supplier_id);

    recordEvent('decline', {
      request_id: request.id, supplier_id: request.supplier_id, supplier_name: supplier.name,
      member_id: memberId, member_name: companyLabel
    }, { supplierId: request.supplier_id, memberId });

    res.json({ ok: true });
  } catch (err) {
    console.error('member decline request error:', err);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
});

// Email a plain-text copy of this member's confirmed timetable to whatever
// address they give us - handy for having on a phone at the venue. This is
// the ONLY email the app ever sends. While testing, it's redirected to us
// marked as a test; once live, it genuinely reaches the address typed in.
router.post('/bookings/email-timetable', async (req, res) => {
  try {
    const memberId = req.session.user.id;
    const to = (req.body.email || '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
      return res.status(400).json({ error: 'Please enter a valid email address' });
    }

    const member = getMember(memberId);
    const companyLabel = member.company || member.name;

    const bookings = db.prepare(`
      SELECT sl.start_time, sl.end_time, d.label AS day_label, d.date AS day_date, s.name AS supplier_name
      FROM bookings b
      JOIN slots sl ON sl.id = b.slot_id
      JOIN exhibition_days d ON d.id = sl.day_id
      JOIN suppliers s ON s.id = b.supplier_id
      WHERE b.member_id = ? AND b.cancelled_at IS NULL
      ORDER BY d.date, sl.start_time
    `).all(memberId);

    if (!bookings.length) {
      return res.status(400).json({ error: "You don't have any confirmed meetings yet" });
    }

    const dayAbbr = (iso) => {
      const dt = new Date(iso + 'T00:00:00');
      return dt.toLocaleDateString('en-GB', { weekday: 'short' }).toUpperCase().slice(0, 3);
    };
    const ukDate = (iso) => {
      const [y, m, d] = iso.split('-');
      return `${d}-${m}-${y}`;
    };

    const lines = bookings.map(b =>
      `${b.day_label} - ${dayAbbr(b.day_date)} (${ukDate(b.day_date)})  ${b.start_time}-${b.end_time}  ${b.supplier_name}`
    );

    await sendTimetableEmail(to, `Your Cedabond Exhibition meeting timetable - ${companyLabel}`,
      `Hi,\n\nHere's ${companyLabel}'s confirmed meeting timetable for the Cedabond Exhibition:\n\n` +
      lines.join('\n') + '\n');

    res.json({ ok: true });
  } catch (err) {
    console.error('member email timetable error:', err);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
});

module.exports = router;
