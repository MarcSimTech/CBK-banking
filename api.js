// routes/api.js — All API endpoints
const express = require('express');
const router  = express.Router();
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const Joi     = require('joi');
const db      = require('../config/database');
const banking = require('../services/banking');
const { handleUSSD } = require('../services/ussd');
const { requireAdmin, validateUSSDSource } = require('../middleware/auth');
const logger  = require('../config/logger');

const validate = schema => (req, res, next) => {
  const { error } = schema.validate(req.body, { abortEarly: false });
  if (error) return res.status(400).json({ success: false, errors: error.details.map(d => d.message) });
  next();
};

// ═══════════════════════════════════════════════════════════
//  AUTH
// ═══════════════════════════════════════════════════════════

router.post('/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password)
      return res.status(400).json({ success: false, error: 'Username and password required' });
    const r = await db.query('SELECT * FROM admin_users WHERE username=$1 AND is_active=TRUE', [username]);
    if (!r.rows.length || !(await bcrypt.compare(password, r.rows[0].password)))
      return res.status(401).json({ success: false, error: 'Invalid credentials' });
    const admin = r.rows[0];
    await db.query('UPDATE admin_users SET last_login=NOW() WHERE id=$1', [admin.id]);
    const token = jwt.sign({ id: admin.id, username: admin.username, role: admin.role }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || '8h' });
    await db.query(`INSERT INTO audit_log (action,performed_by,details) VALUES ('admin_login',$1,$2)`, [username, JSON.stringify({ ip: req.ip })]);
    logger.info('Admin login', { username, ip: req.ip });
    res.json({ success: true, token, admin: { id: admin.id, username: admin.username, fullName: admin.full_name, role: admin.role } });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.get('/auth/me', requireAdmin, (req, res) => res.json({ success: true, admin: req.admin }));

// ═══════════════════════════════════════════════════════════
//  BANKS
// ═══════════════════════════════════════════════════════════

const bankSchema = Joi.object({
  bankName: Joi.string().min(2).max(100).required(),
  bankCode: Joi.string().alphanum().min(2).max(10).required(),
  region: Joi.string().min(2).max(50).required(),
  cbkAllocation: Joi.number().min(0).default(0),
  swiftCode: Joi.string().optional().allow(''),
});

