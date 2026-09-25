const express = require("express");
const path = require("path");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const cookieParser = require("cookie-parser");
const rateLimit = require("express-rate-limit");
const { Pool } = require("pg");
const Decimal = require("decimal.js");

const app = express();

Decimal.set({
  precision: 50,
  rounding: Decimal.ROUND_DOWN
});

app.set("trust proxy", 1);

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

const PORT = process.env.PORT || 10000;
const DATABASE_URL = process.env.DATABASE_URL;

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

const SESSION_DAYS = 30;
const MINER_API_SECRET = process.env.MINER_API_SECRET || "";

const ASSETS = [
  {
    symbol: "USDT",
    name: "Tether",
    decimals: 6,
    active: true
  },
  {
    symbol: "BTC",
    name: "Bitcoin",
    decimals: 8,
    active: true
  },
  {
    symbol: "ETH",
    name: "Ethereum",
    decimals: 8,
    active: true
  },
  {
    symbol: "SOL",
    name: "Solana",
    decimals: 8,
    active: true
  },
  {
    symbol: "XRP",
    name: "XRP",
    decimals: 6,
    active: true
  },
  {
    symbol: "TON",
    name: "Toncoin",
    decimals: 8,
    active: true
  },
  {
    symbol: "SHIB",
    name: "Shiba Inu",
    decimals: 8,
    active: true
  },
  {
    symbol: "VLX",
    name: "VELTRIX",
    decimals: 8,
    active: true,
    listingDate: "2026-11-24"
  }
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

function cleanEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function safeUser(user) {
  if (!user) return null;

  return {
    id: user.id,
    email: user.email,
    display_name: user.display_name,
    role: user.role,
    telegram_user_id: user.telegram_user_id || null,
    created_at: user.created_at
  };
}

function validNumber(value) {
  try {
    const d = new Decimal(value);
    return d.isFinite() && d.gt(0);
  } catch {
    return false;
  }
}

function normalizeSymbol(symbol) {
  return String(symbol || "").trim().toUpperCase();
}

function normalizeSide(side) {
  side = String(side || "").trim().toLowerCase();

  if (side !== "buy" && side !== "sell") {
    return null;
  }

  return side;
}

function normalizeOrderType(type) {
  type = String(type || "limit").trim().toLowerCase();

  if (type !== "limit" && type !== "market") {
    return null;
  }

  return type;
}

function parsePair(symbol) {
  const value = normalizeSymbol(symbol);

  if (!value.includes("/")) return null;

  const [base, quote] = value.split("/");

  if (!base || !quote) return null;

  return { base, quote };
}

function isVLXTradingAllowed() {
  const today = new Date();
  const listing = new Date("2026-11-24T00:00:00Z");

  return today >= listing;
}

/* -------------------------------------------------------
   DATABASE
------------------------------------------------------- */

async function initDatabase() {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    await client.query(`
      CREATE TABLE IF NOT EXISTS vlx_users (
        id BIGSERIAL PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        display_name TEXT,
        role TEXT NOT NULL DEFAULT 'user',
        telegram_user_id TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS
      vlx_users_telegram_unique
      ON vlx_users(telegram_user_id)
      WHERE telegram_user_id IS NOT NULL
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS vlx_sessions (
        id TEXT PRIMARY KEY,
        user_id BIGINT NOT NULL REFERENCES vlx_users(id) ON DELETE CASCADE,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS vlx_assets (
        id BIGSERIAL PRIMARY KEY,
        symbol TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        decimals INTEGER NOT NULL DEFAULT 8,
        active BOOLEAN NOT NULL DEFAULT TRUE,
        listing_date DATE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS vlx_balances (
        id BIGSERIAL PRIMARY KEY,
        user_id BIGINT NOT NULL REFERENCES vlx_users(id) ON DELETE CASCADE,
        asset_id BIGINT NOT NULL REFERENCES vlx_assets(id) ON DELETE CASCADE,
        available NUMERIC(50,18) NOT NULL DEFAULT 0,
        locked NUMERIC(50,18) NOT NULL DEFAULT 0,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(user_id, asset_id)
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS vlx_ledger_entries (
        id BIGSERIAL PRIMARY KEY,
        user_id BIGINT NOT NULL REFERENCES vlx_users(id) ON DELETE CASCADE,
        asset_id BIGINT NOT NULL REFERENCES vlx_assets(id),
        amount NUMERIC(50,18) NOT NULL,
        type TEXT NOT NULL,
        reference_id TEXT,
        note TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS vlx_orders (
        id BIGSERIAL PRIMARY KEY,
        user_id BIGINT NOT NULL REFERENCES vlx_users(id) ON DELETE CASCADE,
        symbol TEXT NOT NULL,
        side TEXT NOT NULL,
        type TEXT NOT NULL,
        price NUMERIC(50,18),
        amount NUMERIC(50,18) NOT NULL,
        remaining NUMERIC(50,18) NOT NULL,
        quote_amount NUMERIC(50,18),
        remaining_quote NUMERIC(50,18),
        status TEXT NOT NULL DEFAULT 'open',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS vlx_trades (
        id BIGSERIAL PRIMARY KEY,
        symbol TEXT NOT NULL,
        maker_order_id BIGINT,
        taker_order_id BIGINT,
        maker_user_id BIGINT REFERENCES vlx_users(id),
        taker_user_id BIGINT REFERENCES vlx_users(id),
        price NUMERIC(50,18) NOT NULL,
        amount NUMERIC(50,18) NOT NULL,
        quote_amount NUMERIC(50,18) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS vlx_deposits (
        id BIGSERIAL PRIMARY KEY,
        user_id BIGINT NOT NULL REFERENCES vlx_users(id),
        asset_symbol TEXT NOT NULL,
        amount NUMERIC(50,18),
        tx_hash TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS vlx_withdrawals (
        id BIGSERIAL PRIMARY KEY,
        user_id BIGINT NOT NULL REFERENCES vlx_users(id),
        asset_symbol TEXT NOT NULL,
        amount NUMERIC(50,18),
        address TEXT,
        tx_hash TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS vlx_audit_logs (
        id BIGSERIAL PRIMARY KEY,
        user_id BIGINT,
        action TEXT NOT NULL,
        details TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    for (const asset of ASSETS) {
      await client.query(
        `
        INSERT INTO vlx_assets
          (symbol, name, decimals, active, listing_date)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT(symbol)
        DO UPDATE SET
          name = EXCLUDED.name,
          decimals = EXCLUDED.decimals,
          active = EXCLUDED.active,
          listing_date = EXCLUDED.listing_date
        `,
        [
          asset.symbol,
          asset.name,
          asset.decimals,
          asset.active,
          asset.listingDate || null
        ]
      );
    }

    await client.query("COMMIT");

    console.log("VELTRIX database initialized successfully");
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Database initialization error:", error);
    throw error;
  } finally {
    client.release();
  }
}

/* -------------------------------------------------------
   AUTH / SESSION
------------------------------------------------------- */

function createSessionId() {
  return crypto.randomBytes(32).toString("hex");
}

async function createSession(userId) {
  const sessionId = createSessionId();

  await pool.query(
    `
    INSERT INTO vlx_sessions
      (id, user_id, expires_at)
    VALUES
      ($1, $2, NOW() + ($3 * INTERVAL '1 day'))
    `,
    [sessionId, userId, SESSION_DAYS]
  );

  return sessionId;
}

async function getCurrentUser(req) {
  const sessionId = req.cookies?.vlx_session;

  if (!sessionId) return null;

  const result = await pool.query(
    `
    SELECT u.*
    FROM vlx_sessions s
    JOIN vlx_users u ON u.id = s.user_id
    WHERE s.id = $1
      AND s.expires_at > NOW()
    LIMIT 1
    `,
    [sessionId]
  );

  return result.rows[0] || null;
}

async function requireAuth(req, res, next) {
  try {
    const user = await getCurrentUser(req);

    if (!user) {
      return res.status(401).json({
        ok: false,
        error: "Authentication required"
      });
    }

    req.user = user;
    next();
  } catch (error) {
    console.error("AUTH middleware:", error);

    return res.status(500).json({
      ok: false,
      error: "Authentication error"
    });
  }
}

async function registerHandler(req, res) {
  try {
    const email = cleanEmail(req.body.email);
    const password = String(req.body.password || "");
    const displayName =
      String(
        req.body.display_name ||
        req.body.displayName ||
        email.split("@")[0] ||
        ""
      ).trim();

    if (!email || !email.includes("@")) {
      return res.status(400).json({
        ok: false,
        error: "Valid email is required"
      });
    }

    if (password.length < 6) {
      return res.status(400).json({
        ok: false,
        error: "Password must contain at least 6 characters"
      });
    }

    const exists = await pool.query(
      `SELECT id FROM vlx_users WHERE email = $1 LIMIT 1`,
      [email]
    );

    if (exists.rows.length) {
      return res.status(409).json({
        ok: false,
        error: "Email already registered"
      });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const result = await pool.query(
      `
      INSERT INTO vlx_users
        (email, password_hash, display_name)
      VALUES
        ($1, $2, $3)
      RETURNING *
      `,
      [email, passwordHash, displayName]
    );

    const user = result.rows[0];

    const sessionId = await createSession(user.id);

    res.cookie("vlx_session", sessionId, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: SESSION_DAYS * 24 * 60 * 60 * 1000
    });

    return res.status(201).json({
      ok: true,
      user: safeUser(user)
    });
  } catch (error) {
    console.error("REGISTER error:", error);

    return res.status(500).json({
      ok: false,
      error: "Registration failed"
    });
  }
}

async function loginHandler(req, res) {
  try {
    const email = cleanEmail(req.body.email);
    const password = String(req.body.password || "");

    if (!email || !password) {
      return res.status(400).json({
        ok: false,
        error: "Email and password are required"
      });
    }

    const result = await pool.query(
      `
      SELECT *
      FROM vlx_users
      WHERE email = $1
      LIMIT 1
      `,
      [email]
    );

    if (!result.rows.length) {
      return res.status(401).json({
        ok: false,
        error: "Invalid email or password"
      });
    }

    const user = result.rows[0];

    const passwordOk = await bcrypt.compare(
      password,
      user.password_hash
    );

    if (!passwordOk) {
      return res.status(401).json({
        ok: false,
        error: "Invalid email or password"
      });
    }

    const sessionId = await createSession(user.id);

    res.cookie("vlx_session", sessionId, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: SESSION_DAYS * 24 * 60 * 60 * 1000
    });

    return res.json({
      ok: true,
      user: safeUser(user)
    });
  } catch (error) {
    console.error("LOGIN error:", error);

    return res.status(500).json({
      ok: false,
      error: "Login failed"
    });
  }
}

/* -------------------------------------------------------
   RATE LIMIT
------------------------------------------------------- */

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false
});

app.use("/api/login", authLimiter);
app.use("/api/register", authLimiter);
app.use("/api/auth/login", authLimiter);
app.use("/api/auth/register", authLimiter);

/* -------------------------------------------------------
   AUTH ROUTES
------------------------------------------------------- */

app.post("/api/register", registerHandler);
app.post("/api/auth/register", registerHandler);

app.post("/api/login", loginHandler);
app.post("/api/auth/login", loginHandler);

app.get("/api/me", async (req, res) => {
  try {
    const user = await getCurrentUser(req);

    res.json({
      ok: true,
      user: safeUser(user)
    });
  } catch (error) {
    console.error("ME error:", error);

    res.status(500).json({
      ok: false,
      user: null,
      error: "Unable to load account"
    });
  }
});

app.get("/api/auth/me", async (req, res) => {
  try {
    const user = await getCurrentUser(req);

    res.json({
      ok: true,
      user: safeUser(user)
    });
  } catch (error) {
    console.error("AUTH ME error:", error);

    res.status(500).json({
      ok: false,
      user: null,
      error: "Unable to load account"
    });
  }
});

async function logoutHandler(req, res) {
  try {
    const sessionId = req.cookies?.vlx_session;

    if (sessionId) {
      await pool.query(
        `DELETE FROM vlx_sessions WHERE id = $1`,
        [sessionId]
      );
    }

    res.clearCookie("vlx_session");

    return res.json({
      ok: true
    });
  } catch (error) {
    console.error("LOGOUT error:", error);

    res.clearCookie("vlx_session");

    return res.json({
      ok: true
    });
  }
}

app.post("/api/logout", logoutHandler);
app.post("/api/auth/logout", logoutHandler);

/* -------------------------------------------------------
   HEALTH
------------------------------------------------------- */

app.get("/api/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");

    res.json({
      ok: true,
      project: "VELTRIX EXCHANGE",
      symbol: "VLX",
      database: "PostgreSQL",
      databaseConnected: true,
      vlxTrading: isVLXTradingAllowed(),
      listingDate: "2026-11-24"
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      project: "VELTRIX EXCHANGE",
      database: "PostgreSQL",
      databaseConnected: false
    });
  }
});

/* -------------------------------------------------------
   CONFIG
------------------------------------------------------- */

app.get("/api/config", (req, res) => {
  res.json({
    ok: true,
    project: "VELTRIX EXCHANGE",
    symbol: "VLX",
    pairs: PAIRS,
    vlxListingDate: "2026-11-24",
    vlxTradingEnabled: isVLXTradingAllowed()
  });
});

/* -------------------------------------------------------
   ASSETS
------------------------------------------------------- */

app.get("/api/assets", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        symbol,
        name,
        decimals,
        active,
        listing_date
      FROM vlx_assets
      ORDER BY
        CASE
          WHEN symbol = 'USDT' THEN 0
          WHEN symbol = 'BTC' THEN 1
          WHEN symbol = 'ETH' THEN 2
          WHEN symbol = 'SOL' THEN 3
          WHEN symbol = 'XRP' THEN 4
          WHEN symbol = 'TON' THEN 5
          WHEN symbol = 'SHIB' THEN 6
          WHEN symbol = 'VLX' THEN 7
          ELSE 99
        END
    `);

    res.json({
      ok: true,
      assets: result.rows
    });
  } catch (error) {
    console.error("ASSETS error:", error);

    res.status(500).json({
      ok: false,
      error: "Unable to load assets"
    });
  }
});

