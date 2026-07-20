function requireApiKey(req, res, next) {
  const key = req.header('X-API-Key');
  if (!key || key !== process.env.FM_API_KEY) {
    return res.status(401).json({ error: 'Invalid or missing X-API-Key header' });
  }
  next();
}

module.exports = { requireApiKey };
