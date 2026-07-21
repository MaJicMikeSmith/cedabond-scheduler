const db = require('../db');

let io = null;
/** Called once from server.js after Socket.io is created. */
function attachSocketServer(socketServer) {
  io = socketServer;
}

const insertLog = db.prepare(`
  INSERT INTO sync_log (entity_type, payload) VALUES (?, ?)
`);

/**
 * Records an event for FileMaker's pull endpoint AND pushes it live to any
 * connected browser clients in the relevant supplier/member rooms.
 *
 * @param {string} entityType - booking | cancellation | request | slot_block | slot_unblock
 * @param {object} payload - plain JSON-serialisable details of the event
 * @param {object} rooms - { supplierId, memberId } - who should receive a live push
 */
function recordEvent(entityType, payload, rooms = {}) {
  insertLog.run(entityType, JSON.stringify(payload));

  if (io) {
    const message = { type: entityType, ...payload };
    if (rooms.supplierId) io.to(`supplier:${rooms.supplierId}`).emit('update', message);
    if (rooms.memberId) io.to(`company:${rooms.memberId}`).emit('update', message);
  }
}

module.exports = { attachSocketServer, recordEvent };
