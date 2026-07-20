const crypto = require('crypto');

function verifyToken(token) {
  if (!token) return null;
  const parts = token.split(':');
  if (parts.length !== 3) return null;
  const [role, id, sig] = parts;
  const expected = crypto.createHmac('sha256', process.env.SOCKET_SECRET).update(`${role}:${id}`).digest('hex');
  if (sig !== expected) return null;
  return { role, id };
}

function initSockets(io) {
  io.on('connection', (socket) => {
    socket.on('join', (token) => {
      const identity = verifyToken(token);
      if (!identity) return; // silently ignore bad/forged tokens
      socket.join(`${identity.role}:${identity.id}`);
    });
  });
}

module.exports = { initSockets };
