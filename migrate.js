// scripts/migrate.js — Setup database schema and default admin
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { Pool } = require('pg');
const bcrypt   = require('bcryptjs');
const fs       = require('fs');
const path     = require('path');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME || 'cbk_banking',
  user: process.env.DB_USER || 'cbk_admin',
  password: process.env.DB_PASSWORD,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

async function migrate() {
  const client = await pool.connect();
  try {
    console.log('\n🏦  CBK Banking System — Database Migration\n' + '─'.repeat(50));
    const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    await client.query(sql);
    console.log('✅  Schema applied');

    const adminUser = process.env.ADMIN_USERNAME || 'cbk_admin';
    const adminPass = process.env.ADMIN_PASSWORD || 'Admin@CBK2024!';
    const hash      = await bcrypt.hash(adminPass, 12);
    await client.query(
      `INSERT INTO admin_users (username,password,full_name,role) VALUES ($1,$2,'CBK Super Admin','superadmin')
       ON CONFLICT (username) DO UPDATE SET password=$2`,
      [adminUser, hash]);
    console.log(`✅  Admin user ready → username: ${adminUser}`);
    console.log('\n' + '─'.repeat(50));
    console.log('🚀  Run "npm start" to launch the system');
    console.log('🌐  Dashboard will be at http://localhost:' + (process.env.PORT || 3000));
    console.log('─'.repeat(50) + '\n');
  } catch (err) {
    console.error('❌  Migration failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
