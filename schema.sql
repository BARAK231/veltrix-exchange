CREATE TABLE IF NOT EXISTS vlx_users (
  id BIGSERIAL PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user'
    CHECK (role IN ('user','admin')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS vlx_sessions (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES vlx_users(id) ON DELETE CASCADE,
  token_hash TEXT UNIQUE NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS vlx_assets (
  id BIGSERIAL PRIMARY KEY,
  symbol TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  network TEXT,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','planned','disabled')),
  listing_date DATE,
  decimals INT NOT NULL DEFAULT 18,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS vlx_balances (
  user_id BIGINT NOT NULL REFERENCES vlx_users(id) ON DELETE CASCADE,
  asset_id BIGINT NOT NULL REFERENCES vlx_assets(id) ON DELETE CASCADE,
  available NUMERIC(38,18) NOT NULL DEFAULT 0,
  locked NUMERIC(38,18) NOT NULL DEFAULT 0,
  PRIMARY KEY(user_id, asset_id)
);

CREATE TABLE IF NOT EXISTS vlx_ledger_entries (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES vlx_users(id),
  asset_id BIGINT NOT NULL REFERENCES vlx_assets(id),
  amount NUMERIC(38,18) NOT NULL,
  type TEXT NOT NULL,
  reference_id TEXT,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS vlx_orders (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES vlx_users(id),
  symbol TEXT NOT NULL,
  side TEXT NOT NULL
    CHECK (side IN ('buy','sell')),
  order_type TEXT NOT NULL
    CHECK (order_type IN ('market','limit')),
  price NUMERIC(38,18),
  quantity NUMERIC(38,18) NOT NULL
    CHECK (quantity > 0),
  filled_quantity NUMERIC(38,18) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (
      status IN (
        'open',
        'partially_filled',
        'filled',
        'cancelled'
      )
    ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS vlx_orders_book_idx
ON vlx_orders(symbol, side, status, price, created_at);

CREATE TABLE IF NOT EXISTS vlx_trades (
  id BIGSERIAL PRIMARY KEY,
  symbol TEXT NOT NULL,
  buy_order_id BIGINT NOT NULL REFERENCES vlx_orders(id),
  sell_order_id BIGINT NOT NULL REFERENCES vlx_orders(id),
  buyer_id BIGINT NOT NULL REFERENCES vlx_users(id),
  seller_id BIGINT NOT NULL REFERENCES vlx_users(id),
  price NUMERIC(38,18) NOT NULL,
  quantity NUMERIC(38,18) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS vlx_trades_symbol_idx
ON vlx_trades(symbol, created_at DESC);

CREATE TABLE IF NOT EXISTS vlx_deposits (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES vlx_users(id),
  asset_id BIGINT NOT NULL REFERENCES vlx_assets(id),
  amount NUMERIC(38,18) NOT NULL,
  txid TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','confirmed','failed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS vlx_withdrawals (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES vlx_users(id),
  asset_id BIGINT NOT NULL REFERENCES vlx_assets(id),
  amount NUMERIC(38,18) NOT NULL,
  address TEXT NOT NULL,
  txid TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (
      status IN (
        'pending',
        'approved',
        'processing',
        'completed',
        'rejected',
        'failed'
      )
    ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS vlx_audit_logs (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT REFERENCES vlx_users(id),
  action TEXT NOT NULL,
  ip TEXT,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO vlx_assets
(symbol, name, network, status, listing_date, decimals)
VALUES
('USDT', 'Tether USD', 'TBD', 'active', NULL, 6),
('BTC', 'Bitcoin', 'Bitcoin', 'active', NULL, 8),
('ETH', 'Ethereum', 'Ethereum', 'active', NULL, 18),
('SOL', 'Solana', 'Solana', 'active', NULL, 9),
('XRP', 'XRP', 'XRP Ledger', 'active', NULL, 6),
('TON', 'Toncoin', 'TON', 'active', NULL, 9),
('SHIB', 'Shiba Inu', 'Ethereum', 'active', NULL, 18),
('VLX', 'VELTRIX', 'TBD', 'planned', '2026-11-24', 18)
ON CONFLICT(symbol)
DO UPDATE SET
  name = EXCLUDED.name,
  network = EXCLUDED.network,
  status = EXCLUDED.status,
  listing_date = EXCLUDED.listing_date,
  decimals = EXCLUDED.decimals;
