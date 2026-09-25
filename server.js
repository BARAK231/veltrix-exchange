const express = require("express");
const path = require("path");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const cookieParser = require("cookie-parser");
const rateLimit = require("express-rate-limit");
const { Pool } = require("pg");
const Decimal = require("decimal.js");

const app = express();
const PORT = Number(process.env.PORT || 10000);

Decimal.set({
  precision: 50,
  rounding: Decimal.ROUND_DOWN
});

/* =========================================================
   DATABASE
   ========================================================= */

const DATABASE_URL = String(process.env.DATABASE_URL || "").trim();

if (!DATABASE_URL) {
  console.error("VELTRIX ERROR: DATABASE_URL is not configured.");
  process.exit(1);
}

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
    max: 500,
    standardHeaders: true,
    legacyHeaders: false
  })
);

app.use(express.static(path.join(__dirname, "public")));

/* =========================================================
   CONFIG
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

const LISTING_DATE = "2026-11-24T00:00:00Z";

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

function positiveDecimal(value) {
  try {
    const d = new Decimal(String(value));

    if (!d.isFinite() || d.lte(0)) {
      return null;
    }

    return d;
  } catch {
    return null;
  }
}

function validPair(symbol) {
  return PAIRS.includes(symbol);
}

function splitPair(symbol) {
  const parts = symbol.split("/");

  return {
    base: parts[0],
    quote: parts[1]
  };
}

function remainingQuantity(order) {
  return new Decimal(String(order.quantity))
    .minus(new Decimal(String(order.filled_quantity || 0)));
}

function isOpenOrder(order) {
  return (
    order.status === "open" ||
    order.status === "partially_filled"
  );
}

async function getAsset(client, symbol) {
  const result = await client.query(
    `
    SELECT *
    FROM vlx_assets
    WHERE symbol=$1
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
    (user_id,asset_id,available,locked)
    VALUES($1,$2,0,0)
    ON CONFLICT(user_id,asset_id)
    DO NOTHING
    `,
    [userId, assetId]
  );
}

async function getBalanceForUpdate(
  client,
  userId,
  assetId
) {
  await ensureBalance(client, userId, assetId);

  const result = await client.query(
    `
    SELECT *
    FROM vlx_balances
    WHERE user_id=$1
    AND asset_id=$2
    FOR UPDATE
    `,
    [userId, assetId]
  );

  if (!result.rows.length) {
    throw new Error("Balance not found");
  }

  return result.rows[0];
}

async function ledger(
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
    (user_id,asset_id,amount,type,reference_id,note)
    VALUES($1,$2,$3,$4,$5,$6)
    `,
    [
      userId,
      assetId,
      String(amount),
      type,
      referenceId || null,
      note || null
    ]
  );
}

async function audit(
  client,
  userId,
  action,
  ip,
  metadata = {}
) {
  await client.query(
    `
    INSERT INTO vlx_audit_logs
    (user_id,action,ip,metadata)
    VALUES($1,$2,$3,$4)
    `,
    [
      userId || null,
      action,
      ip || null,
      JSON.stringify(metadata)
    ]
  );
}

/* =========================================================
   DATABASE INITIALIZATION
   ========================================================= */

