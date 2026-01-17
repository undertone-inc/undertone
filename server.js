// server.js (Undertone minimal production-ish API)
//
// Implements:
//   - POST /signup
//   - POST /login
//   - POST /logout
//   - POST /delete-account         (auth required)
//   - POST /request-password-reset  (creates a one-time reset token)
//   - POST /reset-password          (consumes reset token)
//   - GET  /me                      (auth required)
//   - POST /update-account-name     (auth required)
//   - POST /update-email            (auth required, requires password)
//   - POST /update-password         (auth required, requires current password)
//   - POST /start-subscription      (stub)
//   - POST /analyze-face            (auth required, multipart image upload)
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
const multer = require("multer");
const jpeg = require("jpeg-js");

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

// OpenAI (server-side only)
const OPENAI_API_KEY = String(process.env.OPENAI_API_KEY || "").trim();
const OPENAI_MODEL = String(process.env.OPENAI_MODEL || "gpt-4o").trim();
const OPENAI_MODEL_FALLBACK = String(process.env.OPENAI_MODEL_FALLBACK || "").trim();
const OPENAI_IMAGE_DETAIL = String(process.env.OPENAI_IMAGE_DETAIL || "high").trim();
const OPENAI_MAX_OUTPUT_TOKENS = Number(process.env.OPENAI_MAX_OUTPUT_TOKENS || 120);

// Upload constraints
const UPLOAD_MAX_MB = Number(process.env.UPLOAD_MAX_MB || 8);

// Match server.js behavior: enable SSL in production unless explicitly disabled.
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
    id: row.id,
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

function startOfMonthUtc() {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1, 0, 0, 0, 0));
}

async function getUploadsUsedThisMonth(userId) {
  // If the table doesn't exist yet (migration not run), default to 0.
  try {
    const from = startOfMonthUtc();
    const { rows } = await pool.query(
      "SELECT COUNT(*)::int AS c FROM face_analyses WHERE user_id = $1 AND created_at >= $2",
      [userId, from]
    );
    return Number(rows?.[0]?.c || 0);
  } catch (e) {
    return 0;
  }
}

// Plan limits
//
// For local testing, you can bump these in .env.server without touching code:
//   UPLOAD_LIMIT_FREE=9999
//   UPLOAD_LIMIT_PRO=9999
const PLAN_UPLOAD_LIMITS = {
  free: Number(process.env.UPLOAD_LIMIT_FREE || 100),
  pro: Number(process.env.UPLOAD_LIMIT_PRO || 100),
};

// Dev/testing escape hatch
// Set DISABLE_UPLOAD_LIMITS=true to bypass monthly caps (useful while testing).
const DISABLE_UPLOAD_LIMITS = (() => {
  const v = String(process.env.DISABLE_UPLOAD_LIMITS || '').trim().toLowerCase();
  return v === 'true' || v === '1' || v === 'yes';
})();
function uploadLimitForPlan(planTier) {
  const t = String(planTier || "free").toLowerCase();
  // "Plus" is no longer offered; treat it as "Pro" so legacy values don't reduce limits.
  if (t === "plus") return PLAN_UPLOAD_LIMITS.pro;
  return PLAN_UPLOAD_LIMITS[t] ?? PLAN_UPLOAD_LIMITS.free;
}


// --- Stability helpers (to make results consistent across scans) ---
// We compute a "stable" result by taking a weighted vote across the last N scans,
// down-weighting low-confidence / poor-lighting / filtered photos.

async function getRecentFaceAnalyses(userId, limit = 10) {
  try {
    const { rows } = await pool.query(
      "SELECT analysis_json FROM face_analyses WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2",
      [userId, limit]
    );
    return (rows || []).map((r) => r.analysis_json).filter(Boolean);
  } catch {
    return [];
  }
}

