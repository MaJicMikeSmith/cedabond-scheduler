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
  const password = (req.body.password || '').trim();
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
  const password = (req.body.password || '').trim();
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

// Admin login - a single shared password (set as the ADMIN_PASSWORD
// environment variable), not a database row, since there's only ever one
// admin user rather than many companies each needing their own record.
router.post('/admin-login', (req, res) => {
  const password = (req.body.password || '').trim();
  if (!password) return res.status(400).json({ error: 'Password required' });
  if (!process.env.ADMIN_PASSWORD || password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Incorrect password' });
  }

  req.session.user = { id: 0, role: 'admin', name: 'Admin' };
  res.json({ ok: true, role: 'admin', redirect: '/admin/' });
});

// Switch back from an impersonated member/supplier session to the original
// admin session. Only works if an admin genuinely started this via the
// /api/admin/impersonate route below - session.impersonatingAdmin is never
// set by anything a member or supplier can trigger themselves, so this
// can't be used to self-escalate to admin.
router.post('/return-to-admin', (req, res) => {
  if (!req.session.impersonatingAdmin) {
    return res.status(400).json({ error: 'Not currently managing on someone else\'s behalf' });
  }
  req.session.user = req.session.impersonatingAdmin;
  delete req.session.impersonatingAdmin;
  res.json({ ok: true, redirect: '/admin/' });
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

router.get('/me', (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'Not logged in' });
  const { role, id } = req.session.user;
  res.json({
    ...req.session.user,
    socketToken: signSocketToken(role, id),
    impersonating: !!req.session.impersonatingAdmin
  });
});

module.exports = router;
