# Cedabond Exhibition Scheduler

A small web app for the Cedabond exhibition: suppliers request meetings with
members, members book 20-minute slots (against a request or ad-hoc), and the
whole thing stays in sync with the FileMaker solution that owns the master data.

**Stack:** Node.js + Express + SQLite (single file, no separate database server)
+ Socket.io (live updates pushed to open browser tabs). Chosen so the whole app
is one process you can host almost anywhere, with no DevOps overhead.

---

## 1. Local setup (do this first, to try it before going anywhere near hosting)

```bash
npm install
cp .env.example .env        # then edit .env - see "Configuration" below
npm run seed-demo           # creates 2 exhibition days, 3 demo suppliers, 4 demo members
npm start
```

Open `http://localhost:3000/login.html`. All demo accounts use the password
`password123` (the seed script prints the email addresses to use).

Note: this container couldn't reach the npm registry to install packages for
you, so dependencies haven't been verified by actually running the server here
— only checked for valid JavaScript syntax. Run the steps above on your own
machine first.

## 2. Configuration (`.env`)

| Variable | Purpose |
|---|---|
| `PORT` | Port the app listens on |
| `APP_BASE_URL` | Public URL of the app — used in emailed links, so it must match wherever it ends up hosted |
| `SESSION_SECRET` | Random string, signs login session cookies |
| `FM_API_KEY` | Shared secret FileMaker must send as the `X-API-Key` header on every call |
| `SOCKET_SECRET` | Random string, signs the short-lived token that authorises a browser tab's live-update connection |
| `SMTP_*` | Outgoing email for setup links and notifications. Leave blank during testing — emails are printed to the server log instead of sent |

Generate random secrets with, e.g.: `node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"`

## 3. Where to host it

You don't need a full server you manage yourself. A platform-as-a-service that
runs Node.js apps and gives you a **persistent disk** (so the SQLite file
survives restarts/deploys) is the simplest fit — e.g. **Render.com** or
**Railway.app**. Both:
- deploy straight from a Git repo (push this folder to GitHub, connect it)
- handle HTTPS automatically (important — FileMaker and the portals both need it)
- let you set the `.env` values above as dashboard "environment variables"
- support Web Sockets out of the box (needed for the live updates)

Steps for Render specifically:
1. Push this project to a GitHub repo.
2. Render → New → Web Service → connect the repo.
3. Build command: `npm install`. Start command: `npm start`.
4. Add a **disk** (e.g. 1GB) mounted at `/data`, and set `DB_PATH=/data/cedabond.db`
   as an environment variable so the database lives on the persistent disk.
5. Add the rest of the `.env` variables under Environment.
6. Deploy. Set `APP_BASE_URL` to the `https://...onrender.com` URL Render gives you
   (or your own domain once pointed at it).

If a smaller budget shared-host (PHP/MySQL only, no Node.js) turns out to be the
only thing available, the recommendation above doesn't apply directly — flag
that to CharDanIT and the data layer/Express layer would need rebuilding for
that environment rather than just redeployed.

## 4. FileMaker integration

All FileMaker calls go to `https://your-app-url/api/filemaker/...` with header
`X-API-Key: <the FM_API_KEY value>` and `Content-Type: application/json`,
using FileMaker's **Insert from URL** script step with `cURL options` set to
`-X POST` (or `-X GET` for the pull endpoint) plus the header and body.

### Push: exhibition days (run once when the exhibition dates/hours are set)
`POST /api/filemaker/exhibition-days`
```json
{ "days": [
  { "external_id": "DAY1", "label": "Day 1", "date": "2026-09-09", "start_time": "09:00", "end_time": "17:00", "slot_minutes": 20 },
  { "external_id": "DAY2", "label": "Day 2", "date": "2026-09-10", "start_time": "09:00", "end_time": "17:00", "slot_minutes": 20 }
]}
```
`external_id` should be the FileMaker record's primary key (as text) so it can
be matched again on re-push. Re-pushing is safe — existing rows are updated in
place, and slot generation only ever adds missing slots, never removes booked ones.

### Push: suppliers (run whenever supplier records are added/changed)
`POST /api/filemaker/suppliers`
```json
{ "suppliers": [
  { "external_id": "SUP047", "name": "Bright Catering Equipment", "email": "sales@brightcatering.example", "company": "Bright Catering Equipment Ltd" }
]}
```
A brand-new supplier (an `external_id` not seen before) gets a "set your
password" email automatically and their 20-minute slots are generated for both
days. Pushing the same `external_id` again just updates their details.

### Push: members
`POST /api/filemaker/members`
```json
{ "members": [
  { "external_id": "MBR0170", "name": "Alex Carter", "email": "alex@cartercatering.example",
    "company": "Carter Catering", "day_external_id": "DAY1", "window_start": "09:00", "window_end": "13:00" }
]}
```
`day_external_id` must match an `external_id` already pushed via the days
endpoint. A new member gets a setup email automatically.

### Pull: activity (run on a schedule, e.g. every 1–2 minutes via a FileMaker server schedule)
`GET /api/filemaker/activity?since=<last id you processed>`

Returns every booking, cancellation, request, and slot block/unblock since that
id, plus the new high-water mark to store and pass next time:
```json
{ "lastId": 482, "events": [
  { "id": 480, "type": "booking", "created_at": "2026-09-09 10:02:11", "booking_id": 12,
    "supplier_id": 3, "supplier_name": "Bright Catering Equipment",
    "member_id": 7, "member_name": "Alex Carter", "start_time": "10:20", "end_time": "10:40", "source": "request" },
  { "id": 481, "type": "cancellation", "...": "..." }
]}
```
A FileMaker script loops through `events`, matches `supplier_id`/`member_id`
back to FileMaker records by external id (or stores the web app's numeric id
directly in a mirror table — your call), and stores the new `lastId` in a
global field for next time.

### Resending a setup email
If an email bounces or a contact's inbox didn't get it, `GET
/api/filemaker/setup-links` (same `X-API-Key` header) returns every pending
member/supplier with their unused setup link, so staff can forward it manually.

## 5. What's deliberately simple right now (flag these as next steps)

- **Sessions** use Express's default in-memory store — fine for a single
  process, but logins won't survive a server restart/redeploy until swapped
  for a persistent store (a 10-minute change once you're on Postgres/Redis).
- **One database file** — entirely appropriate for ~170 members/80 suppliers
  over a 2-day event, but isn't designed to scale past a single server process.
- **No admin UI in the web app itself** — by design, all setup/admin happens
  in FileMaker as specified; the web app is push/pull-only on that side.
- **Email** needs a real SMTP account (e.g. a transactional email provider)
  wired into `.env` before go-live — currently logs to console if unset.
