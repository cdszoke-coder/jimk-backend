const env = require('../config/env');

module.exports = function adminAuth(req, res, next) {
  const bearer = req.header('authorization') || '';
  const bearerToken = bearer.startsWith('Bearer ') ? bearer.slice(7).trim() : null;
  const provided = req.header('x-admin-key') || bearerToken || req.query.adminKey;
  if (!provided || provided !== env.adminApiKey) {
    return res.status(401).json({ error: 'Unauthorized admin request' });
  }
  next();
};