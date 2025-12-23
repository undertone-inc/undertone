// server.js (Undertone minimal production-ish API)
//
// Implements:
//   - POST /signup
//   - POST /login
//   - POST /logout
//   - POST /request-password-reset  (creates a one-time reset token)
//   - POST /reset-password          (consumes reset token)
//   - GET  /me                      (auth required)
//   - POST /update-account-name     (auth required)
//   - POST /update-email            (auth required, requires password)
//   - POST /update-password         (auth required, requires current password)
//   - POST /start-subscription      (stub)
//   - GET  /healthz
//
// Requires Postgres + DATABASE_URL. Run: npm run db:migrate

const express = require("express");
const cors = require("cors");
const path = require("path");
const dotenv = require("dotenv");
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");

// Load server env vars from .env.server (preferred).
// Falls back to .env for backwards compatibility.
const envServerPath = path.resolve(__dirname, ".env.server");
const envServerResult = dotenv.config({ path: envServerPath });
if (envServerResult.error) {
  dotenv.config();
}

const app = express();
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

app.use(cors());
app.use(express.json({ limit: "1mb" }));

const DATABASE_URL = process.env.DATABASE_URL || "";
const NODE_ENV = process.env.NODE_ENV || "development";

const SESSION_TTL_DAYS = Number(process.env.SESSION_TTL_DAYS || 30);
const RESET_TTL_MINUTES = Number(process.env.RESET_TTL_MINUTES || 30);

const sslEnabled =
  String(process.env.DATABASE_SSL || "").toLowerCase() === "true" ||
  (NODE_ENV === "production" && String(process.env.DATABASE_SSL || "").toLowerCase() !== "false");

const pool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: sslEnabled ? { rejectUnauthorized: false } : false,
    })
  : null;

function isValidEmail(email) {
  const e = String(email || "").trim();
  return e.length >= 5 && e.includes("@") && e.includes(".");
}

function normalizeEmail(email) {
  const trimmed = String(email || "").trim();
  return { trimmed, norm: trimmed.toLowerCase() };
}

function requireDb(res) {
  if (!pool) {
    res.status(500).json({
      ok: false,
      error:
        "DATABASE_URL is not set. Configure Postgres and set DATABASE_URL in .env.server / host env vars.",
    });
    return false;
  }
  return true;
}

function publicUserRow(row) {
  return {
    email: row.email,
    accountName: row.account_name || "",
    planTier: "free",
  };
}

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token || "")).digest("hex");
}

function getBearerToken(req) {
  const h = String(req.headers?.authorization || "");
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? String(m[1] || "").trim() : "";
}

async function getUserByEmailNorm(emailNorm) {
  const { rows } = await pool.query(
    "SELECT id, email, email_norm, password_hash, account_name FROM users WHERE email_norm = $1 LIMIT 1",
    [emailNorm]
  );
  return rows[0] || null;
}

async function createSession(userId) {
  const token = crypto.randomBytes(32).toString("hex");
  const tokenHash = hashToken(token);

  const ttlDays = Number.isFinite(SESSION_TTL_DAYS) && SESSION_TTL_DAYS > 0 ? SESSION_TTL_DAYS : 30;
  const expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000);

  const { rows } = await pool.query(
    "INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, $3) RETURNING id",
    [userId, tokenHash, expiresAt]
  );

  return { token, sessionId: rows?.[0]?.id };
}

async function revokeOtherSessions(userId, exceptSessionId) {
  if (!userId) return;

  if (exceptSessionId) {
    await pool.query(
      "UPDATE sessions SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL AND id <> $2",
      [userId, exceptSessionId]
    );
  } else {
    await pool.query("UPDATE sessions SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL", [userId]);
  }
}