async function initDatabase() {
  requireDB();

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

    CREATE INDEX IF NOT EXISTS vlx_trades_symbol_idx
    ON vlx_trades(symbol, created_at DESC);

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
    Safe migration for older databases.
  */

  await pool.query(`
    ALTER TABLE vlx_users
    ADD COLUMN IF NOT EXISTS telegram_user_id TEXT;

    CREATE UNIQUE INDEX IF NOT EXISTS
    vlx_users_telegram_user_idx
    ON vlx_users(telegram_user_id)
    WHERE telegram_user_id IS NOT NULL;
  `);

  for (const asset of ASSETS) {
    await pool.query(
      `
      INSERT INTO vlx_assets
      (symbol,name,network,status,listing_date,decimals)
      VALUES($1,$2,$3,$4,$5,$6)
      ON CONFLICT(symbol)
      DO UPDATE SET
        name=EXCLUDED.name,
        network=EXCLUDED.network,
        status=EXCLUDED.status,
        listing_date=EXCLUDED.listing_date,
        decimals=EXCLUDED.decimals
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
        ON u.id=s.user_id
      WHERE s.token_hash=$1
      AND s.expires_at>NOW()
      LIMIT 1
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
      matchingEngine: "ENABLED",
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
    listingDateUTC: LISTING_DATE,
    matchingEngine: true
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
      await ensureBalance(
        pool,
        userId,
        asset.id
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
        ON a.id=b.asset_id
      WHERE b.user_id=$1
      ORDER BY a.id
      `,
      [user.id]
    );

    res.json({
      balances: result.rows
    });

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
      SELECT
        price,
        quantity,
        filled_quantity,
        (quantity-filled_quantity) AS remaining_quantity
      FROM vlx_orders
      WHERE symbol=$1
      AND side='sell'
      AND status IN ('open','partially_filled')
      ORDER BY price ASC, created_at ASC, id ASC
      LIMIT 50
      `,
      [symbol]
    );

    const bids = await pool.query(
      `
      SELECT
        price,
        quantity,
        filled_quantity,
        (quantity-filled_quantity) AS remaining_quantity
      FROM vlx_orders
      WHERE symbol=$1
      AND side='buy'
      AND status IN ('open','partially_filled')
      ORDER BY price DESC, created_at ASC, id ASC
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
   MATCHING ENGINE
   ========================================================= */

async function matchOrder(client, orderId) {
  const orderResult = await client.query(
    `
    SELECT *
    FROM vlx_orders
    WHERE id=$1
    FOR UPDATE
    `,
    [orderId]
  );

  if (!orderResult.rows.length) {
    throw new Error("Order not found");
  }

  const taker = orderResult.rows[0];

  if (!isOpenOrder(taker)) {
    return {
      filled: new Decimal(0),
      remaining: remainingQuantity(taker)
    };
  }

  const { base, quote } = splitPair(taker.symbol);

  const baseAsset = await getAsset(client, base);
  const quoteAsset = await getAsset(client, quote);

  if (!baseAsset || !quoteAsset) {
    throw new Error("Trading assets not found");
  }

  let filledTotal = new Decimal(
    String(taker.filled_quantity || 0)
  );

  let remaining = remainingQuantity(taker);

  /*
    Lock one symbol while matching.
    This prevents two concurrent orders from consuming
    the same book liquidity.
  */

  await client.query(
    `SELECT pg_advisory_xact_lock(hashtext($1))`,
    [taker.symbol]
  );

  while (remaining.gt(0)) {
    let sql = `
      SELECT *
      FROM vlx_orders
      WHERE symbol=$1
      AND side=$2
      AND status IN ('open','partially_filled')
      AND id<>$3
      AND user_id<>$4
    `;

    const params = [
      taker.symbol,
      taker.side === "buy" ? "sell" : "buy",
      taker.id,
      taker.user_id
    ];

    /*
      Limit order price rules.
    */

    if (taker.order_type === "limit") {
      if (taker.side === "buy") {
        sql += ` AND price <= $5`;
        params.push(taker.price);

        sql += `
          ORDER BY price ASC, created_at ASC, id ASC
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        `;
      } else {
        sql += ` AND price >= $5`;
        params.push(taker.price);

        sql += `
          ORDER BY price DESC, created_at ASC, id ASC
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        `;
      }

    } else {
      /*
        Market buy:
        lowest ask first.

        Market sell:
        highest bid first.
      */

      if (taker.side === "buy") {
        sql += `
          ORDER BY price ASC, created_at ASC, id ASC
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        `;
      } else {
        sql += `
          ORDER BY price DESC, created_at ASC, id ASC
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        `;
      }
    }

    const makerResult = await client.query(
      sql,
      params
    );

    if (!makerResult.rows.length) {
      break;
    }

    const maker = makerResult.rows[0];

    if (!isOpenOrder(maker)) {
      continue;
    }

    const makerRemaining = remainingQuantity(maker);

    if (makerRemaining.lte(0)) {
      continue;
    }

    const tradeQuantity = Decimal.min(
      remaining,
      makerRemaining
    );

    const tradePrice = new Decimal(
      String(maker.price)
    );

    const tradeValue = tradeQuantity.mul(
      tradePrice
    );

    const buyerOrder =
      taker.side === "buy"
        ? taker
        : maker;

    const sellerOrder =
      taker.side === "sell"
        ? taker
        : maker;

    /*
      Lock buyer/seller balances.
    */

    const buyerQuote = await getBalanceForUpdate(
      client,
      buyerOrder.user_id,
      quoteAsset.id
    );

    const buyerBase = await getBalanceForUpdate(
      client,
      buyerOrder.user_id,
      baseAsset.id
    );

    const sellerBase = await getBalanceForUpdate(
      client,
      sellerOrder.user_id,
      baseAsset.id
    );

    const sellerQuote = await getBalanceForUpdate(
      client,
      sellerOrder.user_id,
      quoteAsset.id
    );

    /*
      Seller must have the base asset locked.
    */

    if (
      new Decimal(String(sellerBase.locked))
        .lt(tradeQuantity)
    ) {
      throw new Error(
        "Seller locked balance is insufficient"
      );
    }

    /*
      Buyer market orders need quote balance.
      Limit buyers already locked their maximum.
    */

    if (
      buyerOrder.order_type === "market"
      &&
      new Decimal(String(buyerQuote.available))
        .lt(tradeValue)
    ) {
      throw new Error(
        "Insufficient quote balance for market order"
      );
    }

    /*
      BUYER:
      base locked/available receives base.

      For a limit buy, the maximum quote amount
      was locked when the order was created.
    */

    await client.query(
      `
      UPDATE vlx_balances
      SET available=available+$1
      WHERE user_id=$2
      AND asset_id=$3
      `,
      [
        tradeQuantity.toFixed(18),
        buyerOrder.user_id,
        baseAsset.id
      ]
    );

    /*
      SELLER:
      remove base from locked,
      add quote to available.
    */

    await client.query(
      `
      UPDATE vlx_balances
      SET locked=locked-$1
      WHERE user_id=$2
      AND asset_id=$3
      `,
      [
        tradeQuantity.toFixed(18),
        sellerOrder.user_id,
        baseAsset.id
      ]
    );

    await client.query(
      `
      UPDATE vlx_balances
      SET available=available+$1
      WHERE user_id=$2
      AND asset_id=$3
      `,
      [
        tradeValue.toFixed(18),
        sellerOrder.user_id,
        quoteAsset.id
      ]
    );

    /*
      BUYER quote handling.

      Limit buyer:
      quote was locked at its limit price.
      We consume the actual trade value.

      Market buyer:
      quote comes from available.
    */

    if (buyerOrder.order_type === "limit") {
      await client.query(
        `
        UPDATE vlx_balances
        SET locked=locked-$1
        WHERE user_id=$2
        AND asset_id=$3
        `,
        [
          tradeValue.toFixed(18),
          buyerOrder.user_id,
          quoteAsset.id
        ]
      );

      /*
        If buyer limit price was higher than maker price,
        return the unused price difference.
      */

      const reservedPrice =
        new Decimal(String(buyerOrder.price));

      const reservedForTrade =
        tradeQuantity.mul(reservedPrice);

      const refund =
        reservedForTrade.minus(tradeValue);

      if (refund.gt(0)) {
        await client.query(
          `
          UPDATE vlx_balances
          SET locked=locked-$1,
              available=available+$1
          WHERE user_id=$2
          AND asset_id=$3
          `,
          [
            refund.toFixed(18),
            buyerOrder.user_id,
            quoteAsset.id
          ]
        );
      }

    } else {
      await client.query(
        `
        UPDATE vlx_balances
        SET available=available-$1
        WHERE user_id=$2
        AND asset_id=$3
        `,
        [
          tradeValue.toFixed(18),
          buyerOrder.user_id,
          quoteAsset.id
        ]
      );
    }

    /*
      Update order fill quantities.
    */

    const newTakerFilled =
      new Decimal(String(taker.filled_quantity || 0))
        .plus(tradeQuantity);

    const newMakerFilled =
      new Decimal(String(maker.filled_quantity || 0))
        .plus(tradeQuantity);

    const makerRemainingAfter =
      new Decimal(String(maker.quantity))
        .minus(newMakerFilled);

    const takerRemainingAfter =
      new Decimal(String(taker.quantity))
        .minus(newTakerFilled);

    const makerStatus =
      makerRemainingAfter.lte(0)
        ? "filled"
        : "partially_filled";

    const takerStatus =
      takerRemainingAfter.lte(0)
        ? "filled"
        : "partially_filled";

    await client.query(
      `
      UPDATE vlx_orders
      SET filled_quantity=$1,
          status=$2
      WHERE id=$3
      `,
      [
        newMakerFilled.toFixed(18),
        makerStatus,
        maker.id
      ]
    );

    await client.query(
      `
      UPDATE vlx_orders
      SET filled_quantity=$1,
          status=$2
      WHERE id=$3
      `,
      [
        newTakerFilled.toFixed(18),
        takerStatus,
        taker.id
      ]
    );

    /*
      Record trade.
    */

    await client.query(
      `
      INSERT INTO vlx_trades
      (
        symbol,
        buy_order_id,
        sell_order_id,
        buyer_id,
        seller_id,
        price,
        quantity
      )
      VALUES($1,$2,$3,$4,$5,$6,$7)
      `,
      [
        taker.symbol,
        buyerOrder.id,
        sellerOrder.id,
        buyerOrder.user_id,
        sellerOrder.user_id,
        tradePrice.toFixed(18),
        tradeQuantity.toFixed(18)
      ]
    );

    await ledger(
      client,
      buyerOrder.user_id,
      baseAsset.id,
      tradeQuantity.toFixed(18),
      "trade_buy",
      String(taker.id),
      `Bought ${base} on ${taker.symbol}`
    );

    await ledger(
      client,
      sellerOrder.user_id,
      quoteAsset.id,
      tradeValue.toFixed(18),
      "trade_sell",
      String(taker.id),
      `Sold ${base} on ${taker.symbol}`
    );

    filledTotal = filledTotal.plus(
      tradeQuantity
    );

    remaining = remaining.minus(
      tradeQuantity
    );

    /*
      Refresh taker state for next match.
    */

    taker.filled_quantity =
      newTakerFilled.toFixed(18);

    taker.status = takerStatus;

    if (remaining.lte(0)) {
      break;
    }
  }

  /*
    Market order with unfilled quantity:
    cancel remaining amount and unlock/refund.
  */

  if (
    taker.order_type === "market" &&
    remaining.gt(0) &&
    isOpenOrder(taker)
  ) {
    const { base: marketBase, quote: marketQuote } =
      splitPair(taker.symbol);

    const marketBaseAsset =
      await getAsset(client, marketBase);

    const marketQuoteAsset =
      await getAsset(client, marketQuote);

    if (taker.side === "sell") {
      const balance = await getBalanceForUpdate(
        client,
        taker.user_id,
        marketBaseAsset.id
      );

      /*
        Remaining market-sell base was locked.
      */

      await client.query(
        `
        UPDATE vlx_balances
        SET locked=locked-$1,
            available=available+$1
        WHERE user_id=$2
        AND asset_id=$3
        `,
        [
          remaining.toFixed(18),
          taker.user_id,
          marketBaseAsset.id
        ]
      );

    } else {
      /*
        For market buy we do not pre-lock funds in this
        implementation. Any unused available quote stays
        untouched.
      */
    }

    await client.query(
      `
      UPDATE vlx_orders
      SET status='cancelled'
      WHERE id=$1
      `,
      [taker.id]
    );

    taker.status = "cancelled";
  }

  return {
    filled: filledTotal,
    remaining
  };
}

/* =========================================================
   CREATE ORDER
   ========================================================= */

app.post("/api/orders", async (req, res) => {
  const user = await auth(req, res);

  if (!user) return;

  const symbol = String(req.body.symbol || "").trim();
  const side = String(req.body.side || "").trim();
  const orderType = String(
    req.body.orderType || "limit"
  ).trim();

  const priceRaw = String(
    req.body.price || ""
  ).trim();

  const quantityRaw = String(
    req.body.quantity || ""
  ).trim();

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

  if (!["limit", "market"].includes(orderType)) {
    return res.status(400).json({
      error: "Invalid order type"
    });
  }

  if (!validAmount(quantityRaw)) {
    return res.status(400).json({
      error: "Invalid quantity"
    });
  }

  const quantity = positiveDecimal(quantityRaw);

  if (!quantity) {
    return res.status(400).json({
      error: "Quantity must be positive"
    });
  }

  let price = null;

  if (orderType === "limit") {
    if (!validAmount(priceRaw)) {
      return res.status(400).json({
        error: "Invalid price"
      });
    }

    price = positiveDecimal(priceRaw);

    if (!price) {
      return res.status(400).json({
        error: "Price must be positive"
      });
    }
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    /*
      One matching lock per trading pair.
    */

    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext($1))`,
      [symbol]
    );

    const { base, quote } = splitPair(symbol);

    const baseAsset = await getAsset(
      client,
      base
    );

    const quoteAsset = await getAsset(
      client,
      quote
    );

    if (!baseAsset || !quoteAsset) {
      throw new Error("Trading asset not found");
    }

    /*
      VLX is planned until listing date.
      Prevent normal VLX trading before listing.
    */

    if (base === "VLX") {
      const listingTime =
        new Date(LISTING_DATE).getTime();

      if (Date.now() < listingTime) {
        throw new Error(
          "VLX trading is not open yet. Listing is planned for 24 November 2026."
        );
      }
    }

    /*
      Check and lock user's funds.
    */

    if (side === "sell") {
      const balance = await getBalanceForUpdate(
        client,
        user.id,
        baseAsset.id
      );

      if (
        new Decimal(String(balance.available))
          .lt(quantity)
      ) {
        throw new Error(
          `Insufficient ${base} balance`
        );
      }

      /*
        Limit and market sells lock base quantity.
      */

      await client.query(
        `
        UPDATE vlx_balances
        SET available=available-$1,
            locked=locked+$1
        WHERE user_id=$2
        AND asset_id=$3
        `,
        [
          quantity.toFixed(18),
          user.id,
          baseAsset.id
        ]
      );

    } else {
      /*
        LIMIT BUY:
        lock price * quantity.

        MARKET BUY:
        We do not know final cost yet.
        Therefore require available quote balance
        and reserve it conservatively using the
        best available ask if one exists.
      */

      if (orderType === "limit") {
        const required =
          price.mul(quantity);

        const balance =
          await getBalanceForUpdate(
            client,
            user.id,
            quoteAsset.id
          );

        if (
          new Decimal(String(balance.available))
            .lt(required)
        ) {
          throw new Error(
            `Insufficient ${quote} balance`
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
            required.toFixed(18),
            user.id,
            quoteAsset.id
          ]
        );

      } else {
        /*
          Market buy uses the current lowest ask
          to calculate the maximum expected cost.
        */

        const ask = await client.query(
          `
          SELECT price
          FROM vlx_orders
          WHERE symbol=$1
          AND side='sell'
          AND status IN ('open','partially_filled')
          AND user_id<>$2
          ORDER BY price ASC,created_at ASC,id ASC
          LIMIT 1
          `,
          [symbol, user.id]
        );

        if (!ask.rows.length) {
          throw new Error(
            "No sell orders available for this market buy"
          );
        }

        const estimatedCost =
          new Decimal(String(ask.rows[0].price))
            .mul(quantity);

        const balance =
          await getBalanceForUpdate(
            client,
            user.id,
            quoteAsset.id
          );

        if (
          new Decimal(String(balance.available))
            .lt(estimatedCost)
        ) {
          throw new Error(
            `Insufficient ${quote} balance`
          );
        }
      }
    }

    const orderResult = await client.query(
      `
      INSERT INTO vlx_orders
      (
        user_id,
        symbol,
        side,
        order_type,
        price,
        quantity,
        filled_quantity,
        status
      )
      VALUES($1,$2,$3,$4,$5,$6,0,'open')
      RETURNING *
      `,
      [
        user.id,
        symbol,
        side,
        orderType,
        price
          ? price.toFixed(18)
          : null,
        quantity.toFixed(18)
      ]
    );

    const order = orderResult.rows[0];

    await audit(
      client,
      user.id,
      "order_created",
      req.ip,
      {
        orderId: order.id,
        symbol,
        side,
        orderType
      }
    );

    /*
      Run matching engine inside same transaction.
    */

    await matchOrder(
      client,
      order.id
    );

    const finalOrderResult =
      await client.query(
        `
        SELECT *
        FROM vlx_orders
        WHERE id=$1
        `,
        [order.id]
      );

    await client.query("COMMIT");

    res.status(201).json({
      ok: true,
      order: finalOrderResult.rows[0]
    });

  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {}

    console.error(
      "ORDER ERROR:",
      err.message
    );

    res.status(400).json({
      error: err.message
    });

  } finally {
    client.release();
  }
});

/* =========================================================
   CANCEL ORDER
   ========================================================= */

app.delete("/api/orders/:id", async (req, res) => {
  const user = await auth(req, res);

  if (!user) return;

  const orderId = Number(req.params.id);

  if (!Number.isInteger(orderId) || orderId <= 0) {
    return res.status(400).json({
      error: "Invalid order ID"
    });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const orderResult = await client.query(
      `
      SELECT *
      FROM vlx_orders
      WHERE id=$1
      AND user_id=$2
      FOR UPDATE
      `,
      [orderId, user.id]
    );

    if (!orderResult.rows.length) {
      throw new Error("Order not found");
    }

    const order = orderResult.rows[0];

    if (!isOpenOrder(order)) {
      throw new Error(
        "Only open orders can be cancelled"
      );
    }

    const { base, quote } =
      splitPair(order.symbol);

    const baseAsset =
      await getAsset(client, base);

    const quoteAsset =
      await getAsset(client, quote);

    const remaining =
      remainingQuantity(order);

    if (remaining.gt(0)) {
      if (order.side === "sell") {
        /*
          Unlock remaining base.
        */

        await client.query(
          `
          UPDATE vlx_balances
          SET locked=locked-$1,
              available=available+$1
          WHERE user_id=$2
          AND asset_id=$3
          `,
          [
            remaining.toFixed(18),
            user.id,
            baseAsset.id
          ]
        );

      } else if (
        order.side === "buy" &&
        order.order_type === "limit"
      ) {
        /*
          Unlock remaining quote based on
          original limit price.
        */

        const unlock =
          remaining.mul(
            new Decimal(String(order.price))
          );

        await client.query(
          `
          UPDATE vlx_balances
          SET locked=locked-$1,
              available=available+$1
          WHERE user_id=$2
          AND asset_id=$3
          `,
          [
            unlock.toFixed(18),
            user.id,
            quoteAsset.id
          ]
        );
      }
    }

    await client.query(
      `
      UPDATE vlx_orders
      SET status='cancelled'
      WHERE id=$1
      `,
      [order.id]
    );

    await audit(
      client,
      user.id,
      "order_cancelled",
      req.ip,
      {
        orderId: order.id,
        symbol: order.symbol
      }
    );

    await client.query("COMMIT");

    res.json({
      ok: true,
      message: "Order cancelled"
    });

  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {}

    console.error(
      "CANCEL ERROR:",
      err.message
    );

    res.status(400).json({
      error: err.message
    });

  } finally {
    client.release();
  }
});

/* =========================================================
   USER ORDERS
   ========================================================= */

app.get("/api/orders", async (req, res) => {
  const user = await auth(req, res);

  if (!user) return;

  try {
    const result = await pool.query(
      `
      SELECT
        *,
        (quantity-filled_quantity)
        AS remaining_quantity
      FROM vlx_orders
      WHERE user_id=$1
      ORDER BY id DESC
      LIMIT 200
      `,
      [user.id]
    );

    res.json(result.rows);

  } catch (err) {
    console.error(
      "ORDERS ERROR:",
      err.message
    );

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
      SELECT
        price,
        quantity,
        created_at
      FROM vlx_trades
      WHERE symbol=$1
      ORDER BY id DESC
      LIMIT 100
      `,
      [symbol]
    );

    res.json({
      symbol,
      trades: result.rows
    });

  } catch (err) {
    console.error(
      "TRADES ERROR:",
      err.message
    );

    res.status(500).json({
      error: "Failed to load trades"
    });
  }
});

