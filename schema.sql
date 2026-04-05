-- ═══════════════════════════════════════════════════════════
--  CBK BANKING SYSTEM — PostgreSQL Schema  v2.1
--  Run via: npm run migrate
-- ═══════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Admin users (primary user)
CREATE TABLE IF NOT EXISTS admin_users (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  username    VARCHAR(50) UNIQUE NOT NULL,
  password    TEXT NOT NULL,
  full_name   VARCHAR(100) NOT NULL,
  role        VARCHAR(20) DEFAULT 'superadmin',
  is_active   BOOLEAN DEFAULT TRUE,
  last_login  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Local banks registered with CBK
CREATE TABLE IF NOT EXISTS local_banks (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  bank_name        VARCHAR(100) NOT NULL,
  bank_code        VARCHAR(10)  UNIQUE NOT NULL,
  region           VARCHAR(50)  NOT NULL,
  cbk_allocation   NUMERIC(15,2) DEFAULT 0,
  current_balance  NUMERIC(15,2) DEFAULT 0,
  swift_code       VARCHAR(20),
  is_active        BOOLEAN DEFAULT TRUE,
  created_by       UUID REFERENCES admin_users(id),
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);

-- Customer accounts
CREATE TABLE IF NOT EXISTS accounts (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_number   VARCHAR(20) UNIQUE NOT NULL,
  full_name        VARCHAR(100) NOT NULL,
  national_id      VARCHAR(20) NOT NULL,
  phone_number     VARCHAR(20) NOT NULL,
  account_type     VARCHAR(20) NOT NULL CHECK (account_type IN ('Savings','Current','Fixed Deposit')),
  balance          NUMERIC(15,2) DEFAULT 0,
  bank_id          UUID NOT NULL REFERENCES local_banks(id),
  pin_hash         TEXT NOT NULL,
  is_active        BOOLEAN DEFAULT TRUE,
  is_blocked       BOOLEAN DEFAULT FALSE,
  pin_attempts     INTEGER DEFAULT 0,
  created_via      VARCHAR(20) DEFAULT 'admin',
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);

-- CBK central reserve (single-row ledger)
CREATE TABLE IF NOT EXISTS cbk_reserve (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  balance     NUMERIC(15,2) NOT NULL DEFAULT 0,
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);
INSERT INTO cbk_reserve (balance) VALUES (0) ON CONFLICT DO NOTHING;

-- All transactions (deposits, withdrawals)
CREATE TABLE IF NOT EXISTS transactions (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tx_reference    VARCHAR(30) UNIQUE NOT NULL,
  account_id      UUID NOT NULL REFERENCES accounts(id),
  bank_id         UUID NOT NULL REFERENCES local_banks(id),
  tx_type         VARCHAR(20) NOT NULL CHECK (tx_type IN ('deposit','withdrawal','transfer','fee')),
  amount          NUMERIC(15,2) NOT NULL CHECK (amount > 0),
  fee             NUMERIC(15,2) DEFAULT 0,
  balance_before  NUMERIC(15,2) NOT NULL,
  balance_after   NUMERIC(15,2) NOT NULL,
  description     TEXT,
  channel         VARCHAR(20) DEFAULT 'admin',
  status          VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending','completed','failed','reversed')),
  cbk_routed      BOOLEAN DEFAULT TRUE,
  cbk_settled_at  TIMESTAMPTZ,
  initiated_at    TIMESTAMPTZ DEFAULT NOW(),
  completed_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- USSD sessions
CREATE TABLE IF NOT EXISTS ussd_sessions (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id      VARCHAR(100) UNIQUE NOT NULL,
  phone_number    VARCHAR(20) NOT NULL,
  account_id      UUID REFERENCES accounts(id),
  current_step    VARCHAR(50) NOT NULL DEFAULT 'main',
  session_data    JSONB DEFAULT '{}',
  is_active       BOOLEAN DEFAULT TRUE,
  started_at      TIMESTAMPTZ DEFAULT NOW(),
  last_activity   TIMESTAMPTZ DEFAULT NOW(),
  ended_at        TIMESTAMPTZ
);

-- SMS confirmation log
CREATE TABLE IF NOT EXISTS sms_log (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  phone_number    VARCHAR(20) NOT NULL,
  message         TEXT NOT NULL,
  message_type    VARCHAR(30),
  account_id      UUID REFERENCES accounts(id),
  tx_reference    VARCHAR(30),
  provider_msg_id VARCHAR(100),
  status          VARCHAR(20) DEFAULT 'sent',
  sent_at         TIMESTAMPTZ DEFAULT NOW()
);

-- System audit log
CREATE TABLE IF NOT EXISTS audit_log (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  action       VARCHAR(100) NOT NULL,
  entity_type  VARCHAR(50),
  entity_id    UUID,
  performed_by VARCHAR(100),
  ip_address   INET,
  details      JSONB DEFAULT '{}',
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_accounts_phone   ON accounts(phone_number);
CREATE INDEX IF NOT EXISTS idx_accounts_number  ON accounts(account_number);
CREATE INDEX IF NOT EXISTS idx_accounts_bank    ON accounts(bank_id);
CREATE INDEX IF NOT EXISTS idx_tx_account       ON transactions(account_id);
CREATE INDEX IF NOT EXISTS idx_tx_reference     ON transactions(tx_reference);
CREATE INDEX IF NOT EXISTS idx_tx_created       ON transactions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ussd_session     ON ussd_sessions(session_id);
CREATE INDEX IF NOT EXISTS idx_audit_created    ON audit_log(created_at DESC);

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_accounts_updated ON accounts;
CREATE TRIGGER trg_accounts_updated BEFORE UPDATE ON accounts FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_banks_updated ON local_banks;
CREATE TRIGGER trg_banks_updated BEFORE UPDATE ON local_banks FOR EACH ROW EXECUTE FUNCTION set_updated_at();
