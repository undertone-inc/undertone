// server.js
const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");
const path = require("path");
const dotenv = require("dotenv");

// Load server env vars from .env.server (preferred).
// Falls back to .env for backwards compatibility.
const envServerPath = path.resolve(__dirname, ".env.server");
const envServerResult = dotenv.config({ path: envServerPath });
if (envServerResult.error) {
  dotenv.config();
}

const app = express();
const PORT = process.env.PORT || 3000;

// Allow JSON bodies and cross-origin requests
app.use(cors());
app.use(express.json());

// --- DB ----------------------------------------------------------------
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.warn("⚠️  DATABASE_URL is not set. Server will fail on first DB call.");
}

const isProd = process.env.NODE_ENV === "production";
// Most managed Postgres providers require SSL in production.
// You can force-disable with DATABASE_SSL=false for local/dev.
const ssl =
  process.env.DATABASE_SSL === "false"
    ? false
    : isProd
      ? { rejectUnauthorized: false }
      : false;

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl,
});

async function dbQuery(text, params) {
  return pool.query(text, params);
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function isValidEmail(email) {
  const e = String(email || "").trim();
  // intentionally simple
  return e.length >= 5 && e.includes("@") && e.includes(".");
}

async function getUserByEmailNorm(emailNorm) {
  const { rows } = await dbQuery(
    "SELECT id, email, email_norm, password_hash, account_name FROM users WHERE email_norm = $1 LIMIT 1",
    [emailNorm],
  );
  return rows[0] || null;
}

// --- Routes ------------------------------------------------------------

// Health check
app.get("/", (req, res) => {
  res.json({ ok: true, message: "Undertone API is running" });
});

// Optional DB health check (useful for Render health checks)
app.get("/healthz", async (req, res) => {
  try {
    await dbQuery("SELECT 1 as ok");
    return res.json({ ok: true, db: "up" });
  } catch (e) {
    console.error("DB health check failed:", e);
    return res.status(500).json({ ok: false, db: "down" });
  }
});

// Get current user profile (demo: identified by email query param)
app.get("/me", async (req, res) => {
  const trimmedEmail = String(req.query?.email || "").trim();
  const emailNorm = normalizeEmail(trimmedEmail);

  if (!trimmedEmail) {
    return res.status(400).json({ ok: false, error: "Missing email" });
  }

  try {
    const user = await getUserByEmailNorm(emailNorm);
    if (!user) {
      return res.status(404).json({ ok: false, error: "User not found" });
    }

    return res.json({
      ok: true,
      user: { email: user.email, accountName: user.account_name || "" },
    });
  } catch (err) {
    console.error("GET /me error:", err);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

// Signup endpoint
app.post("/signup", async (req, res) => {
  const { email, password } = req.body || {};
  const trimmedEmail = (email || "").trim();
  const emailNorm = normalizeEmail(trimmedEmail);

  if (!trimmedEmail || !password) {
    return res.status(400).json({ ok: false, error: "Missing email or password" });
  }

  if (!isValidEmail(trimmedEmail)) {
    return res.status(400).json({ ok: false, error: "Invalid email" });
  }

  try {
    const existing = await getUserByEmailNorm(emailNorm);
    if (existing) {
      return res.status(409).json({ ok: false, error: "Email already registered" });
    }

    const passwordHash = await bcrypt.hash(String(password), 12);

    const { rows } = await dbQuery(
      "INSERT INTO users (email, email_norm, password_hash, account_name) VALUES ($1, $2, $3, $4) RETURNING id, email, account_name",
      [emailNorm, emailNorm, passwordHash, ""],
    );

    const user = rows[0];
    return res.status(201).json({
      ok: true,
      user: { email: user.email, accountName: user.account_name || "" },
      token: "demo-token-signup", // placeholder (will be replaced with real tokens in Step 2)
    });
  } catch (err) {
    console.error("POST /signup error:", err);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

// Login endpoint
app.post("/login", async (req, res) => {
  const { email, password } = req.body || {};
  const trimmedEmail = (email || "").trim();
  const emailNorm = normalizeEmail(trimmedEmail);

  if (!trimmedEmail || !password) {
    return res.status(400).json({ ok: false, error: "Missing email or password" });
  }

  try {
    const user = await getUserByEmailNorm(emailNorm);
    if (!user) {
      return res.status(404).json({ ok: false, error: "User not found" });
    }

    const ok = await bcrypt.compare(String(password), user.password_hash);
    if (!ok) {
      return res.status(401).json({ ok: false, error: "Incorrect password" });
    }

    return res.json({
      ok: true,
      user: { email: user.email, accountName: user.account_name || "" },
      token: "demo-token-login", // placeholder (will be replaced with real tokens in Step 2)
    });
  } catch (err) {
    console.error("POST /login error:", err);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

// Reset password endpoint (used by the Login screen)
// NOTE: This is intentionally disabled in production until a proper email-token reset flow is added.
app.post("/reset-password", async (req, res) => {
  if (process.env.NODE_ENV === "production") {
    return res.status(501).json({
      ok: false,
      error: "Password reset is not enabled yet. Please contact support.",
    });
  }

  const { email, newPassword } = req.body || {};
  const trimmedEmail = (email || "").trim();
  const emailNorm = normalizeEmail(trimmedEmail);

  if (!trimmedEmail || !newPassword) {
    return res.status(400).json({ ok: false, error: "Missing email or new password" });
  }

  try {
    const user = await getUserByEmailNorm(emailNorm);
    if (!user) {
      return res.status(404).json({ ok: false, error: "User not found" });
    }

    const passwordHash = await bcrypt.hash(String(newPassword), 12);

    await dbQuery(
      "UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2",
      [passwordHash, user.id],
    );

    return res.json({ ok: true });
  } catch (err) {
    console.error("POST /reset-password error:", err);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

// Update account name
app.post("/update-account-name", async (req, res) => {
  const { email, accountName } = req.body || {};
  const trimmedEmail = String(email || "").trim();
  const emailNorm = normalizeEmail(trimmedEmail);
  const trimmedName = String(accountName || "").trim();

  if (!trimmedEmail) {
    return res.status(400).json({ ok: false, error: "Missing email" });
  }

  if (!trimmedName) {
    return res.status(400).json({ ok: false, error: "Account name cannot be empty" });
  }

  try {
    const user = await getUserByEmailNorm(emailNorm);
    if (!user) {
      return res.status(404).json({ ok: false, error: "User not found" });
    }

    const { rows } = await dbQuery(
      "UPDATE users SET account_name = $1, updated_at = NOW() WHERE id = $2 RETURNING email, account_name",
      [trimmedName, user.id],
    );

    const updated = rows[0];
    return res.json({
      ok: true,
      user: { email: updated.email, accountName: updated.account_name || "" },
    });
  } catch (err) {
    console.error("POST /update-account-name error:", err);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

// Update email (requires password)
app.post("/update-email", async (req, res) => {
  const { email, password, newEmail } = req.body || {};
  const trimmedEmail = String(email || "").trim();
  const trimmedNewEmail = String(newEmail || "").trim();
  const emailNorm = normalizeEmail(trimmedEmail);
  const newEmailNorm = normalizeEmail(trimmedNewEmail);

  if (!trimmedEmail || !password || !trimmedNewEmail) {
    return res.status(400).json({ ok: false, error: "Missing email, password, or new email" });
  }

  if (!isValidEmail(trimmedNewEmail)) {
    return res.status(400).json({ ok: false, error: "Invalid new email" });
  }

  try {
    const user = await getUserByEmailNorm(emailNorm);
    if (!user) {
      return res.status(404).json({ ok: false, error: "User not found" });
    }

    const ok = await bcrypt.compare(String(password), user.password_hash);
    if (!ok) {
      return res.status(401).json({ ok: false, error: "Incorrect password" });
    }

    const existing = await getUserByEmailNorm(newEmailNorm);
    if (existing && existing.id !== user.id) {
      return res.status(409).json({ ok: false, error: "That email is already registered" });
    }

    const { rows } = await dbQuery(
      "UPDATE users SET email = $1, email_norm = $2, updated_at = NOW() WHERE id = $3 RETURNING email, account_name",
      [newEmailNorm, newEmailNorm, user.id],
    );

    const updated = rows[0];
    return res.json({ ok: true, user: { email: updated.email, accountName: updated.account_name || "" } });
  } catch (err) {
    console.error("POST /update-email error:", err);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

// Update password (requires current password)
app.post("/update-password", async (req, res) => {
  const { email, currentPassword, newPassword } = req.body || {};
  const trimmedEmail = String(email || "").trim();
  const emailNorm = normalizeEmail(trimmedEmail);

  if (!trimmedEmail || !currentPassword || !newPassword) {
    return res.status(400).json({ ok: false, error: "Missing email, current password, or new password" });
  }

  try {
    const user = await getUserByEmailNorm(emailNorm);
    if (!user) {
      return res.status(404).json({ ok: false, error: "User not found" });
    }

    const ok = await bcrypt.compare(String(currentPassword), user.password_hash);
    if (!ok) {
      return res.status(401).json({ ok: false, error: "Incorrect current password" });
    }

    const passwordHash = await bcrypt.hash(String(newPassword), 12);
    await dbQuery(
      "UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2",
      [passwordHash, user.id],
    );

    return res.json({ ok: true });
  } catch (err) {
    console.error("POST /update-password error:", err);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

// Start the server
app.listen(PORT, () => {
  console.log(`✅ Undertone API listening on http://localhost:${PORT}`);
});
