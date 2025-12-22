// server.js (Undertone minimal production-ish API)
//
// Implements:
//   - POST /signup
//   - POST /login
//   - POST /reset-password   (NOTE: insecure without email verification)
//   - GET  /me?email=...
//   - POST /update-account-name
//   - POST /update-email
//   - POST /update-password
//   - POST /start-subscription (stub)
//   - GET  /healthz
//
// Requires Postgres + DATABASE_URL. Run: npm run db:migrate

const express = require("express");
const cors = require("cors");
const path = require("path");
const dotenv = require("dotenv");
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");

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
      error: "DATABASE_URL is not set. Configure Postgres (Render) and set DATABASE_URL in .env.server / Render env vars.",
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

async function getUserByEmailNorm(emailNorm) {
  const { rows } = await pool.query(
    "SELECT id, email, email_norm, password_hash, account_name FROM users WHERE email_norm = $1 LIMIT 1",
    [emailNorm]
  );
  return rows[0] || null;
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
    return res.status(201).json({ ok: true, user: publicUserRow(user) });
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

    return res.json({ ok: true, user: publicUserRow(user) });
  } catch (e) {
    console.error("login error:", e);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

// Reset password (NOTE: insecure without email verification)
app.post("/reset-password", async (req, res) => {
  if (!requireDb(res)) return;

  const { email, newPassword } = req.body || {};
  const { trimmed, norm } = normalizeEmail(email);

  if (!isValidEmail(trimmed)) return res.status(400).json({ ok: false, error: "Invalid email" });
  if (typeof newPassword !== "string" || newPassword.length < 6) {
    return res.status(400).json({ ok: false, error: "New password must be at least 6 characters" });
  }

  try {
    const user = await getUserByEmailNorm(norm);
    if (!user) return res.status(404).json({ ok: false, error: "User not found" });

    const passwordHash = await bcrypt.hash(newPassword, 12);
    await pool.query("UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2", [passwordHash, user.id]);

    return res.json({ ok: true });
  } catch (e) {
    console.error("reset-password error:", e);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

// Me (demo auth: identified by ?email=)
app.get("/me", async (req, res) => {
  if (!requireDb(res)) return;

  const email = req.query.email;
  const { trimmed, norm } = normalizeEmail(email);
  if (!isValidEmail(trimmed)) return res.status(400).json({ ok: false, error: "Missing or invalid email" });

  try {
    const user = await getUserByEmailNorm(norm);
    if (!user) return res.status(404).json({ ok: false, error: "User not found" });

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

// Update account name
app.post("/update-account-name", async (req, res) => {
  if (!requireDb(res)) return;

  const { email, accountName } = req.body || {};
  const { trimmed, norm } = normalizeEmail(email);
  const name = String(accountName || "").trim();

  if (!isValidEmail(trimmed)) return res.status(400).json({ ok: false, error: "Missing or invalid email" });
  if (!name) return res.status(400).json({ ok: false, error: "Account name cannot be empty" });

  try {
    const user = await getUserByEmailNorm(norm);
    if (!user) return res.status(404).json({ ok: false, error: "User not found" });

    const { rows } = await pool.query(
      "UPDATE users SET account_name = $1, updated_at = NOW() WHERE id = $2 RETURNING id, email, account_name",
      [name, user.id]
    );
    return res.json({ ok: true, user: publicUserRow(rows[0]) });
  } catch (e) {
    console.error("update-account-name error:", e);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

// Update email (requires password)
app.post("/update-email", async (req, res) => {
  if (!requireDb(res)) return;

  const { email, password, newEmail } = req.body || {};
  const cur = normalizeEmail(email);
  const next = normalizeEmail(newEmail);

  if (!isValidEmail(cur.trimmed)) return res.status(400).json({ ok: false, error: "Missing or invalid email" });
  if (!isValidEmail(next.trimmed)) return res.status(400).json({ ok: false, error: "Missing or invalid newEmail" });
  if (typeof password !== "string" || !password) return res.status(400).json({ ok: false, error: "Missing password" });

  try {
    const user = await getUserByEmailNorm(cur.norm);
    if (!user) return res.status(404).json({ ok: false, error: "User not found" });

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ ok: false, error: "Invalid password" });

    // Update with unique email_norm
    const { rows } = await pool.query(
      "UPDATE users SET email = $1, email_norm = $2, updated_at = NOW() WHERE id = $3 RETURNING id, email, account_name",
      [next.trimmed, next.norm, user.id]
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

// Update password (requires current password)
app.post("/update-password", async (req, res) => {
  if (!requireDb(res)) return;

  const { email, currentPassword, newPassword } = req.body || {};
  const cur = normalizeEmail(email);

  if (!isValidEmail(cur.trimmed)) return res.status(400).json({ ok: false, error: "Missing or invalid email" });
  if (typeof currentPassword !== "string" || !currentPassword) {
    return res.status(400).json({ ok: false, error: "Missing currentPassword" });
  }
  if (typeof newPassword !== "string" || newPassword.length < 6) {
    return res.status(400).json({ ok: false, error: "New password must be at least 6 characters" });
  }

  try {
    const user = await getUserByEmailNorm(cur.norm);
    if (!user) return res.status(404).json({ ok: false, error: "User not found" });

    const ok = await bcrypt.compare(currentPassword, user.password_hash);
    if (!ok) return res.status(401).json({ ok: false, error: "Invalid current password" });

    const passwordHash = await bcrypt.hash(newPassword, 12);
    await pool.query("UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2", [passwordHash, user.id]);

    return res.json({ ok: true });
  } catch (e) {
    console.error("update-password error:", e);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

// Subscription stub (mobile stores require IAP for digital subscriptions)
app.post("/start-subscription", async (req, res) => {
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