/* =========================================================
   MARKET SUMMARY
   ========================================================= */

app.get("/api/market/:symbol", async (req, res) => {
  const symbol = req.params.symbol;

  if (!validPair(symbol)) {
    return res.status(400).json({
      error: "Invalid trading pair"
    });
  }

  try {
    const latest = await pool.query(
      `
      SELECT
        price,
        quantity,
        created_at
      FROM vlx_trades
      WHERE symbol=$1
      ORDER BY id DESC
      LIMIT 1
      `,
      [symbol]
    );

    const high = await pool.query(
      `
      SELECT MAX(price) AS high
      FROM vlx_trades
      WHERE symbol=$1
      AND created_at >= NOW()-INTERVAL '24 hours'
      `,
      [symbol]
    );

    const low = await pool.query(
      `
      SELECT MIN(price) AS low
      FROM vlx_trades
      WHERE symbol=$1
      AND created_at >= NOW()-INTERVAL '24 hours'
      `,
      [symbol]
    );

    const volume = await pool.query(
      `
      SELECT
        COALESCE(
          SUM(price * quantity),
          0
        ) AS volume
      FROM vlx_trades
      WHERE symbol=$1
      AND created_at >= NOW()-INTERVAL '24 hours'
      `,
      [symbol]
    );

    res.json({
      symbol,
      lastPrice:
        latest.rows[0]?.price || null,
      lastQuantity:
        latest.rows[0]?.quantity || null,
      high24h:
        high.rows[0]?.high || null,
      low24h:
        low.rows[0]?.low || null,
      volume24h:
        volume.rows[0]?.volume || "0"
    });

  } catch (err) {
    console.error(
      "MARKET ERROR:",
      err.message
    );

    res.status(500).json({
      error: "Failed to load market"
    });
  }
});

