const express = require("express");
const path = require("path");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const cookieParser = require("cookie-parser");
const rateLimit = require("express-rate-limit");
const { Pool } = require("pg");

const app = express();

const PORT = Number(process.env.PORT || 10000);
const DATABASE_URL = process.env.DATABASE_URL;
const BOT_TOKEN = String(process.env.BOT_TOKEN || "");
const ADMIN_ID = String(process.env.ADMIN_ID || "");
const APP_URL = String(process.env.APP_URL || "");
const MINING_PER_HOUR = Number(process.env.MINING_PER_HOUR || 4.74);

if (!DATABASE_URL) {
  console.error("DATABASE_URL is missing");
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

app.set("trust proxy", 1);
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

/* =========================================================
   DATABASE
========================================================= */

async function initDatabase() {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    /* USERS */
    await client.query(`
      CREATE TABLE IF NOT EXISTS vlx_users (
        id BIGSERIAL PRIMARY KEY,
        username TEXT,
        first_name TEXT,
        email TEXT UNIQUE,
        password_hash TEXT,
        telegram_user_id TEXT,
        is_admin BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    /* SESSIONS */
    await client.query(`
      CREATE TABLE IF NOT EXISTS vlx_sessions (
        id BIGSERIAL PRIMARY KEY,
        user_id BIGINT NOT NULL REFERENCES vlx_users(id) ON DELETE CASCADE,
        token TEXT UNIQUE NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    /* ASSETS */
    await client.query(`
      CREATE TABLE IF NOT EXISTS vlx_assets (
        id BIGSERIAL PRIMARY KEY,
        symbol TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        decimals INTEGER NOT NULL DEFAULT 18,
        active BOOLEAN NOT NULL DEFAULT TRUE,
        listing_date DATE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    /* BALANCES */
    await client.query(`
      CREATE TABLE IF NOT EXISTS vlx_balances (
        id BIGSERIAL PRIMARY KEY,
        user_id BIGINT NOT NULL REFERENCES vlx_users(id) ON DELETE CASCADE,
        asset_id BIGINT NOT NULL REFERENCES vlx_assets(id) ON DELETE CASCADE,
        available NUMERIC(50,18) NOT NULL DEFAULT 0,
        locked NUMERIC(50,18) NOT NULL DEFAULT 0,
        UNIQUE(user_id, asset_id)
      )
    `);

    /* LEDGER */
    await client.query(`
      CREATE TABLE IF NOT EXISTS vlx_ledger_entries (
        id BIGSERIAL PRIMARY KEY,
        user_id BIGINT REFERENCES vlx_users(id),
        asset_id BIGINT REFERENCES vlx_assets(id),
        amount NUMERIC(50,18) NOT NULL DEFAULT 0,
        type TEXT NOT NULL,
        reference_id TEXT,
        note TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    /* ORDERS */
    await client.query(`
      CREATE TABLE IF NOT EXISTS vlx_orders (
        id BIGSERIAL PRIMARY KEY,
        user_id BIGINT NOT NULL REFERENCES vlx_users(id),
        symbol TEXT NOT NULL,
        side TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'limit',
        price NUMERIC(50,18),
        amount NUMERIC(50,18) NOT NULL,
        remaining_amount NUMERIC(50,18) NOT NULL,
        quote_amount NUMERIC(50,18),
        remaining_quote NUMERIC(50,18),
        status TEXT NOT NULL DEFAULT 'OPEN',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    /* TRADES */
    await client.query(`
      CREATE TABLE IF NOT EXISTS vlx_trades (
        id BIGSERIAL PRIMARY KEY,
        symbol TEXT NOT NULL,
        maker_order_id BIGINT,
        taker_order_id BIGINT,
        price NUMERIC(50,18) NOT NULL,
        amount NUMERIC(50,18) NOT NULL,
        quote_amount NUMERIC(50,18),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    /* DEPOSITS */
    await client.query(`
      CREATE TABLE IF NOT EXISTS vlx_deposits (
        id BIGSERIAL PRIMARY KEY,
        user_id BIGINT NOT NULL REFERENCES vlx_users(id),
        asset_symbol TEXT NOT NULL,
        amount NUMERIC(50,18) NOT NULL DEFAULT 0,
        tx_hash TEXT,
        network TEXT,
        status TEXT NOT NULL DEFAULT 'PENDING',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    /* WITHDRAWALS */
    await client.query(`
      CREATE TABLE IF NOT EXISTS vlx_withdrawals (
        id BIGSERIAL PRIMARY KEY,
        user_id BIGINT NOT NULL REFERENCES vlx_users(id),
        asset_symbol TEXT NOT NULL,
        amount NUMERIC(50,18) NOT NULL DEFAULT 0,
        address TEXT,
        network TEXT,
        status TEXT NOT NULL DEFAULT 'PENDING',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    /* AUDIT */
    await client.query(`
      CREATE TABLE IF NOT EXISTS vlx_audit_logs (
        id BIGSERIAL PRIMARY KEY,
        user_id BIGINT,
        action TEXT NOT NULL,
        details JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    /* =====================================================
       AUTOMATIC MIGRATION
       دا برخه ستا اصلي ستونزه حل کوي
    ===================================================== */

    await client.query(`
      ALTER TABLE vlx_assets
      ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE
    `);

    await client.query(`
      ALTER TABLE vlx_assets
      ADD COLUMN IF NOT EXISTS listing_date DATE
    `);

    await client.query(`
      ALTER TABLE vlx_users
      ADD COLUMN IF NOT EXISTS telegram_user_id TEXT
    `);

    await client.query(`
      ALTER TABLE vlx_orders
      ADD COLUMN IF NOT EXISTS quote_amount NUMERIC(50,18)
    `);

    await client.query(`
      ALTER TABLE vlx_orders
      ADD COLUMN IF NOT EXISTS remaining_quote NUMERIC(50,18)
    `);

    await client.query(`
      ALTER TABLE vlx_trades
      ADD COLUMN IF NOT EXISTS quote_amount NUMERIC(50,18)
    `);

    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS
      vlx_users_telegram_unique
      ON vlx_users(telegram_user_id)
      WHERE telegram_user_id IS NOT NULL
    `);

    /* =====================================================
       ASSETS
    ===================================================== */

    const assets = [
      ["USDT", "Tether", true, null],
      ["BTC", "Bitcoin", true, null],
      ["ETH", "Ethereum", true, null],
      ["SOL", "Solana", true, null],
      ["XRP", "XRP", true, null],
      ["TON", "Toncoin", true, null],
      ["SHIB", "Shiba Inu", true, null],
      ["VLX", "VELTRIX", true, "2026-11-24"]
    ];

    for (const [symbol, name, active, listingDate] of assets) {
      await client.query(
        `
        INSERT INTO vlx_assets
          (symbol, name, active, listing_date)
        VALUES ($1,$2,$3,$4)
        ON CONFLICT (symbol)
        DO UPDATE SET
          name = EXCLUDED.name,
          active = EXCLUDED.active,
          listing_date = EXCLUDED.listing_date
        `,
        [symbol, name, active, listingDate]
      );
    }

    await client.query("COMMIT");

    console.log("Database initialization completed successfully.");
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Database initialization error:", error);
    throw error;
  } finally {
    client.release();
  }
}

/* =========================================================
   HELPERS
========================================================= */

function sendError(res, status, message) {
  return res.status(status).json({
    ok: false,
    error: message
  });
}

function makeToken() {
  return crypto.randomBytes(48).toString("hex");
}

function nowPlusDays(days) {
  return new Date(Date.now() + days * 86400000);
}

async function currentUser(req) {
  const token = req.cookies.vlx_session;

  if (!token) return null;

  const result = await pool.query(
    `
    SELECT u.*
    FROM vlx_sessions s
    JOIN vlx_users u ON u.id = s.user_id
    WHERE s.token = $1
      AND s.expires_at > NOW()
    `,
    [token]
  );

  return result.rows[0] || null;
}

async function requireAuth(req, res, next) {
  try {
    const user = await currentUser(req);

    if (!user) {
      return sendError(res, 401, "Authentication required");
    }

    req.user = user;
    next();
  } catch (error) {
    console.error(error);
    sendError(res, 500, "Authentication error");
  }
}

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    firstName: user.first_name,
    email: user.email,
    isAdmin: user.is_admin
  };
}

async function getAsset(symbol) {
  const result = await pool.query(
    `SELECT * FROM vlx_assets WHERE UPPER(symbol)=UPPER($1)`,
    [symbol]
  );

  return result.rows[0] || null;
}

async function ensureBalance(userId, assetId) {
  await pool.query(
    `
    INSERT INTO vlx_balances
      (user_id, asset_id, available, locked)
    VALUES ($1,$2,0,0)
    ON CONFLICT (user_id, asset_id) DO NOTHING
    `,
    [userId, assetId]
  );
}

/* =========================================================
   RATE LIMIT
========================================================= */

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 50,
  standardHeaders: true,
  legacyHeaders: false
});

/* =========================================================
   HEALTH
========================================================= */

app.get("/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");

    res.json({
      ok: true,
      project: "VELTRIX EXCHANGE",
      symbol: "VLX",
      database: "PostgreSQL",
      status: "online"
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: "Database unavailable"
    });
  }
});

app.get("/api/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");

    res.json({
      ok: true,
      project: "VELTRIX EXCHANGE",
      symbol: "VLX",
      database: "PostgreSQL"
    });
  } catch (error) {
    sendError(res, 500, "Database unavailable");
  }
});