function clamp01(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function stabilityWeight(a) {
  try {
    // If we only have undertone (minimal schema), treat all scans equally.
    // Normalize legacy values (e.g. "olive") into the current 5-class schema.
    const u = normalizeUndertoneValue(a?.undertone);
    if (!u) return 0;

    // Never let invalid photos (no face / not a photo) influence stability.
    if (a?.photo_ok === false) return 0;
    const issue = String(a?.issue || "").toLowerCase();
    if (issue === "no_human_face" || issue === "not_a_photo") return 0;

    const pq = a?.photo_quality;
    const confNum = Number(a?.confidence);
    const hasPq = pq && typeof pq === "object";
    const hasConf = Number.isFinite(confNum);

    if (!hasPq && !hasConf) return 1;

    // Otherwise, preserve the original weighting behavior.
    const pqObj = hasPq ? pq : {};
    if (pqObj?.face_visible === false) return 0;

    const conf = clamp01((hasConf ? confNum : 50) / 100);

    const lighting = String(pqObj?.lighting || "unknown").toLowerCase();
    const wb = String(pqObj?.white_balance || "unknown").toLowerCase();
    const filtered = pqObj?.filters_detected === true;

    const lightingW = lighting === "good" ? 1 : lighting === "ok" ? 0.7 : lighting === "poor" ? 0.3 : 0.5;
    const wbW = wb === "neutral" ? 1 : wb === "warm" || wb === "cool" ? 0.75 : 0.6;
    const filterW = filtered ? 0.4 : 1;

    return conf * lightingW * wbW * filterW;
  } catch {
    return 0;
  }
}


function weightedVote(analyses, key, allowedValues) {
  const sums = Object.fromEntries(allowedValues.map((v) => [v, 0]));
  let total = 0;
  let counted = 0;

  for (const a of analyses || []) {
    const w = stabilityWeight(a);
    if (w <= 0) continue;

    const raw = a?.[key];
    const v = key === "undertone" ? normalizeUndertoneValue(raw) : String(raw || "unknown").toLowerCase();
    if (!v || !allowedValues.includes(v)) continue;

    sums[v] += w;
    total += w;
    counted += 1;
  }

  let best = "unknown";
  let bestW = 0;
  for (const v of allowedValues) {
    if (sums[v] > bestW) {
      bestW = sums[v];
      best = v;
    }
  }

  const support = total > 0 ? bestW / total : 0;
  return { value: best, support, totalWeight: total, counted };
}

function pickBestRepresentative(analyses, stableUndertone) {
  let best = null;
  let bestW = -1;

  for (const a of analyses || []) {
    const w = stabilityWeight(a);
    if (w <= bestW) continue;

    const u = normalizeUndertoneValue(a?.undertone);
    if (!u) continue;

    // Prefer a scan that matches the stable undertone when available.
    const matches = stableUndertone ? u === stableUndertone : true;
    if (!matches) continue;

    best = a;
    bestW = w;
  }

  // Fallback: highest-weight scan overall
  if (!best) {
    for (const a of analyses || []) {
      const w = stabilityWeight(a);
      if (w > bestW) {
        best = a;
        bestW = w;
      }
    }
  }

  return best || null;
}

function computeStability(analyses) {
  const undertoneVote = weightedVote(analyses, "undertone", ["warm", "neutral-warm", "neutral", "neutral-cool", "cool"]);
  return {
    counted: undertoneVote.counted,
    undertone: undertoneVote.value,
    undertoneSupport: undertoneVote.support,
  };
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

// Delete account (auth required)
app.post("/delete-account", authRequired, async (req, res) => {
  const userId = req?.auth?.user?.id;
  if (!userId) return res.status(400).json({ ok: false, error: "Missing user" });

  try {
    // Cascades delete: sessions, user_docs, password_resets, face_analyses, etc.
    await pool.query("DELETE FROM users WHERE id = $1", [userId]);
    return res.json({ ok: true });
  } catch (e) {
    console.error("delete-account error:", e);
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
    const used = await getUploadsUsedThisMonth(user.id);
    const limit = uploadLimitForPlan("free");

    return res.json({
      ok: true,
      user: publicUserRow(user),
      usage: {
        uploadsThisMonth: used,
        clientsThisMonth: 0,
      },
      limits: {
        uploadsPerMonth: limit,
        uploadLimitsDisabled: DISABLE_UPLOAD_LIMITS,
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

// ---- Product recommendations (best-match color names) ----
// This endpoint powers the “Recommend products” button after a scan.
//
// IMPORTANT: We only scrape/parse from a small allowlist of retailer domains to avoid SSRF.
// Today we support Sephora product pages.

const SHADE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const shadeCache = new Map(); // url -> { fetchedAt: number, shades: Array<{ value: string, desc?: string }> }

function normalizeUndertoneKeyServer(raw) {
  const s = String(raw || "").trim().toLowerCase();
  if (s === "cool" || s === "neutral-cool" || s === "neutral" || s === "neutral-warm" || s === "warm") return s;
  if (s === "olive") return "neutral";
  return "neutral";
}

function normalizeSeasonKeyServer(raw) {
  const s = String(raw || "").trim().toLowerCase();
  if (s === "spring" || s === "summer" || s === "autumn" || s === "winter") return s;
  return "summer";
}

function undertoneDirectionServer(u) {
  if (u === "warm" || u === "neutral-warm") return "warm";
  if (u === "cool" || u === "neutral-cool") return "cool";
  return "neutral";
}

function toneDepthFromNumberServer(n) {
  if (!Number.isFinite(n)) return "light";
  if (n <= 2) return "very fair";
  if (n <= 3.5) return "fair";
  if (n <= 5) return "light";
  if (n <= 6.5) return "medium";
  if (n <= 8) return "tan";
  return "deep";
}

function normalizeToneDepthServer(raw) {
  const s = String(raw || "").trim().toLowerCase();
  if (!s) return null;
  if (s === "very fair" || s === "very_fair" || s === "very-fair") return "very fair";
  if (s === "fair") return "fair";
  if (s === "light") return "light";
  if (s === "medium") return "medium";
  if (s === "tan") return "tan";
  if (s === "deep") return "deep";
  return null;
}

function safeDecodeJsonString(s) {
  const raw = String(s ?? "");
  if (!raw) return "";
  const esc = raw.replace(/"/g, "\\\"");
  try {
    return JSON.parse(`"${esc}"`);
  } catch {
    return raw;
  }
}

function compactSpaces(s) {
  return String(s || "")
    .replace(/\s+/g, " ")
    .replace(/\s+-\s+/g, " - ")
    .trim();
}

function isAllowedRetailerUrl(urlStr) {
  try {
    const u = new URL(String(urlStr || ""));
    const host = String(u.hostname || "").toLowerCase();
    // Allow Sephora (US + CA domains)
    if (host === "www.sephora.com" || host === "sephora.com" || host === "sephora.ca" || host === "www.sephora.ca") {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

async function fetchHtml(url) {
  if (typeof fetch !== "function") throw new Error("fetch is not available in this Node runtime");
  const res = await fetch(url, {
    method: "GET",
    headers: {
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "accept-language": "en-CA,en;q=0.9",
    },
  });
  if (!res.ok) throw new Error(`Retailer fetch failed: ${res.status}`);
  return await res.text();
}

function extractSephoraColorVariantsFromHtml(html) {
  const s = String(html || "");
  if (!s) return [];

  const out = [];
  const seen = new Set();

  const push = (valueRaw, descRaw) => {
    const value = compactSpaces(safeDecodeJsonString(valueRaw));
    const desc = compactSpaces(safeDecodeJsonString(descRaw));
    const vLow = value.toLowerCase();
    if (!value) return;

    // Filter out sizes and other non-color variations.
    if (/(\boz\b|\bml\b|\bg\b|standard size|mini size|travel size)/i.test(value)) return;
    if (value.length > 80) return;

    const key = `${vLow}::${String(desc || "").toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);

    out.push({ value, desc: desc || undefined });
  };

  // Primary: scrape embedded state blobs (most Sephora pages embed all color variants).
  const reColorBlock = /"variationType"\s*:\s*"Color"[\s\S]{0,600}?"variationValue"\s*:\s*"([^\"]+)"(?:[\s\S]{0,300}?"variationDesc"\s*:\s*"([^\"]+)")?/g;
  for (const m of s.matchAll(reColorBlock)) {
    push(m?.[1], m?.[2]);
  }

  // Fallback: grab any sku blocks that include variationValue/variationDesc.
  if (out.length < 2) {
    const reSku = /"skuId"\s*:\s*"?(\d+)"?[\s\S]{0,400}?"variationValue"\s*:\s*"([^\"]+)"(?:[\s\S]{0,220}?"variationDesc"\s*:\s*"([^\"]+)")?/g;
    for (const m of s.matchAll(reSku)) {
      push(m?.[2], m?.[3]);
    }
  }

  return out;
}

function shadeLabel(shade) {
  const value = compactSpaces(String(shade?.value || ""));
  const desc = compactSpaces(String(shade?.desc || ""));
  if (!value) return "";
  if (!desc) return value;
  // Avoid doubling when the description is already baked into the value.
  const vLow = value.toLowerCase();
  const dLow = desc.toLowerCase();
  if (vLow.includes(dLow)) return value;
  return `${value} - ${desc}`;
}

function parseDepthFromText(text) {
  const t = String(text || "").toLowerCase();
  if (!t) return null;
  if (t.includes("very fair")) return "very fair";
  if (t.includes("fair")) return "fair";
  if (t.includes("light medium")) return "medium";
  if (t.includes("light")) return "light";
  if (t.includes("medium")) return "medium";
  if (t.includes("tan")) return "tan";
  if (t.includes("deep")) return "deep";
  return null;
}

function depthRank(depth) {
  const d = String(depth || "").toLowerCase();
  if (d === "very fair") return 0;
  if (d === "fair") return 1;
  if (d === "light") return 2;
  if (d === "medium") return 3;
  if (d === "tan") return 4;
  if (d === "deep") return 5;
  return 2;
}

function scoreByKeywords(text, want = [], avoid = []) {
  const t = String(text || "").toLowerCase();
  let score = 0;
  want.forEach((w) => {
    if (!w) return;
    if (t.includes(String(w).toLowerCase())) score += 1;
  });
  avoid.forEach((w) => {
    if (!w) return;
    if (t.includes(String(w).toLowerCase())) score -= 1;
  });
  return score;
}

function pickBestShadeForCategory({ shades, category, undertone, season, toneNumber, toneDepth }) {
  const list = Array.isArray(shades) ? shades : [];
  if (!list.length) return null;

  const dir = undertoneDirectionServer(undertone);
  const seasonKey = normalizeSeasonKeyServer(season);
  const desiredDepth = normalizeToneDepthServer(toneDepth) || toneDepthFromNumberServer(Number(toneNumber));
  const desiredDepthRank = depthRank(desiredDepth);

  // Shared keyword intent
  const wantDir =
    dir === "warm"
      ? ["warm", "gold", "golden", "yellow", "peach", "apricot", "olive", "bronze", "caramel"]
      : dir === "cool"
        ? ["cool", "pink", "rosy", "rose", "berry", "plum", "blue", "red"]
        : ["neutral", "beige", "balanced", "natural"];
  const avoidDir =
    dir === "warm"
      ? ["cool", "pink", "rosy", "blue"]
      : dir === "cool"
        ? ["warm", "gold", "golden", "yellow", "peach", "orange"]
        : [];

  const wantSeason =
    seasonKey === "spring"
      ? ["coral", "peach", "apricot", "fresh", "bright", "golden", "warm rose"]
      : seasonKey === "summer"
        ? ["soft", "dusty", "mauve", "rose", "cool pink", "taupe", "muted"]
        : seasonKey === "autumn"
          ? ["terracotta", "brick", "copper", "bronze", "spice", "warm brown", "apricot"]
          : ["bold", "deep", "berry", "cranberry", "true red", "plum", "wine"];

  const avoidSeason =
    seasonKey === "spring"
      ? ["deep", "dark", "plum", "wine"]
      : seasonKey === "summer"
        ? ["bright orange", "neon", "brick"]
        : seasonKey === "autumn"
          ? ["icy", "cool pink", "fuchsia"]
          : ["beige", "nude beige"];

  const isFoundation = String(category || "").toLowerCase() === "foundation";
  const tNum = Number(toneNumber);
  const targetP = Number.isFinite(tNum) ? Math.min(1, Math.max(0, (tNum - 1) / 9)) : 0.4;

  // Pre-sort for foundation by first number we can extract (helps pick a similar depth index).
  const withNum = list
    .map((sh, idx) => {
      const label = shadeLabel(sh);
      const m = /\b(\d+(?:\.\d+)?)\b/.exec(label);
      const num = m ? Number(m[1]) : NaN;
      return { sh, idx, label, num };
    })
    .sort((a, b) => {
      const an = a.num;
      const bn = b.num;
      const aOk = Number.isFinite(an);
      const bOk = Number.isFinite(bn);
      if (aOk && bOk) return an - bn;
      if (aOk && !bOk) return -1;
      if (!aOk && bOk) return 1;
      return a.idx - b.idx;
    });

  const targetIdx = Math.round(targetP * Math.max(0, withNum.length - 1));

  let best = null;
  let bestScore = -1e9;

  for (let i = 0; i < withNum.length; i++) {
    const item = withNum[i];
    const label = item.label;
    if (!label) continue;

    let score = 0;
    const text = `${label}`;

    // Undertone + season cues
    score += 2 * scoreByKeywords(text, wantDir, avoidDir);
    score += 1 * scoreByKeywords(text, wantSeason, avoidSeason);

    if (isFoundation) {
      const depth = parseDepthFromText(label);
      if (depth) {
        score += 6 - Math.abs(depthRank(depth) - desiredDepthRank);
      } else {
        // Depth fallback: closeness to target index (using numeric ordering if available)
        score += 4 - Math.min(4, Math.abs(i - targetIdx));
      }
    }

    // Mild preference for shades that look like a real “color name”
    if (/\bcolor\b/i.test(text)) score -= 1;

    if (score > bestScore) {
      bestScore = score;
      best = item.sh;
    }
  }

  return best;
}

async function getSephoraShadesForUrl(url) {
  const u = String(url || "").trim();
  if (!u) return [];
  const cached = shadeCache.get(u);
  const now = Date.now();
  if (cached && now - (cached.fetchedAt || 0) < SHADE_CACHE_TTL_MS) {
    return Array.isArray(cached.shades) ? cached.shades : [];
  }

  const html = await fetchHtml(u);
  const shades = extractSephoraColorVariantsFromHtml(html);
  shadeCache.set(u, { fetchedAt: now, shades });
  return shades;
}

// Product lists (kept intentionally small + stable)
const BUY_RECS_SERVER = {
  cool: {
    foundation: [
      "Estée Lauder Double Wear Stay-in-Place Foundation",
      "NARS Light Reflecting Foundation",
      "Fenty Beauty Pro Filt'r Soft Matte Longwear Foundation",
    ],
    cheeks: ["Rare Beauty Soft Pinch Liquid Blush", "Clinique Cheek Pop", "NARS Blush"],
    eyes: ["Natasha Denona Glam Palette", "Urban Decay Naked2 Basics Palette", "Make Up For Ever Artist Color Pencil"],
    lips: ["MAC Matte Lipstick", "Charlotte Tilbury Matte Revolution Lipstick", "Fenty Beauty Gloss Bomb"],
  },
  "neutral-cool": {
    foundation: ["Dior Backstage Face & Body Foundation", "NARS Light Reflecting Foundation", "Fenty Beauty Pro Filt'r Foundation"],
    cheeks: ["Clinique Cheek Pop", "Rare Beauty Soft Pinch Liquid Blush", "NARS Blush"],
    eyes: ["Natasha Denona Glam Palette", "Urban Decay Naked2 Basics Palette", "Make Up For Ever Artist Color Pencil"],
    lips: ["MAC Satin Lipstick", "Charlotte Tilbury Matte Revolution Lipstick", "Fenty Beauty Gloss Bomb"],
  },
  neutral: {
    foundation: ["Dior Backstage Face & Body Foundation", "Fenty Beauty Eaze Drop Blurring Skin Tint", "NARS Light Reflecting Foundation"],
    cheeks: ["Rare Beauty Soft Pinch Liquid Blush", "Clinique Cheek Pop", "NARS Blush"],
    eyes: ["Natasha Denona Glam Palette", "Urban Decay Naked3 Palette", "Make Up For Ever Artist Color Pencil"],
    lips: ["Charlotte Tilbury Matte Revolution Lipstick", "MAC Satin Lipstick", "Fenty Beauty Gloss Bomb"],
  },
  "neutral-warm": {
    foundation: ["Giorgio Armani Luminous Silk Foundation", "Dior Backstage Face & Body Foundation", "Make Up For Ever HD Skin Foundation"],
    cheeks: ["Rare Beauty Soft Pinch Liquid Blush", "Fenty Beauty Cheeks Out Cream Blush", "NARS Blush"],
    eyes: ["Natasha Denona Bronze Palette", "Huda Beauty Nude Obsessions Palette", "Make Up For Ever Artist Color Pencil"],
    lips: ["Charlotte Tilbury K.I.S.S.I.N.G Lipstick", "MAC Matte Lipstick", "Fenty Beauty Gloss Bomb"],
  },
  warm: {
    foundation: ["Giorgio Armani Luminous Silk Foundation", "Charlotte Tilbury Beautiful Skin Foundation", "Make Up For Ever HD Skin Foundation"],
    cheeks: ["Fenty Beauty Cheeks Out Cream Blush", "Rare Beauty Soft Pinch Liquid Blush", "NARS Blush"],
    eyes: ["Natasha Denona Bronze Palette", "Huda Beauty Nude Obsessions Palette", "Too Faced Natural Eyes Palette"],
    lips: ["Charlotte Tilbury K.I.S.S.I.N.G Lipstick", "MAC Matte Lipstick", "Fenty Beauty Gloss Bomb"],
  },
};

// Sephora product URLs (best-effort; if a URL is missing, we fall back to generic color guidance).
// NOTE: Some products are US-only; those still work for shade names.
const PRODUCT_URLS = {
  "Estée Lauder Double Wear Stay-in-Place Foundation": "https://www.sephora.com/ca/en/product/double-wear-stay-in-place-makeup-P378284",
  "NARS Light Reflecting Foundation": "https://www.sephora.com/ca/en/product/nars-light-reflecting-advance-skincare-foundation-P479338",
  "Fenty Beauty Pro Filt'r Soft Matte Longwear Foundation": "https://www.sephora.com/ca/en/product/pro-filtr-soft-matte-longwear-foundation-P87985432",
  "Fenty Beauty Pro Filt'r Foundation": "https://www.sephora.com/ca/en/product/pro-filtr-soft-matte-longwear-foundation-P87985432",
  "Dior Backstage Face & Body Foundation": "https://www.sephora.com/ca/en/product/backstage-face-body-foundation-P432500",
  "Fenty Beauty Eaze Drop Blurring Skin Tint": "https://www.sephora.com/ca/en/product/fenty-beauty-rihanna-eaze-drop-blurring-skin-tint-P470025",
  "Giorgio Armani Luminous Silk Foundation": "https://www.sephora.com/product/luminous-silk-natural-glow-blurring-liquid-foundation-with-24-hour-wear-P519887",
  "Make Up For Ever HD Skin Foundation": "https://www.sephora.com/ca/en/product/make-up-for-ever-hd-skin-foundation-P479712",
  "Charlotte Tilbury Beautiful Skin Foundation": "https://www.sephora.com/ca/en/product/charlotte-tilbury-beautiful-skin-medium-coverage-liquid-foundation-with-hyaluronic-acid-P480286",

  "Rare Beauty Soft Pinch Liquid Blush": "https://www.sephora.com/ca/en/product/rare-beauty-by-selena-gomez-soft-pinch-liquid-blush-P97989778",
  "Clinique Cheek Pop": "https://www.sephora.com/ca/en/product/cheek-pop-P384996",
  "NARS Blush": "https://www.sephora.com/ca/en/product/blush-P2855",
  "Fenty Beauty Cheeks Out Cream Blush": "https://www.sephora.com/ca/en/product/fenty-beauty-rihanna-cheeks-out-freestyle-cream-blush-P19700127",

  "Natasha Denona Glam Palette": "https://www.sephora.com/product/natasha-denona-glam-eyeshadow-palette-P461188",
  "Natasha Denona Bronze Palette": "https://www.sephora.com/brand/natasha-denona/eyeshadow-palettes",
  "Urban Decay Naked2 Basics Palette": "https://www.sephora.com/ca/en/product/naked2-basics-P388225",
  "Urban Decay Naked3 Palette": "https://www.sephora.com/ca/en/product/naked3-P384099",
  "Huda Beauty Nude Obsessions Palette": "https://www.sephora.com/product/nude-obsessions-eyeshadow-palette-P450887",
  "Too Faced Natural Eyes Palette": "https://www.sephora.com/ca/en/product/too-faced-born-this-way-natural-nudes-eyeshadow-palette-P455201",
  "Make Up For Ever Artist Color Pencil": "https://www.sephora.com/ca/en/product/artist-color-pencil-P430969",

  "MAC Matte Lipstick": "https://www.sephora.com/ca/en/product/mac-cosmetics-m-a-cximal-silky-matte-lipstick-P510799",
  "MAC Satin Lipstick": "https://www.sephora.com/ca/en/product/mac-cosmetics-macximal-sleek-satin-lipstick-P513655",
  "Charlotte Tilbury Matte Revolution Lipstick": "https://www.sephora.com/ca/en/product/matte-revolution-lipstick-P433530",
  "Charlotte Tilbury K.I.S.S.I.N.G Lipstick": "https://www.sephora.com/ca/en/product/P433531",
  "Fenty Beauty Gloss Bomb": "https://www.sephora.com/ca/en/product/gloss-bomb-universal-lip-luminizer-P67988453",
};

function buildFallbackColorLabelServer({ category, undertone, season, toneNumber, toneDepth }) {
  const dir = undertoneDirectionServer(undertone);
  const s = normalizeSeasonKeyServer(season);
  const depth = normalizeToneDepthServer(toneDepth) || toneDepthFromNumberServer(Number(toneNumber));

  const pick = (cool, neutral, warm) => (dir === "cool" ? cool : dir === "warm" ? warm : neutral);

  if (String(category || "").toLowerCase() === "foundation") {
    const desc = pick("cool rosy", "neutral", "warm/peach");
    const num = Number.isFinite(Number(toneNumber)) ? Number(toneNumber) : 4.5;
    const rounded = Math.round(num * 2) / 2;
    return `${rounded} - ${depth}, ${desc}`;
  }

  if (String(category || "").toLowerCase() === "cheeks") {
    if (s === "spring") return pick("cool pink", "peach-pink", "peach/coral");
    if (s === "summer") return pick("soft rose", "dusty rose", "soft peach");
    if (s === "autumn") return pick("mauve-rose", "rose-bronze", "apricot/terracotta");
    return pick("berry", "deep rose", "warm red");
  }

  if (String(category || "").toLowerCase() === "eyes") {
    if (s === "spring") return pick("cool champagne", "taupe-champagne", "golden champagne");
    if (s === "summer") return pick("cool taupe", "soft taupe", "warm taupe");
    if (s === "autumn") return pick("cool brown", "mushroom brown", "bronze/olive");
    return pick("charcoal/plum", "deep taupe", "deep bronze");
  }

  // lips
  if (s === "spring") return pick("raspberry pink", "warm rose", "coral");
  if (s === "summer") return pick("mauve", "rose", "warm rose");
  if (s === "autumn") return pick("berry-brown", "rose-brown", "brick/terracotta");
  return pick("blue-red/cranberry", "classic red", "true red");
}

async function buildProductLines({ products, category, undertone, season, toneNumber, toneDepth }) {
  const out = [];
  const list = Array.isArray(products) ? products : [];
  const picks = list.slice(0, 2);

  for (const name of picks) {
    const url = PRODUCT_URLS[name] || "";
    let label = "";
    try {
      if (url && isAllowedRetailerUrl(url)) {
        const shades = await getSephoraShadesForUrl(url);
        const best = pickBestShadeForCategory({
          shades,
          category,
          undertone,
          season,
          toneNumber,
          toneDepth,
        });
        label = best ? shadeLabel(best) : "";
      }
    } catch {
      label = "";
    }

    if (!label) {
      label = buildFallbackColorLabelServer({ category, undertone, season, toneNumber, toneDepth });
    }

    const tail = label ? ` — ${label}` : "";
    out.push(`- ${name}${tail}`);
  }

  return out;
}

app.post("/recommend-products", authRequired, async (req, res) => {
  try {
    const undertone = normalizeUndertoneKeyServer(req?.body?.undertone);
    const season = normalizeSeasonKeyServer(req?.body?.season);
    const toneNumber = req?.body?.tone_number;
    const toneDepth = req?.body?.tone_depth;

    const list = BUY_RECS_SERVER[undertone] || BUY_RECS_SERVER.neutral;

    const lines = [];
    lines.push("Recommended products:");

    const sections = [
      { title: "Foundation", key: "foundation" },
      { title: "Cheeks", key: "cheeks" },
      { title: "Eyes", key: "eyes" },
      { title: "Lips", key: "lips" },
    ];

    for (const sec of sections) {
      const products = list?.[sec.key] || [];
      const block = await buildProductLines({
        products,
        category: sec.title,
        undertone,
        season,
        toneNumber,
        toneDepth,
      });

      if (!block.length) continue;
      lines.push("");
      lines.push(`${sec.title}:`);
      block.forEach((l) => lines.push(l));
    }

    return res.json({ ok: true, text: lines.join("\n") });
  } catch (e) {
    console.error("recommend-products error:", e);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

// ---- Face photo analysis ----
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: Math.max(1, UPLOAD_MAX_MB) * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const mt = String(file.mimetype || "");
    if (!mt.startsWith("image/")) return cb(new Error("Only image uploads are supported"));
    cb(null, true);
  },
});

function extractOutputText(resp) {
  let text = typeof resp?.output_text === "string" ? resp.output_text : "";
  let refusal = typeof resp?.refusal === "string" ? resp.refusal : "";

  const output = Array.isArray(resp?.output) ? resp.output : [];
  for (const item of output) {
    if (typeof item?.output_text === "string") text += item.output_text;
    if (typeof item?.refusal === "string" && !refusal) refusal = item.refusal;

    const content = Array.isArray(item?.content) ? item.content : [];
    for (const part of content) {
      if (part?.type === "output_text" && typeof part?.text === "string") text += part.text;
      if (part?.type === "refusal" && typeof part?.refusal === "string" && !refusal) refusal = part.refusal;
    }
  }

  return { text: String(text || "").trim(), refusal: String(refusal || "").trim() };
}

// --- Analysis normalization (guarantee we always return a usable undertone) ---
// 5-class undertone output:
//   cool | neutral-cool | neutral | neutral-warm | warm
// (Legacy values like "olive" are normalized to "neutral".)
const ALLOWED_UNDERTONES = ["warm", "neutral-warm", "neutral", "neutral-cool", "cool"];
const ALLOWED_LIGHTING = ["good", "ok", "poor", "unknown"];
const ALLOWED_WB = ["neutral", "warm", "cool", "unknown"];

function clampInt(n, min, max, fallback) {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.max(min, Math.min(max, Math.round(v)));
}

function toStr(x) {
  if (typeof x === "string") return x;
  if (x === null || x === undefined) return "";
  return String(x);
}

function cleanList(value, max = 10) {
  const a = Array.isArray(value) ? value : [];
  return a
    .map((x) => toStr(x).trim())
    .filter(Boolean)
    .slice(0, max);
}

function normalizeUndertoneValue(v) {
  const s = toStr(v).trim().toLowerCase();
  if (!s) return null;
  if (ALLOWED_UNDERTONES.includes(s)) return s;

  // Common/legacy values or freeform strings.
  if (s === "unknown" || s === "unsure" || s === "uncertain" || s === "n/a") return null;

  // Normalize common separators first.
  const hy = s.replace(/[_\s]+/g, "-");
  const letters = s.replace(/[^a-z]+/g, "");

  // Prefer the 5-class neutral-leaning labels when explicitly present.
  if (hy === "neutral-cool" || hy === "cool-neutral") return "neutral-cool";
  if (hy === "neutral-warm" || hy === "warm-neutral") return "neutral-warm";
  if (letters === "neutralcool" || letters === "coolneutral") return "neutral-cool";
  if (letters === "neutralwarm" || letters === "warmneutral") return "neutral-warm";

  // Heuristic: "neutral" + "cool" (and not "warm") => neutral-cool
  if (s.includes("neutral") && s.includes("cool") && !s.includes("warm")) return "neutral-cool";
  // Heuristic: "neutral" + "warm" (and not "cool") => neutral-warm
  if (s.includes("neutral") && s.includes("warm") && !s.includes("cool")) return "neutral-warm";

  // Fallback: pick the nearest base bucket.
  if (s.includes("warm")) return "warm";
  if (s.includes("cool")) return "cool";
  if (s.includes("neutral")) return "neutral";
  // Legacy: keep the 5-class output stable.
  if (s.includes("olive") || s.includes("green")) return "neutral";

  return null;
}

function defaultRecommendationsForUndertone(undertone) {
  // Treat neutral-leaning labels as their base direction for recommendations.
  const u0 = normalizeUndertoneValue(undertone) || "neutral";
  const u = u0 === "neutral-warm" ? "warm" : u0 === "neutral-cool" ? "cool" : u0;

  switch (u) {
    case "warm":
      return {
        best_neutrals: ["ivory", "cream", "warm beige", "camel", "warm taupe", "chocolate"],
        accent_colors: ["coral", "peach", "tomato red", "terracotta", "mustard", "warm teal"],
        metals: ["gold", "rose gold", "bronze"],
        makeup_tips: [
          "Choose foundation/skin tints labeled warm or golden (test on jawline).",
          "Try peach/coral blushes.",
          "Warm browns, bronzes, and olive tones tend to flatter.",
        ],
        avoid: ["icy pastels", "blue-based pinks", "very ashy grays"],
      };

    case "cool":
      return {
        best_neutrals: ["soft white", "cool beige", "cool taupe", "charcoal", "navy", "black"],
        accent_colors: ["berry", "fuchsia", "true red", "cobalt", "emerald", "icy lavender"],
        metals: ["silver", "platinum", "white gold"],
        makeup_tips: [
          "Choose foundation/skin tints labeled cool, rosy, or neutral-cool (test on jawline).",
          "Try rosy/berry blushes.",
          "Cool browns, plums, and gray-taupes often work well.",
        ],
        avoid: ["very orange tones", "yellow-heavy beige", "mustard-heavy palettes"],
      };

    default:
      return {
        best_neutrals: ["soft white", "taupe", "medium gray", "navy", "mushroom", "soft black"],
        accent_colors: ["dusty rose", "teal", "true red", "sage", "berry", "peach"],
        metals: ["silver", "gold"],
        makeup_tips: [
          "Neutral undertones can often wear both warm and cool shades—test on the jawline in daylight.",
          "Choose blush/lip colors that are muted rather than very neon.",
        ],
        avoid: ["extreme orange", "extreme icy pastels"],
      };
  }
}

function softenQualityNotes(s) {
  let t = toStr(s).trim();
  if (!t) return "";
  // Remove overly absolute language. We always return a best-effort undertone.
  t = t.replace(/not\s+sufficient[^.]*\.?/gi, "Best-effort estimate; brighter, neutral daylight improves accuracy.");
  t = t.replace(/cannot\s+determine[^.]*\.?/gi, "Best-effort estimate; a clearer, evenly lit photo improves accuracy.");
  t = t.replace(/seasonal\s+(family|analysis|color|palette)/gi, "undertone");
  return t.trim();
}

function sanitizeAnalysis(raw) {
  // Minimal client response with strict fields.
  // - undertone: one of the 5 labels
  // - season: one of the 4 seasons
  // - photo_ok: whether a real human face is present + usable
  // - issue: why a photo is not usable (or "ok")
  // - confidence: 0-100 (undertone confidence; capped low when photo_ok is false)

  const undertoneNorm = normalizeUndertoneValue(raw?.undertone);
  const undertone = undertoneNorm || "neutral";

  const seasonRaw = String(raw?.season ?? raw?.color_season ?? raw?.season4 ?? "").trim().toLowerCase();
  const allowedSeasons = new Set(["spring", "summer", "autumn", "winter"]);
  let season = allowedSeasons.has(seasonRaw) ? seasonRaw : "";

  // Best-effort fallback if season isn't provided.
  if (!season) {
    // Classic 4-season heuristic: warm-leaning tends to spring/autumn; cool-leaning tends to summer/winter.
    // Without clear contrast info, default to the lighter/softer season.
    const u = undertone;
    if (u === "warm" || u === "neutral-warm") season = "spring";
    else if (u === "cool" || u === "neutral-cool") season = "summer";
    else season = "summer";
  }

  const photoOkRaw =
    raw?.photo_ok ??
    raw?.photoOk ??
    raw?.photoOK ??
    raw?.human_face ??
    raw?.humanFace ??
    raw?.face_present ??
    raw?.facePresent;

  const photo_ok = typeof photoOkRaw === "boolean" ? photoOkRaw : true;

  const issueRaw = String(raw?.issue ?? raw?.photo_issue ?? raw?.photoIssue ?? "")
    .trim()
    .toLowerCase();

  const allowedIssues = new Set([
    "ok",
    "no_human_face",
    "face_not_clear",
    "face_too_far",
    "lighting_poor",
    "obstructed",
    "multiple_faces",
    "not_a_photo",
  ]);

  const issue = allowedIssues.has(issueRaw) ? issueRaw : photo_ok ? "ok" : "face_not_clear";

  let confidence = clampInt(raw?.confidence, 0, 100, 55);
  if (photo_ok === false) confidence = Math.min(confidence, 20);

  return { undertone, season, photo_ok, issue, confidence };
}


function guessUndertoneFromJpeg(jpegBuffer) {
  try {
    const decoded = jpeg.decode(jpegBuffer, { useTArray: true });
    const w = decoded?.width || 0;
    const h = decoded?.height || 0;
    const data = decoded?.data;
    if (!w || !h || !data) return null;

    const cx = w * 0.5;
    const cy = h * 0.42;
    const rx = w * 0.34;
    const ry = h * 0.32;
    const step = Math.max(2, Math.min(8, Math.floor(Math.min(w, h) / 180)));

    const x0 = Math.max(0, Math.floor(cx - rx));
    const x1 = Math.min(w - 1, Math.ceil(cx + rx));
    const y0 = Math.max(0, Math.floor(cy - ry));
    const y1 = Math.min(h - 1, Math.ceil(cy + ry));

    const lumOf = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const isSkin = (r, g, b) => {
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const y = 0.299 * r + 0.587 * g + 0.114 * b;
      const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
      const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;

      const rgbRule =
        r > 45 &&
        g > 18 &&
        b > 12 &&
        r >= g &&
        r >= b &&
        Math.abs(r - g) > 8 &&
        max - min > 12;

      const ycbcrRule = y > 28 && cb >= 75 && cb <= 145 && cr >= 132 && cr <= 190;
      return rgbRule || ycbcrRule;
    };

    let count = 0;
    let skinCount = 0;
    let sumLum = 0;
    let sumSkinLum = 0;
    let sumR = 0;
    let sumG = 0;
    let sumB = 0;
    let dark = 0;
    let bright = 0;

    for (let y = y0; y <= y1; y += step) {
      const yn = (y - cy) / (ry || 1);
      for (let x = x0; x <= x1; x += step) {
        const xn = (x - cx) / (rx || 1);
        if (xn * xn + yn * yn > 1) continue;

        const i = (y * w + x) * 4;
        const r = data[i] || 0;
        const g = data[i + 1] || 0;
        const b = data[i + 2] || 0;
        const lum = lumOf(r, g, b);

        count++;
        sumLum += lum;
        if (lum < 35) dark++;
        if (lum > 225) bright++;

        if (isSkin(r, g, b)) {
          skinCount++;
          sumSkinLum += lum;
          sumR += r;
          sumG += g;
          sumB += b;
        }
      }
    }

    if (count < 200 || skinCount < 120) {
      return {
        undertone: "neutral",
        confidence: 18,
        lighting: "unknown",
        white_balance: "unknown",
        face_visible: skinCount >= 60,
        notes: "Best-effort estimate; ensure your face and neck are centered and evenly lit.",
      };
    }

    const meanLum = sumLum / Math.max(1, count);
    const darkRatio = dark / Math.max(1, count);
    const brightRatio = bright / Math.max(1, count);

    const avgR = sumR / Math.max(1, skinCount);
    const avgG = sumG / Math.max(1, skinCount);
    const avgB = sumB / Math.max(1, skinCount);

    const skinLum = sumSkinLum / Math.max(1, skinCount);
    const roundHalf = (n) => Math.round(n * 2) / 2;
    const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
    const tone_number = clamp(roundHalf(((255 - skinLum) / 255) * 9 + 1), 1, 10);
    const tone_depth =
      tone_number <= 2
        ? 'very fair'
        : tone_number <= 3.5
        ? 'fair'
        : tone_number <= 5
        ? 'light'
        : tone_number <= 6.5
        ? 'medium'
        : tone_number <= 8
        ? 'tan'
        : 'deep';

    const denom = meanLum + 1;
    const castRB = (avgR - avgB) / denom; // +warm, -cool
    const greenDelta = (avgG - (avgR + avgB) / 2) / denom;

    let undertone = "neutral";
    // Legacy "olive" handling removed for 5-class output.
    // Green-ish bias without a strong red/blue bias: treat as neutral.
    if (greenDelta > 0.06 && Math.abs(castRB) < 0.11) undertone = "neutral";
    else if (castRB > 0.09) undertone = "warm";
    else if (castRB > 0.04) undertone = "neutral-warm";
    else if (castRB < -0.09) undertone = "cool";
    else if (castRB < -0.04) undertone = "neutral-cool";
    else undertone = "neutral";

    const lighting = meanLum < 55 || darkRatio > 0.35 || brightRatio > 0.35 ? "poor" : meanLum < 70 || darkRatio > 0.25 ? "ok" : "good";
    const white_balance = Math.abs(castRB) < 0.06 ? "neutral" : castRB > 0 ? "warm" : "cool";

    // Conservative confidence: this is a fallback heuristic.
    const signal = Math.max(Math.abs(castRB), Math.abs(greenDelta));
    let confidence = 18 + Math.round(Math.min(22, (signal / 0.18) * 22));
    confidence = clampInt(confidence, 10, 40, 20);

    return {
      undertone,
      confidence,
      lighting,
      white_balance,
      tone_number,
      tone_depth,
      face_visible: true,
      notes: "Best-effort estimate; brighter, neutral daylight improves accuracy.",
    };
  } catch {
    return null;
  }
}

function buildFallbackAnalysisFromImage({ jpegBuffer, reason }) {
  const guess = guessUndertoneFromJpeg(jpegBuffer);

  // If we cannot see enough skin / face region, treat as invalid photo.
  if (!guess || guess.face_visible === false) {
    return sanitizeAnalysis({
      undertone: "neutral",
      photo_ok: false,
      issue: "no_human_face",
      confidence: 10,
    });
  }

  return sanitizeAnalysis({
    undertone: guess.undertone || "neutral",
    photo_ok: true,
    issue: "ok",
    confidence: typeof guess.confidence === "number" ? guess.confidence : 25,
  });
}


async function callOpenAIForAnalysis({ dataUrl, dataUrlNormalized = null, dataUrlCrop = null, modelOverride = null }) {
  if (!OPENAI_API_KEY) {
    throw new Error("Missing OPENAI_API_KEY on server");
  }

  // Structured Outputs schema (photo validity + undertone + season)
  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      photo_ok: { type: "boolean" },
      issue: {
        type: "string",
        enum: [
          "ok",
          "no_human_face",
          "face_not_clear",
          "face_too_far",
          "lighting_poor",
          "obstructed",
          "multiple_faces",
          "not_a_photo",
        ],
      },
      undertone: { type: "string", enum: ["cool", "neutral-cool", "neutral", "neutral-warm", "warm"] },
      season: { type: "string", enum: ["spring", "summer", "autumn", "winter"] },
      confidence: { type: "integer", minimum: 0, maximum: 100 },
    },
    required: ["photo_ok", "issue", "undertone", "season", "confidence"],
  };

  const systemPrompt =
    "You are a color-analysis assistant." +
    " First, verify whether the image contains a REAL HUMAN FACE suitable for skin undertone analysis." +
    " If there is no human face (animal/object/illustration), set photo_ok=false and issue=no_human_face." +
    " If a human face is present but not usable (too far, too blurry, heavily obscured, extreme lighting), set photo_ok=false and choose the best issue from the enum." +
    " Only when photo_ok=true, estimate skin undertone from the face/neck/jaw area." +
    " Return exactly one undertone from: cool | neutral-cool | neutral | neutral-warm | warm." +
    " Use neutral-cool / neutral-warm ONLY when the skin appears neutral overall but clearly leans cool or warm." +
    " If uncertain (but photo_ok=true), choose neutral." +
    " Also estimate the person's 4-season color season: spring | summer | autumn | winter (best-effort)." +
    " If uncertain, pick the most likely season given undertone: warm-leaning often spring/autumn, cool-leaning often summer/winter." +
    " Provide confidence 0-100 for the undertone classification. If photo_ok=false, keep confidence low (0-20)." +
    " Be neutral and non-judgmental. Do NOT comment on attractiveness, body shape, health, age, or race/ethnicity." +
    " Return JSON that matches the provided schema.";

  const userText =
    "1) Determine if a real human face is present and usable for undertone analysis." +
    " 2) If usable, output undertone (cool/neutral-cool/neutral/neutral-warm/warm)." +
    " 3) If usable, output a 4-season color season (spring/summer/autumn/winter)." +
    " Issue enum: ok | no_human_face | face_not_clear | face_too_far | lighting_poor | obstructed | multiple_faces | not_a_photo." +
    " If multiple images are provided: the first is the original, the second is a mild white-balanced version (reduces color-cast), and an optional third is a tighter crop of the face/neck.";

  const content = [
    { type: "input_text", text: userText },
    { type: "input_image", image_url: dataUrl, detail: OPENAI_IMAGE_DETAIL },
  ];
  if (dataUrlNormalized) {
    content.push({ type: "input_image", image_url: dataUrlNormalized, detail: OPENAI_IMAGE_DETAIL });
  }
  if (dataUrlCrop) {
    content.push({ type: "input_image", image_url: dataUrlCrop, detail: OPENAI_IMAGE_DETAIL });
  }

  const payload = {
    model: modelOverride || OPENAI_MODEL,
    temperature: 0,
    input: [
      {
        role: "system",
        content: systemPrompt,
      },
      {
        role: "user",
        content,
      },
    ],
    max_output_tokens: OPENAI_MAX_OUTPUT_TOKENS,
    text: {
      format: {
        type: "json_schema",
        name: "undertone_face_analysis",
        strict: true,
        schema,
      },
    },
  };

  const r = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = data?.error?.message || data?.error || `OpenAI error HTTP ${r.status}`;
    throw new Error(msg);
  }

  const { text, refusal } = extractOutputText(data);
  if (refusal) throw new Error(refusal);
  if (!text) throw new Error("OpenAI returned no text output");

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("OpenAI returned non-JSON output");
  }

  return parsed;
}

function mildWhiteBalanceJpeg(jpegBuffer) {
  try {
    const decoded = jpeg.decode(jpegBuffer, { useTArray: true });
    const w = decoded?.width || 0;
    const h = decoded?.height || 0;
    const data = decoded?.data;
    if (!w || !h || !data) return null;

    // Sample bright, near-neutral pixels to estimate the scene's white point.
    const step = Math.max(1, Math.floor(Math.min(w, h) / 260));

    let sumR = 0;
    let sumG = 0;
    let sumB = 0;
    let count = 0;

    const lumOf = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

    for (let y = 0; y < h; y += step) {
      for (let x = 0; x < w; x += step) {
        const i = (y * w + x) * 4;
        const r = data[i] || 0;
        const g = data[i + 1] || 0;
        const b = data[i + 2] || 0;

        const lum = lumOf(r, g, b);
        if (lum < 180 || lum > 250) continue;

        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        if (max >= 252 || min <= 6) continue;
        if (max - min > 18) continue;

        sumR += r;
        sumG += g;
        sumB += b;
        count++;
      }
    }

    // Fallback: if we couldn't find enough near-neutral highlights, use a broader set.
    if (count < 120) {
      sumR = 0;
      sumG = 0;
      sumB = 0;
      count = 0;

      for (let y = Math.floor(h * 0.15); y < Math.floor(h * 0.85); y += step) {
        for (let x = Math.floor(w * 0.15); x < Math.floor(w * 0.85); x += step) {
          const i = (y * w + x) * 4;
          const r = data[i] || 0;
          const g = data[i + 1] || 0;
          const b = data[i + 2] || 0;

          const lum = lumOf(r, g, b);
          if (lum < 60 || lum > 220) continue;

          sumR += r;
          sumG += g;
          sumB += b;
          count++;
        }
      }
    }

    if (count < 60) return null;

    const avgR = sumR / count;
    const avgG = sumG / count;
    const avgB = sumB / count;
    const target = (avgR + avgG + avgB) / 3;

    let scaleR = target / (avgR || 1);
    let scaleG = target / (avgG || 1);
    let scaleB = target / (avgB || 1);

    // Clamp + soften (mild correction so we reduce lighting cast without nuking undertone).
    const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
    scaleR = clamp(scaleR, 0.85, 1.15);
    scaleG = clamp(scaleG, 0.85, 1.15);
    scaleB = clamp(scaleB, 0.85, 1.15);

    const strength = 0.65;
    scaleR = 1 + (scaleR - 1) * strength;
    scaleG = 1 + (scaleG - 1) * strength;
    scaleB = 1 + (scaleB - 1) * strength;

    const out = Buffer.from(data);
    for (let i = 0; i < out.length; i += 4) {
      out[i] = Math.max(0, Math.min(255, Math.round((out[i] || 0) * scaleR)));
      out[i + 1] = Math.max(0, Math.min(255, Math.round((out[i + 1] || 0) * scaleG)));
      out[i + 2] = Math.max(0, Math.min(255, Math.round((out[i + 2] || 0) * scaleB)));
      // alpha stays
    }

    const enc = jpeg.encode({ data: out, width: w, height: h }, 90);
    return enc?.data || null;
  } catch {
    return null;
  }
}

function centerCropJpeg(jpegBuffer) {
  try {
    const decoded = jpeg.decode(jpegBuffer, { useTArray: true });
    const w = decoded?.width || 0;
    const h = decoded?.height || 0;
    const data = decoded?.data;
    if (!w || !h || !data) return null;

    // A safe, device-agnostic crop that keeps the face + neck without relying on UI overlay math.
    const cropW = Math.max(1, Math.floor(w * 0.76));
    const cropH = Math.max(1, Math.floor(h * 0.88));

    const originX = Math.max(0, Math.floor((w - cropW) / 2));
    const originY = Math.max(0, Math.min(h - cropH, Math.floor(h * 0.06)));

    const out = Buffer.allocUnsafe(cropW * cropH * 4);

    for (let y = 0; y < cropH; y++) {
      const srcStart = ((originY + y) * w + originX) * 4;
      const srcEnd = srcStart + cropW * 4;
      const dstStart = y * cropW * 4;
      out.set(data.subarray(srcStart, srcEnd), dstStart);
    }

    const enc = jpeg.encode({ data: out, width: cropW, height: cropH }, 90);
    return enc?.data || null;
  } catch {
    return null;
  }
}

async function insertFaceAnalysisRow({ userId, sha256, source, analysis }) {
  try {
    const { rows } = await pool.query(
      "INSERT INTO face_analyses (user_id, image_sha256, source, analysis_json) VALUES ($1, $2, $3, $4::jsonb) RETURNING id",
      [userId, sha256 || null, source || null, JSON.stringify(analysis || {})]
    );
    return rows?.[0]?.id ?? null;
  } catch {
    return null;
  }
}

app.post("/analyze-face", authRequired, upload.single("image"), async (req, res) => {
  try {
    const user = req?.auth?.user;
    const userId = user?.id;

    if (!OPENAI_API_KEY) {
      return res.status(500).json({ ok: false, error: "Server is missing OPENAI_API_KEY" });
    }

    const used = await getUploadsUsedThisMonth(userId);
    const limit = uploadLimitForPlan("free");
    if (!DISABLE_UPLOAD_LIMITS && used >= limit) {
      return res.status(402).json({ ok: false, error: "Monthly upload limit reached", used, limit });
    }

    const file = req.file;
    if (!file?.buffer) return res.status(400).json({ ok: false, error: "Missing image file" });

    const mime = String(file.mimetype || "image/jpeg");
    const sha = crypto.createHash("sha256").update(file.buffer).digest("hex");
    const b64 = file.buffer.toString("base64");
    const dataUrl = `data:${mime};base64,${b64}`;

    // Optional: mild white-balance normalization (JPEG only). This helps reduce lighting color-cast
    // so undertone can be inferred more consistently.
    let dataUrlNormalized = null;
    try {
      const mt = String(mime || "").toLowerCase();
      if (mt.includes("jpeg") || mt.includes("jpg")) {
        const wbBuf = mildWhiteBalanceJpeg(file.buffer);
        if (wbBuf) {
          const b64n = Buffer.from(wbBuf).toString("base64");
          dataUrlNormalized = `data:${mime};base64,${b64n}`;
        }
      }
    } catch {
      dataUrlNormalized = null;
    }

    
    // Optional: tighter, safe crop (JPEG only). This helps the model focus on face/neck.
    let dataUrlCrop = null;
    try {
      const mt = String(mime || "").toLowerCase();
      if (mt.includes("jpeg") || mt.includes("jpg")) {
        const cropBuf = centerCropJpeg(file.buffer);
        if (cropBuf) {
          const b64c = Buffer.from(cropBuf).toString("base64");
          dataUrlCrop = `data:${mime};base64,${b64c}`;
        }
      }
    } catch {
      dataUrlCrop = null;
    }

    // 1) Primary model attempt
    let analysis = null;
    try {
      analysis = await callOpenAIForAnalysis({ dataUrl, dataUrlNormalized, dataUrlCrop });
      analysis = sanitizeAnalysis(analysis);
    } catch (e) {
      // Don't fail the entire request – we'll fall back to a best-effort heuristic.
      console.error("OpenAI analysis failed:", e);
      analysis = null;
    }

    // 2) Optional upgrade pass (if configured): re-run with a stronger model only when the primary call fails.
    if (OPENAI_MODEL_FALLBACK && analysis === null) {
      try {
        const upgraded = await callOpenAIForAnalysis({
          dataUrl,
          dataUrlNormalized,
          dataUrlCrop,
          modelOverride: OPENAI_MODEL_FALLBACK,
        });
        analysis = sanitizeAnalysis(upgraded);
      } catch {
        // ignore fallback model failures
      }
    }

    // 3) Hard fallback: always return a usable result when possible.
    if (!analysis) {
      analysis = buildFallbackAnalysisFromImage({ jpegBuffer: file.buffer, reason: "fallback" });
    }

    // If there is no valid human face, do NOT return an undertone.
    if (analysis?.photo_ok === false) {
      const issue = String(analysis?.issue || "").toLowerCase();
      const code = issue === "no_human_face" ? "NO_HUMAN_FACE" : "PHOTO_NOT_SUITABLE";
      const msg =
        issue === "no_human_face"
          ? "No human face detected. Please retake a clear, front-facing photo of a human face with jawline/neck visible (no filters, even lighting)."
          : "Photo isn't suitable for undertone analysis. Please retake: clear human face, evenly lit, no heavy shadows or filters.";

      return res.status(422).json({ ok: false, code, error: msg, analysis });
    }




    // Add a best-effort complexion "color" hint (number + depth) from the image.
    // This is used client-side as: "Color 4.5, light, neutral peach".
    try {
      const tone = guessUndertoneFromJpeg(file.buffer);
      if (tone && typeof tone.tone_number === "number" && Number.isFinite(tone.tone_number)) {
        analysis.tone_number = tone.tone_number;
        if (tone.tone_depth) analysis.tone_depth = tone.tone_depth;
      }
    } catch {
      // ignore
    }
    const source = String(req.body?.source || "").trim();
    const analysisId = await insertFaceAnalysisRow({ userId, sha256: sha, source, analysis });

    const recent = await getRecentFaceAnalyses(userId, 10);
    const combined = [analysis, ...(recent || [])].slice(0, 10);
    const stability = computeStability(combined);

    // Prefer a stable representative once we have a few scans that agree.
    const analysisStable =
      stability.counted >= 3 && stability.undertoneSupport >= 0.6
        ? pickBestRepresentative(combined, stability.undertone)
        : null;

    return res.json({
      ok: true,
      analysisId,
      analysis,
      analysisStable,
      stability,
      usage: { uploadsThisMonth: used + 1 },
      limits: { uploadsPerMonth: limit },
    });
  } catch (e) {
    console.error("analyze-face error:", e);
    return res.status(500).json({ ok: false, error: String(e?.message || "Server error") });
  }
});

// Multer / upload error handler
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({ ok: false, error: `Image too large. Max ${Math.max(1, UPLOAD_MAX_MB)}MB.` });
    }
    return res.status(400).json({ ok: false, error: err.message || "Upload error" });
  }

  if (err) {
    const msg = String(err?.message || err);
    return res.status(400).json({ ok: false, error: msg || "Request error" });
  }

  return next();
});

app.listen(PORT, () => {
  console.log(`✅ Undertone API listening on http://localhost:${PORT}`);
});
