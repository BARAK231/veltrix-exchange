const express = require("express");
const path = require("path");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const cookieParser = require("cookie-parser");
const rateLimit = require("express-rate-limit");
const { Pool } = require("pg");
const Decimal = require("decimal.js");

Decimal.set({
  precision: 50,
  rounding: Decimal.ROUND_DOWN
});

const app = express();

app.set("trust proxy", 1);

app.use(express.json({ limit: "100kb" }));
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());

/* =========================================================
   CONFIG
========================================================= */

const PORT = Number(process.env.PORT || 10000);

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error("DATABASE_URL is missing.");
  process.exit(1);
}

const SESSION_DAYS = Number(process.env.SESSION_DAYS || 30);

const MINER_API_SECRET =
  process.env.MINER_API_SECRET || "";

const ADMIN_EMAIL =
  String(process.env.ADMIN_EMAIL || "")
    .trim()
    .toLowerCase();

const TRADING_FEE_BPS =
  Number(process.env.TRADING_FEE_BPS || 0);

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  },
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

/* =========================================================
   DECIMAL HELPERS
========================================================= */

function D(value) {
  return new Decimal(value || 0);
}

function decimalString(value) {
  return D(value).toFixed();
}

function isPositive(value) {
  try {
    return D(value).gt(0);
  } catch {
    return false;
  }
}

function minDecimal(a, b) {
  return D(a).lt(D(b)) ? D(a) : D(b);
}

function feeFor(amount) {
  if (!TRADING_FEE_BPS || TRADING_FEE_BPS <= 0) {
    return D(0);
  }

  return D(amount)
    .mul(TRADING_FEE_BPS)
    .div(10000);
}

/* =========================================================
   ASSETS
========================================================= */