/* -------------------------------------------------------
   BALANCES
------------------------------------------------------- */

app.get("/api/balances", requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT
        a.symbol,
        a.name,
        a.decimals,
        COALESCE(b.available, 0) AS available,
        COALESCE(b.locked, 0) AS locked,
        (
          COALESCE(b.available, 0) +
          COALESCE(b.locked, 0)
        ) AS total
      FROM vlx_assets a
      LEFT JOIN vlx_balances b
        ON b.asset_id = a.id
       AND b.user_id = $1
      WHERE a.active = TRUE
      ORDER BY a.symbol
      `,
      [req.user.id]
    );

    res.json({
      ok: true,
      balances: result.rows
    });
  } catch (error) {
    console.error("BALANCES error:", error);

    res.status(500).json({
      ok: false,
      error: "Unable to load balances"
    });
  }
});

/* -------------------------------------------------------
   BALANCE HELPERS
------------------------------------------------------- */

async function getAsset(client, symbol) {
  const result = await client.query(
    `
    SELECT *
    FROM vlx_assets
    WHERE symbol = $1
    LIMIT 1
    `,
    [symbol]
  );

  return result.rows[0] || null;
}

async function ensureBalance(client, userId, assetId) {
  await client.query(
    `
    INSERT INTO vlx_balances
      (user_id, asset_id, available, locked)
    VALUES
      ($1, $2, 0, 0)
    ON CONFLICT(user_id, asset_id)
    DO NOTHING
    `,
    [userId, assetId]
  );
}

async function changeBalance(
  client,
  userId,
  assetId,
  availableDelta,
  lockedDelta
) {
  await ensureBalance(client, userId, assetId);

  const result = await client.query(
    `
    UPDATE vlx_balances
    SET
      available = available + $1,
      locked = locked + $2,
      updated_at = NOW()
    WHERE user_id = $3
      AND asset_id = $4
    RETURNING *
    `,
    [
      availableDelta.toString(),
      lockedDelta.toString(),
      userId,
      assetId
    ]
  );

  if (!result.rows.length) {
    throw new Error("Balance not found");
  }

  const row = result.rows[0];

  if (
    new Decimal(row.available).lt(0) ||
    new Decimal(row.locked).lt(0)
  ) {
    throw new Error("Insufficient balance");
  }

  return row;
}

async function addLedger(
  client,
  userId,
  assetId,
  amount,
  type,
  referenceId,
  note
) {
  await client.query(
    `
    INSERT INTO vlx_ledger_entries
      (
        user_id,
        asset_id,
        amount,
        type,
        reference_id,
        note
      )
    VALUES
      ($1, $2, $3, $4, $5, $6)
    `,
    [
      userId,
      assetId,
      amount.toString(),
      type,
      referenceId || null,
      note || null
    ]
  );
}

/* -------------------------------------------------------
   ORDER BOOK
------------------------------------------------------- */

app.get("/api/orderbook/:symbol", async (req, res) => {
  try {
    const symbol = normalizeSymbol(req.params.symbol);

    const result = await pool.query(
      `
      SELECT
        id,
        user_id,
        side,
        type,
        price,
        remaining AS amount,
        created_at
      FROM vlx_orders
      WHERE symbol = $1
        AND status = 'open'
        AND remaining > 0
      ORDER BY
        CASE WHEN side = 'buy' THEN price END DESC,
        CASE WHEN side = 'sell' THEN price END ASC,
        created_at ASC
      `,
      [symbol]
    );

    const bids = result.rows
      .filter(row => row.side === "buy")
      .map(row => ({
        price: row.price,
        amount: row.amount
      }))
      .slice(0, 100);

    const asks = result.rows
      .filter(row => row.side === "sell")
      .map(row => ({
        price: row.price,
        amount: row.amount
      }))
      .slice(0, 100);

    res.json({
      ok: true,
      symbol,
      bids,
      asks
    });
  } catch (error) {
    console.error("ORDERBOOK error:", error);

    res.status(500).json({
      ok: false,
      error: "Unable to load order book"
    });
  }
});

/* -------------------------------------------------------
   PLACE ORDER
------------------------------------------------------- */

app.post("/api/orders", requireAuth, async (req, res) => {
  const client = await pool.connect();

  try {
    const symbol = normalizeSymbol(req.body.symbol);
    const side = normalizeSide(req.body.side);
    const type = normalizeOrderType(req.body.type);

    const amount = req.body.amount;
    const price = req.body.price;

    const pair = parsePair(symbol);

    if (!pair || !PAIRS.includes(symbol)) {
      return res.status(400).json({
        ok: false,
        error: "Invalid trading pair"
      });
    }

    if (!side || !type) {
      return res.status(400).json({
        ok: false,
        error: "Invalid order"
      });
    }

    if (!validNumber(amount)) {
      return res.status(400).json({
        ok: false,
        error: "Invalid amount"
      });
    }

    if (type === "limit" && !validNumber(price)) {
      return res.status(400).json({
        ok: false,
        error: "Valid price is required"
      });
    }

    if (
      pair.base === "VLX" ||
      pair.quote === "VLX"
    ) {
      if (!isVLXTradingAllowed()) {
        return res.status(403).json({
          ok: false,
          error: "VLX trading is not live yet",
          listingDate: "2026-11-24"
        });
      }
    }

    await client.query("BEGIN");

    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext($1))`,
      [symbol]
    );

    const baseAsset = await getAsset(client, pair.base);
    const quoteAsset = await getAsset(client, pair.quote);

    if (!baseAsset || !quoteAsset) {
      throw new Error("Asset not found");
    }

    const orderAmount = new Decimal(amount);

    let orderPrice = null;

    if (type === "limit") {
      orderPrice = new Decimal(price);
    }

    let reserveAsset;
    let reserveAmount;

    if (side === "sell") {
      reserveAsset = baseAsset;
      reserveAmount = orderAmount;
    } else {
      reserveAsset = quoteAsset;

      if (type === "limit") {
        reserveAmount = orderAmount.mul(orderPrice);
      } else {
        const quoteAmount = new Decimal(
          req.body.quoteAmount ||
          req.body.quote_amount ||
          0
        );

        if (!quoteAmount.gt(0)) {
          throw new Error(
            "Market buy requires quoteAmount"
          );
        }

        reserveAmount = quoteAmount;
      }
    }

    await ensureBalance(
      client,
      req.user.id,
      reserveAsset.id
    );

    const balanceResult = await client.query(
      `
      SELECT *
      FROM vlx_balances
      WHERE user_id = $1
        AND asset_id = $2
      FOR UPDATE
      `,
      [req.user.id, reserveAsset.id]
    );

    const balance = balanceResult.rows[0];

    if (
      new Decimal(balance.available)
        .lt(reserveAmount)
    ) {
      throw new Error(
        `Insufficient ${reserveAsset.symbol} balance`
      );
    }

    await changeBalance(
      client,
      req.user.id,
      reserveAsset.id,
      reserveAmount.neg(),
      reserveAmount
    );

    const orderResult = await client.query(
      `
      INSERT INTO vlx_orders
        (
          user_id,
          symbol,
          side,
          type,
          price,
          amount,
          remaining,
          quote_amount,
          remaining_quote,
          status
        )
      VALUES
        ($1,$2,$3,$4,$5,$6,$6,$7,$7,'open')
      RETURNING *
      `,
      [
        req.user.id,
        symbol,
        side,
        type,
        orderPrice ? orderPrice.toString() : null,
        orderAmount.toString(),
        side === "buy" && type === "market"
          ? reserveAmount.toString()
          : (
              orderPrice
                ? orderAmount.mul(orderPrice).toString()
                : null
            )
      ]
    );

    const order = orderResult.rows[0];

    await addLedger(
      client,
      req.user.id,
      reserveAsset.id,
      reserveAmount.neg(),
      "order_lock",
      String(order.id),
      `Order ${order.id} reserve`
    );

    await client.query("COMMIT");

    let result;

    try {
      result = await matchOrder(order.id);
    } catch (matchError) {
      console.error("Matching error:", matchError);

      result = {
        ok: true,
        order
      };
    }

    res.json({
      ok: true,
      orderId: order.id,
      order: result.order || order,
      trades: result.trades || []
    });
  } catch (error) {
    await client.query("ROLLBACK");

    console.error("ORDER error:", error);

    res.status(400).json({
      ok: false,
      error: error.message || "Unable to place order"
    });
  } finally {
    client.release();
  }
});

