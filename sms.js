// services/sms.js  — Africa's Talking SMS integration
const AfricasTalking = require('africastalking');
const logger = require('../config/logger');

let sms = null;

function init() {
  if (!process.env.AT_API_KEY || process.env.AT_API_KEY.includes('your_')) {
    logger.warn('Africa\'s Talking not configured — SMS will be logged only (simulation mode)');
    return false;
  }
  const at = AfricasTalking({ apiKey: process.env.AT_API_KEY, username: process.env.AT_USERNAME });
  sms = at.SMS;
  logger.info('Africa\'s Talking SMS ready', { username: process.env.AT_USERNAME });
  return true;
}

const ready = init();

function normalizePhone(phone) {
  phone = String(phone).replace(/[\s\-]/g, '');
  if (phone.startsWith('0'))   return '+254' + phone.slice(1);
  if (phone.startsWith('254')) return '+' + phone;
  if (phone.startsWith('+'))   return phone;
  return '+254' + phone;
}

async function send(to, message) {
  const phone = normalizePhone(to);
  logger.info('SMS dispatch', { to: phone, preview: message.slice(0, 50) });

  if (!ready) {
    // Simulation — log and return success
    logger.info('SMS [SIMULATED]', { to: phone, message });
    return { success: true, simulated: true, messageId: 'SIM-' + Date.now() };
  }

  try {
    const result    = await sms.send({ to: [phone], message, from: process.env.AT_SENDER_ID || 'CBK-BANK' });
    const recipient = result.SMSMessageData.Recipients[0];
    if (recipient.status === 'Success') {
      return { success: true, messageId: recipient.messageId, cost: recipient.cost };
    }
    throw new Error(recipient.status);
  } catch (err) {
    logger.error('SMS failed', { to: phone, error: err.message });
    return { success: false, error: err.message };
  }
}

function fmt(n) {
  return Number(n).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ── SMS message templates ────────────────────────────────
const templates = {
  accountCreated:    (name, no, bank, type)     => `[CBK] Dear ${name}, your ${type} account ${no} is now OPEN at ${bank}. Dial *384*1# to bank. Keep your PIN safe. —Central Bank of Kenya`,
  depositConfirm:    (name, no, amt, ref, bal, code) => `[CBK] DEPOSIT KSh ${fmt(amt)} on ${no} via CBK→${code} confirmed. Ref:${ref}. New Bal: KSh ${fmt(bal)}. —CBK`,
  withdrawalConfirm: (name, no, amt, ref, bal, code) => `[CBK] WITHDRAWAL KSh ${fmt(amt)} from ${no} via ${code}→CBK confirmed. Ref:${ref}. New Bal: KSh ${fmt(bal)}. —CBK`,
  pinChanged:        (name, no)                => `[CBK] PIN changed for ${no}. Not you? Call CBK: 0800 000 000 immediately. —CBK`,
  lowBalance:        (name, no, bal, min)       => `[CBK] LOW BALANCE: ${no} has KSh ${fmt(bal)}, below minimum KSh ${fmt(min)}. Please deposit. —CBK`,
};

module.exports = { send, normalizePhone, templates };
