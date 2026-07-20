require('dotenv').config();
const path = require('path');
const express = require('express');
const session = require('express-session');
const http = require('http');
const { Server } = require('socket.io');

const { requirePageRole } = require('./middleware/requireAuth');
const { attachSocketServer } = require('./lib/sync');
const { initSockets } = require('./sockets');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
attachSocketServer(io);
initSockets(io);

app.use(express.json());
app.use(session({
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

// Gate the portal pages themselves behind login (the JS/CSS assets used by both
// portals stay public so the pages can actually render before/while checking auth).
app.use('/supplier', requirePageRole('supplier'), express.static(path.join(__dirname, 'public/supplier')));
app.use('/member', requirePageRole('member'), express.static(path.join(__dirname, 'public/member')));
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Cedabond scheduler running on port ${PORT}`));