/* =========================================================
   CONFIG
========================================================= */

app.get("/api/config", (req, res) => {
  res.json({
    ok: true,
    project: "VELTRIX EXCHANGE",
    name: "VELTRIX",
    symbol: "VLX",
    database: "PostgreSQL",
    blockchainEnabled: false,
    vlxListingDate: "2026-11-24"
  });
});

/* =========================================================
   REGISTER
========================================================= */

async function registerHandler(req, res) {
  try {
    const username = String(req.body?.username || "").trim();
    const email = String(req.body?.email || "").trim().toLowerCase();
    const password = String(req.body?.password || "");

    if (!email || !password) {
      return sendError(res, 400, "Email and password are required");
    }

    if (password.length < 6) {
      return sendError(res, 400, "Password must be at least 6 characters");
    }

    const existing = await pool.query(
      `SELECT id FROM vlx_users WHERE email=$1`,
      [email]
    );

    if (existing.rows.length) {
      return sendError(res, 409, "Email already registered");
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const result = await pool.query(
      `
      INSERT INTO vlx_users
        (username, first_name, email, password_hash)
      VALUES ($1,$2,$3,$4)
      RETURNING *
      `,
      [username || email.split("@")[0], username || "", email, passwordHash]
    );

    const user = result.rows[0];

    const assets = await pool.query(
      `SELECT id FROM vlx_assets WHERE active=true`
    );

    for (const asset of assets.rows) {
      await ensureBalance(user.id, asset.id);
    }

    const token = makeToken();

    await pool.query(
      `
      INSERT INTO vlx_sessions
        (user_id, token, expires_at)
      VALUES ($1,$2,$3)
      `,
      [user.id, token, nowPlusDays(30)]
    );

    res.cookie("vlx_session", token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 30 * 86400000
    });

    res.json({
      ok: true,
      user: publicUser(user)
    });
  } catch (error) {
    console.error("Register error:", error);
    sendError(res, 500, "Registration failed");
  }
}

