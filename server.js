// server.js — CBK Banking System (Unified: Frontend + API)
require('dotenv').config();

const express    = require('express');
const helmet     = require('helmet');
const cors       = require('cors');
const morgan     = require('morgan');
const rateLimit  = require('express-rate-limit');
const path       = require('path');
const logger     = require('./config/logger');
const apiRoutes  = require('./routes/api');

const app = express();

// ── Security ───────────────────────────────────────────────
app.use(helmet({
  // Allow inline scripts & styles for the dashboard HTML
  contentSecurityPolicy: {
    directives: {
      defaultSrc:  ["'self'"],
      scriptSrc:   ["'self'", "'unsafe-inline'", 'fonts.googleapis.com'],
      styleSrc:    ["'self'", "'unsafe-inline'", 'fonts.googleapis.com', 'fonts.gstatic.com'],
      fontSrc:     ["'self'", 'fonts.gstatic.com'],
      connectSrc:  ["'self'"],
      imgSrc:      ["'self'", 'data:'],
    },
  },
}));

app.use(cors({ origin: process.env.ALLOWED_ORIGINS?.split(',') || '*', methods: ['GET','POST','PUT','PATCH','DELETE'] }));
app.set('trust proxy', 1);

// ── Rate limiting ──────────────────────────────────────────
app.use('/api/auth/login', rateLimit({ windowMs: 15*60*1000, max: 10, message: { success:false, error:'Too many login attempts.' } }));
app.use('/api/ussd', rateLimit({ windowMs: 60*1000, max: 60, message: 'END Rate limit exceeded' }));
app.use('/api', rateLimit({ windowMs: 15*60*1000, max: 300, message: { success:false, error:'Too many requests.' } }));

// ── Middleware ─────────────────────────────────────────────
app.use(morgan('combined', { stream: { write: msg => logger.info(msg.trim()) } }));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));   // Required for USSD form-encoded callbacks

// ── Serve static frontend from /public ────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ── API routes ─────────────────────────────────────────────
app.use('/api', apiRoutes);

// ── Health check ───────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'CBK Banking System', version: '2.1.0', timestamp: new Date().toISOString() });
});

// ── All other routes → serve dashboard SPA ────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Error handler ──────────────────────────────────────────
app.use((err, req, res, next) => {
  logger.error('Unhandled error', { error: err.message, path: req.path });
  res.status(500).json({ success: false, error: 'Internal server error' });
});

// ── Start ──────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  logger.info('CBK Banking System started', { port: PORT, env: process.env.NODE_ENV });
  console.log(`
  ╔══════════════════════════════════════════════════════════╗
  ║         CBK BANKING SYSTEM v2.1  —  RUNNING             ║
  ╠══════════════════════════════════════════════════════════╣
  ║  Dashboard:  http://localhost:${PORT}                      ║
  ║  API:        http://localhost:${PORT}/api                  ║
  ║  Health:     http://localhost:${PORT}/health               ║
  ║  USSD Code:  ${(process.env.AT_USSD_CODE || '*384*1#').padEnd(44)} ║
  ╚══════════════════════════════════════════════════════════╝
  `);
});

module.exports = app;
