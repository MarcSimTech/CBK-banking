// services/ussd.js — Africa's Talking USSD callback handler
const db      = require('../config/database');
const banking = require('./banking');
const sms     = require('./sms');
const logger  = require('../config/logger');
const bcrypt  = require('bcryptjs');

const CON = t => `CON ${t}`;
const END = t => `END ${t}`;
const fmt = n => Number(n).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ── Session store (DB-backed) ──────────────────────────────
async function saveSession(sid, phone, step, data) {
  await db.query(
    `INSERT INTO ussd_sessions (session_id,phone_number,current_step,session_data)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (session_id) DO UPDATE SET current_step=$3,session_data=$4,last_activity=NOW()`,
    [sid, phone, step, JSON.stringify(data)]);
}
async function getSession(sid) {
  const r = await db.query('SELECT * FROM ussd_sessions WHERE session_id=$1 AND is_active=TRUE', [sid]);
  return r.rows[0] || null;
}
async function updateSession(sid, data) {
  await db.query('UPDATE ussd_sessions SET session_data=$1,last_activity=NOW() WHERE session_id=$2', [JSON.stringify(data), sid]);
}
async function endSession(sid) {
  await db.query('UPDATE ussd_sessions SET is_active=FALSE,ended_at=NOW() WHERE session_id=$1', [sid]);
}