/* =========================================================
   VLX LISTING
   ========================================================= */

app.get("/api/listing", (req, res) => {
  const listing =
    new Date(LISTING_DATE);

  const now =
    new Date();

  res.json({
    symbol: "VLX",
    status:
      now.getTime() >= listing.getTime()
        ? "listed"
        : "planned",
    listingDateUTC:
      listing.toISOString(),
    nowUTC:
      now.toISOString(),
    remainingMilliseconds:
      Math.max(
        0,
        listing.getTime() - now.getTime()
      )
  });
});

/* =========================================================
   DEPOSIT STATUS
   ========================================================= */

app.get(
  "/api/deposits",
  async (req, res) => {
    const user = await auth(req, res);

    if (!user) return;

    try {
      const result = await pool.query(
        `
        SELECT
          d.*,
          a.symbol,
          a.name
        FROM vlx_deposits d
        JOIN vlx_assets a
          ON a.id=d.asset_id
        WHERE d.user_id=$1
        ORDER BY d.id DESC
        LIMIT 100
        `,
        [user.id]
      );

      res.json({
        deposits: result.rows,
        blockchainEnabled: false,
        message:
          "On-chain deposits are not enabled yet."
      });

    } catch (err) {
      console.error(
        "DEPOSITS ERROR:",
        err.message
      );

      res.status(500).json({
        error: "Failed to load deposits"
      });
    }
  }
);