app.post("/api/register", authLimiter, registerHandler);
app.post("/api/auth/register", authLimiter, registerHandler);

/* =========================================================
   LOGIN
========================================================= */

async function loginHandler(req, res) {
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    const password = String(req.body?.password || "");

    if (!email || !password) {
      return sendError(res, 400, "Email and password are required");
    }

    const result = await pool.query(
      `SELECT * FROM vlx_users WHERE email=$1`,
      [email]
    );

    const user = result.rows[0];

    if (!user || !user.password_hash) {
      return sendError(res, 401, "Invalid email or password");
    }

    const valid = await bcrypt.compare(password, user.password_hash);

    if (!valid) {
      return sendError(res, 401, "Invalid email or password");
    }

    const token = makeToken();

    await pool.query(
      `
      INSERT INTO vlx_sessions
        (user_id, token, expires_at)
      VALUES ($1,$2,$3)
      `,
      [user.id, token, nowPlusDays(30)]
    );

    res.cookie("vlx_session", token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 30 * 86400000
    });

    res.json({
      ok: true,
      user: publicUser(user)
    });
  } catch (error) {
    console.error("Login error:", error);
    sendError(res, 500, "Login failed");
  }
}

app.post("/api/login", authLimiter, loginHandler);
app.post("/api/auth/login", authLimiter, loginHandler);

/* =========================================================
   ME
========================================================= */

async function meHandler(req, res) {
  try {
    const user = await currentUser(req);

    res.json({
      ok: true,
      authenticated: !!user,
      user: user ? publicUser(user) : null
    });
  } catch (error) {
    sendError(res, 500, "Unable to load account");
  }
}

