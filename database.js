// config/database.js
const { Pool } = require('pg');

// DigitalOcean App Platform injects DATABASE_URL automatically
// when you add a PostgreSQL database resource to your app.
// Supports both DATABASE_URL (DigitalOcean) and individual DB_* vars (local dev).

let poolConfig;

if (process.env.DATABASE_URL) {
  // DigitalOcean managed database — always needs SSL
  poolConfig = {
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  };
  console.log('DB: connected via DATABASE_URL (DigitalOcean)');
} else {
  // Local development
  poolConfig = {
    host:     process.env.DB_HOST     || 'localhost',
    port:     parseInt(process.env.DB_PORT) || 5432,
    database: process.env.DB_NAME     || 'cbk_banking',
    user:     process.env.DB_USER     || 'cbk_admin',
    password: process.env.DB_PASSWORD,
    ssl:      process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  };
  console.log('DB: connected via local DB_* variables');
}

const pool = new Pool(poolConfig);

pool.on('error', (err) => console.error('DB pool error:', err.message));

async function query(text, params) {
  try {
    return await pool.query(text, params);
  } catch (err) {
    console.error('Query error:', text.slice(0, 80), '-', err.message);
    throw err;
  }
}

async function getClient() {
  return await pool.connect();
}

module.exports = { query, getClient, pool };
