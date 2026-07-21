const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { requireApiKey } = require('../middleware/requireApiKey');
const { ensureSlotsForSupplier, ensureSlotsForAllSuppliers } = require('../lib/slotgen');
const { sendEmail } = require('../lib/email');

const router = express.Router();
router.use(requireApiKey);

function setupLink(type, token) {
  return `${process.env.APP_BASE_URL}/set-password.html?type=${type}&token=${token}`;
}

function inviteLink(externalId, token) {
  return `${process.env.APP_BASE_URL}/add-attendee.html?member=${encodeURIComponent(externalId)}&token=${token}`;
}

// ---- PUSH: exhibition days -------------------------------------------------
// Body: { "days": [ { external_id, label, date, start_time, end_time, slot_minutes } ] }
router.post('/exhibition-days', (req, res) => {
  try {
    const days = req.body.days || [];
    const upsert = db.prepare(`
      INSERT INTO exhibition_days (external_id, label, date, start_time, end_time, slot_minutes)
      VALUES (@external_id, @label, @date, @start_time, @end_time, @slot_minutes)
      ON CONFLICT(external_id) DO UPDATE SET
        label = excluded.label, date = excluded.date, start_time = excluded.start_time,
        end_time = excluded.end_time, slot_minutes = excluded.slot_minutes
    `);
    for (const d of days) {
      upsert.run({ slot_minutes: 20, ...d });
    }
    ensureSlotsForAllSuppliers();
    res.json({ ok: true, count: days.length });
  } catch (err) {
    console.error('exhibition-days error:', err);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
});

// ---- PUSH: suppliers --------------------------------------------------------
// Body: { "suppliers": [ { external_id, name, email, company } ] }
router.post('/suppliers', async (req, res) => {
  try {
    const suppliers = req.body.suppliers || [];
    const existingStmt = db.prepare('SELECT id FROM suppliers WHERE external_id = ?');
    const insert = db.prepare(`
      INSERT INTO suppliers (external_id, name, email, company, setup_token)
      VALUES (@external_id, @name, @email, @company, @setup_token)
    `);
    const update = db.prepare(`
      UPDATE suppliers SET name=@name, email=@email, company=@company, updated_at=datetime('now')
      WHERE external_id=@external_id
    `);

    const created = [];
    for (const s of suppliers) {
      const existing = existingStmt.get(String(s.external_id));
      if (existing) {
        update.run({ ...s, external_id: String(s.external_id) });
      } else {
        const token = crypto.randomBytes(20).toString('hex');
        insert.run({ ...s, external_id: String(s.external_id), setup_token: token });
        const row = existingStmt.get(String(s.external_id));
        ensureSlotsForSupplier(row.id);
        created.push({ ...s, token });
      }
    }

    for (const c of created) {
      await sendEmail(
        c.email,
        'Set up your Cedabond Exhibition account',
        `Hi ${c.name},\n\nYou're registered as an exhibiting supplier for the Cedabond exhibition. ` +
        `Set your password here to start requesting meetings with members:\n${setupLink('supplier', c.token)}\n`
      );
    }

    res.json({ ok: true, count: suppliers.length, created: created.length });
  } catch (err) {
    console.error('suppliers push error:', err);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
});

// ---- PUSH: members (companies) ----------------------------------------------
// Body: { "members": [ { external_id, name, email, company } ] }
// Each newly-created member gets a durable invite link, emailed to the primary
// contact, which they can forward to any colleagues attending - each person
// uses the same link to add themselves as an individual attendee.
router.post('/members', async (req, res) => {
  try {
    const members = req.body.members || [];
    const existingStmt = db.prepare('SELECT id, invite_token FROM members WHERE external_id = ?');
    const insert = db.prepare(`
      INSERT INTO members (external_id, name, email, company, invite_token)
      VALUES (@external_id, @name, @email, @company, @invite_token)
    `);
    const update = db.prepare(`
      UPDATE members SET name=@name, email=@email, company=@company, updated_at=datetime('now')
      WHERE external_id=@external_id
    `);

    const created = [];
    for (const m of members) {
      const existing = existingStmt.get(String(m.external_id));
      if (existing) {
        update.run({ ...m, external_id: String(m.external_id) });
      } else {
        const inviteToken = crypto.randomBytes(12).toString('hex');
        insert.run({ ...m, external_id: String(m.external_id), invite_token: inviteToken });
        created.push({ ...m, inviteToken });
      }
    }

    for (const c of created) {
      await sendEmail(
        c.email,
        'Register your team for the Cedabond Exhibition',
        `Hi ${c.name},\n\n${c.company || 'Your company'} is registered to attend the Cedabond exhibition.\n\n` +
        `Please use the link below to add yourself as an attendee, and feel free to forward it to any ` +
        `colleagues who'll also be attending - each person adds their own details and gets their own login ` +
        `to book meetings:\n${inviteLink(c.external_id, c.inviteToken)}\n`
      );
    }

    res.json({ ok: true, count: members.length, created: created.length });
  } catch (err) {
    console.error('members push error:', err);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
});

// ---- Staff-triggered: register a supplier's login (password decided in FileMaker) ----
// FileMaker generates the password and sends the confirmation email itself (so a
// permanent, lookup-able copy exists there for support calls). This endpoint's job
// is purely to store the account so the supplier can actually log in - it does NOT
// generate a password or send any email of its own.
// Body: { external_id, name, company, password, emails: ["a@x.com", "b@x.com", ...] }
router.post('/suppliers/acknowledge', async (req, res) => {
  try {
    const { external_id, name, company, password, emails } = req.body;
    if (!external_id || !name || !password || !Array.isArray(emails) || !emails.length) {
      return res.status(400).json({ error: 'external_id, name, password, and at least one email are required' });
    }
    const extId = String(external_id);
    const cleanEmails = [...new Set(emails.map(e => e.trim().toLowerCase()).filter(Boolean))];
    const hash = bcrypt.hashSync(password, 10);

    let supplier = db.prepare('SELECT * FROM suppliers WHERE external_id = ?').get(extId);

    if (!supplier) {
      // Someone else might already hold the primary email (e.g. re-testing, or a
      // genuine handover) - reassign rather than crash on the unique constraint.
      const emailOwner = db.prepare('SELECT * FROM suppliers WHERE email = ?').get(cleanEmails[0]);
      if (emailOwner) {
        db.prepare(`UPDATE suppliers SET external_id = ?, name = ?, company = ?, password_hash = ?, updated_at = datetime('now') WHERE id = ?`)
          .run(extId, name, company || null, hash, emailOwner.id);
        supplier = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(emailOwner.id);
      } else {
        const result = db.prepare(`
          INSERT INTO suppliers (external_id, name, email, company, password_hash)
          VALUES (?, ?, ?, ?, ?)
        `).run(extId, name, cleanEmails[0], company || null, hash);
        supplier = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(result.lastInsertRowid);
      }
    } else {
      db.prepare(`UPDATE suppliers SET name = ?, company = ?, password_hash = ?, updated_at = datetime('now') WHERE id = ?`)
        .run(name, company || null, hash, supplier.id);
    }

    const insertEmail = db.prepare('INSERT OR IGNORE INTO supplier_emails (supplier_id, email) VALUES (?, ?)');
    for (const e of cleanEmails) insertEmail.run(supplier.id, e);

    res.json({ ok: true, supplier_id: supplier.id, emails: cleanEmails });
  } catch (err) {
    console.error('acknowledge error:', err);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
});

// ---- PULL: activity since a given sync_log id --------------------------------
// GET /api/filemaker/activity?since=123  -> rows with id > 123, plus the new high-water mark
router.get('/activity', (req, res) => {
  try {
    const since = Number(req.query.since || 0);
    const rows = db.prepare('SELECT * FROM sync_log WHERE id > ? ORDER BY id ASC LIMIT 500').all(since);
    const events = rows.map(r => ({ id: r.id, type: r.entity_type, created_at: r.created_at, ...JSON.parse(r.payload) }));
    const lastId = rows.length ? rows[rows.length - 1].id : since;
    res.json({ lastId, events });
  } catch (err) {
    console.error('activity error:', err);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
});

// ---- Staff convenience: list any invite/setup links not yet used or re-sendable ---
router.get('/setup-links', (req, res) => {
  try {
    const members = db.prepare("SELECT external_id, name, email, invite_token FROM members WHERE invite_token IS NOT NULL").all();
    const suppliers = db.prepare("SELECT external_id, name, email, setup_token FROM suppliers WHERE setup_token IS NOT NULL").all();
    res.json({
      members: members.map(m => ({ ...m, link: inviteLink(m.external_id, m.invite_token) })),
      suppliers: suppliers.map(s => ({ ...s, link: setupLink('supplier', s.setup_token) }))
    });
  } catch (err) {
    console.error('setup-links error:', err);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
});

module.exports = router;