// ── Main USSD handler ──────────────────────────────────────
async function handleUSSD({ sessionId, phoneNumber, text }) {
  logger.info('USSD', { sessionId, phoneNumber, text: text || '(start)' });
  const inputs = text ? text.split('*') : [];
  const step   = inputs.length;

  try {
    // MAIN MENU
    if (step === 0 || !text) {
      await saveSession(sessionId, phoneNumber, 'main', {});
      return CON(`CBK BANKING SYSTEM\n─────────────────\n1. Check Balance\n2. Deposit\n3. Withdrawal\n4. Open Account\n5. Mini Statement\n6. Change PIN\n\n0. Exit`);
    }

    const c = inputs[0];
    if (c === '0') return END('Thank you for using CBK Banking.\nDial *384*1# anytime.');

    // ── 1. BALANCE ──────────────────────────────────────────
    if (c === '1') {
      if (step === 1) return CON('CHECK BALANCE\n\nEnter account number:');
      if (step === 2) {
        const acct = await banking.getByNumber(inputs[1].toUpperCase());
        if (!acct) return END('Account not found.\n\nDial *384*1# to try again.');
        await saveSession(sessionId, phoneNumber, 'bal_pin', { accountId: acct.id, acctNo: acct.account_number });
        return CON(`Account: ${acct.account_number}\nHolder: ${acct.full_name}\n\nEnter your 4-digit PIN:`);
      }
      if (step === 3) {
        const sess = await getSession(sessionId);
        if (!sess) return END('Session expired. Dial *384*1#');
        const pr = await banking.verifyPin(sess.session_data.accountId, inputs[2]);
        if (!pr.valid) return END(`❌ ${pr.reason}\n\nDial *384*1# to retry.`);
        const r = await db.query('SELECT a.*,b.bank_name FROM accounts a JOIN local_banks b ON a.bank_id=b.id WHERE a.id=$1', [sess.session_data.accountId]);
        const a = r.rows[0];
        await endSession(sessionId);
        return END(`BALANCE ENQUIRY\n─────────────────\nAccount: ${a.account_number}\nName: ${a.full_name}\nBank: ${a.bank_name}\nType: ${a.account_type}\n\nBalance: KSh ${fmt(a.balance)}\n\nDial *384*1# for more.`);
      }
    }

    // ── 2. DEPOSIT ──────────────────────────────────────────
    if (c === '2') {
      if (step === 1) return CON('DEPOSIT\n\nEnter account number:');
      if (step === 2) {
        const acct = await banking.getByNumber(inputs[1].toUpperCase());
        if (!acct) return END('Account not found. Dial *384*1#');
        await saveSession(sessionId, phoneNumber, 'dep_pin', { accountId: acct.id, acctNo: acct.account_number, name: acct.full_name });
        return CON(`DEPOSIT\nAccount: ${acct.account_number}\nHolder: ${acct.full_name}\n\nEnter your PIN:`);
      }
      if (step === 3) {
        const sess = await getSession(sessionId);
        const pr   = await banking.verifyPin(sess.session_data.accountId, inputs[2]);
        if (!pr.valid) return END(`❌ ${pr.reason}`);
        await updateSession(sessionId, { ...sess.session_data, ok: true });
        return CON('DEPOSIT\nPIN verified ✓\n\nEnter amount (KSh):');
      }
      if (step === 4) {
        const sess = await getSession(sessionId);
        if (!sess?.session_data.ok) return END('Session error. Dial *384*1#');
        const amt = parseFloat(inputs[3]);
        if (isNaN(amt) || amt <= 0) return CON('Invalid amount.\n\nEnter amount (KSh):');
        await updateSession(sessionId, { ...sess.session_data, amt });
        const acct = await banking.getByNumber(sess.session_data.acctNo);
        return CON(`DEPOSIT CONFIRM\n─────────────────\nAccount: ${sess.session_data.acctNo}\nName: ${acct.full_name}\nBank: ${acct.bank_name}\nAmount: KSh ${fmt(amt)}\nRoute: You → CBK → ${acct.bank_code}\n\n1. Confirm\n2. Cancel`);
      }
      if (step === 5) {
        const sess = await getSession(sessionId);
        if (inputs[4] !== '1') { await endSession(sessionId); return END('Deposit cancelled.\n\nDial *384*1# for more.'); }
        try {
          const res = await banking.processTransaction({ accountId: sess.session_data.accountId, txType: 'deposit', amount: sess.session_data.amt, description: 'USSD Deposit', channel: 'ussd' });
          await endSession(sessionId);
          return END(`✅ DEPOSIT SUCCESSFUL\n─────────────────\nRef: ${res.transaction.reference}\nAmount: KSh ${fmt(res.transaction.amount)}\nNew Balance: KSh ${fmt(res.account.newBalance)}\n\nSMS confirmation sent.\nDial *384*1# for more.`);
        } catch (err) { await endSession(sessionId); return END(`❌ ${err.message}`); }
      }
    }

    // ── 3. WITHDRAWAL ───────────────────────────────────────
    if (c === '3') {
      if (step === 1) return CON('WITHDRAWAL\n\nEnter account number:');
      if (step === 2) {
        const acct = await banking.getByNumber(inputs[1].toUpperCase());
        if (!acct) return END('Account not found. Dial *384*1#');
        await saveSession(sessionId, phoneNumber, 'wit_pin', { accountId: acct.id, acctNo: acct.account_number });
        return CON(`WITHDRAWAL\nAccount: ${acct.account_number}\nHolder: ${acct.full_name}\n\nEnter your PIN:`);
      }
      if (step === 3) {
        const sess = await getSession(sessionId);
        const pr   = await banking.verifyPin(sess.session_data.accountId, inputs[2]);
        if (!pr.valid) return END(`❌ ${pr.reason}`);
        const br   = await db.query('SELECT balance FROM accounts WHERE id=$1', [sess.session_data.accountId]);
        const bal  = br.rows[0].balance;
        await updateSession(sessionId, { ...sess.session_data, ok: true, bal });
        return CON(`WITHDRAWAL\nPIN verified ✓\nBalance: KSh ${fmt(bal)}\n\nEnter amount (KSh):`);
      }
      if (step === 4) {
        const sess = await getSession(sessionId);
        if (!sess?.session_data.ok) return END('Session error. Dial *384*1#');
        const amt = parseFloat(inputs[3]);
        if (isNaN(amt) || amt <= 0) return CON('Invalid amount.\n\nEnter amount (KSh):');
        if (amt > parseFloat(sess.session_data.bal)) return CON(`Insufficient balance.\nBalance: KSh ${fmt(sess.session_data.bal)}\n\nEnter a lower amount:`);
        const fee = Math.round(amt * parseFloat(process.env.CBK_TRANSACTION_FEE_PERCENT || 0.5) / 100 * 100) / 100;
        await updateSession(sessionId, { ...sess.session_data, amt, fee });
        const acct = await banking.getByNumber(sess.session_data.acctNo);
        return CON(`WITHDRAWAL CONFIRM\n─────────────────\nAccount: ${sess.session_data.acctNo}\nAmount: KSh ${fmt(amt)}\nCBK Fee: KSh ${fmt(fee)}\nTotal: KSh ${fmt(amt + fee)}\nRoute: ${acct.bank_code} → CBK → You\n\n1. Confirm\n2. Cancel`);
      }
      if (step === 5) {
        const sess = await getSession(sessionId);
        if (inputs[4] !== '1') { await endSession(sessionId); return END('Withdrawal cancelled.\n\nDial *384*1# for more.'); }
        try {
          const res = await banking.processTransaction({ accountId: sess.session_data.accountId, txType: 'withdrawal', amount: sess.session_data.amt, description: 'USSD Withdrawal', channel: 'ussd' });
          await endSession(sessionId);
          return END(`✅ WITHDRAWAL APPROVED\n─────────────────\nRef: ${res.transaction.reference}\nAmount: KSh ${fmt(res.transaction.amount)}\nNew Balance: KSh ${fmt(res.account.newBalance)}\n\nCollect cash from agent.\nSMS sent. Dial *384*1# for more.`);
        } catch (err) { await endSession(sessionId); return END(`❌ ${err.message}`); }
      }
    }

    // ── 4. OPEN ACCOUNT ─────────────────────────────────────
    if (c === '4') {
      if (step === 1) return CON('OPEN ACCOUNT\n\nEnter your full name:');
      if (step === 2) { await saveSession(sessionId, phoneNumber, 'ca_id', { name: inputs[1] }); return CON(`OPEN ACCOUNT\nName: ${inputs[1]}\n\nEnter National ID / Passport:`); }
      if (step === 3) { await updateSession(sessionId, { name: inputs[1], idNo: inputs[2] }); const banks = (await db.query('SELECT id,bank_name,bank_code FROM local_banks WHERE is_active=TRUE ORDER BY bank_name')).rows; if (!banks.length) return END('No banks available. Contact CBK admin.'); await updateSession(sessionId, { name: inputs[1], idNo: inputs[2], banks }); return CON(`SELECT BANK\n\n${banks.map((b,i)=>`${i+1}. ${b.bank_name}`).join('\n')}\n\nEnter number:`); }
      if (step === 4) {
        const sess = await getSession(sessionId); const banks = sess.session_data.banks; const idx = parseInt(inputs[3]) - 1;
        if (isNaN(idx) || idx < 0 || idx >= banks.length) return CON('Invalid. Enter bank number:');
        await updateSession(sessionId, { ...sess.session_data, bankId: banks[idx].id, bankName: banks[idx].bank_name });
        return CON(`OPEN ACCOUNT\nBank: ${banks[idx].bank_name}\n\nAccount type:\n1. Savings\n2. Current\n\nEnter choice:`);
      }
      if (step === 5) {
        const sess = await getSession(sessionId); const type = inputs[4] === '2' ? 'Current' : 'Savings';
        await updateSession(sessionId, { ...sess.session_data, type });
        return CON('Set a 4-digit PIN for your account:');
      }
      if (step === 6) {
        const pin = inputs[5];
        if (!/^\d{4}$/.test(pin)) return CON('PIN must be 4 digits.\n\nSet your PIN:');
        const sess = await getSession(sessionId); const d = sess.session_data;
        await updateSession(sessionId, { ...d, pin });
        return CON(`ACCOUNT SUMMARY\n─────────────────\nName: ${d.name}\nID: ${d.idNo}\nPhone: ${phoneNumber}\nBank: ${d.bankName}\nType: ${d.type}\n\n1. Confirm & Open\n2. Cancel`);
      }
      if (step === 7) {
        const sess = await getSession(sessionId);
        if (inputs[6] !== '1') { await endSession(sessionId); return END('Cancelled.\n\nDial *384*1# anytime.'); }
        const d = sess.session_data;
        try {
          const res = await banking.createAccount({ fullName: d.name, nationalId: d.idNo, phoneNumber, accountType: d.type, bankId: d.bankId, pin: d.pin, openingBalance: 0, createdVia: 'ussd' });
          await endSession(sessionId);
          return END(`✅ ACCOUNT OPENED!\n─────────────────\nAccount: ${res.account.account_number}\nBank: ${d.bankName}\nType: ${d.type}\n\nSMS sent to ${phoneNumber}\nWelcome to CBK Banking!\nDial *384*1# to start.`);
        } catch (err) { await endSession(sessionId); return END(`❌ ${err.message}`); }
      }
    }

    // ── 5. MINI STATEMENT ────────────────────────────────────
    if (c === '5') {
      if (step === 1) return CON('MINI STATEMENT\n\nEnter account number:');
      if (step === 2) {
        const acct = await banking.getByNumber(inputs[1].toUpperCase());
        if (!acct) return END('Account not found.');
        await saveSession(sessionId, phoneNumber, 'stmt', { accountId: acct.id, acctNo: acct.account_number });
        return CON(`Mini Statement\nAccount: ${inputs[1].toUpperCase()}\n\nEnter PIN:`);
      }
      if (step === 3) {
        const sess = await getSession(sessionId);
        const pr   = await banking.verifyPin(sess.session_data.accountId, inputs[2]);
        if (!pr.valid) return END(`❌ ${pr.reason}`);
        const txs  = await banking.getMiniStatement(sess.session_data.accountId);
        const br   = await db.query('SELECT balance FROM accounts WHERE id=$1', [sess.session_data.accountId]);
        const bal  = br.rows[0].balance;
        await endSession(sessionId);
        const lines = txs.length ? txs.map(t => `${t.tx_type==='deposit'?'+':'-'}KSh ${fmt(t.amount)} ${(t.description||'').slice(0,12)}`).join('\n') : 'No transactions yet.';
        return END(`MINI STATEMENT\n${sess.session_data.acctNo}\n─────────────────\n${lines}\n─────────────────\nBal: KSh ${fmt(bal)}`);
      }
    }

    // ── 6. CHANGE PIN ────────────────────────────────────────
    if (c === '6') {
      if (step === 1) return CON('CHANGE PIN\n\nEnter account number:');
      if (step === 2) {
        const acct = await banking.getByNumber(inputs[1].toUpperCase());
        if (!acct) return END('Account not found.');
        await saveSession(sessionId, phoneNumber, 'pin_chg', { accountId: acct.id, acctNo: inputs[1] });
        return CON('CHANGE PIN\n\nEnter current PIN:');
      }
      if (step === 3) {
        const sess = await getSession(sessionId);
        const pr   = await banking.verifyPin(sess.session_data.accountId, inputs[2]);
        if (!pr.valid) return END(`❌ ${pr.reason}`);
        await updateSession(sessionId, { ...sess.session_data, ok: true });
        return CON('Current PIN verified ✓\n\nEnter NEW 4-digit PIN:');
      }
      if (step === 4) {
        const pin = inputs[3];
        if (!/^\d{4}$/.test(pin)) return CON('Must be 4 digits.\n\nEnter new PIN:');
        const sess = await getSession(sessionId);
        if (!sess?.session_data.ok) return END('Session error. Dial *384*1#');
        const hash = await bcrypt.hash(pin, 12);
        await db.query('UPDATE accounts SET pin_hash=$1,pin_attempts=0 WHERE id=$2', [hash, sess.session_data.accountId]);
        const ar = await db.query('SELECT phone_number,full_name,account_number FROM accounts WHERE id=$1', [sess.session_data.accountId]);
        const ac = ar.rows[0];
        await sms.send(ac.phone_number, sms.templates.pinChanged(ac.full_name, ac.account_number));
        await db.query(`INSERT INTO audit_log (action,entity_type,entity_id,performed_by) VALUES ('pin_changed','account',$1,'ussd')`, [sess.session_data.accountId]);
        await endSession(sessionId);
        return END('✅ PIN changed successfully.\n\nSMS notification sent.\nDial *384*1# to continue.');
      }
    }

    return END('Invalid option.\n\nDial *384*1# to start again.');
  } catch (err) {
    logger.error('USSD error', { error: err.message, sessionId, text });
    return END('System error. Please try again.\nDial *384*1#');
  }
}

module.exports = { handleUSSD };
