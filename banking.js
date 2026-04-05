// services/banking.js — Core banking engine with CBK routing
const db     = require('../config/database');
const sms    = require('./sms');
const logger = require('../config/logger');
const bcrypt = require('bcryptjs');

// ── Helpers ────────────────────────────────────────────────
async function genAccountNumber() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let no, exists;
  do {
    no     = 'CBK-' + Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
    exists = (await db.query('SELECT id FROM accounts WHERE account_number=$1', [no])).rows.length > 0;
  } while (exists);
  return no;
}

function genTxRef() {
  return 'TXN' + Date.now().toString().slice(-8) + Math.random().toString(36).substr(2, 4).toUpperCase();
}

// ── CREATE ACCOUNT ─────────────────────────────────────────
async function createAccount({ fullName, nationalId, phoneNumber, accountType, bankId, pin, openingBalance = 0, createdVia = 'admin' }) {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    const bankRes = await client.query('SELECT * FROM local_banks WHERE id=$1 AND is_active=TRUE', [bankId]);
    if (!bankRes.rows.length) throw new Error('Bank not found or inactive');
    const bank = bankRes.rows[0];

    const dup = await client.query('SELECT id FROM accounts WHERE national_id=$1 AND bank_id=$2', [nationalId, bankId]);
    if (dup.rows.length) throw new Error('Account with this ID already exists at ' + bank.bank_name);

    const accountNumber = await genAccountNumber();
    const pinHash       = await bcrypt.hash(pin, 12);

    const acctRes = await client.query(
      `INSERT INTO accounts (account_number,full_name,national_id,phone_number,account_type,balance,bank_id,pin_hash,created_via)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [accountNumber, fullName, nationalId, phoneNumber, accountType, openingBalance, bankId, pinHash, createdVia]);
    const account = acctRes.rows[0];

    if (openingBalance > 0) {
      const txRef = genTxRef();
      await client.query(
        `INSERT INTO transactions (tx_reference,account_id,bank_id,tx_type,amount,fee,balance_before,balance_after,description,channel,status,cbk_settled_at,completed_at)
         VALUES ($1,$2,$3,'deposit',$4,0,0,$5,'Opening balance',$6,'completed',NOW(),NOW())`,
        [txRef, account.id, bankId, openingBalance, openingBalance, createdVia]);
      await client.query('UPDATE local_banks SET current_balance=current_balance+$1 WHERE id=$2', [openingBalance, bankId]);
      await client.query('UPDATE cbk_reserve SET balance=balance+$1,updated_at=NOW()', [openingBalance]);
    }

    await client.query(
      `INSERT INTO audit_log (action,entity_type,entity_id,performed_by,details)
       VALUES ('account_created','account',$1,$2,$3)`,
      [account.id, createdVia, JSON.stringify({ accountNumber, bankName: bank.bank_name, accountType })]);

    await client.query('COMMIT');

    // SMS confirmation
    const msg    = sms.templates.accountCreated(fullName, accountNumber, bank.bank_name, accountType);
    const smsRes = await sms.send(phoneNumber, msg);
    await db.query(
      `INSERT INTO sms_log (phone_number,message,message_type,account_id,provider_msg_id,status)
       VALUES ($1,$2,'account_created',$3,$4,$5)`,
      [phoneNumber, msg, account.id, smsRes.messageId || null, smsRes.success ? 'sent' : 'failed']);

    logger.info('Account created', { accountNumber, bank: bank.bank_name, via: createdVia });
    return { success: true, account: { ...account, bankName: bank.bank_name, bankCode: bank.bank_code } };
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('Account creation failed', { error: err.message });
    throw err;
  } finally {
    client.release();
  }
}

// ── PROCESS TRANSACTION (CBK ROUTING) ─────────────────────
async function processTransaction({ accountId, txType, amount, description = '', channel = 'admin' }) {
  if (!amount || amount <= 0) throw new Error('Invalid amount');

  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    // Lock account row
    const acctRes = await client.query(
      `SELECT a.*,b.bank_name,b.bank_code,b.id AS bid
       FROM accounts a JOIN local_banks b ON a.bank_id=b.id
       WHERE a.id=$1 AND a.is_active=TRUE AND a.is_blocked=FALSE FOR UPDATE`,
      [accountId]);
    if (!acctRes.rows.length) throw new Error('Account not found, inactive, or blocked');
    const a   = acctRes.rows[0];
    const bal = parseFloat(a.balance);

    const minBal    = parseFloat(process.env.CBK_MIN_BALANCE || 100);
    const maxSingle = parseFloat(process.env.CBK_MAX_SINGLE_TRANSACTION || 1000000);
    const maxDaily  = parseFloat(process.env.CBK_MAX_DAILY_WITHDRAWAL || 500000);
    const feePct    = parseFloat(process.env.CBK_TRANSACTION_FEE_PERCENT || 0.5);

    if (txType === 'withdrawal') {
      if (bal - amount < minBal) throw new Error(`Insufficient balance. Min balance KSh ${minBal}`);
      if (amount > maxSingle)   throw new Error(`Exceeds single transaction limit KSh ${maxSingle.toLocaleString()}`);
      const todayRes = await client.query(
        `SELECT COALESCE(SUM(amount),0) AS tot FROM transactions
         WHERE account_id=$1 AND tx_type='withdrawal' AND status='completed' AND created_at>=CURRENT_DATE`,
        [accountId]);
      if (parseFloat(todayRes.rows[0].tot) + amount > maxDaily)
        throw new Error(`Daily withdrawal limit KSh ${maxDaily.toLocaleString()} exceeded`);
    }

    const fee         = txType === 'withdrawal' ? Math.round(amount * feePct / 100 * 100) / 100 : 0;
    const balAfter    = txType === 'deposit' ? bal + amount : bal - amount - fee;
    const txRef       = genTxRef();

    // ① Insert pending transaction
    const txRes = await client.query(
      `INSERT INTO transactions (tx_reference,account_id,bank_id,tx_type,amount,fee,balance_before,balance_after,description,channel,status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending') RETURNING *`,
      [txRef, accountId, a.bid, txType, amount, fee, bal, balAfter, description || txType, channel]);

    logger.info('CBK routing', { txRef, txType, amount, route: `${txType==='deposit'?'→':'←'}CBK→${a.bank_code}` });

    // ② Update balances
    await client.query('UPDATE accounts SET balance=$1,updated_at=NOW() WHERE id=$2', [balAfter, accountId]);
    if (txType === 'deposit') {
      await client.query('UPDATE local_banks SET current_balance=current_balance+$1 WHERE id=$2', [amount, a.bid]);
      await client.query('UPDATE cbk_reserve SET balance=balance+$1,updated_at=NOW()', [amount]);
    } else {
      await client.query('UPDATE local_banks SET current_balance=current_balance-$1 WHERE id=$2', [amount + fee, a.bid]);
      await client.query('UPDATE cbk_reserve SET balance=balance-$1,updated_at=NOW()', [amount]);
    }

    // ③ Settle
    await client.query(
      `UPDATE transactions SET status='completed',cbk_routed=TRUE,cbk_settled_at=NOW(),completed_at=NOW() WHERE id=$1`,
      [txRes.rows[0].id]);

    await client.query(
      `INSERT INTO audit_log (action,entity_type,entity_id,performed_by,details) VALUES ($1,'transaction',$2,$3,$4)`,
      [`transaction_${txType}`, txRes.rows[0].id, channel,
       JSON.stringify({ txRef, amount, fee, balBefore: bal, balAfter, bank: a.bank_code })]);

    await client.query('COMMIT');

    // ④ SMS confirmation
    const msg = txType === 'deposit'
      ? sms.templates.depositConfirm(a.full_name, a.account_number, amount, txRef, balAfter, a.bank_code)
      : sms.templates.withdrawalConfirm(a.full_name, a.account_number, amount, txRef, balAfter, a.bank_code);
    const smsRes = await sms.send(a.phone_number, msg);
    await db.query(
      `INSERT INTO sms_log (phone_number,message,message_type,account_id,tx_reference,provider_msg_id,status)
       VALUES ($1,$2,'tx_confirm',$3,$4,$5,$6)`,
      [a.phone_number, msg, accountId, txRef, smsRes.messageId || null, smsRes.success ? 'sent' : 'failed']);

    // Low balance alert
    if (balAfter < minBal * 3)
      await sms.send(a.phone_number, sms.templates.lowBalance(a.full_name, a.account_number, balAfter, minBal));

    logger.info('Transaction settled', { txRef, txType, amount, account: a.account_number });
    return {
      success: true,
      transaction: { reference: txRef, type: txType, amount, fee, balanceBefore: bal, balanceAfter: balAfter, channel, cbkRouted: true },
      account:     { accountNumber: a.account_number, name: a.full_name, bank: a.bank_name, newBalance: balAfter },
    };
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('Transaction failed', { error: err.message });
    throw err;
  } finally {
    client.release();
  }
}

