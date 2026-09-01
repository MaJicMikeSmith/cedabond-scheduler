require('dotenv').config();
const path = require('path');
const express = require('express');
const session = require('express-session');
const BetterSqlite3Store = require('better-sqlite3-session-store')(session);
const http = require('http');
const { Server } = require('socket.io');

const db = require('./db');
const { requirePageRole } = require('./middleware/requireAuth');
const { attachSocketServer } = require('./lib/sync');
const { initSockets } = require('./sockets');

const app = express();

// Render terminates HTTPS for us and forwards plain HTTP internally - without
// this, Express doesn't realise the original connection was secure, so it
// refuses to set the "secure" session cookie below, and logins silently fail.
app.set('trust proxy', 1);

const server = http.createServer(app);
const io = new Server(server);
attachSocketServer(io);
initSockets(io);

app.use(express.json());
app.use(session({
  // Stored in the same SQLite database (on the persistent disk) rather than
  // in memory - a server restart mid-event no longer logs everyone out.
  store: new BetterSqlite3Store({
    client: db,
    expired: { clear: true, intervalMs: 15 * 60 * 1000 } // sweep expired sessions every 15 min
  }),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production' }
}));

// API routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/filemaker', require('./routes/filemaker'));
app.use('/api/supplier', require('./routes/supplier'));
app.use('/api/member', require('./routes/member'));
app.use('/api/admin', require('./routes/admin'));

// Gate the portal pages themselves behind login (the JS/CSS assets used by both
// portals stay public so the pages can actually render before/while checking auth).
// Both suppliers and members now log in with one shared company-level password -
// no self-service registration flow, everything is set up via FileMaker.
app.use('/supplier', requirePageRole('supplier'), express.static(path.join(__dirname, 'public/supplier')));
app.use('/member', requirePageRole('member'), express.static(path.join(__dirname, 'public/member')));
app.use('/admin', requirePageRole('admin'), express.static(path.join(__dirname, 'public/admin')));
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Cedabond scheduler running on port ${PORT}`));
