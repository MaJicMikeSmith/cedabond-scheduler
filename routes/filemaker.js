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

// ---- PUSH: suppliers (bulk, self-service setup link) -----------------------
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

// ---- Staff-triggered: register a supplier's login (password decided in FileMaker) ----
// FileMaker generates the password and sends the confirmation email itself.
// This endpoint just stores the account - no password generation, no email.
// Body: { external_id, name, company, password, emails: ["a@x.com", ...] }
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
      // Only merge into an email match if that row has no external_id of its own -
      // i.e. a genuine orphan record, never one already claimed by a different
      // confirmed supplier. Without this guard, several suppliers sharing one email
      // (e.g. everything routed to a single test-mode address) silently overwrite
      // each other's row instead of getting their own.
      const emailOwner = db.prepare(
        "SELECT * FROM suppliers WHERE email = ? AND (external_id IS NULL OR external_id = '')"
      ).get(cleanEmails[0]);
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
    console.error('supplier acknowledge error:', err);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
});

// ---- Staff-triggered: register a member company + its attendee list -------
// FileMaker generates the shared password and sends the confirmation email
// itself - same pattern as suppliers/acknowledge. Attendees are purely
// informational (badges/catering) and are NOT tied to login - the whole
// company shares one password. Each call REPLACES the member's attendee
// list entirely with what's sent, since FileMaker is the source of truth.
// Body: { external_id, name, company, password,
//         attendees: [ { name, job_description, email, phone, arrival, departure, day_external_ids: [...] } ] }
router.post('/members/acknowledge', async (req, res) => {
  try {
    const { external_id, name, company, password, attendees } = req.body;
    if (!external_id || !name || !password) {
      return res.status(400).json({ error: 'external_id, name, and password are required' });
    }
    const extId = String(external_id);
    const hash = bcrypt.hashSync(password, 10);
    const attendeeList = Array.isArray(attendees) ? attendees : [];
    const primaryEmail = req.body.email || (attendeeList.find(a => a.email) || {}).email;

    let member = db.prepare('SELECT * FROM members WHERE external_id = ?').get(extId);

    if (!member) {
      if (!primaryEmail) {
        return res.status(400).json({ error: 'At least one email (top-level, or on an attendee) is required for a new member' });
      }
      const cleanEmail = primaryEmail.trim().toLowerCase();
      // Same guard as suppliers/acknowledge - only merge into a genuine orphan row,
      // never one already claimed by a different confirmed member.
      const emailOwner = db.prepare(
        "SELECT * FROM members WHERE email = ? AND (external_id IS NULL OR external_id = '')"
      ).get(cleanEmail);
      if (emailOwner) {
        db.prepare(`UPDATE members SET external_id = ?, name = ?, company = ?, password_hash = ?, updated_at = datetime('now') WHERE id = ?`)
          .run(extId, name, company || null, hash, emailOwner.id);
        member = db.prepare('SELECT * FROM members WHERE id = ?').get(emailOwner.id);
      } else {
        const result = db.prepare(`
          INSERT INTO members (external_id, name, email, company, password_hash)
          VALUES (?, ?, ?, ?, ?)
        `).run(extId, name, cleanEmail, company || null, hash);
        member = db.prepare('SELECT * FROM members WHERE id = ?').get(result.lastInsertRowid);
      }
    } else {
      db.prepare(`UPDATE members SET name = ?, company = ?, password_hash = ?, updated_at = datetime('now') WHERE id = ?`)
        .run(name, company || null, hash, member.id);
    }

    // Replace the attendee list wholesale - simplest way to stay in sync with
    // whatever FileMaker currently shows, no diffing needed.
    const oldAttendeeIds = db.prepare('SELECT id FROM attendees WHERE member_id = ?').all(member.id).map(r => r.id);
    if (oldAttendeeIds.length) {
      const placeholders = oldAttendeeIds.map(() => '?').join(',');
      db.prepare(`DELETE FROM attendee_days WHERE attendee_id IN (${placeholders})`).run(...oldAttendeeIds);
    }
    db.prepare('DELETE FROM attendees WHERE member_id = ?').run(member.id);

    const insertAttendee = db.prepare(`
      INSERT INTO attendees (member_id, name, job_description, email, phone, arrival, departure)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const insertAttendeeDay = db.prepare('INSERT OR IGNORE INTO attendee_days (attendee_id, day_id) VALUES (?, ?)');
    const findDay = db.prepare('SELECT id FROM exhibition_days WHERE external_id = ?');

    for (const a of attendeeList) {
      const result = insertAttendee.run(
        member.id,
        a.name || '(unnamed)',
        a.job_description || null,
        a.email || null,
        a.phone || null,
        a.arrival || null,
        a.departure || null
      );
      const attendeeId = result.lastInsertRowid;
      for (const dayExtId of (a.day_external_ids || [])) {
        const day = findDay.get(String(dayExtId));
        if (day) insertAttendeeDay.run(attendeeId, day.id);
      }
    }

    res.json({ ok: true, member_id: member.id, attendee_count: attendeeList.length });
  } catch (err) {
    console.error('member acknowledge error:', err);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
});

// ---- PULL: activity since a given sync_log id --------------------------------
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

// ---- Staff convenience: list any supplier setup links not yet used --------
router.get('/setup-links', (req, res) => {
  try {
    const suppliers = db.prepare("SELECT external_id, name, email, setup_token FROM suppliers WHERE setup_token IS NOT NULL").all();
    res.json({
      suppliers: suppliers.map(s => ({ ...s, link: setupLink('supplier', s.setup_token) }))
    });
  } catch (err) {
    console.error('setup-links error:', err);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
});

module.exports = router;