/* =========================================================
   WITHDRAWAL STATUS
   ========================================================= */

app.get(
  "/api/withdrawals",
  async (req, res) => {
    const user = await auth(req, res);

    if (!user) return;

    try {
      const result = await pool.query(
        `
        SELECT
          w.*,
          a.symbol,
          a.name
        FROM vlx_withdrawals w
        JOIN vlx_assets a
          ON a.id=w.asset_id
        WHERE w.user_id=$1
        ORDER BY w.id DESC
        LIMIT 100
        `,
        [user.id]
      );

      res.json({
        withdrawals: result.rows,
        blockchainEnabled: false,
        message:
          "On-chain withdrawals are not enabled yet."
      });

    } catch (err) {
      console.error(
        "WITHDRAWALS ERROR:",
        err.message
      );

      res.status(500).json({
        error: "Failed to load withdrawals"
      });
    }
  }
);

/* =========================================================
   TELEGRAM MINER CREDIT
   ========================================================= */

app.post(
  "/api/miner/credit",
  async (req, res) => {
    const secret =
      String(
        process.env.MINER_API_SECRET || ""
      ).trim();

    if (!secret) {
      return res.status(503).json({
        error:
          "Miner credit system is not configured"
      });
    }

    const telegramUserId =
      String(
        req.body.telegramUserId || ""
      ).trim();

    const amountRaw =
      String(
        req.body.amount || ""
      ).trim();

    const requestId =
      String(
        req.body.requestId || ""
      ).trim();

    const signature =
      String(
        req.body.signature || ""
      ).trim();

    if (
      !telegramUserId ||
      !amountRaw ||
      !requestId ||
      !signature
    ) {
      return res.status(400).json({
        error: "Missing required fields"
      });
    }

    const amount =
      positiveDecimal(amountRaw);

    if (!amount) {
      return res.status(400).json({
        error: "Invalid amount"
      });
    }

    const message =
      `${telegramUserId}:${amount.toFixed(18)}:${requestId}`;

    const expected =
      crypto
        .createHmac(
          "sha256",
          secret
        )
        .update(message)
        .digest("hex");

    if (
      signature.length !== expected.length ||
      !crypto.timingSafeEqual(
        Buffer.from(signature),
        Buffer.from(expected)
      )
    ) {
      return res.status(401).json({
        error: "Invalid signature"
      });
    }

    const client =
      await pool.connect();

    try {
      await client.query("BEGIN");

      /*
        Idempotency:
        do not credit same request twice.
      */

      const duplicate =
        await client.query(
          `
          SELECT id
          FROM vlx_ledger_entries
          WHERE type='miner_credit'
          AND reference_id=$1
          LIMIT 1
          `,
          [requestId]
        );

      if (duplicate.rows.length) {
        await client.query("ROLLBACK");

        return res.json({
          ok: true,
          duplicate: true,
          message:
            "Request already processed"
        });
      }

      const user =
        await client.query(
          `
          SELECT *
          FROM vlx_users
          WHERE telegram_user_id=$1
          LIMIT 1
          `,
          [telegramUserId]
        );

      if (!user.rows.length) {
        throw new Error(
          "Telegram user is not linked to a VELTRIX account"
        );
      }

      const vlx =
        await getAsset(
          client,
          "VLX"
        );

      if (!vlx) {
        throw new Error(
          "VLX asset not found"
        );
      }

      const balance =
        await getBalanceForUpdate(
          client,
          user.rows[0].id,
          vlx.id
        );

      await client.query(
        `
        UPDATE vlx_balances
        SET available=available+$1
        WHERE user_id=$2
        AND asset_id=$3
        `,
        [
          amount.toFixed(18),
          user.rows[0].id,
          vlx.id
        ]
      );

      await ledger(
        client,
        user.rows[0].id,
        vlx.id,
        amount.toFixed(18),
        "miner_credit",
        requestId,
        "VELTRIX Telegram Miner credit"
      );

      await audit(
        client,
        user.rows[0].id,
        "miner_credit",
        req.ip,
        {
          telegramUserId,
          amount:
            amount.toFixed(18),
          requestId
        }
      );

      await client.query("COMMIT");

      res.json({
        ok: true,
        credited:
          amount.toFixed(18),
        symbol: "VLX"
      });

    } catch (err) {
      try {
        await client.query(
          "ROLLBACK"
        );
      } catch {}

      console.error(
        "MINER CREDIT ERROR:",
        err.message
      );

      res.status(400).json({
        error: err.message
      });

    } finally {
      client.release();
    }
  }
);

