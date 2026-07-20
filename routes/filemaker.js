const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const { requireApiKey } = require('../middleware/requireApiKey');
const { ensureSlotsForSupplier, ensureSlotsForAllSuppliers } = require('../lib/slotgen');
const { sendEmail } = require('../lib/email');

const router = express.Router();
router.use(requireApiKey);

function setupLink(type, token) {
  return `${process.env.APP_BASE_URL}/set-password.html?type=${type}&token=${token}`;
}

// ---- PUSH: exhibition days -------------------------------------------------
// Body: { "days": [ { external_id, label, date, start_time, end_time, slot_minutes } ] }
router.post('/exhibition-days', (req, res) => {
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
});

// ---- PUSH: suppliers --------------------------------------------------------
// Body: { "suppliers": [ { external_id, name, email, company } ] }
router.post('/suppliers', async (req, res) => {
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
    const existing = existingStmt.get(s.external_id);
    if (existing) {
      update.run(s);
    } else {
      const token = crypto.randomBytes(20).toString('hex');
      insert.run({ ...s, setup_token: token });
      const row = existingStmt.get(s.external_id);
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
});

// ---- PUSH: members ----------------------------------------------------------
// Body: { "members": [ { external_id, name, email, company, day_external_id, window_start, window_end } ] }
router.post('/members', async (req, res) => {
  const members = req.body.members || [];
  const existingStmt = db.prepare('SELECT id FROM members WHERE external_id = ?');
  const dayStmt = db.prepare('SELECT id FROM exhibition_days WHERE external_id = ?');

  const insert = db.prepare(`
    INSERT INTO members (external_id, name, email, company, day_id, window_start, window_end, setup_token)
    VALUES (@external_id, @name, @email, @company, @day_id, @window_start, @window_end, @setup_token)
  `);
  const update = db.prepare(`
    UPDATE members SET name=@name, email=@email, company=@company, day_id=@day_id,
      window_start=@window_start, window_end=@window_end, updated_at=datetime('now')
    WHERE external_id=@external_id
  `);

  const created = [];
  const errors = [];
  for (const m of members) {
    const day = m.day_external_id ? dayStmt.get(m.day_external_id) : null;
    if (m.day_external_id && !day) {
      errors.push({ external_id: m.external_id, error: `Unknown day_external_id '${m.day_external_id}'` });
      continue;
    }
    const row = { ...m, day_id: day ? day.id : null };
    const existing = existingStmt.get(m.external_id);
    if (existing) {
      update.run(row);
    } else {
      const token = crypto.randomBytes(20).toString('hex');
      insert.run({ ...row, setup_token: token });
      created.push({ ...m, token });
    }
  }

  for (const c of created) {
    await sendEmail(
      c.email,
      'Set up your Cedabond Exhibition account',
      `Hi ${c.name},\n\nYou're registered to attend the Cedabond exhibition. ` +
      `Set your password here to view supplier meeting requests and book time slots:\n${setupLink('member', c.token)}\n`
    );
  }

  res.json({ ok: true, count: members.length, created: created.length, errors });
});

// ---- PULL: activity since a given sync_log id --------------------------------
// GET /api/filemaker/activity?since=123  -> rows with id > 123, plus the new high-water mark
router.get('/activity', (req, res) => {
  const since = Number(req.query.since || 0);
  const rows = db.prepare('SELECT * FROM sync_log WHERE id > ? ORDER BY id ASC LIMIT 500').all(since);
  const events = rows.map(r => ({ id: r.id, type: r.entity_type, created_at: r.created_at, ...JSON.parse(r.payload) }));
  const lastId = rows.length ? rows[rows.length - 1].id : since;
  res.json({ lastId, events });
});

// ---- Staff convenience: list any setup links not yet used (in case an email bounced) ---
router.get('/setup-links', (req, res) => {
  const members = db.prepare("SELECT external_id, name, email, setup_token FROM members WHERE setup_token IS NOT NULL").all();
  const suppliers = db.prepare("SELECT external_id, name, email, setup_token FROM suppliers WHERE setup_token IS NOT NULL").all();
  res.json({
    members: members.map(m => ({ ...m, link: setupLink('member', m.setup_token) })),
    suppliers: suppliers.map(s => ({ ...s, link: setupLink('supplier', s.setup_token) }))
  });
});

module.exports = router;