/* -------------------------------------------------------
   MATCH ENGINE
------------------------------------------------------- */

async function matchOrder(orderId) {
  const client = await pool.connect();
  const trades = [];

  try {
    await client.query("BEGIN");

    const orderResult = await client.query(
      `
      SELECT *
      FROM vlx_orders
      WHERE id = $1
      FOR UPDATE
      `,
      [orderId]
    );

    if (!orderResult.rows.length) {
      throw new Error("Order not found");
    }

    let taker = orderResult.rows[0];

    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext($1))`,
      [taker.symbol]
    );

    const pair = parsePair(taker.symbol);

    const baseAsset = await getAsset(client, pair.base);
    const quoteAsset = await getAsset(client, pair.quote);

    while (
      taker.status === "open" &&
      new Decimal(taker.remaining).gt(0)
    ) {
      const condition =
        taker.side === "buy"
          ? `
            side = 'sell'
            AND status = 'open'
            AND remaining > 0
            AND price IS NOT NULL
            ${
              taker.type === "limit"
                ? "AND price <= $2"
                : ""
            }
          `
          : `
            side = 'buy'
            AND status = 'open'
            AND remaining > 0
            AND price IS NOT NULL
            ${
              taker.type === "limit"
                ? "AND price >= $2"
                : ""
            }
          `;

      const params =
        taker.type === "limit"
          ? [taker.symbol, taker.price]
          : [taker.symbol];

      const makerResult = await client.query(
        `
        SELECT *
        FROM vlx_orders
        WHERE symbol = $1
          AND ${condition}
        ORDER BY
          ${
            taker.side === "buy"
              ? "price ASC"
              : "price DESC"
          },
          created_at ASC
        LIMIT 1
        FOR UPDATE
        `,
        params
      );

      if (!makerResult.rows.length) {
        break;
      }

      const maker = makerResult.rows[0];

      if (Number(maker.user_id) === Number(taker.user_id)) {
        break;
      }

      const makerPrice = new Decimal(maker.price);
      const takerRemaining = new Decimal(taker.remaining);
      const makerRemaining = new Decimal(maker.remaining);

      let tradeAmount = Decimal.min(
        takerRemaining,
        makerRemaining
      );

      if (
        taker.type === "market" &&
        taker.side === "buy"
      ) {
        const remainingQuote = new Decimal(
          taker.remaining_quote || 0
        );

        if (makerPrice.gt(0)) {
          tradeAmount = Decimal.min(
            tradeAmount,
            remainingQuote.div(makerPrice)
          );
        }
      }

      if (!tradeAmount.gt(0)) {
        break;
      }

      const quoteAmount =
        tradeAmount.mul(makerPrice);

      const makerUserId = maker.user_id;
      const takerUserId = taker.user_id;

      if (taker.side === "buy") {
        await changeBalance(
          client,
          takerUserId,
          baseAsset.id,
          tradeAmount,
          new Decimal(0)
        );

        await changeBalance(
          client,
          takerUserId,
          quoteAsset.id,
          quoteAmount.neg(),
          new Decimal(0)
        );

        await changeBalance(
          client,
          makerUserId,
          quoteAsset.id,
          quoteAmount,
          new Decimal(0)
        );

        await changeBalance(
          client,
          makerUserId,
          baseAsset.id,
          tradeAmount.neg(),
          new Decimal(0)
        );
      } else {
        await changeBalance(
          client,
          takerUserId,
          baseAsset.id,
          tradeAmount,
          new Decimal(0)
        );

        await changeBalance(
          client,
          takerUserId,
          quoteAsset.id,
          quoteAmount.neg(),
          new Decimal(0)
        );

        await changeBalance(
          client,
          makerUserId,
          quoteAsset.id,
          quoteAmount,
          new Decimal(0)
        );

        await changeBalance(
          client,
          makerUserId,
          baseAsset.id,
          tradeAmount.neg(),
          new Decimal(0)
        );
      }

      const newMakerRemaining =
        makerRemaining.sub(tradeAmount);

      const newTakerRemaining =
        takerRemaining.sub(tradeAmount);

      const makerStatus =
        newMakerRemaining.lte(0)
          ? "filled"
          : "open";

      await client.query(
        `
        UPDATE vlx_orders
        SET
          remaining = $1,
          status = $2,
          updated_at = NOW()
        WHERE id = $3
        `,
        [
          newMakerRemaining.toString(),
          makerStatus,
          maker.id
        ]
      );

      let newTakerQuote =
        taker.remaining_quote;

      if (newTakerQuote !== null) {
        newTakerQuote = new Decimal(
          newTakerQuote
        ).sub(quoteAmount);

        if (newTakerQuote.lt(0)) {
          newTakerQuote = new Decimal(0);
        }
      }

      const takerStatus =
        newTakerRemaining.lte(0)
          ? "filled"
          : "open";

      const takerUpdate = await client.query(
        `
        UPDATE vlx_orders
        SET
          remaining = $1,
          remaining_quote = $2,
          status = $3,
          updated_at = NOW()
        WHERE id = $4
        RETURNING *
        `,
        [
          newTakerRemaining.toString(),
          newTakerQuote === null
            ? null
            : newTakerQuote.toString(),
          takerStatus,
          taker.id
        ]
      );

      taker = takerUpdate.rows[0];

      const tradeResult = await client.query(
        `
        INSERT INTO vlx_trades
          (
            symbol,
            maker_order_id,
            taker_order_id,
            maker_user_id,
            taker_user_id,
            price,
            amount,
            quote_amount
          )
        VALUES
          ($1,$2,$3,$4,$5,$6,$7,$8)
        RETURNING *
        `,
        [
          taker.symbol,
          maker.id,
          taker.id,
          makerUserId,
          takerUserId,
          makerPrice.toString(),
          tradeAmount.toString(),
          quoteAmount.toString()
        ]
      );

      trades.push(tradeResult.rows[0]);

      if (makerStatus === "filled") {
        /* maker complete */
      }

      if (takerStatus === "filled") {
        break;
      }
    }

    if (
      taker.status === "filled" &&
      taker.remaining_quote
    ) {
      const leftover = new Decimal(
        taker.remaining_quote
      );

      if (leftover.gt(0) && taker.side === "buy") {
        await changeBalance(
          client,
          taker.user_id,
          quoteAsset.id,
          leftover,
          new Decimal(0)
        );

        await client.query(
          `
          UPDATE vlx_orders
          SET remaining_quote = 0
          WHERE id = $1
          `,
          [taker.id]
        );
      }
    }

    if (
      taker.type === "market" &&
      taker.status === "open"
    ) {
      const remainingBase =
        new Decimal(taker.remaining);

      if (taker.side === "buy") {
        const quoteLocked =
          new Decimal(taker.remaining_quote || 0);

        if (quoteLocked.gt(0)) {
          await changeBalance(
            client,
            taker.user_id,
            quoteAsset.id,
            quoteLocked,
            quoteLocked.neg()
          );
        }
      } else {
        if (remainingBase.gt(0)) {
          await changeBalance(
            client,
            taker.user_id,
            baseAsset.id,
            remainingBase,
            remainingBase.neg()
          );
        }
      }

      await client.query(
        `
        UPDATE vlx_orders
        SET
          status = 'cancelled',
          updated_at = NOW()
        WHERE id = $1
        `,
        [taker.id]
      );

      taker.status = "cancelled";
    }

    await client.query("COMMIT");

    return {
      ok: true,
      order: taker,
      trades
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/* -------------------------------------------------------
   CANCEL ORDER
------------------------------------------------------- */

app.delete(
  "/api/orders/:id",
  requireAuth,
  async (req, res) => {
    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const result = await client.query(
        `
        SELECT *
        FROM vlx_orders
        WHERE id = $1
          AND user_id = $2
        FOR UPDATE
        `,
        [
          req.params.id,
          req.user.id
        ]
      );

      if (!result.rows.length) {
        throw new Error("Order not found");
      }

      const order = result.rows[0];

      if (order.status !== "open") {
        throw new Error("Order is not open");
      }

      const pair = parsePair(order.symbol);

      const baseAsset = await getAsset(
        client,
        pair.base
      );

      const quoteAsset = await getAsset(
        client,
        pair.quote
      );

      if (order.side === "sell") {
        const amount = new Decimal(
          order.remaining
        );

        await changeBalance(
          client,
          req.user.id,
          baseAsset.id,
          amount,
          amount.neg()
        );
      } else {
        let amount = new Decimal(
          order.remaining_quote || 0
        );

        if (
          order.type === "limit" &&
          amount.eq(0)
        ) {
          amount = new Decimal(order.remaining)
            .mul(new Decimal(order.price));
        }

        if (amount.gt(0)) {
          await changeBalance(
            client,
            req.user.id,
            quoteAsset.id,
            amount,
            amount.neg()
          );
        }
      }

      await client.query(
        `
        UPDATE vlx_orders
        SET
          status = 'cancelled',
          updated_at = NOW()
        WHERE id = $1
        `,
        [order.id]
      );

      await client.query("COMMIT");

      res.json({
        ok: true,
        message: "Order cancelled"
      });
    } catch (error) {
      await client.query("ROLLBACK");

      res.status(400).json({
        ok: false,
        error: error.message
      });
    } finally {
      client.release();
    }
  }
);

/* -------------------------------------------------------
   USER ORDERS
------------------------------------------------------- */

app.get("/api/orders", requireAuth, async (req, res) => {
  try {
    const symbol = req.query.symbol
      ? normalizeSymbol(req.query.symbol)
      : null;

    const result = await pool.query(
      `
      SELECT *
      FROM vlx_orders
      WHERE user_id = $1
        AND ($2::text IS NULL OR symbol = $2)
      ORDER BY created_at DESC
      LIMIT 200
      `,
      [req.user.id, symbol]
    );

    res.json({
      ok: true,
      orders: result.rows
    });
  } catch (error) {
    console.error("ORDERS error:", error);

    res.status(500).json({
      ok: false,
      error: "Unable to load orders"
    });
  }
});

/* -------------------------------------------------------
   TRADES
------------------------------------------------------- */

app.get("/api/trades/:symbol", async (req, res) => {
  try {
    const symbol = normalizeSymbol(req.params.symbol);

    const result = await pool.query(
      `
      SELECT
        id,
        symbol,
        price,
        amount,
        quote_amount,
        created_at
      FROM vlx_trades
      WHERE symbol = $1
      ORDER BY created_at DESC
      LIMIT 100
      `,
      [symbol]
    );

    res.json({
      ok: true,
      trades: result.rows
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: "Unable to load trades"
    });
  }
});

app.get("/api/my-trades", requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT *
      FROM vlx_trades
      WHERE maker_user_id = $1
         OR taker_user_id = $1
      ORDER BY created_at DESC
      LIMIT 200
      `,
      [req.user.id]
    );

    res.json({
      ok: true,
      trades: result.rows
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: "Unable to load trade history"
    });
  }
});

