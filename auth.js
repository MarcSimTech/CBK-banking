// middleware/auth.js
const jwt = require('jsonwebtoken');
const db  = require('../config/database');
const logger = require('../config/logger');

async function requireAdmin(req, res, next) {
  try {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer '))
      return res.status(401).json({ success: false, error: 'Authorization token required' });

    const token   = header.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const result  = await db.query(
      'SELECT id, username, full_name, role, is_active FROM admin_users WHERE id = $1', [decoded.id]);

    if (!result.rows.length || !result.rows[0].is_active)
      return res.status(401).json({ success: false, error: 'Admin account inactive' });

    req.admin = result.rows[0];
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError')
      return res.status(401).json({ success: false, error: 'Session expired. Please log in again.' });
    return res.status(401).json({ success: false, error: 'Invalid token' });
  }
}

function validateUSSDSource(req, res, next) {
  // In production: whitelist Africa's Talking IPs (196.201.214.0/24)
  // For development/testing, allow all
  if (process.env.NODE_ENV === 'production') {
    const allowedIPs = (process.env.AT_ALLOWED_IPS || '196.201.214,196.201.215').split(',');
    const clientIP   = req.ip || req.connection.remoteAddress || '';
    if (!allowedIPs.some(ip => clientIP.includes(ip.trim()))) {
      logger.warn('USSD from unauthorized IP', { ip: clientIP });
      return res.status(403).send('END Unauthorized');
    }
  }
  next();
}

module.exports = { requireAdmin, validateUSSDSource };
