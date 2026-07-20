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

module.exports = { requireRole, requirePageRole };
