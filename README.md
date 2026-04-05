# CBK Banking System v2.1
### Central Bank of Kenya — Unified Banking Platform

One folder. One server. Frontend + Backend + USSD + SMS.

```
cbk-system/
├── server.js              ← Entry point (serves EVERYTHING)
├── package.json
├── .env.example           ← Copy to .env and fill in
├── ecosystem.config.js    ← PM2 process manager
│
├── public/
│   └── index.html         ← Admin Dashboard (served by Express)
│
├── routes/
│   └── api.js             ← All API endpoints
│
├── services/
│   ├── banking.js         ← Core banking + CBK routing engine
│   ├── ussd.js            ← USSD session handler (*384*1#)
│   └── sms.js             ← Africa's Talking SMS
│
├── middleware/
│   └── auth.js            ← JWT + USSD source validation
│
├── config/
│   ├── database.js        ← PostgreSQL pool
│   └── logger.js          ← Winston logger
│
└── scripts/
    ├── schema.sql         ← Full database schema
    └── migrate.js         ← Migration runner
```

---

## Setup in 5 Steps

### Step 1 — Install dependencies
```bash
cd cbk-system
npm install
```

### Step 2 — Configure environment
```bash
cp .env.example .env
nano .env
```
Fill in: `DB_PASSWORD`, `JWT_SECRET`, `AT_API_KEY`, `AT_USERNAME`

### Step 3 — Set up PostgreSQL database
```bash
# Create the database
sudo -u postgres psql -c "CREATE DATABASE cbk_banking;"
sudo -u postgres psql -c "CREATE USER cbk_admin WITH ENCRYPTED PASSWORD 'your_password';"
sudo -u postgres psql -c "GRANT ALL PRIVILEGES ON DATABASE cbk_banking TO cbk_admin;"

# Run migrations (creates all tables + default admin user)
npm run migrate
```

### Step 4 — Start the server
```bash
# Development
npm run dev

# Production (with PM2)
npm install -g pm2
pm2 start ecosystem.config.js
pm2 save && pm2 startup
```

### Step 5 — Open the dashboard
```
http://localhost:3000
```
Login with: `cbk_admin` / `Admin@CBK2024!`

---

## How It Works

The single Express server (`server.js`) does everything:

| Path | What it serves |
|------|---------------|
| `GET /` | Admin Dashboard (public/index.html) |
| `POST /api/auth/login` | Admin login → JWT token |
| `GET /api/dashboard` | Stats, reserve, recent transactions |
| `POST /api/banks` | Register local bank with CBK |
| `GET /api/banks` | List all banks |
| `POST /api/accounts` | Create customer account |
| `GET /api/accounts` | List/search accounts |
| `POST /api/transactions` | Process deposit/withdrawal via CBK |
| `GET /api/transactions` | Transaction history |
| `POST /api/ussd/callback` | Africa's Talking USSD callback |
| `GET /api/sms-log` | All SMS messages sent |
| `GET /api/audit-log` | System audit trail |
| `GET /health` | Health check |

---

## Africa's Talking Setup

1. Sign up at https://africastalking.com
2. Create an app → get your **API Key** and **Username**
3. Set in `.env`: `AT_API_KEY` and `AT_USERNAME`
4. In AT dashboard → USSD → Create service:
   - **Callback URL**: `https://your-domain.com/api/ussd/callback`
   - **USSD Code**: Apply for `*384*1#` from Safaricom (or use sandbox `*384*566#` for testing)
5. For SMS, go to **Sender ID** → request `CBK-BANK`

---

## Nginx Config (Production)

```nginx
server {
    listen 443 ssl http2;
    server_name your-domain.com;

    ssl_certificate     /etc/letsencrypt/live/your-domain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/your-domain.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

```bash
sudo certbot --nginx -d your-domain.com
```

---

## USSD Menu (*384*1#)
```
1. Check Balance   → account number → PIN → balance shown
2. Deposit         → account → PIN → amount → confirm → CBK routes → SMS sent
3. Withdrawal      → account → PIN → amount → confirm → CBK routes → SMS sent
4. Open Account    → name → ID → bank → type → PIN → confirm → SMS sent
5. Mini Statement  → account → PIN → last 5 transactions
6. Change PIN      → account → current PIN → new PIN → SMS alert sent
```

---

## Default Login
- **Username**: `cbk_admin`
- **Password**: `Admin@CBK2024!`

Change the password immediately after first login via the database:
```bash
node -e "
const bcrypt = require('bcryptjs');
bcrypt.hash('YourNewPassword!', 12).then(h => console.log(h));
"
# Then: UPDATE admin_users SET password='<hash>' WHERE username='cbk_admin';
```