/* -------------------------------------------------------
   MARKET
------------------------------------------------------- */

app.get("/api/market/:symbol", async (req, res) => {
  try {
    const symbol = normalizeSymbol(req.params.symbol);

    const lastTrade = await pool.query(
      `
      SELECT
        price,
        amount,
        created_at
      FROM vlx_trades
      WHERE symbol = $1
      ORDER BY created_at DESC
      LIMIT 1
      `,
      [symbol]
    );

    const book = await pool.query(
      `
      SELECT
        side,
        price,
        remaining
      FROM vlx_orders
      WHERE symbol = $1
        AND status = 'open'
        AND remaining > 0
      ORDER BY created_at ASC
      LIMIT 500
      `,
      [symbol]
    );

    let lastPrice = null;

    if (lastTrade.rows.length) {
      lastPrice = lastTrade.rows[0].price;
    }

    const bids = book.rows
      .filter(x => x.side === "buy")
      .sort(
        (a, b) =>
          Number(b.price) - Number(a.price)
      );

    const asks = book.rows
      .filter(x => x.side === "sell")
      .sort(
        (a, b) =>
          Number(a.price) - Number(b.price)
      );

    res.json({
      ok: true,
      symbol,
      lastPrice,
      bestBid: bids[0]?.price || null,
      bestAsk: asks[0]?.price || null
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: "Unable to load market"
    });
  }
});

