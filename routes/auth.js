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

// Member login - password only. The member's PK is embedded in the password
// itself (e.g. "SUNSHINE-42"), so no email is needed - the number on the end
// identifies the company. One shared password for the whole organisation;
// any attendee given it can book on the company's behalf.
router.post('/member-login', (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'Password required' });

  const match = password.match(/-(\d+)$/);
  if (!match) return res.status(401).json({ error: 'Incorrect password' });

  const member = db.prepare('SELECT * FROM members WHERE external_id = ?').get(match[1]);
  if (!member || !member.password_hash || !bcrypt.compareSync(password, member.password_hash)) {
    return res.status(401).json({ error: 'Incorrect password' });
  }

  req.session.user = { id: member.id, role: 'member', name: member.company || member.name, email: member.email };
  res.json({ ok: true, role: 'member', redirect: '/member/' });
});

// Supplier login - password only, same pattern.
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
  res.json({
    ...req.session.user,
    socketToken: signSocketToken(role, id)
  });
});

module.exports = router;
