const express = require("express");
const path = require("path");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const cookieParser = require("cookie-parser");
const rateLimit = require("express-rate-limit");
const { Pool } = require("pg");

const app = express();
const PORT = Number(process.env.PORT || 10000);

/* =========================================================
   DATABASE
   ========================================================= */

const DATABASE_URL = String(process.env.DATABASE_URL || "").trim();

if (!DATABASE_URL) {
  console.error("VELTRIX ERROR: DATABASE_URL is not configured.");
  process.exit(1);
}

/*
  Render PostgreSQL normally provides DATABASE_URL.
  SSL is enabled for Render/PostgreSQL compatibility.
*/

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  },
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

pool.on("error", (err) => {
  console.error("VELTRIX PostgreSQL pool error:", err.message);
});

/* =========================================================
   MIDDLEWARE
   ========================================================= */

app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());

app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false
  })
);

app.use(express.static(path.join(__dirname, "public")));

/* =========================================================
   ASSETS
   ========================================================= */

const ASSETS = [
  ["USDT", "Tether USD", "TBD", "active", null, 6],
  ["BTC", "Bitcoin", "Bitcoin", "active", null, 8],
  ["ETH", "Ethereum", "Ethereum", "active", null, 18],
  ["SOL", "Solana", "Solana", "active", null, 9],
  ["XRP", "XRP", "XRP Ledger", "active", null, 6],
  ["TON", "Toncoin", "TON", "active", null, 9],
  ["SHIB", "Shiba Inu", "Ethereum", "active", null, 18],
  ["VLX", "VELTRIX", "TBD", "planned", "2026-11-24", 18]
];

const PAIRS = [
  "BTC/USDT",
  "ETH/USDT",
  "SOL/USDT",
  "XRP/USDT",
  "TON/USDT",
  "SHIB/USDT",
  "VLX/USDT"
];

/* =========================================================
   HELPERS
   ========================================================= */

function requireDB() {
  if (!pool) {
    throw new Error("Database connection is not available");
  }
}

function hashToken(token) {
  return crypto
    .createHash("sha256")
    .update(token)
    .digest("hex");
}

function newToken() {
  return crypto.randomBytes(48).toString("hex");
}

function validEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function validAmount(value) {
  return /^\d+(\.\d{1,18})?$/.test(String(value));
}

function validPair(symbol) {
  return PAIRS.includes(symbol);
}

/* =========================================================
   DATABASE INITIALIZATION
   ========================================================= */

async function initDatabase() {
  requireDB();

  /*
    Test the connection first.
  */

  await pool.query("SELECT 1");

  console.log("VELTRIX PostgreSQL connection successful");

  await pool.query(`
    CREATE TABLE IF NOT EXISTS vlx_users (
      id BIGSERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      display_name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
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
      status TEXT NOT NULL DEFAULT 'active',
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
      side TEXT NOT NULL CHECK(side IN ('buy','sell')),
      order_type TEXT NOT NULL CHECK(order_type IN ('market','limit')),
      price NUMERIC(38,18),
      quantity NUMERIC(38,18) NOT NULL CHECK(quantity > 0),
      filled_quantity NUMERIC(38,18) NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'open',
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

    CREATE TABLE IF NOT EXISTS vlx_deposits (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES vlx_users(id),
      asset_id BIGINT NOT NULL REFERENCES vlx_assets(id),
      amount NUMERIC(38,18) NOT NULL,
      txid TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS vlx_withdrawals (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES vlx_users(id),
      asset_id BIGINT NOT NULL REFERENCES vlx_assets(id),
      amount NUMERIC(38,18) NOT NULL,
      address TEXT NOT NULL,
      txid TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS vlx_audit_logs (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT,
      action TEXT NOT NULL,
      ip TEXT,
      metadata JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  /*
    Insert/update supported assets.
  */

  for (const asset of ASSETS) {
    await pool.query(
      `
      INSERT INTO vlx_assets
      (symbol, name, network, status, listing_date, decimals)
      VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT(symbol) DO UPDATE SET
        name = EXCLUDED.name,
        network = EXCLUDED.network,
        status = EXCLUDED.status,
        listing_date = EXCLUDED.listing_date,
        decimals = EXCLUDED.decimals
      `,
      asset
    );
  }

  console.log("VELTRIX database initialized successfully");
}

/* =========================================================
   AUTH
   ========================================================= */

async function auth(req, res) {
  try {
    requireDB();

    const token = req.cookies.vlx_session;

    if (!token) {
      res.status(401).json({
        error: "Login required"
      });
      return null;
    }

    const result = await pool.query(
      `
      SELECT u.*
      FROM vlx_sessions s
      JOIN vlx_users u
        ON u.id = s.user_id
      WHERE s.token_hash = $1
      AND s.expires_at > NOW()
      `,
      [hashToken(token)]
    );

    if (!result.rows.length) {
      res.status(401).json({
        error: "Session expired"
      });
      return null;
    }

    return result.rows[0];

  } catch (err) {
    console.error("AUTH ERROR:", err.message);

    res.status(500).json({
      error: "Authentication error"
    });

    return null;
  }
}

/* =========================================================
   HEALTH
   ========================================================= */

app.get("/api/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");

    res.json({
      ok: true,
      project: "VELTRIX EXCHANGE",
      database: "PostgreSQL",
      mode: "LIVE-BACKEND",
      pairs: PAIRS
    });

  } catch (err) {
    console.error("HEALTH ERROR:", err.message);

    res.status(500).json({
      ok: false,
      error: "Database unavailable"
    });
  }
});

/* =========================================================
   CONFIG
   ========================================================= */

app.get("/api/config", (req, res) => {
  res.json({
    name: "VELTRIX EXCHANGE",
    symbol: "VLX",
    pairs: PAIRS,
    listingDateUTC: "2026-11-24T00:00:00Z"
  });
});

/* =========================================================
   ASSETS
   ========================================================= */

app.get("/api/assets", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        symbol,
        name,
        network,
        status,
        listing_date,
        decimals
      FROM vlx_assets
      ORDER BY id
    `);

    res.json(result.rows);

  } catch (err) {
    console.error("ASSETS ERROR:", err.message);

    res.status(500).json({
      error: "Failed to load assets"
    });
  }
});