/* -------------------------------------------------------
   CANDLES
------------------------------------------------------- */

app.get("/api/candles/:symbol", async (req, res) => {
  try {
    const symbol = normalizeSymbol(req.params.symbol);

    const limit = Math.min(
      Math.max(
        Number(req.query.limit || 200),
        1
      ),
      1000
    );

    const rows = await pool.query(
      `
      SELECT
        price,
        amount,
        created_at
      FROM vlx_trades
      WHERE symbol = $1
      ORDER BY created_at ASC
      LIMIT $2
      `,
      [symbol, limit]
    );

    if (!rows.rows.length) {
      return res.json({
        ok: true,
        candles: []
      });
    }

    const grouped = new Map();

    for (const row of rows.rows) {
      const timestamp =
        new Date(row.created_at).getTime();

      const minute =
        Math.floor(timestamp / 60000) * 60000;

      const price = Number(row.price);
      const volume = Number(row.amount);

      if (!grouped.has(minute)) {
        grouped.set(minute, {
          time: Math.floor(minute / 1000),
          open: price,
          high: price,
          low: price,
          close: price,
          volume
        });
      } else {
        const candle = grouped.get(minute);

        candle.high = Math.max(
          candle.high,
          price
        );

        candle.low = Math.min(
          candle.low,
          price
        );

        candle.close = price;
        candle.volume += volume;
      }
    }

    res.json({
      ok: true,
      candles: Array.from(grouped.values())
    });
  } catch (error) {
    console.error("CANDLES error:", error);

    res.status(500).json({
      ok: false,
      error: "Unable to load candles"
    });
  }
});

