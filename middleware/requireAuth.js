const db = require('../db');

function requireRole(role) {
  return (req, res, next) => {
    if (!req.session.user || req.session.user.role !== role) {
      return res.status(401).json({ error: 'Not logged in' });
    }
    next();
  };
}

/** For pages (not API calls) - redirect to login instead of returning JSON. */
function requirePageRole(role) {
  return (req, res, next) => {
    if (!req.session.user || req.session.user.role !== role) {
      return res.redirect('/login.html');
    }
    next();
  };
}

/** Blocks any write action (booking, request, blocking a slot, etc.) while
 *  admin has locked this member's/supplier's account. Read-only GET routes
 *  don't need this - only apply it to the routes that actually change data.
 *  Has no effect on admin sessions themselves. */
function requireNotLocked() {
  return (req, res, next) => {
    const { role, id } = req.session.user || {};
    if (role !== 'member' && role !== 'supplier') return next();
    const table = role === 'member' ? 'members' : 'suppliers';
    const record = db.prepare(`SELECT locked FROM ${table} WHERE id = ?`).get(id);
    if (record && record.locked) {
      return res.status(403).json({ error: 'Changes are not currently permitted on this account - please contact the organiser.' });
    }
    next();
  };
}

module.exports = { requireRole, requirePageRole, requireNotLocked };
