const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const db = require('../db');

const router = express.Router();

function signSocketToken(role, id) {
  const payload = `${role}:${id}`;
  const sig = crypto.createHmac('sha256', process.env.SOCKET_SECRET).update(payload).digest('hex');
  return `${payload}:${sig}`;
}

// Member/attendee login - email + password, unchanged.
router.post('/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  const attendee = db.prepare('SELECT * FROM attendees WHERE email = ?').get(email.toLowerCase());
  if (!attendee || !attendee.password_hash || !bcrypt.compareSync(password, attendee.password_hash)) {
    return res.status(401).json({ error: 'Incorrect email or password' });
  }

  req.session.user = { id: attendee.id, role: 'attendee', name: attendee.name, email: attendee.email };
  res.json({ ok: true, role: 'attendee', redirect: '/member/' });
});

// Supplier login - password only. The supplier's PK is embedded in the password
// itself (e.g. "SUNSHINE-217"), so no email is needed to identify the account -
// the number on the end tells us exactly which supplier to check against.
router.post('/supplier-login', (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'Password required' });

  const match = password.match(/-(\d+)$/);
  if (!match) return res.status(401).json({ error: 'Incorrect password' });

  const supplier = db.prepare('SELECT * FROM suppliers WHERE external_id = ?').get(match[1]);
  if (!supplier || !supplier.password_hash || !bcrypt.compareSync(password, supplier.password_hash)) {
    return res.status(401).json({ error: 'Incorrect password' });
  }

  req.session.user = { id: supplier.id, role: 'supplier', name: supplier.name, email: supplier.email };
  res.json({ ok: true, role: 'supplier', redirect: '/supplier/' });
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

router.get('/me', (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'Not logged in' });
  const { role, id } = req.session.user;
  const response = {
    ...req.session.user,
    socketToken: signSocketToken(role, id)
  };
  // Attendees also join a company-wide room, so a new request/booking/cancellation
  // notifies every attendee from that member company, not just the one who acted.
  if (role === 'attendee') {
    const attendee = db.prepare('SELECT member_id FROM attendees WHERE id = ?').get(id);
    if (attendee) response.companySocketToken = signSocketToken('company', attendee.member_id);
  }
  res.json(response);
});

// First-time setup for ATTENDEES only: the token emailed when they register
// via a member's invite link is exchanged for a password. Suppliers don't use
// this - their password is generated and emailed directly (see
// POST /api/filemaker/suppliers/acknowledge).
router.post('/set-password', (req, res) => {
  const { token, type, password } = req.body;
  if (!token || !type || !password) return res.status(400).json({ error: 'Missing fields' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  if (type !== 'attendee') return res.status(400).json({ error: 'Invalid type' });

  const account = db.prepare('SELECT * FROM attendees WHERE setup_token = ?').get(token);
  if (!account) return res.status(400).json({ error: 'This setup link is invalid or has already been used' });

  const hash = bcrypt.hashSync(password, 10);
  db.prepare('UPDATE attendees SET password_hash = ?, setup_token = NULL WHERE id = ?').run(hash, account.id);
  res.json({ ok: true });
});

module.exports = router;
