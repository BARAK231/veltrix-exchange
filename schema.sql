CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL,
  telegram_user_id TEXT UNIQUE,
  telegram_username TEXT,
  role TEXT NOT NULL DEFAULT 'user'
    CHECK (role IN ('user','admin')),
  kyc_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (kyc_status IN ('pending','submitted','verified','rejected')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sessions (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT UNIQUE NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS sessions_token_idx
ON sessions(token_hash);

CREATE TABLE IF NOT EXISTS assets (
  id BIGSERIAL PRIMARY KEY,
  symbol TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  network TEXT,
  status TEXT NOT NULL DEFAULT 'planned'
    CHECK (status IN ('active','planned','disabled')),
  listing_date DATE,
  decimals INT NOT NULL DEFAULT 18,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS balances (
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  asset_id BIGINT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  available NUMERIC(38,18) NOT NULL DEFAULT 0
    CHECK (available >= 0),
  locked NUMERIC(38,18) NOT NULL DEFAULT 0
    CHECK (locked >= 0),
  PRIMARY KEY(user_id,asset_id)
);

CREATE TABLE IF NOT EXISTS ledger_entries (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  asset_id BIGINT NOT NULL REFERENCES assets(id),
  amount NUMERIC(38,18) NOT NULL,
  type TEXT NOT NULL,
  reference_id TEXT,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ledger_user_idx
ON ledger_entries(user_id,created_at DESC);

CREATE TABLE IF NOT EXISTS miner_credits (
  id BIGSERIAL PRIMARY KEY,
  request_id TEXT UNIQUE NOT NULL,
  telegram_user_id TEXT NOT NULL,
  amount NUMERIC(38,18) NOT NULL CHECK(amount > 0),
  credited_user_id BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS orders (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id),
  symbol TEXT NOT NULL,
  side TEXT NOT NULL
    CHECK(side IN ('buy','sell')),
  order_type TEXT NOT NULL
    CHECK(order_type IN ('market','limit')),
  price NUMERIC(38,18),
  quantity NUMERIC(38,18) NOT NULL
    CHECK(quantity > 0),
  filled_quantity NUMERIC(38,18) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open'
    CHECK(status IN (
      'open',
      'partially_filled',
      'filled',
      'cancelled'
    )),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS orders_book_idx
ON orders(symbol,side,status,price,created_at);

CREATE TABLE IF NOT EXISTS audit_logs (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT REFERENCES users(id),
  action TEXT NOT NULL,
  ip TEXT,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO assets
(symbol,name,network,status,listing_date,decimals)
VALUES
(
  'USDT',
  'Tether USD',
  'TBD',
  'active',
  NULL,
  6
),
(
  'VLX',
  'VELTRIX',
  'TBD',
  'planned',
  '2026-11-17',
  18
)
ON CONFLICT(symbol)
DO UPDATE SET
  name=EXCLUDED.name,
  status=EXCLUDED.status,
  listing_date=EXCLUDED.listing_date;
