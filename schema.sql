-- Exhibition days (Cedabond will normally push 2 rows: Day 1 and Day 2)
CREATE TABLE IF NOT EXISTS exhibition_days (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  external_id   TEXT UNIQUE,           -- FileMaker record id, for matching on re-push
  label         TEXT NOT NULL,         -- e.g. "Day 1"
  date          TEXT NOT NULL,         -- YYYY-MM-DD
  start_time    TEXT NOT NULL,         -- HH:MM, exhibition opens (e.g. 09:00)
  end_time      TEXT NOT NULL,         -- HH:MM, exhibition closes (e.g. 17:00)
  slot_minutes  INTEGER NOT NULL DEFAULT 20
);

CREATE TABLE IF NOT EXISTS members (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  external_id   TEXT UNIQUE,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  company       TEXT,
  day_id        INTEGER REFERENCES exhibition_days(id),
  window_start  TEXT,                  -- HH:MM - member's own attendance hours that day
  window_end    TEXT,
  password_hash TEXT,
  setup_token   TEXT,
  created_at    TEXT DEFAULT (datetime('now')),
  updated_at    TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS suppliers (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  external_id   TEXT UNIQUE,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  company       TEXT,
  password_hash TEXT,
  setup_token   TEXT,
  created_at    TEXT DEFAULT (datetime('now')),
  updated_at    TEXT DEFAULT (datetime('now'))
);

-- One row per bookable 20-minute slot, per supplier, per day.
CREATE TABLE IF NOT EXISTS slots (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  supplier_id   INTEGER NOT NULL REFERENCES suppliers(id),
  day_id        INTEGER NOT NULL REFERENCES exhibition_days(id),
  start_time    TEXT NOT NULL,
  end_time      TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'available', -- available | blocked | booked
  UNIQUE(supplier_id, day_id, start_time)
);

-- A supplier's expression of interest in meeting a member, before any slot is booked.
CREATE TABLE IF NOT EXISTS meeting_requests (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  supplier_id   INTEGER NOT NULL REFERENCES suppliers(id),
  member_id     INTEGER NOT NULL REFERENCES members(id),
  status        TEXT NOT NULL DEFAULT 'pending', -- pending | booked | cancelled
  created_at    TEXT DEFAULT (datetime('now')),
  UNIQUE(supplier_id, member_id)
);

CREATE TABLE IF NOT EXISTS bookings (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  slot_id       INTEGER NOT NULL REFERENCES slots(id),
  member_id     INTEGER NOT NULL REFERENCES members(id),
  supplier_id   INTEGER NOT NULL REFERENCES suppliers(id),
  request_id    INTEGER REFERENCES meeting_requests(id),
  source        TEXT NOT NULL DEFAULT 'adhoc', -- adhoc | request
  created_at    TEXT DEFAULT (datetime('now')),
  cancelled_at  TEXT
);

-- Only one active (non-cancelled) booking per slot; cancelled bookings are kept
-- for history and must not block the slot from being booked again.
CREATE UNIQUE INDEX IF NOT EXISTS idx_bookings_active_slot ON bookings(slot_id) WHERE cancelled_at IS NULL;

-- Every change worth telling FileMaker about. FileMaker polls /api/filemaker/activity
-- and works through rows with id > last-seen-id.
CREATE TABLE IF NOT EXISTS sync_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type   TEXT NOT NULL,   -- booking | cancellation | request | slot_block | slot_unblock
  payload       TEXT NOT NULL,   -- JSON blob, see lib/sync.js
  created_at    TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_slots_supplier_day ON slots(supplier_id, day_id);
CREATE INDEX IF NOT EXISTS idx_requests_member ON meeting_requests(member_id);
CREATE INDEX IF NOT EXISTS idx_bookings_member ON bookings(member_id);
CREATE INDEX IF NOT EXISTS idx_bookings_supplier ON bookings(supplier_id);