app.get("/api/me", meHandler);
app.get("/api/auth/me", meHandler);

/* =========================================================
   LOGOUT
========================================================= */

async function logoutHandler(req, res) {
  try {
    const token = req.cookies.vlx_session;

    if (token) {
      await pool.query(
        `DELETE FROM vlx_sessions WHERE token=$1`,
        [token]
      );
    }

    res.clearCookie("vlx_session");

    res.json({
      ok: true
    });
  } catch (error) {
    sendError(res, 500, "Logout failed");
  }
}

app.post("/api/logout", logoutHandler);
app.post("/api/auth/logout", logoutHandler);

/* =========================================================
   ASSETS
========================================================= */

app.get("/api/assets", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        id,
        symbol,
        name,
        decimals,
        active,
        listing_date AS "listingDate"
      FROM vlx_assets
      ORDER BY
        CASE WHEN symbol='VLX' THEN 0 ELSE 1 END,
        symbol
    `);

    res.json({
      ok: true,
      assets: result.rows
    });
  } catch (error) {
    console.error(error);
    sendError(res, 500, "Unable to load assets");
  }
});

/* =========================================================
   BALANCES
========================================================= */

app.get("/api/balances", requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT
        a.symbol,
        a.name,
        b.available,
        b.locked
      FROM vlx_balances b
      JOIN vlx_assets a ON a.id=b.asset_id
      WHERE b.user_id=$1
      ORDER BY a.symbol
      `,
      [req.user.id]
    );

    res.json({
      ok: true,
      balances: result.rows
    });
  } catch (error) {
    sendError(res, 500, "Unable to load balances");
  }
});

/* =========================================================
   ORDER BOOK
========================================================= */

app.get("/api/orderbook/:symbol", async (req, res) => {
  try {
    const symbol = String(req.params.symbol || "").toUpperCase();

    const buys = await pool.query(
      `
      SELECT
        price,
        SUM(remaining_amount) AS amount
      FROM vlx_orders
      WHERE symbol=$1
        AND side='buy'
        AND status='OPEN'
        AND remaining_amount > 0
      GROUP BY price
      ORDER BY price DESC
      LIMIT 50
      `,
      [symbol]
    );

    const sells = await pool.query(
      `
      SELECT
        price,
        SUM(remaining_amount) AS amount
      FROM vlx_orders
      WHERE symbol=$1
        AND side='sell'
        AND status='OPEN'
        AND remaining_amount > 0
      GROUP BY price
      ORDER BY price ASC
      LIMIT 50
      `,
      [symbol]
    );

    res.json({
      ok: true,
      bids: buys.rows,
      asks: sells.rows
    });
  } catch (error) {
    sendError(res, 500, "Unable to load order book");
  }
});

/* =========================================================
   PLACE ORDER
========================================================= */

