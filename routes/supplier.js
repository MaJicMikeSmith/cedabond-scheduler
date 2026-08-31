const express = require('express');
const db = require('../db');
const { requireRole } = require('../middleware/requireAuth');
const { recordEvent } = require('../lib/sync');
const { sendEmail } = require('../lib/email');

const router = express.Router();
router.use(requireRole('supplier'));

// List all attending member companies, and whether this supplier has already
// sent them a request. Bookings now belong directly to the member company
// (one shared login per company), so no join through attendees is needed.
router.get('/members', (req, res) => {
  try {
    const supplierId = req.session.user.id;
    const members = db.prepare(`
      SELECT m.id, m.name, m.email,
             r.id AS request_id, r.status AS request_status,
             (SELECT COUNT(*) FROM bookings b
                WHERE b.member_id = m.id AND b.supplier_id = ? AND b.cancelled_at IS NULL) AS booking_count,
             d.date AS booked_date, sl.start_time AS booked_start_time, sl.end_time AS booked_end_time
      FROM members m
      LEFT JOIN meeting_requests r ON r.member_id = m.id AND r.supplier_id = ?
      LEFT JOIN bookings b2 ON b2.member_id = m.id AND b2.supplier_id = ? AND b2.cancelled_at IS NULL
      LEFT JOIN slots sl ON sl.id = b2.slot_id
      LEFT JOIN exhibition_days d ON d.id = sl.day_id
      GROUP BY m.id
      ORDER BY m.name
    `).all(supplierId, supplierId, supplierId);
    res.json(members);
  } catch (err) {
    console.error('supplier members list error:', err);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
});

const MAX_REQUESTS = 40;

// Send meeting requests to a batch of members in one hit (tick-list UI).
// Only actions members that don't already have an active (pending/booked)
// request - re-ticking a cancelled one re-activates it. Enforces a total
// cap of MAX_REQUESTS active requests per supplier, counting existing ones.
router.post('/requests/batch', async (req, res) => {
  try {
    const supplierId = req.session.user.id;
    const memberIds = Array.isArray(req.body.member_ids)
      ? [...new Set(req.body.member_ids.map(Number).filter(Number.isInteger))]
      : [];
    if (!memberIds.length) return res.status(400).json({ error: 'No members selected' });

    const supplier = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(supplierId);

    const activeRows = db.prepare(`
      SELECT member_id FROM meeting_requests WHERE supplier_id = ? AND status IN ('pending', 'booked')
    `).all(supplierId);
    const activeIds = new Set(activeRows.map(r => r.member_id));

    // Ignore any that are already active (shouldn't happen from the UI, but
    // don't let a stale client double-count them against the cap).
    const toRequest = memberIds.filter(id => !activeIds.has(id));

    if (activeRows.length + toRequest.length > MAX_REQUESTS) {
      const spaceLeft = Math.max(0, MAX_REQUESTS - activeRows.length);
      return res.status(409).json({
        error: `That's over the ${MAX_REQUESTS}-member limit - you have ${spaceLeft} space${spaceLeft === 1 ? '' : 's'} left.`
      });
    }

    let requested = 0;
    for (const memberId of toRequest) {
      const member = db.prepare('SELECT * FROM members WHERE id = ?').get(memberId);
      if (!member) continue;

      const existing = db.prepare('SELECT * FROM meeting_requests WHERE supplier_id = ? AND member_id = ?')
        .get(supplierId, memberId);

      let requestId;
      if (existing) {
        db.prepare("UPDATE meeting_requests SET status = 'pending', created_at = datetime('now') WHERE id = ?")
          .run(existing.id);
        requestId = existing.id;
      } else {
        const result = db.prepare('INSERT INTO meeting_requests (supplier_id, member_id) VALUES (?, ?)')
          .run(supplierId, memberId);
        requestId = result.lastInsertRowid;
      }

      recordEvent('request', {
        request_id: requestId,
        supplier_id: supplierId, supplier_name: supplier.name,
        member_id: memberId, member_name: member.name
      }, { memberId });

      await sendEmail(member.email, `${supplier.name} would like to meet you at the exhibition`,
        `Hi ${member.name},\n\n${supplier.name} has requested a meeting with you at the exhibition. ` +
        `Log in to your member portal to view their available time slots and book one:\n${process.env.APP_BASE_URL}/member/\n`);

      requested++;
    }

    res.json({ ok: true, requested });
  } catch (err) {
    console.error('supplier batch request error:', err);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
});

// Send a meeting request to a member - one click on their name. Allows
// re-requesting someone previously cancelled or declined, and enforces the
// same MAX_REQUESTS cap as the batch route.
router.post('/requests', async (req, res) => {
  try {
    const supplierId = req.session.user.id;
    const memberId = Number(req.body.member_id);
    const member = db.prepare('SELECT * FROM members WHERE id = ?').get(memberId);
    if (!member) return res.status(404).json({ error: 'Member not found' });

    const existing = db.prepare('SELECT * FROM meeting_requests WHERE supplier_id = ? AND member_id = ?')
      .get(supplierId, memberId);
    if (existing && (existing.status === 'pending' || existing.status === 'booked')) {
      return res.status(409).json({ error: `A request already exists for this member (${existing.status})` });
    }

    const activeCount = db.prepare(`
      SELECT COUNT(*) AS c FROM meeting_requests WHERE supplier_id = ? AND status IN ('pending', 'booked')
    `).get(supplierId).c;
    if (activeCount >= MAX_REQUESTS) {
      return res.status(409).json({ error: `You're at the ${MAX_REQUESTS}-member limit - cancel one first` });
    }

    const supplier = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(supplierId);

    let requestId;
    if (existing) {
      db.prepare("UPDATE meeting_requests SET status = 'pending', created_at = datetime('now') WHERE id = ?")
        .run(existing.id);
      requestId = existing.id;
    } else {
      const result = db.prepare('INSERT INTO meeting_requests (supplier_id, member_id) VALUES (?, ?)')
        .run(supplierId, memberId);
      requestId = result.lastInsertRowid;
    }

    recordEvent('request', {
      request_id: requestId,
      supplier_id: supplierId, supplier_name: supplier.name,
      member_id: memberId, member_name: member.name
    }, { memberId });

    await sendEmail(member.email, `${supplier.name} would like to meet you at the exhibition`,
      `Hi ${member.name},\n\n${supplier.name} has requested a meeting with you at the exhibition. ` +
      `Log in to your member portal to view their available time slots and book one:\n${process.env.APP_BASE_URL}/member/\n`);

    res.json({ ok: true });
  } catch (err) {
    console.error('supplier request error:', err);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
});

// This supplier's full slot schedule across both days. Bookings now belong
// directly to the member company, so we join members straight off the
// booking rather than through an attendee.
router.get('/schedule', (req, res) => {
  try {
    const supplierId = req.session.user.id;
    const slots = db.prepare(`
      SELECT s.id, s.start_time, s.end_time, s.status, d.label AS day_label, d.date AS day_date,
             b.id AS booking_id, m.name AS member_name, m.company AS member_company
      FROM slots s
      JOIN exhibition_days d ON d.id = s.day_id
      LEFT JOIN bookings b ON b.slot_id = s.id AND b.cancelled_at IS NULL
      LEFT JOIN members m ON m.id = b.member_id
      WHERE s.supplier_id = ?
      ORDER BY d.date, s.start_time
    `).all(supplierId);
    res.json(slots);
  } catch (err) {
    console.error('supplier schedule error:', err);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
});

// Block a slot (e.g. lunch break) - only allowed while it's currently available.
router.post('/slots/:id/block', (req, res) => {
  try {
    const supplierId = req.session.user.id;
    const slot = db.prepare('SELECT * FROM slots WHERE id = ? AND supplier_id = ?').get(req.params.id, supplierId);
    if (!slot) return res.status(404).json({ error: 'Slot not found' });
    if (slot.status !== 'available') return res.status(409).json({ error: `Slot is currently ${slot.status}` });

    db.prepare("UPDATE slots SET status = 'blocked' WHERE id = ?").run(slot.id);
    recordEvent('slot_block', { slot_id: slot.id }, { supplierId });
    res.json({ ok: true });
  } catch (err) {
    console.error('supplier block slot error:', err);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
});

// Release a previously blocked slot back to available.
router.post('/slots/:id/unblock', (req, res) => {
  try {
    const supplierId = req.session.user.id;
    const slot = db.prepare('SELECT * FROM slots WHERE id = ? AND supplier_id = ?').get(req.params.id, supplierId);
    if (!slot) return res.status(404).json({ error: 'Slot not found' });
    if (slot.status !== 'blocked') return res.status(409).json({ error: `Slot is currently ${slot.status}` });

    db.prepare("UPDATE slots SET status = 'available' WHERE id = ?").run(slot.id);
    recordEvent('slot_unblock', { slot_id: slot.id }, { supplierId });
    res.json({ ok: true });
  } catch (err) {
    console.error('supplier unblock slot error:', err);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
});

// Cancel a pending request - reverts it to unrequested so the supplier can
// tick someone else instead. Only allowed before the member has booked a
// time; once booked, this route refuses (use the schedule to manage that).
router.post('/requests/:id/cancel', async (req, res) => {
  try {
    const supplierId = req.session.user.id;
    const request = db.prepare('SELECT * FROM meeting_requests WHERE id = ? AND supplier_id = ?')
      .get(req.params.id, supplierId);
    if (!request) return res.status(404).json({ error: 'Request not found' });
    if (request.status === 'booked') {
      return res.status(409).json({ error: "Can't cancel - the member has already booked a time" });
    }
    if (request.status === 'cancelled') {
      return res.status(409).json({ error: 'This request is already cancelled' });
    }

    db.prepare("UPDATE meeting_requests SET status = 'cancelled' WHERE id = ?").run(request.id);

    const supplier = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(supplierId);
    const member = db.prepare('SELECT * FROM members WHERE id = ?').get(request.member_id);

    recordEvent('request_cancelled', {
      request_id: request.id, supplier_id: supplierId, supplier_name: supplier.name,
      member_id: request.member_id, member_name: member.company || member.name
    }, { memberId: request.member_id });

    res.json({ ok: true });
  } catch (err) {
    console.error('supplier cancel request error:', err);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
});

module.exports = router;
