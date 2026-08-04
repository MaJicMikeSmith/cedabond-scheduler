// Run with: npm run reset-test-data
//
// Wipes all test suppliers, members, attendees, slots, bookings, requests,
// and sync log entries — so the real supplier/member list (from FileMaker or
// a spreadsheet import) can start clean.
//
// Does NOT touch exhibition_days — day/date/time config is left exactly as is.
require('dotenv').config();
const db = require('../db');

const tablesInOrder = [
  'bookings',
  'meeting_requests',
  'slots',
  'attendee_days',
  'attendees',
  'supplier_emails',
  'suppliers',
  'members',
  'sync_log'
];

const countBefore = {};
for (const t of tablesInOrder) {
  countBefore[t] = db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
}

const wipe = db.transaction(() => {
  for (const t of tablesInOrder) {
    db.prepare(`DELETE FROM ${t}`).run();
    // Reset the autoincrement counter so new real records start at id 1 again.
    db.prepare(`DELETE FROM sqlite_sequence WHERE name = ?`).run(t);
  }
});

wipe();

console.log('Test data cleared. Rows removed:');
for (const t of tablesInOrder) {
  console.log(`  ${t}: ${countBefore[t]}`);
}

const daysLeft = db.prepare('SELECT COUNT(*) AS n FROM exhibition_days').get().n;
console.log(`exhibition_days left untouched: ${daysLeft} row(s) still there.`);
