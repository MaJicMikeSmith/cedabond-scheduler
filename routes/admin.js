const express = require('express');
const db = require('../db');
const { requireRole } = require('../middleware/requireAuth');
const router = express.Router();
router.use(requireRole('admin'));

function getDays() {
  return db.prepare('SELECT * FROM exhibition_days ORDER BY date ASC').all();
}

// Suppliers overview: every supplier, with how many of their slots are
// still genuinely available (not booked, not blocked) on each exhibition day.
router.get('/suppliers', (req, res) => {
  try {
    const days = getDays();
    const suppliers = db.prepare('SELECT id, name, company, locked FROM suppliers ORDER BY name').all();

    const result = suppliers.map(s => {
      const perDay = days.map(d => {
        const row = db.prepare(`
          SELECT COUNT(*) AS c FROM slots WHERE supplier_id = ? AND day_id = ? AND status = 'available'
        `).get(s.id, d.id);
        return { day_id: d.id, day_label: d.label, available: row.c };
      });
      return { id: s.id, name: s.name, company: s.company, locked: !!s.locked, days: perDay };
    });

    res.json({ days: days.map(d => ({ id: d.id, label: d.label, date: d.date })), suppliers: result });
  } catch (err) {
    console.error('admin suppliers list error:', err);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
});

// Members overview: every member, with how many confirmed bookings they
// have on each exhibition day.
router.get('/members', (req, res) => {
  try {
    const days = getDays();
    const members = db.prepare('SELECT id, name, company, locked FROM members ORDER BY name').all();

    const result = members.map(m => {
      const perDay = days.map(d => {
        const row = db.prepare(`
          SELECT COUNT(*) AS c FROM bookings b
          JOIN slots sl ON sl.id = b.slot_id
          WHERE b.member_id = ? AND sl.day_id = ? AND b.cancelled_at IS NULL
        `).get(m.id, d.id);
        return { day_id: d.id, day_label: d.label, booked: row.c };
      });
      return { id: m.id, name: m.name, company: m.company, locked: !!m.locked, days: perDay };
    });

    res.json({ days: days.map(d => ({ id: d.id, label: d.label, date: d.date })), members: result });
  } catch (err) {
    console.error('admin members list error:', err);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
});

// Lock or unlock a single member's or supplier's account - while locked,
// they can still log in and see everything, but every write route (booking,
// requesting, blocking a slot, etc.) refuses with a clear message.
router.post('/lock', (req, res) => {
  try {
    const { role, id, locked } = req.body;
    if (role !== 'member' && role !== 'supplier') {
      return res.status(400).json({ error: 'role must be "member" or "supplier"' });
    }
    const table = role === 'member' ? 'members' : 'suppliers';
    const record = db.prepare(`SELECT id FROM ${table} WHERE id = ?`).get(id);
    if (!record) return res.status(404).json({ error: `${role === 'member' ? 'Member' : 'Supplier'} not found` });

    db.prepare(`UPDATE ${table} SET locked = ? WHERE id = ?`).run(locked ? 1 : 0, id);
    res.json({ ok: true });
  } catch (err) {
    console.error('admin lock error:', err);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
});

// Lock or unlock every member or every supplier at once - the "Lock all" /
// "Unlock all" control above each admin table.
router.post('/lock-all', (req, res) => {
  try {
    const { role, locked } = req.body;
    if (role !== 'member' && role !== 'supplier') {
      return res.status(400).json({ error: 'role must be "member" or "supplier"' });
    }
    const table = role === 'member' ? 'members' : 'suppliers';
    db.prepare(`UPDATE ${table} SET locked = ?`).run(locked ? 1 : 0);
    res.json({ ok: true });
  } catch (err) {
    console.error('admin lock-all error:', err);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
});

// One supplier's full schedule, every slot on every day, with whichever
// member (if any) has booked each one.
router.get('/suppliers/:id', (req, res) => {
  try {
    const supplier = db.prepare('SELECT id, name, company FROM suppliers WHERE id = ?').get(req.params.id);
    if (!supplier) return res.status(404).json({ error: 'Supplier not found' });

    const slots = db.prepare(`
      SELECT sl.id, sl.start_time, sl.end_time, sl.status, sl.note,
             d.id AS day_id, d.label AS day_label, d.date AS day_date,
             m.id AS member_id, COALESCE(m.company, m.name) AS member_name
      FROM slots sl
      JOIN exhibition_days d ON d.id = sl.day_id
      LEFT JOIN bookings b ON b.slot_id = sl.id AND b.cancelled_at IS NULL
      LEFT JOIN members m ON m.id = b.member_id
      WHERE sl.supplier_id = ?
      ORDER BY d.date, sl.start_time
    `).all(supplier.id);

    res.json({ supplier, slots });
  } catch (err) {
    console.error('admin supplier detail error:', err);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
});

// Switch the current (admin) session into a member's or supplier's account,
// so admin can manage their bookings/requests directly without ever needing
// their password. The original admin identity is stashed in a session field
// a member/supplier session can never set themselves, so /api/auth/return-to-admin
// can only ever hand back a session that was genuinely admin to start with.
router.post('/impersonate', (req, res) => {
  try {
    const { role, id } = req.body;
    if (role !== 'member' && role !== 'supplier') {
      return res.status(400).json({ error: 'role must be "member" or "supplier"' });
    }
    const table = role === 'member' ? 'members' : 'suppliers';
    const record = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
    if (!record) return res.status(404).json({ error: `${role === 'member' ? 'Member' : 'Supplier'} not found` });

    // Keep the very first admin identity if we're somehow already mid-impersonation
    // (shouldn't happen via the UI, but avoids ever losing the way back to admin).
    req.session.impersonatingAdmin = req.session.impersonatingAdmin || req.session.user;
    req.session.user = {
      id: record.id,
      role,
      name: record.company || record.name,
      email: record.email
    };
    res.json({ ok: true, redirect: role === 'member' ? '/member/' : '/supplier/' });
  } catch (err) {
    console.error('admin impersonate error:', err);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
});

// One member's confirmed bookings across every exhibition day.
router.get('/members/:id', (req, res) => {
  try {
    const member = db.prepare('SELECT id, name, company FROM members WHERE id = ?').get(req.params.id);
    if (!member) return res.status(404).json({ error: 'Member not found' });

    const bookings = db.prepare(`
      SELECT b.id, sl.start_time, sl.end_time,
             d.id AS day_id, d.label AS day_label, d.date AS day_date,
             s.id AS supplier_id, s.name AS supplier_name
      FROM bookings b
      JOIN slots sl ON sl.id = b.slot_id
      JOIN exhibition_days d ON d.id = sl.day_id
      JOIN suppliers s ON s.id = b.supplier_id
      WHERE b.member_id = ? AND b.cancelled_at IS NULL
      ORDER BY d.date, sl.start_time
    `).all(member.id);

    res.json({ member, bookings });
  } catch (err) {
    console.error('admin member detail error:', err);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
});

module.exports = router;