/* -------------------------------------------------------
   LISTING
------------------------------------------------------- */

app.get("/api/listing", (req, res) => {
  res.json({
    ok: true,
    symbol: "VLX",
    pair: "VLX/USDT",
    listingDate: "2026-11-24",
    tradingEnabled: isVLXTradingAllowed()
  });
});

/* -------------------------------------------------------
   DEPOSITS
------------------------------------------------------- */

app.get(
  "/api/deposits",
  requireAuth,
  async (req, res) => {
    try {
      const result = await pool.query(
        `
        SELECT *
        FROM vlx_deposits
        WHERE user_id = $1
        ORDER BY created_at DESC
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
      res.status(500).json({
        ok: false,
        error: "Unable to load deposits"
      });
    }
  }
);

/* -------------------------------------------------------
   WITHDRAWALS
------------------------------------------------------- */

app.get(
  "/api/withdrawals",
  requireAuth,
  async (req, res) => {
    try {
      const result = await pool.query(
        `
        SELECT *
        FROM vlx_withdrawals
        WHERE user_id = $1
        ORDER BY created_at DESC
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
      res.status(500).json({
        ok: false,
        error: "Unable to load withdrawals"
      });
    }
  }
);

/* -------------------------------------------------------
   TELEGRAM MINER CREDIT
------------------------------------------------------- */

app.post(
  "/api/miner/credit",
  async (req, res) => {
    const client = await pool.connect();

    try {
      const {
        telegramUserId,
        amount,
        requestId,
        signature
      } = req.body;

      if (
        !telegramUserId ||
        !amount ||
        !requestId ||
        !signature
      ) {
        return res.status(400).json({
          ok: false,
          error: "Missing required fields"
        });
      }

      if (!MINER_API_SECRET) {
        return res.status(503).json({
          ok: false,
          error: "Miner integration is not configured"
        });
      }

      const payload =
        `${telegramUserId}:${amount}:${requestId}`;

      const expected = crypto
        .createHmac(
          "sha256",
          MINER_API_SECRET
        )
        .update(payload)
        .digest("hex");

      const sigBuf = Buffer.from(
        String(signature),
        "utf8"
      );

      const expectedBuf = Buffer.from(
        expected,
        "utf8"
      );

      if (
        sigBuf.length !== expectedBuf.length ||
        !crypto.timingSafeEqual(
          sigBuf,
          expectedBuf
        )
      ) {
        return res.status(401).json({
          ok: false,
          error: "Invalid signature"
        });
      }

      if (!validNumber(amount)) {
        return res.status(400).json({
          ok: false,
          error: "Invalid amount"
        });
      }

      await client.query("BEGIN");

      const duplicate = await client.query(
        `
        SELECT id
        FROM vlx_ledger_entries
        WHERE reference_id = $1
        LIMIT 1
        `,
        [`miner:${requestId}`]
      );

      if (duplicate.rows.length) {
        await client.query("ROLLBACK");

        return res.json({
          ok: true,
          duplicate: true
        });
      }

      const userResult = await client.query(
        `
        SELECT *
        FROM vlx_users
        WHERE telegram_user_id = $1
        LIMIT 1
        `,
        [String(telegramUserId)]
      );

      if (!userResult.rows.length) {
        await client.query("ROLLBACK");

        return res.status(404).json({
          ok: false,
          error: "Telegram account is not linked"
        });
      }

      const user = userResult.rows[0];

      const asset = await getAsset(
        client,
        "VLX"
      );

      await ensureBalance(
        client,
        user.id,
        asset.id
      );

      await changeBalance(
        client,
        user.id,
        asset.id,
        new Decimal(amount),
        new Decimal(0)
      );

      await addLedger(
        client,
        user.id,
        asset.id,
        new Decimal(amount),
        "miner_credit",
        `miner:${requestId}`,
        "VELTRIX Telegram Miner credit"
      );

      await client.query("COMMIT");

      return res.json({
        ok: true,
        credited: String(amount)
      });
    } catch (error) {
      await client.query("ROLLBACK");

      console.error("MINER CREDIT error:", error);

      res.status(500).json({
        ok: false,
        error: "Miner credit failed"
      });
    } finally {
      client.release();
    }
  }
);

/* -------------------------------------------------------
   LINK TELEGRAM
------------------------------------------------------- */

app.post(
  "/api/account/link-telegram",
  requireAuth,
  async (req, res) => {
    try {
      const telegramUserId = String(
        req.body.telegramUserId ||
        req.body.telegram_user_id ||
        ""
      ).trim();

      if (!telegramUserId) {
        return res.status(400).json({
          ok: false,
          error: "Telegram user ID is required"
        });
      }

      const exists = await pool.query(
        `
        SELECT id
        FROM vlx_users
        WHERE telegram_user_id = $1
          AND id <> $2
        LIMIT 1
        `,
        [
          telegramUserId,
          req.user.id
        ]
      );

      if (exists.rows.length) {
        return res.status(409).json({
          ok: false,
          error: "Telegram account is already linked"
        });
      }

      const result = await pool.query(
        `
        UPDATE vlx_users
        SET telegram_user_id = $1
        WHERE id = $2
        RETURNING *
        `,
        [
          telegramUserId,
          req.user.id
        ]
      );

      res.json({
        ok: true,
        user: safeUser(result.rows[0])
      });
    } catch (error) {
      console.error(
        "LINK TELEGRAM error:",
        error
      );

      res.status(500).json({
        ok: false,
        error: "Unable to link Telegram"
      });
    }
  }
);

/* -------------------------------------------------------
   ADMIN WITHDRAWALS
------------------------------------------------------- */

app.get(
  "/api/admin/withdrawals",
  requireAuth,
  async (req, res) => {
    try {
      if (req.user.role !== "admin") {
        return res.status(403).json({
          ok: false,
          error: "Admin access required"
        });
      }

      const result = await pool.query(`
        SELECT
          w.*,
          u.email,
          u.display_name
        FROM vlx_withdrawals w
        JOIN vlx_users u
          ON u.id = w.user_id
        ORDER BY w.created_at DESC
        LIMIT 500
      `);

      res.json({
        ok: true,
        withdrawals: result.rows
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        error: "Unable to load withdrawals"
      });
    }
  }
);

/* -------------------------------------------------------
   API 404
   IMPORTANT:
   This prevents missing API routes from returning HTML.
------------------------------------------------------- */

app.use("/api", (req, res) => {
  res.status(404).json({
    ok: false,
    error: "API endpoint not found",
    path: req.originalUrl
  });
});

/* -------------------------------------------------------
   FRONTEND
------------------------------------------------------- */

const publicPath = path.join(
  __dirname,
  "public"
);

app.use(
  express.static(publicPath, {
    maxAge: "1h"
  })
);

app.get("*", (req, res) => {
  res.sendFile(
    path.join(
      publicPath,
      "index.html"
    )
  );
});

/* -------------------------------------------------------
   ERROR HANDLER
------------------------------------------------------- */

app.use((error, req, res, next) => {
  console.error("SERVER ERROR:", error);

  if (res.headersSent) {
    return next(error);
  }

  res.status(500).json({
    ok: false,
    error: "Internal server error"
  });
});

/* -------------------------------------------------------
   START
------------------------------------------------------- */

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
