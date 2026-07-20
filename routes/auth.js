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

router.post('/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  const member = db.prepare('SELECT * FROM members WHERE email = ?').get(email.toLowerCase());
  const supplier = db.prepare('SELECT * FROM suppliers WHERE email = ?').get(email.toLowerCase());
  const account = member || supplier;
  const role = member ? 'member' : supplier ? 'supplier' : null;

  if (!account || !account.password_hash || !bcrypt.compareSync(password, account.password_hash)) {
    return res.status(401).json({ error: 'Incorrect email or password' });
  }

  req.session.user = { id: account.id, role, name: account.name, email: account.email };
  res.json({ ok: true, role, redirect: role === 'member' ? '/member/' : '/supplier/' });
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

router.get('/me', (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'Not logged in' });
  res.json({
    ...req.session.user,
    socketToken: signSocketToken(req.session.user.role, req.session.user.id)
  });
});

// Step 1 of first-time setup: token (emailed when FileMaker first pushes the person in)
// is exchanged for a password.
router.post('/set-password', (req, res) => {
  const { token, type, password } = req.body;
  if (!token || !type || !password) return res.status(400).json({ error: 'Missing fields' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

  const table = type === 'member' ? 'members' : type === 'supplier' ? 'suppliers' : null;
  if (!table) return res.status(400).json({ error: 'Invalid type' });

  const account = db.prepare(`SELECT * FROM ${table} WHERE setup_token = ?`).get(token);
  if (!account) return res.status(400).json({ error: 'This setup link is invalid or has already been used' });

  const hash = bcrypt.hashSync(password, 10);
  db.prepare(`UPDATE ${table} SET password_hash = ?, setup_token = NULL WHERE id = ?`).run(hash, account.id);
  res.json({ ok: true });
});

module.exports = router;
