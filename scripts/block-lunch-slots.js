// One-off script: blocks the lunch-break slots for every supplier, on both
// exhibition days. Run once via Render Shell: node scripts/block-lunch-slots.js
//
// Day 1 (13:20-14:20): 13:20, 13:40, 14:00
// Day 2 (13:00-14:00): 13:00, 13:20, 13:40
//
// Only touches slots that are currently 'available'. Any slot that's already
// booked or blocked is left untouched and reported separately, so this is
// safe to run even with real test bookings already in the system.

const db = require('../db');

const TARGETS = [
  { dayLabel: 'Day 1', times: ['13:20', '13:40', '14:00'] },
  { dayLabel: 'Day 2', times: ['13:00', '13:20', '13:40'] }
];

let blocked = 0;
let alreadyBooked = [];
let missing = [];

for (const { dayLabel, times } of TARGETS) {
  const day = db.prepare('SELECT * FROM exhibition_days WHERE label = ?').get(dayLabel);
  if (!day) {
    console.log(`No exhibition day found with label "${dayLabel}" - skipping.`);
    continue;
  }

  const suppliers = db.prepare('SELECT id, name FROM suppliers').all();

  for (const time of times) {
    for (const supplier of suppliers) {
      const slot = db.prepare('SELECT * FROM slots WHERE supplier_id = ? AND day_id = ? AND start_time = ?')
        .get(supplier.id, day.id, time);

      if (!slot) {
        missing.push(`${supplier.name} - ${dayLabel} ${time} (no slot found)`);
        continue;
      }
      if (slot.status === 'booked') {
        alreadyBooked.push(`${supplier.name} - ${dayLabel} ${time} (already booked, left alone)`);
        continue;
      }
      if (slot.status === 'blocked') {
        continue; // already blocked, nothing to do
      }

      db.prepare("UPDATE slots SET status = 'blocked' WHERE id = ?").run(slot.id);
      blocked++;
    }
  }
}

console.log(`\nBlocked ${blocked} slots.`);

if (alreadyBooked.length) {
  console.log(`\n${alreadyBooked.length} slot(s) already had a real booking and were left alone:`);
  alreadyBooked.forEach(line => console.log('  - ' + line));
}

if (missing.length) {
  console.log(`\n${missing.length} slot(s) couldn't be found at all (check day labels / times):`);
  missing.forEach(line => console.log('  - ' + line));
}

console.log('\nDone.');
