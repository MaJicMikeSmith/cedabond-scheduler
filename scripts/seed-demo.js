// Run with: npm run seed-demo
// Creates 2 exhibition days, 3 demo suppliers and 4 demo members, all with the
// password "password123", so you can click through both portals immediately.
require('dotenv').config();
const bcrypt = require('bcryptjs');
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

const members = [
  { external_id: 'MEM1', name: 'Alex Carter', email: 'demo.member1@example.com', company: 'Carter Catering', day_external_id: 'DAY1', window_start: '09:00', window_end: '13:00' },
  { external_id: 'MEM2', name: 'Priya Shah', email: 'demo.member2@example.com', company: 'Shah Hospitality Group', day_external_id: 'DAY1', window_start: '12:00', window_end: '17:00' },
  { external_id: 'MEM3', name: 'Tom Baines', email: 'demo.member3@example.com', company: 'Baines Catering Co', day_external_id: 'DAY2', window_start: '09:00', window_end: '17:00' },
  { external_id: 'MEM4', name: 'Joanna Reid', email: 'demo.member4@example.com', company: 'Reid & Sons', day_external_id: 'DAY2', window_start: '09:00', window_end: '12:00' }
];
const dayByExt = Object.fromEntries(dayRows.map(d => [d.external_id, d.id]));
const insertMember = db.prepare(`
  INSERT INTO members (external_id, name, email, company, day_id, window_start, window_end, password_hash)
  VALUES (@external_id, @name, @email, @company, @day_id, @window_start, @window_end, @password_hash)
  ON CONFLICT(external_id) DO NOTHING
`);
members.forEach(m => insertMember.run({ ...m, day_id: dayByExt[m.day_external_id], password_hash: pw }));

ensureSlotsForAllSuppliers();

console.log('Demo data seeded. All accounts use password: password123');
console.log('Suppliers:', suppliers.map(s => s.email).join(', '));
console.log('Members:  ', members.map(m => m.email).join(', '));