/* =========================================================
   LINK TELEGRAM ACCOUNT
   ========================================================= */

app.post(
  "/api/account/link-telegram",
  async (req, res) => {
    const user = await auth(req, res);

    if (!user) return;

    const telegramUserId =
      String(
        req.body.telegramUserId || ""
      ).trim();

    if (!telegramUserId) {
      return res.status(400).json({
        error:
          "Telegram user ID is required"
      });
    }

    try {
      const existing =
        await pool.query(
          `
          SELECT id
          FROM vlx_users
          WHERE telegram_user_id=$1
          AND id<>$2
          LIMIT 1
          `,
          [
            telegramUserId,
            user.id
          ]
        );

      if (existing.rows.length) {
        return res.status(409).json({
          error:
            "This Telegram account is already linked"
        });
      }

      await pool.query(
        `
        UPDATE vlx_users
        SET telegram_user_id=$1
        WHERE id=$2
        `,
        [
          telegramUserId,
          user.id
        ]
      );

      res.json({
        ok: true,
        message:
          "Telegram account linked"
      });

    } catch (err) {
      console.error(
        "LINK TELEGRAM ERROR:",
        err.message
      );

      res.status(500).json({
        error:
          "Failed to link Telegram account"
      });
    }
  }
);

/* =========================================================
   ADMIN: PENDING WITHDRAWALS
   ========================================================= */

app.get(
  "/api/admin/withdrawals",
  async (req, res) => {
    const user = await auth(req, res);

    if (!user) return;

    if (user.role !== "admin") {
      return res.status(403).json({
        error: "Admin access required"
      });
    }

    try {
      const result =
        await pool.query(`
          SELECT
            w.*,
            u.email,
            u.display_name,
            a.symbol
          FROM vlx_withdrawals w
          JOIN vlx_users u
            ON u.id=w.user_id
          JOIN vlx_assets a
            ON a.id=w.asset_id
          WHERE w.status='pending'
          ORDER BY w.id ASC
        `);

      res.json({
        withdrawals:
          result.rows
      });

    } catch (err) {
      console.error(
        "ADMIN WITHDRAWALS ERROR:",
        err.message
      );

      res.status(500).json({
        error:
          "Failed to load withdrawals"
      });
    }
  }
);

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
   START
   ========================================================= */

async function start() {
  try {
    console.log(
      "Starting VELTRIX EXCHANGE..."
    );

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