app.post("/api/orders", requireAuth, async (req, res) => {
  const client = await pool.connect();

  try {
    const symbol = String(req.body?.symbol || "").toUpperCase();
    const side = String(req.body?.side || "").toLowerCase();
    const type = String(req.body?.type || "limit").toLowerCase();

    const amount = Number(req.body?.amount);
    const price = Number(req.body?.price);

    if (!symbol || !["buy", "sell"].includes(side)) {
      return sendError(res, 400, "Invalid order");
    }

    if (!Number.isFinite(amount) || amount <= 0) {
      return sendError(res, 400, "Invalid amount");
    }

    if (type === "limit" && (!Number.isFinite(price) || price <= 0)) {
      return sendError(res, 400, "Invalid price");
    }

    const [base, quote] = symbol.split("/");

    if (!base || !quote) {
      return sendError(res, 400, "Invalid trading pair");
    }

    const baseAsset = await getAsset(base);
    const quoteAsset = await getAsset(quote);

    if (!baseAsset || !quoteAsset) {
      return sendError(res, 400, "Trading pair not supported");
    }

    if (base === "VLX") {
      const listing = new Date("2026-11-24T00:00:00Z");

      if (new Date() < listing) {
        return sendError(
          res,
          403,
          "VLX trading is not available until 2026-11-24"
        );
      }
    }

    await client.query("BEGIN");

    await client.query(
      `
      INSERT INTO vlx_balances
        (user_id,asset_id,available,locked)
      VALUES
        ($1,$2,0,0)
      ON CONFLICT (user_id,asset_id) DO NOTHING
      `,
      [req.user.id, baseAsset.id]
    );

    await client.query(
      `
      INSERT INTO vlx_balances
        (user_id,asset_id,available,locked)
      VALUES
        ($1,$2,0,0)
      ON CONFLICT (user_id,asset_id) DO NOTHING
      `,
      [req.user.id, quoteAsset.id]
    );

    const quoteAmount = amount * (type === "market" ? 0 : price);

    const balanceAssetId = side === "sell"
      ? baseAsset.id
      : quoteAsset.id;

    const required = side === "sell"
      ? amount
      : quoteAmount;

    const balance = await client.query(
      `
      SELECT available
      FROM vlx_balances
      WHERE user_id=$1 AND asset_id=$2
      FOR UPDATE
      `,
      [req.user.id, balanceAssetId]
    );

    const available = Number(balance.rows[0]?.available || 0);

    if (available < required) {
      await client.query("ROLLBACK");
      return sendError(res, 400, "Insufficient balance");
    }

    await client.query(
      `
      UPDATE vlx_balances
      SET
        available=available-$1,
        locked=locked+$1
      WHERE user_id=$2 AND asset_id=$3
      `,
      [required, req.user.id, balanceAssetId]
    );

    const result = await client.query(
      `
      INSERT INTO vlx_orders
        (
          user_id,
          symbol,
          side,
          type,
          price,
          amount,
          remaining_amount,
          quote_amount,
          remaining_quote,
          status
        )
      VALUES
        ($1,$2,$3,$4,$5,$6,$6,$7,$7,'OPEN')
      RETURNING *
      `,
      [
        req.user.id,
        symbol,
        side,
        type,
        type === "market" ? null : price,
        amount,
        quoteAmount
      ]
    );

    await client.query("COMMIT");

    res.json({
      ok: true,
      order: result.rows[0]
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Order error:", error);
    sendError(res, 500, "Unable to place order");
  } finally {
    client.release();
  }
});

/* =========================================================
   USER ORDERS
========================================================= */

app.get("/api/orders", requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT *
      FROM vlx_orders
      WHERE user_id=$1
      ORDER BY id DESC
      LIMIT 200
      `,
      [req.user.id]
    );

    res.json({
      ok: true,
      orders: result.rows
    });
  } catch (error) {
    sendError(res, 500, "Unable to load orders");
  }
});

/* =========================================================
   CANCEL ORDER
========================================================= */

app.post("/api/orders/:id/cancel", requireAuth, async (req, res) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const orderResult = await client.query(
      `
      SELECT *
      FROM vlx_orders
      WHERE id=$1 AND user_id=$2
      FOR UPDATE
      `,
      [req.params.id, req.user.id]
    );

    const order = orderResult.rows[0];

    if (!order) {
      await client.query("ROLLBACK");
      return sendError(res, 404, "Order not found");
    }

    if (order.status !== "OPEN") {
      await client.query("ROLLBACK");
      return sendError(res, 400, "Order is not open");
    }

    const [base, quote] = order.symbol.split("/");

    const asset = await getAsset(
      order.side === "sell" ? base : quote
    );

    const refund = order.side === "sell"
      ? Number(order.remaining_amount)
      : Number(order.remaining_quote || 0);

    await client.query(
      `
      UPDATE vlx_balances
      SET
        locked=GREATEST(locked-$1,0),
        available=available+$1
      WHERE user_id=$2 AND asset_id=$3
      `,
      [refund, req.user.id, asset.id]
    );

    await client.query(
      `
      UPDATE vlx_orders
      SET
        status='CANCELED',
        updated_at=NOW()
      WHERE id=$1
      `,
      [order.id]
    );

    await client.query("COMMIT");

    res.json({
      ok: true
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(error);
    sendError(res, 500, "Unable to cancel order");
  } finally {
    client.release();
  }
});

/* =========================================================
   TRADES
========================================================= */

app.get("/api/trades/:symbol", async (req, res) => {
  try {
    const symbol = String(req.params.symbol || "").toUpperCase();

    const result = await pool.query(
      `
      SELECT
        id,
        symbol,
        price,
        amount,
        quote_amount AS "quoteAmount",
        EXTRACT(EPOCH FROM created_at) AS time
      FROM vlx_trades
      WHERE symbol=$1
      ORDER BY id DESC
      LIMIT 200
      `,
      [symbol]
    );

    res.json({
      ok: true,
      trades: result.rows
    });
  } catch (error) {
    sendError(res, 500, "Unable to load trades");
  }
});

/* =========================================================
   MARKET
========================================================= */

app.get("/api/market/:symbol", async (req, res) => {
  try {
    const symbol = String(req.params.symbol || "").toUpperCase();

    const result = await pool.query(
      `
      SELECT
        price,
        amount,
        created_at
      FROM vlx_trades
      WHERE symbol=$1
      ORDER BY id DESC
      LIMIT 1
      `,
      [symbol]
    );

    const last = result.rows[0] || null;

    res.json({
      ok: true,
      symbol,
      price: last ? Number(last.price) : 0,
      amount: last ? Number(last.amount) : 0,
      time: last ? last.created_at : null
    });
  } catch (error) {
    sendError(res, 500, "Unable to load market");
  }
});

/* =========================================================
   CANDLES
========================================================= */

app.get("/api/candles/:symbol", async (req, res) => {
  try {
    const symbol = String(req.params.symbol || "").toUpperCase();
    const limit = Math.min(Number(req.query.limit || 200), 500);

    const result = await pool.query(
      `
      SELECT
        EXTRACT(EPOCH FROM date_trunc('minute', created_at)) AS time,
        MIN(price) AS low,
        MAX(price) AS high,
        (ARRAY_AGG(price ORDER BY created_at ASC))[1] AS open,
        (ARRAY_AGG(price ORDER BY created_at DESC))[1] AS close,
        SUM(amount) AS volume
      FROM vlx_trades
      WHERE symbol=$1
      GROUP BY date_trunc('minute', created_at)
      ORDER BY time DESC
      LIMIT $2
      `,
      [symbol, limit]
    );

    res.json({
      ok: true,
      candles: result.rows.reverse().map(x => ({
        time: Number(x.time),
        open: Number(x.open),
        high: Number(x.high),
        low: Number(x.low),
        close: Number(x.close),
        volume: Number(x.volume || 0)
      }))
    });
  } catch (error) {
    sendError(res, 500, "Unable to load candles");
  }
});

/* =========================================================
   LISTING
========================================================= */

app.get("/api/listing", (req, res) => {
  res.json({
    ok: true,
    symbol: "VLX",
    name: "VELTRIX",
    listingDate: "2026-11-24",
    tradingEnabled: new Date() >= new Date("2026-11-24T00:00:00Z")
  });
});

/* =========================================================
   DEPOSITS
========================================================= */

app.get("/api/deposits", requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT *
      FROM vlx_deposits
      WHERE user_id=$1
      ORDER BY id DESC
      LIMIT 100
      `,
      [req.user.id]
    );

    res.json({
      ok: true,
      blockchainEnabled: false,
      deposits: result.rows
    });
  } catch (error) {
    sendError(res, 500, "Unable to load deposits");
  }
});