async function authRequired(req, res, next) {
  if (!requireDb(res)) return;

  const token = getBearerToken(req);
  if (!token) return res.status(401).json({ ok: false, error: "Missing authorization token" });

  try {
    const tokenHash = hashToken(token);
    const { rows } = await pool.query(
      `
      SELECT
        s.id AS session_id,
        s.user_id,
        u.email,
        u.account_name,
        u.password_hash
      FROM sessions s
      JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1
        AND s.revoked_at IS NULL
        AND s.expires_at > NOW()
      LIMIT 1
      `,
      [tokenHash]
    );

    const row = rows[0];
    if (!row) return res.status(401).json({ ok: false, error: "Invalid or expired session" });

    req.auth = {
      sessionId: row.session_id,
      user: {
        id: row.user_id,
        email: row.email,
        account_name: row.account_name,
        password_hash: row.password_hash,
      },
    };

    return next();
  } catch (e) {
    console.error("authRequired error:", e);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
}

// Root
app.get("/", (req, res) => {
  res.json({ ok: true, message: "Undertone API is running" });
});

// Health check
app.get("/healthz", async (req, res) => {
  if (!pool) return res.json({ ok: true, db: "not_configured" });
  try {
    await pool.query("SELECT 1 AS ok");
    return res.json({ ok: true, db: "up" });
  } catch (e) {
    return res.status(500).json({ ok: false, db: "down", error: String(e?.message || e) });
  }
});

// Signup
app.post("/signup", async (req, res) => {
  if (!requireDb(res)) return;

  const { email, password } = req.body || {};
  const { trimmed, norm } = normalizeEmail(email);

  if (!isValidEmail(trimmed)) {
    return res.status(400).json({ ok: false, error: "Invalid email" });
  }
  if (typeof password !== "string" || password.length < 6) {
    return res.status(400).json({ ok: false, error: "Password must be at least 6 characters" });
  }

  try {
    const passwordHash = await bcrypt.hash(password, 12);
    const accountName = "";

    const { rows } = await pool.query(
      "INSERT INTO users (email, email_norm, password_hash, account_name) VALUES ($1, $2, $3, $4) RETURNING id, email, account_name",
      [trimmed, norm, passwordHash, accountName]
    );

    const user = rows[0];
    const session = await createSession(user.id);

    return res.status(201).json({ ok: true, token: session.token, user: publicUserRow(user) });
  } catch (e) {
    // Unique violation on email_norm
    const msg = String(e?.message || e);
    if (msg.toLowerCase().includes("unique") || msg.toLowerCase().includes("duplicate")) {
      return res.status(409).json({ ok: false, error: "Email already in use" });
    }
    console.error("signup error:", e);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

// Login
app.post("/login", async (req, res) => {
  if (!requireDb(res)) return;

  const { email, password } = req.body || {};
  const { trimmed, norm } = normalizeEmail(email);

  if (!isValidEmail(trimmed)) {
    return res.status(400).json({ ok: false, error: "Invalid email" });
  }
  if (typeof password !== "string" || password.length < 1) {
    return res.status(400).json({ ok: false, error: "Missing password" });
  }

  try {
    const user = await getUserByEmailNorm(norm);
    if (!user) return res.status(401).json({ ok: false, error: "Invalid email or password" });

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ ok: false, error: "Invalid email or password" });

    const session = await createSession(user.id);

    return res.json({ ok: true, token: session.token, user: publicUserRow(user) });
  } catch (e) {
    console.error("login error:", e);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

// Logout (revoke current session)
app.post("/logout", authRequired, async (req, res) => {
  const sessionId = req?.auth?.sessionId;
  if (!sessionId) return res.status(400).json({ ok: false, error: "Missing session" });

  try {
    await pool.query("UPDATE sessions SET revoked_at = NOW() WHERE id = $1", [sessionId]);
    return res.json({ ok: true });
  } catch (e) {
    console.error("logout error:", e);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

// Request password reset (always returns ok:true to avoid user enumeration)
app.post("/request-password-reset", async (req, res) => {
  if (!requireDb(res)) return;

  const { email } = req.body || {};
  const { trimmed, norm } = normalizeEmail(email);

  // Always respond ok:true even if invalid.
  if (!isValidEmail(trimmed)) {
    return res.json({ ok: true });
  }

  try {
    const user = await getUserByEmailNorm(norm);

    if (!user) {
      // No enumeration.
      return res.json({ ok: true });
    }

    const resetToken = crypto.randomBytes(20).toString("hex");
    const tokenHash = hashToken(resetToken);

    const ttlMinutes = Number.isFinite(RESET_TTL_MINUTES) && RESET_TTL_MINUTES > 0 ? RESET_TTL_MINUTES : 30;
    const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000);

    await pool.query(
      "INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES ($1, $2, $3)",
      [user.id, tokenHash, expiresAt]
    );

    // In production, deliver resetToken out-of-band (email/SMS). We do NOT return it.
    if (NODE_ENV !== "production") {
      return res.json({ ok: true, resetToken });
    }

    return res.json({ ok: true });
  } catch (e) {
    console.error("request-password-reset error:", e);
    // Still no enumeration.
    return res.json({ ok: true });
  }
});

// Reset password (consumes reset token)
app.post("/reset-password", async (req, res) => {
  if (!requireDb(res)) return;

  const { token, newPassword } = req.body || {};
  const t = String(token || "").trim();

  if (!t) return res.status(400).json({ ok: false, error: "Missing reset token" });
  if (typeof newPassword !== "string" || newPassword.length < 6) {
    return res.status(400).json({ ok: false, error: "New password must be at least 6 characters" });
  }

  try {
    const tokenHash = hashToken(t);

    const { rows } = await pool.query(
      `
      SELECT id, user_id
      FROM password_resets
      WHERE token_hash = $1
        AND used_at IS NULL
        AND expires_at > NOW()
      LIMIT 1
      `,
      [tokenHash]
    );

    const pr = rows[0];
    if (!pr) return res.status(400).json({ ok: false, error: "Invalid or expired reset token" });

    const passwordHash = await bcrypt.hash(newPassword, 12);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2", [passwordHash, pr.user_id]);
      await client.query("UPDATE password_resets SET used_at = NOW() WHERE id = $1", [pr.id]);
      await client.query("UPDATE sessions SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL", [pr.user_id]);
      await client.query("COMMIT");
    } catch (e) {
      try {
        await client.query("ROLLBACK");
      } catch (_) {
        // ignore rollback errors
      }
      throw e;
    } finally {
      client.release();
    }

    return res.json({ ok: true });
  } catch (e) {
    console.error("reset-password error:", e);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

// Me (auth required)
app.get("/me", authRequired, async (req, res) => {
  try {
    const user = req?.auth?.user;
    return res.json({
      ok: true,
      user: publicUserRow(user),
      usage: {
        uploadsUsedThisMonth: 0,
        clientsUsedThisMonth: 0,
      },
    });
  } catch (e) {
    console.error("me error:", e);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

// Update account name (auth required)
app.post("/update-account-name", authRequired, async (req, res) => {
  const userId = req?.auth?.user?.id;
  const name = String(req?.body?.accountName || "").trim();

  if (!name) return res.status(400).json({ ok: false, error: "Account name cannot be empty" });

  try {
    const { rows } = await pool.query(
      "UPDATE users SET account_name = $1, updated_at = NOW() WHERE id = $2 RETURNING id, email, account_name",
      [name, userId]
    );

    return res.json({ ok: true, user: publicUserRow(rows[0]) });
  } catch (e) {
    console.error("update-account-name error:", e);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

// Update email (auth required + confirm password)
app.post("/update-email", authRequired, async (req, res) => {
  const userId = req?.auth?.user?.id;
  const currentPasswordHash = req?.auth?.user?.password_hash;

  const { password, newEmail } = req.body || {};
  const next = normalizeEmail(newEmail);

  if (!isValidEmail(next.trimmed)) return res.status(400).json({ ok: false, error: "Missing or invalid newEmail" });
  if (typeof password !== "string" || !password) return res.status(400).json({ ok: false, error: "Missing password" });

  try {
    const ok = await bcrypt.compare(password, currentPasswordHash);
    if (!ok) return res.status(401).json({ ok: false, error: "Invalid password" });

    const { rows } = await pool.query(
      "UPDATE users SET email = $1, email_norm = $2, updated_at = NOW() WHERE id = $3 RETURNING id, email, account_name",
      [next.trimmed, next.norm, userId]
    );

    return res.json({ ok: true, user: publicUserRow(rows[0]) });
  } catch (e) {
    const msg = String(e?.message || e);
    if (msg.toLowerCase().includes("unique") || msg.toLowerCase().includes("duplicate")) {
      return res.status(409).json({ ok: false, error: "That email is already in use" });
    }
    console.error("update-email error:", e);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

// Update password (auth required)
app.post("/update-password", authRequired, async (req, res) => {
  const userId = req?.auth?.user?.id;
  const sessionId = req?.auth?.sessionId;
  const currentPasswordHash = req?.auth?.user?.password_hash;

  const { currentPassword, newPassword } = req.body || {};

  if (typeof currentPassword !== "string" || !currentPassword) {
    return res.status(400).json({ ok: false, error: "Missing currentPassword" });
  }
  if (typeof newPassword !== "string" || newPassword.length < 6) {
    return res.status(400).json({ ok: false, error: "New password must be at least 6 characters" });
  }

  try {
    const ok = await bcrypt.compare(currentPassword, currentPasswordHash);
    if (!ok) return res.status(401).json({ ok: false, error: "Invalid current password" });

    const passwordHash = await bcrypt.hash(newPassword, 12);

    await pool.query("UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2", [passwordHash, userId]);

    // Revoke other sessions after a password change.
    await revokeOtherSessions(userId, sessionId);

    return res.json({ ok: true });
  } catch (e) {
    console.error("update-password error:", e);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

// Subscription stub (mobile stores require IAP for digital subscriptions)
app.post("/start-subscription", authRequired, async (req, res) => {
  const { plan } = req.body || {};
  return res.json({
    ok: true,
    plan: String(plan || "free"),
    url: null,
    message: "Subscription checkout is not implemented on the server. Use in-app purchase on iOS/Android.",
  });
});

app.listen(PORT, () => {
  console.log(`✅ Undertone API listening on http://localhost:${PORT}`);
});