/* =========================================================
   REGISTER
   ========================================================= */

app.post("/api/register", async (req, res) => {
  try {
    const email = String(req.body.email || "")
      .trim()
      .toLowerCase();

    const password = String(req.body.password || "");

    const displayName = String(req.body.displayName || "")
      .trim();

    if (!validEmail(email)) {
      return res.status(400).json({
        error: "Invalid email"
      });
    }

    if (password.length < 8) {
      return res.status(400).json({
        error: "Password must contain at least 8 characters"
      });
    }

    if (!displayName || displayName.length > 80) {
      return res.status(400).json({
        error: "Invalid display name"
      });
    }

    const existing = await pool.query(
      "SELECT id FROM vlx_users WHERE email=$1",
      [email]
    );

    if (existing.rows.length) {
      return res.status(409).json({
        error: "Email already registered"
      });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const user = await pool.query(
      `
      INSERT INTO vlx_users
      (email,password_hash,display_name)
      VALUES($1,$2,$3)
      RETURNING id,email,display_name,role,created_at
      `,
      [email, passwordHash, displayName]
    );

    const userId = user.rows[0].id;

    const assets = await pool.query(
      "SELECT id FROM vlx_assets"
    );

    for (const asset of assets.rows) {
      await pool.query(
        `
        INSERT INTO vlx_balances(user_id,asset_id)
        VALUES($1,$2)
        ON CONFLICT DO NOTHING
        `,
        [userId, asset.id]
      );
    }

    res.status(201).json({
      ok: true,
      user: user.rows[0]
    });

  } catch (err) {
    console.error("REGISTER ERROR:", err.message);

    res.status(500).json({
      error: "Registration failed"
    });
  }
});

/* =========================================================
   LOGIN
   ========================================================= */

app.post("/api/login", async (req, res) => {
  try {
    const email = String(req.body.email || "")
      .trim()
      .toLowerCase();

    const password = String(req.body.password || "");

    const result = await pool.query(
      "SELECT * FROM vlx_users WHERE email=$1",
      [email]
    );

    if (!result.rows.length) {
      return res.status(401).json({
        error: "Invalid email or password"
      });
    }

    const user = result.rows[0];

    const valid = await bcrypt.compare(
      password,
      user.password_hash
    );

    if (!valid) {
      return res.status(401).json({
        error: "Invalid email or password"
      });
    }

    const token = newToken();

    await pool.query(
      `
      INSERT INTO vlx_sessions
      (user_id,token_hash,expires_at)
      VALUES($1,$2,NOW()+INTERVAL '7 days')
      `,
      [user.id, hashToken(token)]
    );

    res.cookie("vlx_session", token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 7 * 24 * 60 * 60 * 1000
    });

    res.json({
      ok: true,
      user: {
        id: user.id,
        email: user.email,
        displayName: user.display_name,
        role: user.role
      }
    });

  } catch (err) {
    console.error("LOGIN ERROR:", err.message);

    res.status(500).json({
      error: "Login failed"
    });
  }
});