/* =========================================================
   WITHDRAWALS
========================================================= */

app.get("/api/withdrawals", requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT *
      FROM vlx_withdrawals
      WHERE user_id=$1
      ORDER BY id DESC
      LIMIT 100
      `,
      [req.user.id]
    );

    res.json({
      ok: true,
      blockchainEnabled: false,
      withdrawals: result.rows
    });
  } catch (error) {
    sendError(res, 500, "Unable to load withdrawals");
  }
});

/* =========================================================
   TELEGRAM ACCOUNT LINK
========================================================= */

app.post("/api/telegram/link", requireAuth, async (req, res) => {
  try {
    const telegramUserId = String(
      req.body?.telegramUserId || ""
    ).trim();

    if (!telegramUserId) {
      return sendError(res, 400, "Telegram user ID required");
    }

    await pool.query(
      `
      UPDATE vlx_users
      SET telegram_user_id=$1
      WHERE id=$2
      `,
      [telegramUserId, req.user.id]
    );

    res.json({
      ok: true
    });
  } catch (error) {
    console.error(error);
    sendError(res, 500, "Unable to link Telegram");
  }
});

/* =========================================================
   TELEGRAM MINER CREDIT
========================================================= */

app.post("/api/telegram/credit", async (req, res) => {
  try {
    const telegramUserId = String(
      req.body?.telegramUserId || ""
    );

    const amount = Number(req.body?.amount || 0);
    const signature = String(req.body?.signature || "");

    if (!telegramUserId || !Number.isFinite(amount) || amount <= 0) {
      return sendError(res, 400, "Invalid request");
    }

    if (!BOT_TOKEN || !signature) {
      return sendError(res, 403, "Telegram integration not configured");
    }

    const message = `${telegramUserId}:${amount}`;

    const expected = crypto
      .createHmac("sha256", BOT_TOKEN)
      .update(message)
      .digest("hex");

    if (
      expected.length !== signature.length ||
      !crypto.timingSafeEqual(
        Buffer.from(expected),
        Buffer.from(signature)
      )
    ) {
      return sendError(res, 403, "Invalid signature");
    }

    const userResult = await pool.query(
      `
      SELECT *
      FROM vlx_users
      WHERE telegram_user_id=$1
      `,
      [telegramUserId]
    );

    const user = userResult.rows[0];

    if (!user) {
      return sendError(res, 404, "Telegram account not linked");
    }

    const asset = await getAsset("VLX");

    await ensureBalance(user.id, asset.id);

    await pool.query(
      `
      UPDATE vlx_balances
      SET available=available+$1
      WHERE user_id=$2 AND asset_id=$3
      `,
      [amount, user.id, asset.id]
    );

    await pool.query(
      `
      INSERT INTO vlx_ledger_entries
        (user_id,asset_id,amount,type,note)
      VALUES
        ($1,$2,$3,'TELEGRAM_MINER','VLX Miner credit')
      `,
      [user.id, asset.id, amount]
    );

    res.json({
      ok: true,
      credited: amount
    });
  } catch (error) {
    console.error("Telegram credit error:", error);
    sendError(res, 500, "Unable to credit VLX");
  }
});

/* =========================================================
   ADMIN WITHDRAWALS
========================================================= */

function adminOnly(req, res, next) {
  const adminId =
    String(req.headers["x-admin-id"] || req.body?.adminId || "");

  if (!ADMIN_ID || adminId !== ADMIN_ID) {
    return sendError(res, 403, "Forbidden");
  }

  next();
}

app.get(
  "/api/admin/withdrawals",
  adminOnly,
  async (req, res) => {
    try {
      const result = await pool.query(`
        SELECT
          w.*,
          u.email,
          u.username,
          u.first_name
        FROM vlx_withdrawals w
        JOIN vlx_users u ON u.id=w.user_id
        ORDER BY w.id DESC
        LIMIT 200
      `);

      res.json({
        ok: true,
        withdrawals: result.rows
      });
    } catch (error) {
      sendError(res, 500, "Unable to load admin withdrawals");
    }
  }
);

app.post(
  "/api/admin/withdrawals/:id/status",
  adminOnly,
  async (req, res) => {
    try {
      const status = String(
        req.body?.status || ""
      ).toUpperCase();

      const allowed = [
        "PENDING",
        "APPROVED",
        "REJECTED",
        "PAID"
      ];

      if (!allowed.includes(status)) {
        return sendError(res, 400, "Invalid status");
      }

      await pool.query(
        `
        UPDATE vlx_withdrawals
        SET
          status=$1,
          updated_at=NOW()
        WHERE id=$2
        `,
        [status, req.params.id]
      );

      res.json({
        ok: true
      });
    } catch (error) {
      sendError(res, 500, "Unable to update withdrawal");
    }
  }
);

/* =========================================================
   API 404
   مهم: د HTML پر ځای JSON ورکوي
========================================================= */

app.use("/api", (req, res) => {
  res.status(404).json({
    ok: false,
    error: "API endpoint not found",
    path: req.originalUrl
  });
});

/* =========================================================
   FRONTEND
========================================================= */

const publicPath = path.join(__dirname, "public");

app.use(express.static(publicPath));

app.get("*", (req, res) => {
  res.sendFile(path.join(publicPath, "index.html"));
});

/* =========================================================
   START
========================================================= */

async function start() {
  try {
    console.log("Starting VELTRIX EXCHANGE...");

    await initDatabase();

    app.listen(PORT, "0.0.0.0", () => {
      console.log(
        `VELTRIX EXCHANGE running on port ${PORT}`
      );
    });
  } catch (error) {
    console.error(
      "VELTRIX EXCHANGE failed to start:",
      error
    );

    process.exit(1);
  }
}

start();