// ── LOOKUP HELPERS ─────────────────────────────────────────
async function getByNumber(accountNumber) {
  const r = await db.query(
    'SELECT a.*,b.bank_name,b.bank_code,b.region FROM accounts a JOIN local_banks b ON a.bank_id=b.id WHERE a.account_number=$1',
    [accountNumber]);
  return r.rows[0] || null;
}

async function verifyPin(accountId, pin) {
  const r = await db.query('SELECT pin_hash,pin_attempts,is_blocked FROM accounts WHERE id=$1', [accountId]);
  if (!r.rows.length) return { valid: false, reason: 'Account not found' };
  const { pin_hash, pin_attempts, is_blocked } = r.rows[0];
  if (is_blocked) return { valid: false, reason: 'Account blocked — too many wrong PINs' };
  const valid = await bcrypt.compare(pin, pin_hash);
  if (!valid) {
    const attempts = pin_attempts + 1;
    const blocked  = attempts >= 3;
    await db.query('UPDATE accounts SET pin_attempts=$1,is_blocked=$2 WHERE id=$3', [attempts, blocked, accountId]);
    return { valid: false, reason: blocked ? 'Account blocked after 3 failed attempts' : 'Incorrect PIN' };
  }
  await db.query('UPDATE accounts SET pin_attempts=0 WHERE id=$1', [accountId]);
  return { valid: true };
}

async function getMiniStatement(accountId) {
  const r = await db.query(
    `SELECT tx_reference,tx_type,amount,fee,balance_after,description,created_at FROM transactions
     WHERE account_id=$1 AND status='completed' ORDER BY created_at DESC LIMIT 5`,
    [accountId]);
  return r.rows;
}

module.exports = { createAccount, processTransaction, getByNumber, verifyPin, getMiniStatement, genTxRef };