/* =========================================================
   CURRENT USER
   ========================================================= */

app.get("/api/me", async (req, res) => {
  const user = await auth(req, res);

  if (!user) return;

  res.json({
    id: user.id,
    email: user.email,
    displayName: user.display_name,
    role: user.role
  });
});

/* =========================================================
   LOGOUT
   ========================================================= */

app.post("/api/logout", async (req, res) => {
  try {
    const token = req.cookies.vlx_session;

    if (token) {
      await pool.query(
        "DELETE FROM vlx_sessions WHERE token_hash=$1",
        [hashToken(token)]
      );
    }

    res.clearCookie("vlx_session");

    res.json({
      ok: true
    });

  } catch (err) {
    console.error("LOGOUT ERROR:", err.message);

    res.status(500).json({
      error: "Logout failed"
    });
  }
});

/* =========================================================
   BALANCES
   ========================================================= */

app.get("/api/balances", async (req, res) => {
  const user = await auth(req, res);

  if (!user) return;

  try {
    const result = await pool.query(
      `
      SELECT
        a.symbol,
        a.name,
        a.network,
        a.status,
        b.available,
        b.locked
      FROM vlx_balances b
      JOIN vlx_assets a
        ON a.id = b.asset_id
      WHERE b.user_id=$1
      ORDER BY a.id
      `,
      [user.id]
    );

    res.json(result.rows);

  } catch (err) {
    console.error("BALANCES ERROR:", err.message);

    res.status(500).json({
      error: "Failed to load balances"
    });
  }
});

/* =========================================================
   ORDER BOOK
   ========================================================= */

app.get("/api/orderbook/:symbol", async (req, res) => {
  const symbol = req.params.symbol;

  if (!validPair(symbol)) {
    return res.status(400).json({
      error: "Invalid trading pair"
    });
  }

  try {
    const asks = await pool.query(
      `
      SELECT price,quantity,filled_quantity
      FROM vlx_orders
      WHERE symbol=$1
      AND side='sell'
      AND status IN ('open','partially_filled')
      ORDER BY price ASC
      LIMIT 50
      `,
      [symbol]
    );

    const bids = await pool.query(
      `
      SELECT price,quantity,filled_quantity
      FROM vlx_orders
      WHERE symbol=$1
      AND side='buy'
      AND status IN ('open','partially_filled')
      ORDER BY price DESC
      LIMIT 50
      `,
      [symbol]
    );

    res.json({
      symbol,
      asks: asks.rows,
      bids: bids.rows
    });

  } catch (err) {
    console.error("ORDERBOOK ERROR:", err.message);

    res.status(500).json({
      error: "Failed to load order book"
    });
  }
});

/* =========================================================
   CREATE LIMIT ORDER
   ========================================================= */

