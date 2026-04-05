// config/database.js
const { Pool } = require('pg');
const logger = require('./logger');

const pool = new Pool({
  host:     process.env.DB_HOST     || 'localhost',
  port:     parseInt(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME     || 'cbk_banking',
  user:     process.env.DB_USER     || 'cbk_admin',
  password: process.env.DB_PASSWORD,
  ssl:      process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

pool.on('error', (err) => logger.error('DB pool error', { error: err.message }));

async function query(text, params) {
  try {
    return await pool.query(text, params);
  } catch (err) {
    logger.error('Query error', { text: text.slice(0, 80), error: err.message });
    throw err;
  }
}

async function getClient() {
  return await pool.connect();
}

module.exports = { query, getClient, pool };
