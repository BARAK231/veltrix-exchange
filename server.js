const express = require("express");
const path = require("path");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const rateLimit = require("express-rate-limit");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 10000;

app.disable("x-powered-by");
app.use(express.json({ limit: "100kb" }));

const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false }
    })
  : null;

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false
});

app.use("/api", apiLimiter);

function cookies(req) {
  const result = {};
  const header = req.headers.cookie || "";

  header.split(";").forEach(part => {
    const index = part.indexOf("=");
    if (index > -1) {
      const key = part.slice(0, index).trim();
      const value = part.slice(index + 1).trim();
      result[key] = decodeURIComponent(value);
    }
  });

  return result;
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function makeToken() {
  return crypto.randomBytes(48).toString("hex");
}

function setSessionCookie(res, token) {
  res.setHeader(
    "Set-Cookie",
    `veltrix_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`
  );
}

function clearSessionCookie(res) {
  res.setHeader(
    "Set-Cookie",
    "veltrix_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"
  );
}

async function currentUser(req) {
  if (!pool) return null;

  const token = cookies(req).veltrix_session;
  if (!token) return null;

  const tokenHash = hashToken(token);

  const result = await pool.query(
    `SELECT u.id,u.email,u.display_name,u.telegram_user_id,
            u.telegram_username,u.role,u.kyc_status
     FROM sessions s
     JOIN users u ON u.id=s.user_id
     WHERE s.token_hash=$1 AND s.expires_at > NOW()`,
    [tokenHash]
  );

  return result.rows[0] || null;
}

async function audit(userId, action, req, metadata = {}) {
  if (!pool) return;

  await pool.query(
    `INSERT INTO audit_logs(user_id,action,ip,metadata)
     VALUES($1,$2,$3,$4)`,
    [
      userId || null,
      action,
      req.headers["x-forwarded-for"] || req.socket.remoteAddress || null,
      JSON.stringify(metadata)
    ]
  );
}

function requireDatabase(req, res, next) {
  if (!pool) {
    return res.status(503).json({
      error: "Database is not configured yet."
    });
  }

  next();
}

async function requireAuth(req, res, next) {
  try {
    const user = await currentUser(req);

    if (!user) {
      return res.status(401).json({
        error: "Authentication required."
      });
    }

    req.user = user;
    next();
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Authentication error." });
  }
}

/* ---------- BASIC ---------- */

app.get("/api/health", async (req, res) => {
  let database = "not_configured";

  if (pool) {
    try {
      await pool.query("SELECT 1");
      database = "connected";
    } catch {
      database = "error";
    }
  }

  res.json({
    name: "VELTRIX EXCHANGE",
    symbol: "VLX",
    status: "online",
    database
  });
});

app.get("/api/config", (req, res) => {
  res.json({
    name: "VELTRIX EXCHANGE",
    symbol: "VLX",
    listingDate: process.env.VLX_LISTING_DATE || "2026-11-17",
    mode: "DEVELOPMENT / FOUNDATION",
    tradingEnabled: false,
    withdrawalsEnabled: false
  });
});

/* ---------- REGISTER ---------- */

app.post("/api/auth/register", requireDatabase, async (req, res) => {
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");
    const displayName = String(req.body.displayName || "").trim();

    if (!email || !password || !displayName) {
      return res.status(400).json({
        error: "Email, password and display name are required."
      });
    }

    if (password.length < 8) {
      return res.status(400).json({
        error: "Password must contain at least 8 characters."
      });
    }

    const existing = await pool.query(
      "SELECT id FROM users WHERE email=$1",
      [email]
    );

    if (existing.rows.length) {
      return res.status(409).json({
        error: "Email already registered."
      });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const result = await pool.query(
      `INSERT INTO users(email,password_hash,display_name)
       VALUES($1,$2,$3)
       RETURNING id,email,display_name,role,kyc_status`,
      [email, passwordHash, displayName]
    );

    const user = result.rows[0];

    const assets = await pool.query(
      "SELECT id FROM assets WHERE status='active'"
    );

    for (const asset of assets.rows) {
      await pool.query(
        `INSERT INTO balances(user_id,asset_id)
         VALUES($1,$2)
         ON CONFLICT DO NOTHING`,
        [user.id, asset.id]
      );
    }

    await audit(user.id, "register", req);

    res.status(201).json({
      message: "Account created.",
      user
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Registration failed." });
  }
});

/* ---------- LOGIN ---------- */

app.post("/api/auth/login", requireDatabase, async (req, res) => {
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");

    const result = await pool.query(
      `SELECT * FROM users WHERE email=$1`,
      [email]
    );

    const user = result.rows[0];

    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({
        error: "Invalid email or password."
      });
    }

    const token = makeToken();
    const tokenHash = hashToken(token);
    const days = Number(process.env.SESSION_DAYS || 7);

    await pool.query(
      `INSERT INTO sessions(user_id,token_hash,expires_at)
       VALUES($1,$2,NOW()+($3 || ' days')::interval)`,
      [user.id, tokenHash, days]
    );

    setSessionCookie(res, token);

    await audit(user.id, "login", req);

    res.json({
      message: "Login successful.",
      user: {
        id: user.id,
        email: user.email,
        displayName: user.display_name,
        role: user.role,
        kycStatus: user.kyc_status
      }
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Login failed." });
  }
});

/* ---------- LOGOUT ---------- */

app.post("/api/auth/logout", requireDatabase, async (req, res) => {
  const token = cookies(req).veltrix_session;

  if (token) {
    await pool.query(
      "DELETE FROM sessions WHERE token_hash=$1",
      [hashToken(token)]
    );
  }

  clearSessionCookie(res);

  res.json({ message: "Logged out." });
});

/* ---------- CURRENT USER ---------- */

app.get("/api/auth/me", requireDatabase, requireAuth, async (req, res) => {
  res.json({ user: req.user });
});

/* ---------- ASSETS ---------- */

app.get("/api/assets", async (req, res) => {
  if (!pool) {
    return res.json([
      {
        symbol: "USDT",
        name: "Tether USD",
        status: "active"
      },
      {
        symbol: "VLX",
        name: "VELTRIX",
        status: "planned",
        listingDate: process.env.VLX_LISTING_DATE || "2026-11-17"
      }
    ]);
  }

  const result = await pool.query(
    `SELECT symbol,name,network,status,listing_date,decimals
     FROM assets
     ORDER BY symbol`
  );

  res.json(result.rows);
});

/* ---------- BALANCES ---------- */

app.get("/api/balances", requireDatabase, requireAuth, async (req, res) => {
  const result = await pool.query(
    `SELECT a.symbol,a.name,b.available,b.locked
     FROM balances b
     JOIN assets a ON a.id=b.asset_id
     WHERE b.user_id=$1
     ORDER BY a.symbol`,
    [req.user.id]
  );

  res.json(result.rows);
});

/* ---------- LEDGER ---------- */

app.get("/api/ledger", requireDatabase, requireAuth, async (req, res) => {
  const result = await pool.query(
    `SELECT l.id,a.symbol,l.amount,l.type,
            l.reference_id,l.note,l.created_at
     FROM ledger_entries l
     JOIN assets a ON a.id=l.asset_id
     WHERE l.user_id=$1
     ORDER BY l.created_at DESC
     LIMIT 100`,
    [req.user.id]
  );

  res.json(result.rows);
});

/* ---------- TELEGRAM MINING CREDIT ---------- */

app.post(
  "/api/miner/credit",
  requireDatabase,
  async (req, res) => {
    try {
      const telegramUserId = String(req.body.telegramUserId || "");
      const amount = String(req.body.amount || "");
      const requestId = String(req.body.requestId || "");
      const signature = String(req.headers["x-miner-signature"] || "");

      if (!telegramUserId || !amount || !requestId || !signature) {
        return res.status(400).json({
          error: "Missing mining request fields."
        });
      }

      const secret = process.env.MINER_WEBHOOK_SECRET;

      if (!secret) {
        return res.status(503).json({
          error: "Mining webhook secret is not configured."
        });
      }

      const raw = `${telegramUserId}:${amount}:${requestId}`;

      const expected = crypto
        .createHmac("sha256", secret)
        .update(raw)
        .digest("hex");

      if (
        signature.length !== expected.length ||
        !crypto.timingSafeEqual(
          Buffer.from(signature),
          Buffer.from(expected)
        )
      ) {
        return res.status(401).json({
          error: "Invalid mining signature."
        });
      }

      const duplicate = await pool.query(
        `SELECT id FROM miner_credits WHERE request_id=$1`,
        [requestId]
      );

      if (duplicate.rows.length) {
        return res.json({
          message: "Request already processed."
        });
      }

      const userResult = await pool.query(
        `SELECT id FROM users
         WHERE telegram_user_id=$1`,
        [telegramUserId]
      );

      if (!userResult.rows.length) {
        return res.status(404).json({
          error: "Telegram account is not linked to a VELTRIX account."
        });
      }

      const userId = userResult.rows[0].id;

      const assetResult = await pool.query(
        `SELECT id FROM assets WHERE symbol='VLX' LIMIT 1`
      );

      if (!assetResult.rows.length) {
        return res.status(500).json({
          error: "VLX asset is not configured."
        });
      }

      const assetId = assetResult.rows[0].id;

      await pool.query("BEGIN");

      await pool.query(
        `INSERT INTO miner_credits
         (request_id,telegram_user_id,amount,credited_user_id)
         VALUES($1,$2,$3,$4)`,
        [requestId, telegramUserId, amount, userId]
      );

      await pool.query(
        `INSERT INTO balances(user_id,asset_id,available)
         VALUES($1,$2,$3)
         ON CONFLICT(user_id,asset_id)
         DO UPDATE SET available=balances.available + EXCLUDED.available`,
        [userId, assetId, amount]
      );

      await pool.query(
        `INSERT INTO ledger_entries
         (user_id,asset_id,amount,type,reference_id,note)
         VALUES($1,$2,$3,'mining_credit',$4,$5)`,
        [
          userId,
          assetId,
          amount,
          requestId,
          "Telegram mining credit"
        ]
      );

      await pool.query("COMMIT");

      await audit(userId, "miner_credit", req, {
        requestId,
        amount
      });

      res.json({
        message: "Mining credit added.",
        amount
      });
    } catch (error) {
      try {
        await pool.query("ROLLBACK");
      } catch {}

      console.error(error);

      res.status(500).json({
        error: "Mining credit failed."
      });
    }
  }
);

/* ---------- ORDERS ---------- */

app.get("/api/orders", requireDatabase, requireAuth, async (req, res) => {
  const result = await pool.query(
    `SELECT id,symbol,side,order_type,price,
            quantity,filled_quantity,status,created_at
     FROM orders
     WHERE user_id=$1
     ORDER BY created_at DESC
     LIMIT 100`,
    [req.user.id]
  );

  res.json(result.rows);
});

/* ---------- FRONTEND ---------- */

app.use(express.static(path.join(__dirname, "public")));

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

/* ---------- START ---------- */

app.listen(PORT, () => {
  console.log(`VELTRIX EXCHANGE running on port ${PORT}`);
});