app.post("/api/orders", async (req, res) => {
  const user = await auth(req, res);

  if (!user) return;

  const symbol = String(req.body.symbol || "");
  const side = String(req.body.side || "");
  const type = String(req.body.orderType || "limit");
  const price = String(req.body.price || "");
  const quantity = String(req.body.quantity || "");

  if (!validPair(symbol)) {
    return res.status(400).json({
      error: "Invalid trading pair"
    });
  }

  if (!["buy", "sell"].includes(side)) {
    return res.status(400).json({
      error: "Invalid order side"
    });
  }

  if (type !== "limit") {
    return res.status(400).json({
      error:
        "Market orders will be enabled after the matching engine is fully tested"
    });
  }

  if (!validAmount(price) || !validAmount(quantity)) {
    return res.status(400).json({
      error: "Invalid price or quantity"
    });
  }

  if (Number(price) <= 0 || Number(quantity) <= 0) {
    return res.status(400).json({
      error: "Price and quantity must be positive"
    });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const [base, quote] = symbol.split("/");

    const assetResult = await client.query(
      `
      SELECT id,symbol
      FROM vlx_assets
      WHERE symbol IN ($1,$2)
      `,
      [base, quote]
    );

    if (assetResult.rows.length !== 2) {
      throw new Error("Asset not found");
    }

    const baseAsset = assetResult.rows.find(
      x => x.symbol === base
    );

    const quoteAsset = assetResult.rows.find(
      x => x.symbol === quote
    );

    const balanceAsset =
      side === "buy"
        ? quoteAsset
        : baseAsset;

    const required =
      side === "buy"
        ? Number(price) * Number(quantity)
        : Number(quantity);

    const balance = await client.query(
      `
      SELECT available
      FROM vlx_balances
      WHERE user_id=$1
      AND asset_id=$2
      FOR UPDATE
      `,
      [user.id, balanceAsset.id]
    );

    if (!balance.rows.length) {
      throw new Error("Balance not found");
    }

    if (
      Number(balance.rows[0].available) <
      required
    ) {
      throw new Error(
        `Insufficient ${balanceAsset.symbol} balance`
      );
    }

    await client.query(
      `
      UPDATE vlx_balances
      SET available=available-$1,
          locked=locked+$1
      WHERE user_id=$2
      AND asset_id=$3
      `,
      [
        required,
        user.id,
        balanceAsset.id
      ]
    );

    const order = await client.query(
      `
      INSERT INTO vlx_orders
      (user_id,symbol,side,order_type,price,quantity)
      VALUES($1,$2,$3,$4,$5,$6)
      RETURNING *
      `,
      [
        user.id,
        symbol,
        side,
        type,
        price,
        quantity
      ]
    );

    await client.query("COMMIT");

    res.status(201).json({
      ok: true,
      order: order.rows[0],
      message:
        "Order created. Matching engine will execute it when a matching order is available."
    });

  } catch (err) {
    await client.query("ROLLBACK");

    console.error("ORDER ERROR:", err.message);

    res.status(400).json({
      error: err.message
    });

  } finally {
    client.release();
  }
});

/* =========================================================
   ORDERS
   ========================================================= */

app.get("/api/orders", async (req, res) => {
  const user = await auth(req, res);

  if (!user) return;

  try {
    const result = await pool.query(
      `
      SELECT *
      FROM vlx_orders
      WHERE user_id=$1
      ORDER BY id DESC
      LIMIT 200
      `,
      [user.id]
    );

    res.json(result.rows);

  } catch (err) {
    console.error("ORDERS ERROR:", err.message);

    res.status(500).json({
      error: "Failed to load orders"
    });
  }
});

/* =========================================================
   TRADES
   ========================================================= */

app.get("/api/trades/:symbol", async (req, res) => {
  const symbol = req.params.symbol;

  if (!validPair(symbol)) {
    return res.status(400).json({
      error: "Invalid trading pair"
    });
  }

  try {
    const result = await pool.query(
      `
      SELECT price,quantity,created_at
      FROM vlx_trades
      WHERE symbol=$1
      ORDER BY id DESC
      LIMIT 100
      `,
      [symbol]
    );

    res.json(result.rows);

  } catch (err) {
    console.error("TRADES ERROR:", err.message);

    res.status(500).json({
      error: "Failed to load trades"
    });
  }
});

/* =========================================================
   VLX LISTING COUNTDOWN
   ========================================================= */

app.get("/api/listing", (req, res) => {
  const listing = new Date(
    "2026-11-24T00:00:00Z"
  );

  res.json({
    symbol: "VLX",
    listingDateUTC: listing.toISOString(),
    nowUTC: new Date().toISOString(),
    remainingMilliseconds: Math.max(
      0,
      listing.getTime() - Date.now()
    )
  });
});

/* =========================================================
   FRONTEND
   ========================================================= */

app.get("*", (req, res) => {
  res.sendFile(
    path.join(
      __dirname,
      "public",
      "index.html"
    )
  );
});

/* =========================================================
   START SERVER
   ========================================================= */

async function start() {
  try {
    console.log("Starting VELTRIX EXCHANGE...");

    await initDatabase();

    app.listen(
      PORT,
      "0.0.0.0",
      () => {
        console.log(
          `VELTRIX EXCHANGE running on port ${PORT}`
        );
      }
    );

  } catch (err) {
    console.error(
      "VELTRIX startup failed:",
      err.message
    );

    process.exit(1);
  }
}

start();