router.post('/banks', requireAdmin, validate(bankSchema), async (req, res) => {
  try {
    const { bankName, bankCode, region, cbkAllocation, swiftCode } = req.body;
    const code = bankCode.toUpperCase();
    const ex   = await db.query('SELECT id FROM local_banks WHERE bank_code=$1', [code]);
    if (ex.rows.length) return res.status(409).json({ success: false, error: 'Bank code already registered' });
    const r = await db.query(
      `INSERT INTO local_banks (bank_name,bank_code,region,cbk_allocation,current_balance,swift_code,created_by)
       VALUES ($1,$2,$3,$4,$4,$5,$6) RETURNING *`,
      [bankName, code, region, cbkAllocation || 0, swiftCode || null, req.admin.id]);
    if (cbkAllocation > 0)
      await db.query('UPDATE cbk_reserve SET balance=balance+$1,updated_at=NOW()', [cbkAllocation]);
    await db.query(`INSERT INTO audit_log (action,entity_type,entity_id,performed_by,details) VALUES ('bank_registered','bank',$1,$2,$3)`,
      [r.rows[0].id, req.admin.username, JSON.stringify({ bankName, bankCode: code, region })]);
    logger.info('Bank registered', { bankName, bankCode: code });
    res.status(201).json({ success: true, bank: r.rows[0] });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.get('/banks', requireAdmin, async (req, res) => {
  try {
    const r = await db.query(`SELECT b.*,COUNT(a.id) AS account_count FROM local_banks b LEFT JOIN accounts a ON a.bank_id=b.id GROUP BY b.id ORDER BY b.bank_name`);
    res.json({ success: true, banks: r.rows });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.get('/banks/:id', requireAdmin, async (req, res) => {
  try {
    const r = await db.query('SELECT * FROM local_banks WHERE id=$1', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ success: false, error: 'Bank not found' });
    res.json({ success: true, bank: r.rows[0] });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ═══════════════════════════════════════════════════════════
//  ACCOUNTS
// ═══════════════════════════════════════════════════════════

const accountSchema = Joi.object({
  fullName: Joi.string().min(2).max(100).required(),
  nationalId: Joi.string().min(4).max(20).required(),
  phoneNumber: Joi.string().pattern(/^(\+?254|0)[17]\d{8}$/).required().messages({ 'string.pattern.base': 'Invalid Kenyan phone number (must start with 07x or 01x)' }),
  accountType: Joi.string().valid('Savings', 'Current', 'Fixed Deposit').required(),
  bankId: Joi.string().uuid().required(),
  pin: Joi.string().pattern(/^\d{4}$/).required().messages({ 'string.pattern.base': 'PIN must be exactly 4 digits' }),
  openingBalance: Joi.number().min(0).default(0),
});

router.post('/accounts', requireAdmin, validate(accountSchema), async (req, res) => {
  try {
    const result = await banking.createAccount({ ...req.body, createdVia: 'admin' });
    res.status(201).json(result);
  } catch (err) { res.status(400).json({ success: false, error: err.message }); }
});

router.get('/accounts', requireAdmin, async (req, res) => {
  try {
    const { bankId, search, page = 1, limit = 100 } = req.query;
    const offset = (page - 1) * limit;
    const params = []; let where = 'WHERE 1=1';
    if (bankId) { params.push(bankId); where += ` AND a.bank_id=$${params.length}`; }
    if (search) { params.push(`%${search}%`); where += ` AND (a.full_name ILIKE $${params.length} OR a.account_number ILIKE $${params.length} OR a.phone_number ILIKE $${params.length})`; }
    params.push(limit, offset);
    const r = await db.query(
      `SELECT a.id,a.account_number,a.full_name,a.phone_number,a.account_type,a.balance,a.is_active,a.is_blocked,a.created_via,a.created_at,b.bank_name,b.bank_code,b.region
       FROM accounts a JOIN local_banks b ON a.bank_id=b.id ${where} ORDER BY a.created_at DESC LIMIT $${params.length-1} OFFSET $${params.length}`, params);
    const ct = await db.query(`SELECT COUNT(*) FROM accounts a ${where}`, params.slice(0,-2));
    res.json({ success: true, accounts: r.rows, total: parseInt(ct.rows[0].count) });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.get('/accounts/:accountNumber', requireAdmin, async (req, res) => {
  try {
    const account = await banking.getByNumber(req.params.accountNumber.toUpperCase());
    if (!account) return res.status(404).json({ success: false, error: 'Account not found' });
    res.json({ success: true, account });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.patch('/accounts/:id/block', requireAdmin, async (req, res) => {
  try {
    const blocked = !!req.body.blocked;
    await db.query('UPDATE accounts SET is_blocked=$1 WHERE id=$2', [blocked, req.params.id]);
    await db.query(`INSERT INTO audit_log (action,entity_type,entity_id,performed_by) VALUES ($1,'account',$2,$3)`,
      [blocked ? 'account_blocked' : 'account_unblocked', req.params.id, req.admin.username]);
    res.json({ success: true, message: `Account ${blocked ? 'blocked' : 'unblocked'}` });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ═══════════════════════════════════════════════════════════
//  TRANSACTIONS
// ═══════════════════════════════════════════════════════════

const txSchema = Joi.object({
  accountNumber: Joi.string().required(),
  type: Joi.string().valid('deposit', 'withdrawal').required(),
  amount: Joi.number().positive().max(1000000).required(),
  description: Joi.string().max(200).default('Admin transaction'),
});

router.post('/transactions', requireAdmin, validate(txSchema), async (req, res) => {
  try {
    const { accountNumber, type, amount, description } = req.body;
    const account = await banking.getByNumber(accountNumber.toUpperCase());
    if (!account) return res.status(404).json({ success: false, error: 'Account not found' });
    const result  = await banking.processTransaction({ accountId: account.id, txType: type, amount: parseFloat(amount), description, channel: 'admin' });
    res.json(result);
  } catch (err) { res.status(400).json({ success: false, error: err.message }); }
});

router.get('/transactions', requireAdmin, async (req, res) => {
  try {
    const { accountId, bankId, type, page = 1, limit = 100 } = req.query;
    const offset = (page - 1) * limit;
    const params = []; let where = `WHERE t.status='completed'`;
    if (accountId) { params.push(accountId); where += ` AND t.account_id=$${params.length}`; }
    if (bankId)    { params.push(bankId);    where += ` AND t.bank_id=$${params.length}`; }
    if (type)      { params.push(type);      where += ` AND t.tx_type=$${params.length}`; }
    params.push(limit, offset);
    const r = await db.query(
      `SELECT t.*,a.account_number,a.full_name,a.phone_number,b.bank_name,b.bank_code
       FROM transactions t JOIN accounts a ON t.account_id=a.id JOIN local_banks b ON t.bank_id=b.id
       ${where} ORDER BY t.created_at DESC LIMIT $${params.length-1} OFFSET $${params.length}`, params);
    res.json({ success: true, transactions: r.rows });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ═══════════════════════════════════════════════════════════
//  DASHBOARD
// ═══════════════════════════════════════════════════════════

router.get('/dashboard', requireAdmin, async (req, res) => {
  try {
    const [banks, accounts, txToday, reserve, recentTx] = await Promise.all([
      db.query('SELECT COUNT(*) FROM local_banks WHERE is_active=TRUE'),
      db.query('SELECT COUNT(*) FROM accounts WHERE is_active=TRUE'),
      db.query(`SELECT COUNT(*) AS count,COALESCE(SUM(amount),0) AS volume FROM transactions WHERE status='completed' AND created_at>=CURRENT_DATE`),
      db.query('SELECT balance FROM cbk_reserve LIMIT 1'),
      db.query(`SELECT t.tx_reference,t.tx_type,t.amount,t.created_at,a.full_name,a.account_number,b.bank_name,b.bank_code
                FROM transactions t JOIN accounts a ON t.account_id=a.id JOIN local_banks b ON t.bank_id=b.id
                WHERE t.status='completed' ORDER BY t.created_at DESC LIMIT 10`),
    ]);
    res.json({
      success: true,
      stats: {
        totalBanks:    parseInt(banks.rows[0].count),
        totalAccounts: parseInt(accounts.rows[0].count),
        txToday:       parseInt(txToday.rows[0].count),
        txVolumeToday: parseFloat(txToday.rows[0].volume),
        cbkReserve:    parseFloat(reserve.rows[0]?.balance || 0),
      },
      recentTransactions: recentTx.rows,
    });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ═══════════════════════════════════════════════════════════
//  LOGS
// ═══════════════════════════════════════════════════════════

router.get('/audit-log', requireAdmin, async (req, res) => {
  try {
    const r = await db.query('SELECT * FROM audit_log ORDER BY created_at DESC LIMIT 200');
    res.json({ success: true, log: r.rows });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.get('/sms-log', requireAdmin, async (req, res) => {
  try {
    const r = await db.query('SELECT * FROM sms_log ORDER BY sent_at DESC LIMIT 200');
    res.json({ success: true, messages: r.rows });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.get('/ussd-sessions', requireAdmin, async (req, res) => {
  try {
    const r = await db.query('SELECT * FROM ussd_sessions ORDER BY started_at DESC LIMIT 100');
    res.json({ success: true, sessions: r.rows });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ═══════════════════════════════════════════════════════════
//  USSD CALLBACK (Africa's Talking → POST here)
// ═══════════════════════════════════════════════════════════

router.post('/ussd/callback', validateUSSDSource, async (req, res) => {
  try {
    const { sessionId, phoneNumber, text } = req.body;
    if (!sessionId || !phoneNumber)
      return res.status(400).send('END Invalid request');
    const response = await handleUSSD({ sessionId, phoneNumber, text: text || '' });
    res.set('Content-Type', 'text/plain');
    res.send(response);
  } catch (err) {
    logger.error('USSD callback error', { error: err.message });
    res.set('Content-Type', 'text/plain');
    res.send('END System error. Dial *384*1# again.');
  }
});

module.exports = router;
