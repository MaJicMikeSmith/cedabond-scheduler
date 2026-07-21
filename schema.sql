-- Exhibition days (Cedabond will normally push 2-4 rows: Day 1, Day 2...)
CREATE TABLE IF NOT EXISTS exhibition_days (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  external_id   TEXT UNIQUE,           -- FileMaker record id, for matching on re-push
  label         TEXT NOT NULL,         -- e.g. "Day 1"
  date          TEXT NOT NULL,         -- YYYY-MM-DD
  start_time    TEXT NOT NULL,         -- HH:MM, exhibition opens (e.g. 09:00)
  end_time      TEXT NOT NULL,         -- HH:MM, exhibition closes (e.g. 17:00)
  slot_minutes  INTEGER NOT NULL DEFAULT 20
);

-- Member COMPANIES. FileMaker pushes these. Each gets a durable, shareable
-- invite link (member external_id + invite_token) that any number of staff
-- at that company can use, at any time, to register themselves as attendees.
-- Members themselves do not log in - only their attendees do.
CREATE TABLE IF NOT EXISTS members (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  external_id   TEXT UNIQUE,
  name          TEXT NOT NULL,          -- primary contact name (informational)
  email         TEXT NOT NULL UNIQUE,   -- primary contact email (informational, gets heads-up notifications)
  company       TEXT,
  invite_token  TEXT UNIQUE,            -- durable - NOT cleared after use, unlike a setup_token
  created_at    TEXT DEFAULT (datetime('now')),
  updated_at    TEXT DEFAULT (datetime('now'))
);

-- Individual people attending the exhibition on behalf of a member company.
-- Each self-registers via the member's invite link, then sets their own
-- password (via a one-time setup_token) to book/manage their own meetings.
CREATE TABLE IF NOT EXISTS attendees (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id         INTEGER NOT NULL REFERENCES members(id),
  name              TEXT NOT NULL,
  job_description   TEXT,
  email             TEXT NOT NULL UNIQUE,
  phone             TEXT,
  arrival           TEXT,               -- optional, informational only (badges/catering) - does NOT restrict bookings
  departure         TEXT,               -- optional, informational only
  password_hash     TEXT,
  setup_token       TEXT,               -- one-time, cleared once their password is set
  created_at        TEXT DEFAULT (datetime('now')),
  updated_at        TEXT DEFAULT (datetime('now'))
);

-- Which exhibition day(s) each attendee is attending. An attendee can only
-- book slots on a day they're marked as attending.
CREATE TABLE IF NOT EXISTS attendee_days (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  attendee_id   INTEGER NOT NULL REFERENCES attendees(id),
  day_id        INTEGER NOT NULL REFERENCES exhibition_days(id),
  UNIQUE(attendee_id, day_id)
);

CREATE TABLE IF NOT EXISTS suppliers (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  external_id   TEXT UNIQUE,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,  -- primary contact email, used for booking/schedule notifications
  company       TEXT,
  password_hash TEXT,
  setup_token   TEXT,
  created_at    TEXT DEFAULT (datetime('now')),
  updated_at    TEXT DEFAULT (datetime('now'))
);

-- Any of these email addresses can log in to the supplier account with its one
-- shared password - low-stakes by design, so no per-person accounts needed.
-- Always includes the row from suppliers.email too (kept in sync on acknowledge).
CREATE TABLE IF NOT EXISTS supplier_emails (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  supplier_id   INTEGER NOT NULL REFERENCES suppliers(id),
  email         TEXT NOT NULL UNIQUE,
  created_at    TEXT DEFAULT (datetime('now'))
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

-- A supplier's expression of interest in meeting a MEMBER COMPANY (not a
-- named attendee) - visible to every attendee from that company, any of
-- whom may respond and book a slot to fulfil it.
CREATE TABLE IF NOT EXISTS meeting_requests (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  supplier_id   INTEGER NOT NULL REFERENCES suppliers(id),
  member_id     INTEGER NOT NULL REFERENCES members(id),
  status        TEXT NOT NULL DEFAULT 'pending', -- pending | booked | cancelled
  created_at    TEXT DEFAULT (datetime('now')),
  UNIQUE(supplier_id, member_id)
);

-- Bookings belong to an individual ATTENDEE, not the member company - each
-- person manages their own personal schedule of meetings.
CREATE TABLE IF NOT EXISTS bookings (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  slot_id       INTEGER NOT NULL REFERENCES slots(id),
  attendee_id   INTEGER NOT NULL REFERENCES attendees(id),
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
  entity_type   TEXT NOT NULL,   -- booking | cancellation | request | slot_block | slot_unblock | attendee_added
  payload       TEXT NOT NULL,   -- JSON blob, see lib/sync.js
  created_at    TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_slots_supplier_day ON slots(supplier_id, day_id);
CREATE INDEX IF NOT EXISTS idx_requests_member ON meeting_requests(member_id);
CREATE INDEX IF NOT EXISTS idx_bookings_attendee ON bookings(attendee_id);
CREATE INDEX IF NOT EXISTS idx_bookings_supplier ON bookings(supplier_id);
CREATE INDEX IF NOT EXISTS idx_attendees_member ON attendees(member_id);
CREATE INDEX IF NOT EXISTS idx_attendee_days_attendee ON attendee_days(attendee_id);
