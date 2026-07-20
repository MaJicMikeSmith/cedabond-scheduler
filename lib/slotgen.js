const db = require('../db');

function toMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

function toHHMM(mins) {
  const h = String(Math.floor(mins / 60)).padStart(2, '0');
  const m = String(mins % 60).padStart(2, '0');
  return `${h}:${m}`;
}

/**
 * Creates any missing slot rows for a supplier across all known exhibition days.
 * Safe to call repeatedly (idempotent) - existing slots are left untouched so that
 * bookings/blocks already made are never wiped out by a re-push from FileMaker.
 */
function ensureSlotsForSupplier(supplierId) {
  const days = db.prepare('SELECT * FROM exhibition_days').all();
  const insert = db.prepare(`
    INSERT OR IGNORE INTO slots (supplier_id, day_id, start_time, end_time, status)
    VALUES (?, ?, ?, ?, 'available')
  `);

  for (const day of days) {
    const start = toMinutes(day.start_time);
    const end = toMinutes(day.end_time);
    const step = day.slot_minutes || 20;
    for (let t = start; t + step <= end; t += step) {
      insert.run(supplierId, day.id, toHHMM(t), toHHMM(t + step));
    }
  }
}

/** Re-generates slots for every supplier - used after exhibition day config changes. */
function ensureSlotsForAllSuppliers() {
  const suppliers = db.prepare('SELECT id FROM suppliers').all();
  for (const s of suppliers) ensureSlotsForSupplier(s.id);
}

module.exports = { ensureSlotsForSupplier, ensureSlotsForAllSuppliers, toMinutes, toHHMM };
