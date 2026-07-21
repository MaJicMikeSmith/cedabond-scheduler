// Run with: npm run seed-demo
// Creates 2 exhibition days, 3 demo suppliers, 4 demo member companies, and
// one demo attendee per member company - all accounts use "password123" so
// you can click through both portals immediately.
require('dotenv').config();
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const db = require('../db');
const { ensureSlotsForAllSuppliers } = require('../lib/slotgen');

const pw = bcrypt.hashSync('password123', 10);

const days = [
  { external_id: 'DAY1', label: 'Day 1', date: '2026-09-09', start_time: '09:00', end_time: '17:00', slot_minutes: 20 },
  { external_id: 'DAY2', label: 'Day 2', date: '2026-09-10', start_time: '09:00', end_time: '17:00', slot_minutes: 20 }
];
const upsertDay = db.prepare(`
  INSERT INTO exhibition_days (external_id, label, date, start_time, end_time, slot_minutes)
  VALUES (@external_id, @label, @date, @start_time, @end_time, @slot_minutes)
  ON CONFLICT(external_id) DO NOTHING
`);
days.forEach(d => upsertDay.run(d));
const dayRows = db.prepare('SELECT * FROM exhibition_days').all();
const dayByExt = Object.fromEntries(dayRows.map(d => [d.external_id, d.id]));

const suppliers = [
  { external_id: 'SUP1', name: 'Maris Fresh Produce', email: 'demo.supplier1@example.com', company: 'Maris Fresh Produce Ltd' },
  { external_id: 'SUP2', name: 'Northfield Bakery Supplies', email: 'demo.supplier2@example.com', company: 'Northfield Bakery Supplies' },
  { external_id: 'SUP3', name: 'Bright Catering Equipment', email: 'demo.supplier3@example.com', company: 'Bright Catering Equipment' }
];
const insertSupplier = db.prepare(`
  INSERT INTO suppliers (external_id, name, email, company, password_hash)
  VALUES (@external_id, @name, @email, @company, @password_hash)
  ON CONFLICT(external_id) DO NOTHING
`);
suppliers.forEach(s => insertSupplier.run({ ...s, password_hash: pw }));

// Members are now company-level only, each with one demo attendee (their
// "Alex Carter" etc.) already registered and logged-in-ready, plus a durable
// invite link so you can also try the self-registration flow for extra attendees.
const members = [
  { external_id: 'MEM1', name: 'Alex Carter', email: 'demo.member1@example.com', company: 'Carter Catering', days: ['DAY1'] },
  { external_id: 'MEM2', name: 'Priya Shah', email: 'demo.member2@example.com', company: 'Shah Hospitality Group', days: ['DAY1'] },
  { external_id: 'MEM3', name: 'Tom Baines', email: 'demo.member3@example.com', company: 'Baines Catering Co', days: ['DAY2'] },
  { external_id: 'MEM4', name: 'Joanna Reid', email: 'demo.member4@example.com', company: 'Reid & Sons', days: ['DAY1', 'DAY2'] }
];
const insertMember = db.prepare(`
  INSERT INTO members (external_id, name, email, company, invite_token)
  VALUES (@external_id, @name, @email, @company, @invite_token)
  ON CONFLICT(external_id) DO NOTHING
`);
const insertAttendee = db.prepare(`
  INSERT INTO attendees (member_id, name, email, password_hash)
  VALUES (@member_id, @name, @email, @password_hash)
`);
const insertAttendeeDay = db.prepare(`INSERT OR IGNORE INTO attendee_days (attendee_id, day_id) VALUES (?, ?)`);
const getMemberId = db.prepare('SELECT id FROM members WHERE external_id = ?');
const getExistingAttendee = db.prepare('SELECT id FROM attendees WHERE email = ?');

const attendeeEmails = [];
for (const m of members) {
  insertMember.run({ ...m, invite_token: crypto.randomBytes(12).toString('hex') });
  const memberId = getMemberId.get(m.external_id).id;

  if (!getExistingAttendee.get(m.email)) {
    const result = insertAttendee.run({ member_id: memberId, name: m.name, email: m.email, password_hash: pw });
    for (const dayExt of m.days) {
      insertAttendeeDay.run(result.lastInsertRowid, dayByExt[dayExt]);
    }
  }
  attendeeEmails.push(m.email);
}

ensureSlotsForAllSuppliers();

console.log('Demo data seeded. All accounts use password: password123');
console.log('Suppliers:', suppliers.map(s => s.email).join(', '));
console.log('Attendees:', attendeeEmails.join(', '));