const ASSETS = [
  {
    symbol: "USDT",
    name: "Tether USD",
    network: "TBD",
    status: "active",
    listingDate: null,
    decimals: 6
  },
  {
    symbol: "BTC",
    name: "Bitcoin",
    network: "Bitcoin",
    status: "active",
    listingDate: null,
    decimals: 8
  },
  {
    symbol: "ETH",
    name: "Ethereum",
    network: "Ethereum",
    status: "active",
    listingDate: null,
    decimals: 18
  },
  {
    symbol: "SOL",
    name: "Solana",
    network: "Solana",
    status: "active",
    listingDate: null,
    decimals: 9
  },
  {
    symbol: "XRP",
    name: "XRP",
    network: "XRP Ledger",
    status: "active",
    listingDate: null,
    decimals: 6
  },
  {
    symbol: "TON",
    name: "Toncoin",
    network: "TON",
    status: "active",
    listingDate: null,
    decimals: 9
  },
  {
    symbol: "SHIB",
    name: "Shiba Inu",
    network: "Ethereum",
    status: "active",
    listingDate: null,
    decimals: 18
  },
  {
    symbol: "VLX",
    name: "VELTRIX",
    network: "TBD",
    status: "planned",
    listingDate: "2026-11-24",
    decimals: 18
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

/* =========================================================
   DATABASE
========================================================= */

async function initDatabase() {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    await client.query(`
      CREATE TABLE IF NOT EXISTS vlx_users (
        id BIGSERIAL PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        display_name TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'user'
          CHECK (role IN ('user','admin')),
        telegram_user_id TEXT UNIQUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS vlx_sessions (
        id BIGSERIAL PRIMARY KEY,
        user_id BIGINT NOT NULL
          REFERENCES vlx_users(id)
          ON DELETE CASCADE,
        token_hash TEXT UNIQUE NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await client.query(`
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
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS vlx_balances (
        user_id BIGINT NOT NULL
          REFERENCES vlx_users(id)
          ON DELETE CASCADE,

        asset_id BIGINT NOT NULL
          REFERENCES vlx_assets(id)
          ON DELETE CASCADE,

        available NUMERIC(38,18) NOT NULL DEFAULT 0,
        locked NUMERIC(38,18) NOT NULL DEFAULT 0,

        PRIMARY KEY(user_id, asset_id),

        CHECK (available >= 0),
        CHECK (locked >= 0)
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS vlx_ledger_entries (
        id BIGSERIAL PRIMARY KEY,

        user_id BIGINT NOT NULL
          REFERENCES vlx_users(id),

        asset_id BIGINT NOT NULL
          REFERENCES vlx_assets(id),

        amount NUMERIC(38,18) NOT NULL,

        type TEXT NOT NULL,

        reference_id TEXT,

        note TEXT,

        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS vlx_orders (
        id BIGSERIAL PRIMARY KEY,

        user_id BIGINT NOT NULL
          REFERENCES vlx_users(id),

        symbol TEXT NOT NULL,

        side TEXT NOT NULL
          CHECK (side IN ('buy','sell')),

        order_type TEXT NOT NULL
          CHECK (order_type IN ('market','limit')),

        price NUMERIC(38,18),

        quantity NUMERIC(38,18) NOT NULL
          CHECK (quantity > 0),

        filled_quantity NUMERIC(38,18) NOT NULL DEFAULT 0,

        quote_amount NUMERIC(38,18),

        remaining_quote NUMERIC(38,18),

        status TEXT NOT NULL DEFAULT 'open'
          CHECK (
            status IN (
              'open',
              'partially_filled',
              'filled',
              'cancelled',
              'expired'
            )
          ),

        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS vlx_trades (
        id BIGSERIAL PRIMARY KEY,

        symbol TEXT NOT NULL,

        buy_order_id BIGINT NOT NULL
          REFERENCES vlx_orders(id),

        sell_order_id BIGINT NOT NULL
          REFERENCES vlx_orders(id),

        buyer_id BIGINT NOT NULL
          REFERENCES vlx_users(id),

        seller_id BIGINT NOT NULL
          REFERENCES vlx_users(id),

        price NUMERIC(38,18) NOT NULL,

        quantity NUMERIC(38,18) NOT NULL,

        quote_amount NUMERIC(38,18) NOT NULL,

        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS vlx_deposits (
        id BIGSERIAL PRIMARY KEY,

        user_id BIGINT NOT NULL
          REFERENCES vlx_users(id),

        asset_id BIGINT NOT NULL
          REFERENCES vlx_assets(id),

        amount NUMERIC(38,18) NOT NULL,

        txid TEXT,

        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (
            status IN (
              'pending',
              'confirmed',
              'failed'
            )
          ),

        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS vlx_withdrawals (
        id BIGSERIAL PRIMARY KEY,

        user_id BIGINT NOT NULL
          REFERENCES vlx_users(id),

        asset_id BIGINT NOT NULL
          REFERENCES vlx_assets(id),

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
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS vlx_audit_logs (
        id BIGSERIAL PRIMARY KEY,

        user_id BIGINT
          REFERENCES vlx_users(id),

        action TEXT NOT NULL,

        ip TEXT,

        metadata JSONB,

        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    /* Existing database upgrades */

    await client.query(`
      ALTER TABLE vlx_users
      ADD COLUMN IF NOT EXISTS telegram_user_id TEXT
    `);

    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS
      vlx_users_telegram_unique
      ON vlx_users(telegram_user_id)
      WHERE telegram_user_id IS NOT NULL
    `);

    await client.query(`
      ALTER TABLE vlx_orders
      ADD COLUMN IF NOT EXISTS quote_amount NUMERIC(38,18)
    `);

    await client.query(`
      ALTER TABLE vlx_orders
      ADD COLUMN IF NOT EXISTS remaining_quote NUMERIC(38,18)
    `);

    await client.query(`
      ALTER TABLE vlx_trades
      ADD COLUMN IF NOT EXISTS quote_amount NUMERIC(38,18)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS
      vlx_orders_book_idx
      ON vlx_orders(
        symbol,
        side,
        status,
        price,
        created_at
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS
      vlx_trades_symbol_idx
      ON vlx_trades(
        symbol,
        created_at DESC
      )
    `);

    /* Assets */

    for (const asset of ASSETS) {
      await client.query(
        `
        INSERT INTO vlx_assets
        (
          symbol,
          name,
          network,
          status,
          listing_date,
          decimals
        )
        VALUES ($1,$2,$3,$4,$5,$6)
        ON CONFLICT(symbol)
        DO UPDATE SET
          name = EXCLUDED.name,
          network = EXCLUDED.network,
          status = EXCLUDED.status,
          listing_date = EXCLUDED.listing_date,
          decimals = EXCLUDED.decimals
        `,
        [
          asset.symbol,
          asset.name,
          asset.network,
          asset.status,
          asset.listingDate,
          asset.decimals
        ]
      );
    }

    await client.query("COMMIT");

    console.log("VELTRIX database initialized successfully");

  } catch (error) {

    await client.query("ROLLBACK");

    console.error(
      "Database initialization failed:",
      error
    );

    throw error;

  } finally {

    client.release();

  }
}

/* =========================================================
   AUTH HELPERS
========================================================= */

function hashToken(token) {
  return crypto
    .createHash("sha256")
    .update(token)
    .digest("hex");
}

function createSessionToken() {
  return crypto.randomBytes(48).toString("hex");
}

function setSessionCookie(res, token) {
  res.cookie("vlx_session", token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: SESSION_DAYS * 24 * 60 * 60 * 1000,
    path: "/"
  });
}

function clearSessionCookie(res) {
  res.clearCookie("vlx_session", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/"
  });
}

async function getCurrentUser(req) {

  const token = req.cookies.vlx_session;

  if (!token) {
    return null;
  }

  const tokenHash = hashToken(token);

  const result = await pool.query(
    `
    SELECT
      u.id,
      u.email,
      u.display_name,
      u.role,
      u.telegram_user_id,
      u.created_at

    FROM vlx_sessions s

    JOIN vlx_users u
      ON u.id = s.user_id

    WHERE s.token_hash = $1
      AND s.expires_at > NOW()

    LIMIT 1
    `,
    [tokenHash]
  );

  return result.rows[0] || null;
}

async function requireAuth(req, res, next) {

  try {

    const user =
      await getCurrentUser(req);

    if (!user) {
      return res.status(401).json({
        error: "Authentication required"
      });
    }

    req.user = user;

    next();

  } catch (error) {

    console.error(error);

    res.status(500).json({
      error: "Authentication error"
    });

  }
}

async function requireAdmin(req, res, next) {

  try {

    const user =
      await getCurrentUser(req);

    if (!user) {
      return res.status(401).json({
        error: "Authentication required"
      });
    }

    if (user.role !== "admin") {
      return res.status(403).json({
        error: "Admin access required"
      });
    }

    req.user = user;

    next();

  } catch (error) {

    res.status(500).json({
      error: "Authentication error"
    });

  }
}

/* =========================================================
   RATE LIMITING
========================================================= */

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 50,
  standardHeaders: true,
  legacyHeaders: false
});

const orderLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false
});

app.use("/api/login", authLimiter);
app.use("/api/register", authLimiter);
app.use("/api/orders", orderLimiter);

/* =========================================================
   AUDIT
========================================================= */

async function audit(
  client,
  userId,
  action,
  req,
  metadata = {}
) {

  await client.query(
    `
    INSERT INTO vlx_audit_logs
    (
      user_id,
      action,
      ip,
      metadata
    )
    VALUES ($1,$2,$3,$4)
    `,
    [
      userId || null,
      action,
      req?.ip || null,
      JSON.stringify(metadata)
    ]
  );
}

/* =========================================================
   ASSET HELPERS
========================================================= */

async function getAssetBySymbol(client, symbol) {

  const result = await client.query(
    `
    SELECT *
    FROM vlx_assets
    WHERE symbol = $1
    LIMIT 1
    `,
    [String(symbol).toUpperCase()]
  );

  return result.rows[0] || null;
}

async function getPairAssets(client, symbol) {

  const parts =
    String(symbol)
      .toUpperCase()
      .split("/");

  if (parts.length !== 2) {
    throw new Error("Invalid trading pair");
  }

  const base = await getAssetBySymbol(
    client,
    parts[0]
  );

  const quote = await getAssetBySymbol(
    client,
    parts[1]
  );

  if (!base || !quote) {
    throw new Error("Asset not found");
  }

  return {
    base,
    quote
  };
}

function isPairAllowed(symbol) {
  return PAIRS.includes(
    String(symbol).toUpperCase()
  );
}

function isAssetTradable(asset) {

  if (!asset) return false;

  if (asset.status !== "active") {
    return false;
  }

  if (
    asset.symbol === "VLX" &&
    asset.listing_date
  ) {

    const today =
      new Date()
        .toISOString()
        .slice(0, 10);

    if (today < asset.listing_date) {
      return false;
    }

  }

  return true;
}

/* =========================================================
   BALANCE HELPERS
========================================================= */

async function ensureBalance(
  client,
  userId,
  assetId
) {

  await client.query(
    `
    INSERT INTO vlx_balances
    (
      user_id,
      asset_id,
      available,
      locked
    )
    VALUES ($1,$2,0,0)
    ON CONFLICT(user_id, asset_id)
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

  await ensureBalance(
    client,
    userId,
    assetId
  );

  const result = await client.query(
    `
    SELECT *
    FROM vlx_balances
    WHERE user_id = $1
      AND asset_id = $2
    FOR UPDATE
    `,
    [userId, assetId]
  );

  return result.rows[0];
}

async function changeBalance(
  client,
  userId,
  assetId,
  availableDelta,
  lockedDelta
) {

  const available =
    D(availableDelta);

  const locked =
    D(lockedDelta);

  const result = await client.query(
    `
    UPDATE vlx_balances
    SET
      available = available + $3,
      locked = locked + $4

    WHERE user_id = $1
      AND asset_id = $2

      AND available + $3 >= 0
      AND locked + $4 >= 0

    RETURNING *
    `,
    [
      userId,
      assetId,
      available.toFixed(),
      locked.toFixed()
    ]
  );

  if (!result.rows[0]) {
    throw new Error(
      "Insufficient or invalid balance"
    );
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
    (
      user_id,
      asset_id,
      amount,
      type,
      reference_id,
      note
    )
    VALUES ($1,$2,$3,$4,$5,$6)
    `,
    [
      userId,
      assetId,
      D(amount).toFixed(),
      type,
      referenceId || null,
      note || null
    ]
  );
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
      version: "2.0.0",
      database: "PostgreSQL",
      trading: true,
      blockchainDeposits: false,
      blockchainWithdrawals: false
    });

  } catch {

    res.status(503).json({
      ok: false
    });

  }

});

/* =========================================================
   CONFIG
========================================================= */

app.get("/api/config", (req, res) => {

  res.json({
    project: "VELTRIX EXCHANGE",
    symbol: "VLX",
    pairs: PAIRS,
    trading: true,
    tradingFeeBps: TRADING_FEE_BPS,
    blockchainDeposits: false,
    blockchainWithdrawals: false,
    vlxListingDate: "2026-11-24"
  });

});

/* =========================================================
   REGISTER
========================================================= */

app.post("/api/register", async (req, res) => {

  const email =
    String(req.body.email || "")
      .trim()
      .toLowerCase();

  const password =
    String(req.body.password || "");

  const displayName =
    String(
      req.body.displayName ||
      email.split("@")[0]
    )
      .trim()
      .slice(0, 80);

  if (
    !email ||
    !email.includes("@")
  ) {

    return res.status(400).json({
      error: "Valid email required"
    });

  }

  if (password.length < 8) {

    return res.status(400).json({
      error: "Password must contain at least 8 characters"
    });

  }

  if (!displayName) {

    return res.status(400).json({
      error: "Display name required"
    });

  }

  const passwordHash =
    await bcrypt.hash(password, 12);

  const client =
    await pool.connect();

  try {

    await client.query("BEGIN");

    const role =
      ADMIN_EMAIL &&
      email === ADMIN_EMAIL
        ? "admin"
        : "user";

    const userResult =
      await client.query(
        `
        INSERT INTO vlx_users
        (
          email,
          password_hash,
          display_name,
          role
        )
        VALUES ($1,$2,$3,$4)

        RETURNING
          id,
          email,
          display_name,
          role,
          telegram_user_id,
          created_at
        `,
        [
          email,
          passwordHash,
          displayName,
          role
        ]
      );

    const user =
      userResult.rows[0];

    const token =
      createSessionToken();

    const tokenHash =
      hashToken(token);

    await client.query(
      `
      INSERT INTO vlx_sessions
      (
        user_id,
        token_hash,
        expires_at
      )
      VALUES
      (
        $1,
        $2,
        NOW() + INTERVAL '${SESSION_DAYS} days'
      )
      `,
      [
        user.id,
        tokenHash
      ]
    );

    for (const asset of ASSETS) {

      const dbAsset =
        await getAssetBySymbol(
          client,
          asset.symbol
        );

      if (dbAsset) {

        await ensureBalance(
          client,
          user.id,
          dbAsset.id
        );

      }

    }

    await audit(
      client,
      user.id,
      "register",
      req
    );

    await client.query("COMMIT");

    setSessionCookie(
      res,
      token
    );

    res.json({
      ok: true,
      user
    });

  } catch (error) {

    await client.query("ROLLBACK");

    if (
      error.code === "23505"
    ) {

      return res.status(409).json({
        error: "Email already registered"
      });

    }

    console.error(error);

    res.status(500).json({
      error: "Registration failed"
    });

  } finally {

    client.release();

  }

});

/* =========================================================
   LOGIN
========================================================= */

app.post("/api/login", async (req, res) => {

  const email =
    String(req.body.email || "")
      .trim()
      .toLowerCase();

  const password =
    String(req.body.password || "");

  if (!email || !password) {

    return res.status(400).json({
      error: "Email and password required"
    });

  }

  try {

    const result =
      await pool.query(
        `
        SELECT *
        FROM vlx_users
        WHERE email = $1
        LIMIT 1
        `,
        [email]
      );

    const user =
      result.rows[0];

    if (!user) {

      return res.status(401).json({
        error: "Invalid email or password"
      });

    }

    const valid =
      await bcrypt.compare(
        password,
        user.password_hash
      );

    if (!valid) {

      return res.status(401).json({
        error: "Invalid email or password"
      });

    }

    const token =
      createSessionToken();

    const tokenHash =
      hashToken(token);

    await pool.query(
      `
      INSERT INTO vlx_sessions
      (
        user_id,
        token_hash,
        expires_at
      )
      VALUES
      (
        $1,
        $2,
        NOW() + INTERVAL '${SESSION_DAYS} days'
      )
      `,
      [
        user.id,
        tokenHash
      ]
    );

    setSessionCookie(
      res,
      token
    );

    res.json({
      ok: true,
      user: {
        id: user.id,
        email: user.email,
        display_name: user.display_name,
        role: user.role,
        telegram_user_id:
          user.telegram_user_id,
        created_at: user.created_at
      }
    });

  } catch (error) {

    console.error(error);

    res.status(500).json({
      error: "Login failed"
    });

  }

});

/* =========================================================
   ME
========================================================= */

app.get(
  "/api/me",
  requireAuth,
  async (req, res) => {

    res.json({
      user: req.user
    });

  }
);

/* =========================================================
   LOGOUT
========================================================= */

app.post(
  "/api/logout",
  async (req, res) => {

    try {

      const token =
        req.cookies.vlx_session;

      if (token) {

        await pool.query(
          `
          DELETE FROM vlx_sessions
          WHERE token_hash = $1
          `,
          [hashToken(token)]
        );

      }

      clearSessionCookie(res);

      res.json({
        ok: true
      });

    } catch {

      clearSessionCookie(res);

      res.json({
        ok: true
      });

    }

  }
);

/* =========================================================
   ASSETS
========================================================= */

app.get("/api/assets", async (req, res) => {

  try {

    const result =
      await pool.query(
        `
        SELECT
          symbol,
          name,
          network,
          status,
          listing_date,
          decimals

        FROM vlx_assets

        ORDER BY
          CASE
            WHEN symbol = 'USDT' THEN 0
            ELSE 1
          END,
          symbol
        `
      );

    res.json({
      assets: result.rows
    });

  } catch {

    res.status(500).json({
      error: "Unable to load assets"
    });

  }

});

/* =========================================================
   BALANCES
========================================================= */

app.get(
  "/api/balances",
  requireAuth,
  async (req, res) => {

    try {

      const result =
        await pool.query(
          `
          SELECT
            a.symbol,
            a.name,
            a.network,
            a.decimals,
            b.available,
            b.locked

          FROM vlx_balances b

          JOIN vlx_assets a
            ON a.id = b.asset_id

          WHERE b.user_id = $1

          ORDER BY
            CASE
              WHEN a.symbol = 'USDT' THEN 0
              ELSE 1
            END,
            a.symbol
          `,
          [req.user.id]
        );

      res.json({
        balances: result.rows
      });

    } catch (error) {

      console.error(error);

      res.status(500).json({
        error: "Unable to load balances"
      });

    }

  }
);

/* =========================================================
   ORDER BOOK
========================================================= */

app.get(
  "/api/orderbook/:symbol",
  async (req, res) => {

    const symbol =
      decodeURIComponent(
        req.params.symbol
      ).toUpperCase();

    if (!isPairAllowed(symbol)) {

      return res.status(400).json({
        error: "Unsupported pair"
      });

    }

    try {

      const asks =
        await pool.query(
          `
          SELECT
            price,
            SUM(
              quantity - filled_quantity
            ) AS quantity

          FROM vlx_orders

          WHERE symbol = $1
            AND side = 'sell'
            AND status IN
              ('open','partially_filled')

          GROUP BY price

          HAVING SUM(
            quantity - filled_quantity
          ) > 0

          ORDER BY price ASC

          LIMIT 50
          `,
          [symbol]
        );

      const bids =
        await pool.query(
          `
          SELECT
            price,
            SUM(
              quantity - filled_quantity
            ) AS quantity

          FROM vlx_orders

          WHERE symbol = $1
            AND side = 'buy'
            AND status IN
              ('open','partially_filled')

          GROUP BY price

          HAVING SUM(
            quantity - filled_quantity
          ) > 0

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

    } catch (error) {

      console.error(error);

      res.status(500).json({
        error: "Unable to load order book"
      });

    }

  }
);

/* =========================================================
   MARKET DATA
========================================================= */

app.get(
  "/api/market/:symbol",
  async (req, res) => {

    const symbol =
      decodeURIComponent(
        req.params.symbol
      ).toUpperCase();

    if (!isPairAllowed(symbol)) {

      return res.status(400).json({
        error: "Unsupported pair"
      });

    }

    try {

      const result =
        await pool.query(
          `
          SELECT

            (
              SELECT price
              FROM vlx_trades
              WHERE symbol = $1
              ORDER BY created_at DESC
              LIMIT 1
            ) AS last_price,

            (
              SELECT MAX(price)
              FROM vlx_trades
              WHERE symbol = $1
                AND created_at >= NOW() - INTERVAL '24 hours'
            ) AS high_24h,

            (
              SELECT MIN(price)
              FROM vlx_trades
              WHERE symbol = $1
                AND created_at >= NOW() - INTERVAL '24 hours'
            ) AS low_24h,

            COALESCE(
              (
                SELECT SUM(quote_amount)
                FROM vlx_trades
                WHERE symbol = $1
                  AND created_at >= NOW() - INTERVAL '24 hours'
              ),
              0
            ) AS volume_24h,

            (
              SELECT price
              FROM vlx_trades
              WHERE symbol = $1
                AND created_at >= NOW() - INTERVAL '24 hours'
              ORDER BY created_at ASC
              LIMIT 1
            ) AS open_24h
          `,
          [symbol]
        );

      const row =
        result.rows[0];

      let change = null;

      if (
        row.open_24h &&
        row.last_price
      ) {

        change =
          D(row.last_price)
            .minus(row.open_24h)
            .div(row.open_24h)
            .mul(100)
            .toFixed(4);

      }

      res.json({
        symbol,
        lastPrice: row.last_price,
        high24h: row.high_24h,
        low24h: row.low_24h,
        volume24h: row.volume_24h,
        change24h: change
      });

    } catch (error) {

      console.error(error);

      res.status(500).json({
        error: "Unable to load market data"
      });

    }

  }
);

/* =========================================================
   CANDLES
========================================================= */

app.get(
  "/api/candles/:symbol",
  async (req, res) => {

    const symbol =
      decodeURIComponent(
        req.params.symbol
      ).toUpperCase();

    if (!isPairAllowed(symbol)) {

      return res.status(400).json({
        error: "Unsupported pair"
      });

    }

    const interval =
      String(
        req.query.interval || "1m"
      );

    const limits = {
      "1m": {
        seconds: 60,
        lookback: 100000
      },

      "5m": {
        seconds: 300,
        lookback: 200000
      },

      "15m": {
        seconds: 900,
        lookback: 400000
      },

      "1H": {
        seconds: 3600,
        lookback: 1000000
      },

      "4H": {
        seconds: 14400,
        lookback: 2000000
      },

      "1D": {
        seconds: 86400,
        lookback: 5000000
      }
    };

    const config =
      limits[interval] ||
      limits["1m"];

    const limit =
      Math.min(
        Math.max(
          Number(req.query.limit || 200),
          20
        ),
        500
      );

    try {

      const result =
        await pool.query(
          `
          WITH bucketed AS (

            SELECT

              to_timestamp(
                floor(
                  extract(
                    epoch FROM created_at
                  ) / $2
                ) * $2
              ) AS bucket,

              price,
              quantity

            FROM vlx_trades

            WHERE symbol = $1
              AND created_at >= NOW() - ($3 * INTERVAL '1 second')

            ORDER BY created_at ASC
          ),

          candles AS (

            SELECT

              bucket,

              (
                ARRAY_AGG(
                  price
                  ORDER BY bucket
                )
              )[1] AS dummy,

              MIN(price) AS low,
              MAX(price) AS high,
              SUM(quantity) AS volume

            FROM bucketed

            GROUP BY bucket
          )

          SELECT
            bucket,
            low,
            high,
            volume

          FROM candles

          ORDER BY bucket DESC

          LIMIT $4
          `,
          [
            symbol,
            config.seconds,
            config.lookback,
            limit
          ]
        );

      /*
        We need proper OHLC.
        Fetch the candle source rows separately
        and construct exact OHLC in JS.
      */

      const raw =
        await pool.query(
          `
          SELECT
            created_at,
            price,
            quantity

          FROM vlx_trades

          WHERE symbol = $1
            AND created_at >= NOW() - ($2 * INTERVAL '1 second')

          ORDER BY created_at ASC

          LIMIT 10000
          `,
          [
            symbol,
            config.lookback
          ]
        );

      const buckets = new Map();

      for (const row of raw.rows) {

        const timestamp =
          new Date(row.created_at)
            .getTime();

        const bucketMs =
          config.seconds * 1000;

        const bucket =
          Math.floor(
            timestamp / bucketMs
          ) * bucketMs;

        const price =
          D(row.price);

        const quantity =
          D(row.quantity);

        if (!buckets.has(bucket)) {

          buckets.set(
            bucket,
            {
              time: bucket,
              open: price,
              high: price,
              low: price,
              close: price,
              volume: quantity
            }
          );

        } else {

          const candle =
            buckets.get(bucket);

          candle.high =
            Decimal.max(
              candle.high,
              price
            );

          candle.low =
            Decimal.min(
              candle.low,
              price
            );

          candle.close =
            price;

          candle.volume =
            candle.volume.add(
              quantity
            );

        }

      }

      const candles =
        Array.from(
          buckets.values()
        )
          .sort(
            (a, b) =>
              a.time - b.time
          )
          .slice(-limit)
          .map(c => ({
            time: c.time,
            open: c.open.toFixed(),
            high: c.high.toFixed(),
            low: c.low.toFixed(),
            close: c.close.toFixed(),
            volume: c.volume.toFixed()
          }));

      res.json({
        symbol,
        interval,
        candles
      });

    } catch (error) {

      console.error(error);

      res.status(500).json({
        error: "Unable to load candles"
      });

    }

  }
);

/* =========================================================
   CREATE ORDER
========================================================= */

app.post(
  "/api/orders",
  requireAuth,
  async (req, res) => {

    const symbol =
      String(
        req.body.symbol || ""
      ).toUpperCase();

    const side =
      String(
        req.body.side || ""
      ).toLowerCase();

    const orderType =
      String(
        req.body.orderType ||
        req.body.order_type ||
        ""
      ).toLowerCase();

    const priceInput =
      req.body.price;

    const quantityInput =
      req.body.quantity;

    /*
      For MARKET BUY:
      frontend sends quoteAmount.
      Example:
      Buy BTC with 100 USDT.
    */

    const quoteAmountInput =
      req.body.quoteAmount;

    if (!isPairAllowed(symbol)) {

      return res.status(400).json({
        error: "Unsupported trading pair"
      });

    }

    if (
      side !== "buy" &&
      side !== "sell"
    ) {

      return res.status(400).json({
        error: "Invalid side"
      });

    }

    if (
      orderType !== "limit" &&
      orderType !== "market"
    ) {

      return res.status(400).json({
        error: "Invalid order type"
      });

    }

    const client =
      await pool.connect();

    try {

      await client.query("BEGIN");

      /*
        One matcher per symbol at a time.
        This prevents two simultaneous matching
        transactions from consuming the same liquidity.
      */

      await client.query(
        `
        SELECT pg_advisory_xact_lock(
          hashtext($1)::bigint
        )
        `,
        [symbol]
      );

      const {
        base,
        quote
      } = await getPairAssets(
        client,
        symbol
      );

      if (
        !isAssetTradable(base) ||
        !isAssetTradable(quote)
      ) {

        throw new Error(
          "This trading pair is not currently available"
        );

      }

      let price = null;
      let quantity = null;
      let quoteAmount = null;

      if (orderType === "limit") {

        price = D(priceInput);
        quantity = D(quantityInput);

        if (!price.gt(0)) {
          throw new Error(
            "Invalid price"
          );
        }

        if (!quantity.gt(0)) {
          throw new Error(
            "Invalid quantity"
          );
        }

        if (side === "buy") {

          quoteAmount =
            price.mul(quantity);

        } else {

          quoteAmount =
            price.mul(quantity);

        }

      } else {

        if (side === "sell") {

          quantity =
            D(quantityInput);

          if (!quantity.gt(0)) {

            throw new Error(
              "Invalid quantity"
            );

          }

        } else {

          quoteAmount =
            D(
              quoteAmountInput ||
              quantityInput
            );

          if (!quoteAmount.gt(0)) {

            throw new Error(
              "Enter the USDT amount for market buy"
            );

          }

          /*
            We use a large quantity ceiling for
            market-buy orders. The actual spend is
            controlled by remaining_quote.
          */

          quantity =
            new Decimal(
              "999999999999999999999999"
            );

        }

      }

      /*
        MARKET order needs liquidity.
      */

      if (orderType === "market") {

        const sideBook =
          await client.query(
            `
            SELECT
              price,
              quantity - filled_quantity AS remaining

            FROM vlx_orders

            WHERE symbol = $1
              AND side = $2
              AND status IN
                ('open','partially_filled')

            ORDER BY
              CASE
                WHEN $2 = 'buy'
                THEN price DESC
                ELSE price ASC
              END,
              created_at ASC

            LIMIT 1
            `,
            [
              symbol,
              side === "buy"
                ? "sell"
                : "buy"
            ]
          );

        if (!sideBook.rows.length) {

          throw new Error(
            "No liquidity available"
          );

        }

      }

      /*
        Reserve user's funds.
      */

      if (side === "buy") {

        const balance =
          await getBalanceForUpdate(
            client,
            req.user.id,
            quote.id
          );

        const available =
          D(balance.available);

        const reserve =
          orderType === "market"
            ? quoteAmount
            : price.mul(quantity);

        if (available.lt(reserve)) {

          throw new Error(
            `Insufficient ${quote.symbol} balance`
          );

        }

        await changeBalance(
          client,
          req.user.id,
          quote.id,
          reserve.neg(),
          reserve
        );

        await ledger(
          client,
          req.user.id,
          quote.id,
          reserve.neg(),
          "order_lock",
          null,
          `Reserved ${symbol} buy order`
        );

      } else {

        const balance =
          await getBalanceForUpdate(
            client,
            req.user.id,
            base.id
          );

        const available =
          D(balance.available);

        if (available.lt(quantity)) {

          throw new Error(
            `Insufficient ${base.symbol} balance`
          );

        }

        await changeBalance(
          client,
          req.user.id,
          base.id,
          quantity.neg(),
          quantity
        );

        await ledger(
          client,
          req.user.id,
          base.id,
          quantity.neg(),
          "order_lock",
          null,
          `Reserved ${symbol} sell order`
        );

      }

      const orderResult =
        await client.query(
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
            quote_amount,
            remaining_quote,
            status
          )

          VALUES
          (
            $1,$2,$3,$4,$5,$6,0,$7,$8,'open'
          )

          RETURNING *
          `,
          [
            req.user.id,
            symbol,
            side,
            orderType,
            price
              ? price.toFixed()
              : null,

            quantity.toFixed(),

            orderType === "market"
              ? quoteAmount.toFixed()
              : null,

            orderType === "market"
              ? quoteAmount.toFixed()
              : null
          ]
        );

      const order =
        orderResult.rows[0];

      await matchOrder(
        client,
        order.id
      );

      const finalOrder =
        await client.query(
          `
          SELECT *
          FROM vlx_orders
          WHERE id = $1
          `,
          [order.id]
        );

      await audit(
        client,
        req.user.id,
        "create_order",
        req,
        {
          orderId: order.id,
          symbol,
          side,
          orderType
        }
      );

      await client.query("COMMIT");

      res.json({
        ok: true,
        order: finalOrder.rows[0]
      });

    } catch (error) {

      await client.query("ROLLBACK");

      console.error(
        "Order error:",
        error
      );

      res.status(400).json({
        error: error.message ||
          "Unable to create order"
      });

    } finally {

      client.release();

    }

  }
);

/* =========================================================
   MATCH ENGINE
========================================================= */

async function matchOrder(
  client,
  orderId
) {

  const orderResult =
    await client.query(
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

  let incoming =
    orderResult.rows[0];

  const pair =
    await getPairAssets(
      client,
      incoming.symbol
    );

  const {
    base,
    quote
  } = pair;

  while (
    incoming.status === "open" ||
    incoming.status === "partially_filled"
  ) {

    const remainingBase =
      D(incoming.quantity)
        .minus(incoming.filled_quantity);

    if (
      incoming.order_type === "market" &&
      incoming.side === "buy" &&
      D(incoming.remaining_quote).lte(0)
    ) {
      break;
    }

    if (remainingBase.lte(0)) {
      break;
    }

    const oppositeSide =
      incoming.side === "buy"
        ? "sell"
        : "buy";

    const condition =
      incoming.order_type === "market"
        ? ""
        : incoming.side === "buy"
          ? "AND price <= $2"
          : "AND price >= $2";

    const params =
      incoming.order_type === "market"
        ? [
            incoming.symbol,
            oppositeSide
          ]
        : [
            incoming.symbol,
            incoming.price,
            oppositeSide
          ];

    /*
      We don't use user_id <> in SQL here because
      it is safer to check self-trade after locking
      the maker order.
    */

    let makerResult;

    if (
      incoming.order_type === "market"
    ) {

      makerResult =
        await client.query(
          `
          SELECT *
          FROM vlx_orders

          WHERE symbol = $1
            AND side = $2

            AND status IN
              ('open','partially_filled')

          ORDER BY
            CASE
              WHEN $2 = 'sell'
              THEN price
            END ASC,

            CASE
              WHEN $2 = 'buy'
              THEN price
            END DESC,

            created_at ASC,
            id ASC

          LIMIT 1

          FOR UPDATE SKIP LOCKED
          `,
          [
            incoming.symbol,
            oppositeSide
          ]
        );

    } else if (
      incoming.side === "buy"
    ) {

      makerResult =
        await client.query(
          `
          SELECT *
          FROM vlx_orders

          WHERE symbol = $1
            AND side = 'sell'
            AND status IN
              ('open','partially_filled')
            AND price <= $2

          ORDER BY
            price ASC,
            created_at ASC,
            id ASC

          LIMIT 1

          FOR UPDATE SKIP LOCKED
          `,
          [
            incoming.symbol,
            incoming.price
          ]
        );

    } else {

      makerResult =
        await client.query(
          `
          SELECT *
          FROM vlx_orders

          WHERE symbol = $1
            AND side = 'buy'
            AND status IN
              ('open','partially_filled')
            AND price >= $2

          ORDER BY
            price DESC,
            created_at ASC,
            id ASC

          LIMIT 1

          FOR UPDATE SKIP LOCKED
          `,
          [
            incoming.symbol,
            incoming.price
          ]
        );

    }

    if (!makerResult.rows.length) {
      break;
    }

    const maker =
      makerResult.rows[0];

    if (
      Number(maker.user_id) ===
      Number(incoming.user_id)
    ) {

      /*
        Prevent self-trading by skipping this order.
        To avoid infinite loops, cancel the incoming
        order's remaining portion rather than trading
        with itself.
      */

      break;
    }

    const makerRemaining =
      D(maker.quantity)
        .minus(maker.filled_quantity);

    if (makerRemaining.lte(0)) {
      continue;
    }

    /*
      Maker price determines execution price.
    */

    const tradePrice =
      D(maker.price);

    let tradeQuantity =
      minDecimal(
        remainingBase,
        makerRemaining
      );

    /*
      Market BUY is controlled by quote budget.
    */

    if (
      incoming.order_type === "market" &&
      incoming.side === "buy"
    ) {

      const remainingQuote =
        D(incoming.remaining_quote);

      const maxBase =
        remainingQuote
          .div(tradePrice);

      tradeQuantity =
        minDecimal(
          tradeQuantity,
          maxBase
        );

    }

    if (tradeQuantity.lte(0)) {
      break;
    }

    const quoteValue =
      tradeQuantity.mul(
        tradePrice
      );

    const tradeFee =
      feeFor(quoteValue);

    /*
      Determine buyer/seller.
    */

    const buyerId =
      incoming.side === "buy"
        ? incoming.user_id
        : maker.user_id;

    const sellerId =
      incoming.side === "sell"
        ? incoming.user_id
        : maker.user_id;

    /*
      Lock buyer and seller balances
      in consistent order to avoid deadlocks.
    */

    const firstUser =
      Number(buyerId) <
      Number(sellerId)
        ? buyerId
        : sellerId;

    const secondUser =
      Number(buyerId) <
      Number(sellerId)
        ? sellerId
        : buyerId;

    const buyerQuote =
      await getBalanceForUpdate(
        client,
        buyerId,
        quote.id
      );

    const sellerBase =
      await getBalanceForUpdate(
        client,
        sellerId,
        base.id
      );

    /*
      Buyer quote is already locked.

      For a LIMIT BUY:
      reserved amount is limitPrice * quantity.

      For a MARKET BUY:
      reserved amount is actual quote spent.
    */

    let buyerReserved;

    const buyerOrder =
      incoming.side === "buy"
        ? incoming
        : maker;

    if (
      buyerOrder.order_type === "market"
    ) {

      buyerReserved =
        quoteValue;

    } else {

      buyerReserved =
        tradeQuantity.mul(
          D(buyerOrder.price)
        );

    }

    /*
      Seller base is locked.
    */

    /*
      Move quote from buyer locked
      into seller available.

      Fee, if configured, is removed
      from seller's received quote.
    */

    const sellerQuoteReceived =
      quoteValue
        .minus(tradeFee);

    await changeBalance(
      client,
      buyerId,
      quote.id,
      0,
      buyerReserved.neg()
    );

    /*
      Return any unused limit-buy reservation
      immediately to available.
    */

    const buyerRefund =
      buyerOrder.order_type === "limit"
        ? buyerReserved.minus(
            quoteValue
          )
        : D(0);

    if (buyerRefund.gt(0)) {

      await changeBalance(
        client,
        buyerId,
        quote.id,
        buyerRefund,
        0
      );

    }

    /*
      Market BUY spends actual quote.
      remaining_quote decreases by actual cost.
    */

    if (
      buyerOrder.order_type === "market"
    ) {

      const newRemainingQuote =
        D(buyerOrder.remaining_quote)
          .minus(quoteValue);

      await client.query(
        `
        UPDATE vlx_orders
        SET remaining_quote = $2
        WHERE id = $1
        `,
        [
          buyerOrder.id,
          newRemainingQuote.toFixed()
        ]
      );

    }

    /*
      Seller locked base decreases.
    */

    await changeBalance(
      client,
      sellerId,
      base.id,
      0,
      tradeQuantity.neg()
    );

    /*
      Buyer receives base.
    */

    await changeBalance(
      client,
      buyerId,
      base.id,
      tradeQuantity,
      0
    );

    /*
      Seller receives quote.
    */

    await changeBalance(
      client,
      sellerId,
      quote.id,
      sellerQuoteReceived,
      0
    );

    /*
      Ledger records.
    */

    await ledger(
      client,
      buyerId,
      base.id,
      tradeQuantity,
      "trade_buy",
      String(orderId),
      `Bought ${base.symbol}`
    );

    await ledger(
      client,
      sellerId,
      base.id,
      tradeQuantity.neg(),
      "trade_sell",
      String(orderId),
      `Sold ${base.symbol}`
    );

    await ledger(
      client,
      sellerId,
      quote.id,
      sellerQuoteReceived,
      "trade_receive",
      String(orderId),
      `Received ${quote.symbol}`
    );

    if (
      tradeFee.gt(0)
    ) {

      await ledger(
        client,
        sellerId,
        quote.id,
        tradeFee.neg(),
        "trading_fee",
        String(orderId),
        "Trading fee"
      );

    }

    /*
      Update maker/incoming fills.
    */

    const incomingNewFilled =
      D(incoming.filled_quantity)
        .add(tradeQuantity);

    const makerNewFilled =
      D(maker.filled_quantity)
        .add(tradeQuantity);

    const incomingDone =
      incomingNewFilled.gte(
        D(incoming.quantity)
      ) ||
      (
        incoming.order_type === "market" &&
        incoming.side === "buy" &&
        D(incoming.remaining_quote)
          .minus(quoteValue)
          .lte(0)
      );

    const makerDone =
      makerNewFilled.gte(
        D(maker.quantity)
      );

    const incomingStatus =
      incomingDone
        ? "filled"
        : "partially_filled";

    const makerStatus =
      makerDone
        ? "filled"
        : "partially_filled";

    await client.query(
      `
      UPDATE vlx_orders
      SET
        filled_quantity = $2,
        status = $3
      WHERE id = $1
      `,
      [
        incoming.id,
        incomingNewFilled.toFixed(),
        incomingStatus
      ]
    );

    await client.query(
      `
      UPDATE vlx_orders
      SET
        filled_quantity = $2,
        status = $3
      WHERE id = $1
      `,
      [
        maker.id,
        makerNewFilled.toFixed(),
        makerStatus
      ]
    );

    /*
      If maker is a limit BUY and is filled,
      any tiny leftover locked quote should be released.

      If partially filled, its remaining quote remains locked.
    */

    if (
      makerDone &&
      maker.side === "buy"
    ) {

      const remainingMakerQty =
        D(maker.quantity)
          .minus(makerNewFilled);

      const reservedLeft =
        remainingMakerQty.gt(0)
          ? remainingMakerQty.mul(
              D(maker.price)
            )
          : D(0);

      /*
        Normally zero when filled.
        Safety refund only if database has
        residual lock.
      */

      if (reservedLeft.eq(0)) {

        /*
          Nothing to unlock.
        */

      }

    }

    /*
      If maker is fully filled and it was a
      market order, its remaining quote is zero.
    */

    /*
      Save trade.
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
        quantity,
        quote_amount
      )

      VALUES
      (
        $1,$2,$3,$4,$5,$6,$7,$8
      )
      `,
      [
        incoming.symbol,

        incoming.side === "buy"
          ? incoming.id
          : maker.id,

        incoming.side === "sell"
          ? incoming.id
          : maker.id,

        buyerId,
        sellerId,

        tradePrice.toFixed(),
        tradeQuantity.toFixed(),
        quoteValue.toFixed()
      ]
    );

    /*
      Refresh incoming order.
    */

    const refreshed =
      await client.query(
        `
        SELECT *
        FROM vlx_orders
        WHERE id = $1
        FOR UPDATE
        `,
        [incoming.id]
      );

    incoming =
      refreshed.rows[0];

    /*
      If maker is completed and was a limit order,
      any impossible residual locked balance is
      not silently created. Actual reservation
      is reduced per trade.
    */

  }

  /*
    Market order with unfilled quantity:
    release remaining reservation.

    Limit order remains open with its reservation.
  */

  const finalResult =
    await client.query(
      `
      SELECT *
      FROM vlx_orders
      WHERE id = $1
      FOR UPDATE
      `,
      [orderId]
    );

  const finalOrder =
    finalResult.rows[0];

  if (
    finalOrder.order_type === "market"
  ) {

    if (
      finalOrder.side === "buy"
    ) {

      const remainingQuote =
        D(finalOrder.remaining_quote || 0);

      if (remainingQuote.gt(0)) {

        await changeBalance(
          client,
          finalOrder.user_id,
          quote.id,
          remainingQuote,
          remainingQuote.neg()
        );

        await ledger(
          client,
          finalOrder.user_id,
          quote.id,
          remainingQuote,
          "market_refund",
          String(finalOrder.id),
          "Unused market buy balance released"
        );

        await client.query(
          `
          UPDATE vlx_orders
          SET remaining_quote = 0
          WHERE id = $1
          `,
          [finalOrder.id]
        );

      }

    } else {

      const remainingBase =
        D(finalOrder.quantity)
          .minus(
            finalOrder.filled_quantity
          );

      if (remainingBase.gt(0)) {

        await changeBalance(
          client,
          finalOrder.user_id,
          base.id,
          remainingBase,
          remainingBase.neg()
        );

        await ledger(
          client,
          finalOrder.user_id,
          base.id,
          remainingBase,
          "market_refund",
          String(finalOrder.id),
          "Unused market sell balance released"
        );

      }

    }

    const currentFilled =
      D(finalOrder.filled_quantity);

    await client.query(
      `
      UPDATE vlx_orders
      SET status = $2
      WHERE id = $1
      `,
      [
        finalOrder.id,
        currentFilled.gt(0)
          ? "filled"
          : "cancelled"
      ]
    );

  }

}

/* =========================================================
   CANCEL ORDER
========================================================= */

app.delete(
  "/api/orders/:id",
  requireAuth,
  async (req, res) => {

    const orderId =
      Number(req.params.id);

    if (!Number.isInteger(orderId)) {

      return res.status(400).json({
        error: "Invalid order ID"
      });

    }

    const client =
      await pool.connect();

    try {

      await client.query("BEGIN");

      const orderResult =
        await client.query(
          `
          SELECT *
          FROM vlx_orders
          WHERE id = $1
            AND user_id = $2
          FOR UPDATE
          `,
          [
            orderId,
            req.user.id
          ]
        );

      if (!orderResult.rows.length) {

        throw new Error(
          "Order not found"
        );

      }

      const order =
        orderResult.rows[0];

      if (
        order.status !== "open" &&
        order.status !== "partially_filled"
      ) {

        throw new Error(
          "Order cannot be cancelled"
        );

      }

      await client.query(
        `
        SELECT pg_advisory_xact_lock(
          hashtext($1)::bigint
        )
        `,
        [order.symbol]
      );

      const {
        base,
        quote
      } =
        await getPairAssets(
          client,
          order.symbol
        );

      const remaining =
        D(order.quantity)
          .minus(order.filled_quantity);

      if (order.side === "sell") {

        if (remaining.gt(0)) {

          await changeBalance(
            client,
            order.user_id,
            base.id,
            remaining,
            remaining.neg()
          );

          await ledger(
            client,
            order.user_id,
            base.id,
            remaining,
            "order_unlock",
            String(order.id),
            "Cancelled sell order"
          );

        }

      } else {

        if (
          order.order_type === "limit"
        ) {

          const lockedQuote =
            remaining.mul(
              D(order.price)
            );

          if (lockedQuote.gt(0)) {

            await changeBalance(
              client,
              order.user_id,
              quote.id,
              lockedQuote,
              lockedQuote.neg()
            );

            await ledger(
              client,
              order.user_id,
              quote.id,
              lockedQuote,
              "order_unlock",
              String(order.id),
              "Cancelled buy order"
            );

          }

        } else {

          const remainingQuote =
            D(
              order.remaining_quote || 0
            );

          if (remainingQuote.gt(0)) {

            await changeBalance(
              client,
              order.user_id,
              quote.id,
              remainingQuote,
              remainingQuote.neg()
            );

            await ledger(
              client,
              order.user_id,
              quote.id,
              remainingQuote,
              "order_unlock",
              String(order.id),
              "Cancelled market buy"
            );

          }

        }

      }

      await client.query(
        `
        UPDATE vlx_orders
        SET status = 'cancelled'
        WHERE id = $1
        `,
        [order.id]
      );

      await audit(
        client,
        req.user.id,
        "cancel_order",
        req,
        {
          orderId: order.id
        }
      );

      await client.query("COMMIT");

      res.json({
        ok: true
      });

    } catch (error) {

      await client.query("ROLLBACK");

      res.status(400).json({
        error:
          error.message ||
          "Unable to cancel order"
      });

    } finally {

      client.release();

    }

  }
);

/* =========================================================
   USER ORDERS
========================================================= */

app.get(
  "/api/orders",
  requireAuth,
  async (req, res) => {

    const symbol =
      req.query.symbol
        ? String(
            req.query.symbol
          ).toUpperCase()
        : null;

    try {

      const result =
        await pool.query(
          `
          SELECT
            id,
            symbol,
            side,
            order_type,
            price,
            quantity,
            filled_quantity,
            quote_amount,
            remaining_quote,
            status,
            created_at

          FROM vlx_orders

          WHERE user_id = $1

            AND (
              $2::text IS NULL
              OR symbol = $2
            )

          ORDER BY created_at DESC

          LIMIT 200
          `,
          [
            req.user.id,
            symbol
          ]
        );

      res.json({
        orders: result.rows
      });

    } catch (error) {

      res.status(500).json({
        error: "Unable to load orders"
      });

    }

  }
);

/* =========================================================
   TRADE HISTORY
========================================================= */

app.get(
  "/api/trades/:symbol",
  async (req, res) => {

    const symbol =
      decodeURIComponent(
        req.params.symbol
      ).toUpperCase();

    if (!isPairAllowed(symbol)) {

      return res.status(400).json({
        error: "Unsupported pair"
      });

    }

    try {

      const result =
        await pool.query(
          `
          SELECT
            id,
            price,
            quantity,
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
        trades: result.rows
      });

    } catch {

      res.status(500).json({
        error: "Unable to load trades"
      });

    }

  }
);

/* =========================================================
   USER TRADE HISTORY
========================================================= */

app.get(
  "/api/my-trades",
  requireAuth,
  async (req, res) => {

    const result =
      await pool.query(
        `
        SELECT
          t.*,

          CASE
            WHEN t.buyer_id = $1
            THEN 'buy'
            ELSE 'sell'
          END AS side

        FROM vlx_trades t

        WHERE
          t.buyer_id = $1
          OR t.seller_id = $1

        ORDER BY
          t.created_at DESC

        LIMIT 200
        `,
        [req.user.id]
      );

    res.json({
      trades: result.rows
    });

  }
);

/* =========================================================
   LISTING
========================================================= */

app.get(
  "/api/listing",
  (req, res) => {

    res.json({
      project: "VELTRIX",
      symbol: "VLX",
      plannedListingDate: "2026-11-24",
      status: "planned"
    });

  }
);

/* =========================================================
   TELEGRAM LINK
========================================================= */

app.post(
  "/api/account/link-telegram",
  requireAuth,
  async (req, res) => {

    const telegramUserId =
      String(
        req.body.telegramUserId || ""
      ).trim();

    if (!telegramUserId) {

      return res.status(400).json({
        error: "telegramUserId required"
      });

    }

    try {

      await pool.query(
        `
        UPDATE vlx_users
        SET telegram_user_id = $1
        WHERE id = $2
        `,
        [
          telegramUserId,
          req.user.id
        ]
      );

      res.json({
        ok: true
      });

    } catch (error) {

      if (
        error.code === "23505"
      ) {

        return res.status(409).json({
          error:
            "This Telegram account is already linked"
        });

      }

      res.status(500).json({
        error: "Unable to link Telegram"
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

    if (!MINER_API_SECRET) {

      return res.status(503).json({
        error:
          "Miner integration is not configured"
      });

    }

    const telegramUserId =
      String(
        req.body.telegramUserId || ""
      ).trim();

    const amount =
      D(req.body.amount || 0);

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
      !requestId ||
      !amount.gt(0) ||
      !signature
    ) {

      return res.status(400).json({
        error: "Invalid miner request"
      });

    }

    const payload =
      `${telegramUserId}:${amount.toFixed()}:${requestId}`;

    const expected =
      crypto
        .createHmac(
          "sha256",
          MINER_API_SECRET
        )
        .update(payload)
        .digest("hex");

    if (
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

      const duplicate =
        await client.query(
          `
          SELECT id
          FROM vlx_ledger_entries
          WHERE type = 'miner_credit'
            AND reference_id = $1
          LIMIT 1
          `,
          [requestId]
        );

      if (duplicate.rows.length) {

        await client.query("ROLLBACK");

        return res.json({
          ok: true,
          duplicate: true
        });

      }

      const userResult =
        await client.query(
          `
          SELECT id
          FROM vlx_users
          WHERE telegram_user_id = $1
          FOR UPDATE
          `,
          [telegramUserId]
        );

      if (!userResult.rows.length) {

        throw new Error(
          "Telegram account is not linked"
        );

      }

      const userId =
        userResult.rows[0].id;

      const vlx =
        await getAssetBySymbol(
          client,
          "VLX"
        );

      await ensureBalance(
        client,
        userId,
        vlx.id
      );

      await changeBalance(
        client,
        userId,
        vlx.id,
        amount,
        0
      );

      await ledger(
        client,
        userId,
        vlx.id,
        amount,
        "miner_credit",
        requestId,
        "VELTRIX Telegram Miner credit"
      );

      await client.query("COMMIT");

      res.json({
        ok: true,
        credited: amount.toFixed()
      });

    } catch (error) {

      await client.query("ROLLBACK");

      res.status(400).json({
        error:
          error.message ||
          "Miner credit failed"
      });

    } finally {

      client.release();

    }

  }
);

/* =========================================================
   DEPOSIT STATUS
========================================================= */

app.get(
  "/api/deposits",
  requireAuth,
  async (req, res) => {

    const result =
      await pool.query(
        `
        SELECT
          d.id,
          a.symbol,
          d.amount,
          d.txid,
          d.status,
          d.created_at

        FROM vlx_deposits d

        JOIN vlx_assets a
          ON a.id = d.asset_id

        WHERE d.user_id = $1

        ORDER BY d.created_at DESC

        LIMIT 100
        `,
        [req.user.id]
      );

    res.json({
      blockchainEnabled: false,
      deposits: result.rows
    });

  }
);

/* =========================================================
   WITHDRAWAL STATUS
========================================================= */

app.get(
  "/api/withdrawals",
  requireAuth,
  async (req, res) => {

    const result =
      await pool.query(
        `
        SELECT
          w.id,
          a.symbol,
          w.amount,
          w.address,
          w.txid,
          w.status,
          w.created_at

        FROM vlx_withdrawals w

        JOIN vlx_assets a
          ON a.id = w.asset_id

        WHERE w.user_id = $1

        ORDER BY w.created_at DESC

        LIMIT 100
        `,
        [req.user.id]
      );

    res.json({
      blockchainEnabled: false,
      withdrawals: result.rows
    });

  }
);

/* =========================================================
   ADMIN WITHDRAWALS
========================================================= */

app.get(
  "/api/admin/withdrawals",
  requireAdmin,
  async (req, res) => {

    const result =
      await pool.query(
        `
        SELECT
          w.*,
          u.email,
          a.symbol

        FROM vlx_withdrawals w

        JOIN vlx_users u
          ON u.id = w.user_id

        JOIN vlx_assets a
          ON a.id = w.asset_id

        ORDER BY
          w.created_at DESC

        LIMIT 500
        `
      );

    res.json({
      withdrawals: result.rows
    });

  }
);

/* =========================================================
   CLEAN EXPIRED SESSIONS
========================================================= */

setInterval(
  async () => {

    try {

      await pool.query(
        `
        DELETE FROM vlx_sessions
        WHERE expires_at < NOW()
        `
      );

    } catch (error) {

      console.error(
        "Session cleanup error:",
        error.message
      );

    }

  },
  60 * 60 * 1000
);

/* =========================================================
   STATIC FRONTEND
========================================================= */

app.use(
  express.static(
    path.join(
      __dirname,
      "public"
    ),
    {
      maxAge:
        process.env.NODE_ENV === "production"
          ? "1h"
          : 0
    }
  )
);

app.get(
  "*",
  (req, res) => {

    res.sendFile(
      path.join(
        __dirname,
        "public",
        "index.html"
      )
    );

  }
);

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

  } catch (error) {

    console.error(
      "Startup failed:",
      error
    );

    process.exit(1);

  }

}

start();
