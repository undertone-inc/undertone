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
const http = require("http");
const https = require("https");
const zlib = require("zlib");

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

// OpenAI (product recommendations via Sephora web search)
// Default to a reasoning model that is cost-efficient and strong at agentic web search.
const OPENAI_RECS_MODEL = String(process.env.OPENAI_RECS_MODEL || "gpt-5-mini").trim();
const OPENAI_RECS_MAX_OUTPUT_TOKENS = Number(process.env.OPENAI_RECS_MAX_OUTPUT_TOKENS || 500);
// Keep tool calls bounded so costs are predictable (search/open/find all count).
const OPENAI_RECS_MAX_TOOL_CALLS = Number(process.env.OPENAI_RECS_MAX_TOOL_CALLS || 20);
const OPENAI_RECS_USE_WEB_SEARCH = String(process.env.OPENAI_RECS_USE_WEB_SEARCH || "true").toLowerCase() !== "false";

// Recs repair: if any category returns '(unavailable)', we do a small targeted follow-up
// web search to fill the exact Sephora color/variant name. This runs only when needed.
const OPENAI_RECS_REPAIR_ENABLED = String(process.env.OPENAI_RECS_REPAIR_ENABLED || "true").toLowerCase() !== "false";
const OPENAI_RECS_REPAIR_MAX_TOOL_CALLS = Number(process.env.OPENAI_RECS_REPAIR_MAX_TOOL_CALLS || 8);
const OPENAI_RECS_REPAIR_MAX_OUTPUT_TOKENS = Number(process.env.OPENAI_RECS_REPAIR_MAX_OUTPUT_TOKENS || 250);
const OPENAI_RECS_DEBUG = String(process.env.OPENAI_RECS_DEBUG || "").toLowerCase() === "true";


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
// Optional: enable robust shade/color extraction via Apify (recommended for reliability at scale).
// Set APIFY_TOKEN in .env.server to enable. Actor default: autofacts/sephora (Sephora Scraper).
let APIFY_TOKEN = String(process.env.APIFY_TOKEN || process.env.APIFY_API_TOKEN || "").trim();
// Don't accidentally treat placeholder values as a real token.
if (!APIFY_TOKEN || /^YOUR_TOKEN$/i.test(APIFY_TOKEN) || /<YOUR/i.test(APIFY_TOKEN)) {
  APIFY_TOKEN = "";
}
const APIFY_SEPHORA_ACTOR_ID = String(process.env.APIFY_SEPHORA_ACTOR_ID || "autofacts~sephora").trim();
const APIFY_SEPHORA_USE_RESIDENTIAL = String(process.env.APIFY_SEPHORA_USE_RESIDENTIAL || "true").toLowerCase() !== "false";

// Debug logging for Apify calls (server-side only). Set to true to print
// the reason variants couldn't be fetched.
const APIFY_DEBUG = String(process.env.APIFY_DEBUG || "").toLowerCase() === "true";

// If your Apify account doesn't include the RESIDENTIAL proxy group, set
// APIFY_SEPHORA_USE_RESIDENTIAL=false. The actor may still work on datacenter
// proxies but can be less reliable.

// Tuning knobs (kept conservative; can be overridden in .env.server)
// NOTE: The actor default for maxRequestsPerCrawl is 0 (unlimited). Setting this
// too low can cause missing/empty `variants`.
const APIFY_SEPHORA_MAX_CONCURRENCY = Math.max(1, Math.min(20, Number(process.env.APIFY_SEPHORA_MAX_CONCURRENCY || 2)));
const APIFY_SEPHORA_MAX_REQUESTS_PER_CRAWL = Math.max(0, Math.min(500, Number(process.env.APIFY_SEPHORA_MAX_REQUESTS_PER_CRAWL || 0)));

// If we scrape fewer than this many shades from raw HTML, try Apify to fill in.
const APIFY_MIN_SHADES_THRESHOLD = Math.max(1, Math.min(50, Number(process.env.APIFY_MIN_SHADES_THRESHOLD || 5)));


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

function normalizeRetailerUrl(urlStr) {
  try {
    const u = new URL(String(urlStr || "").trim());
    u.hash = "";
    u.search = "";
    return u.toString();
  } catch {
    return String(urlStr || "").trim();
  }
}


async function fetchJsonPost(url, bodyObj, extraHeaders = {}) {
  const target = String(url || "").trim();
  if (!target) throw new Error("Missing URL");

  const headers = {
    accept: "application/json",
    "content-type": "application/json",
    ...extraHeaders,
  };

  if (typeof fetch === "function") {
    const res = await fetch(target, {
      method: "POST",
      headers,
      body: JSON.stringify(bodyObj ?? {}),
    });
    if (!res.ok) {
      let body = "";
      try {
        body = String(await res.text());
      } catch {
        body = "";
      }
      const snippet = body ? body.slice(0, 1000) : "";
      throw new Error(`JSON POST failed: ${res.status}${snippet ? ` :: ${snippet}` : ""}`);
    }
    return await res.json();
  }

  return await new Promise((resolve, reject) => {
    let resolved = false;
    try {
      const u = new URL(target);
      const lib = u.protocol === "https:" ? https : http;

      const payload = Buffer.from(JSON.stringify(bodyObj ?? {}), "utf8");

      const req = lib.request(
        {
          method: "POST",
          hostname: u.hostname,
          port: u.port ? Number(u.port) : undefined,
          path: `${u.pathname}${u.search}`,
          headers: {
            ...headers,
            "content-length": String(payload.length),
          },
        },
        (res) => {
          const status = Number(res.statusCode || 0);

          let data = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => {
            if (resolved) return;
            data += String(chunk || "");
            if (data.length > 8_000_000) {
              resolved = true;
              req.destroy();
              reject(new Error("JSON response too large"));
            }
          });
          res.on("end", () => {
            if (resolved) return;
            resolved = true;

            if (status < 200 || status >= 300) {
              const snippet = data ? data.slice(0, 1000) : "";
              reject(new Error(`JSON POST failed: ${status}${snippet ? ` :: ${snippet}` : ""}`));
              return;
            }

            try {
              resolve(JSON.parse(data || "{}"));
            } catch (e) {
              reject(e);
            }
          });
          res.on("error", (e) => {
            if (resolved) return;
            resolved = true;
            reject(e);
          });
        }
      );

      req.on("error", (e) => {
        if (resolved) return;
        resolved = true;
        reject(e);
      });

      req.write(payload);
      req.end();
    } catch (e) {
      if (resolved) return;
      resolved = true;
      reject(e);
    }
  });
}

function extractColorLabelFromApifyVariant(variant) {
  const v = variant && typeof variant === "object" ? variant : {};

  // 1) Options array: [{ name: 'Color', value: 'Heather Pop' }, ...]
  const options = Array.isArray(v.options) ? v.options : [];
  for (const opt of options) {
    const n = String(opt?.name || opt?.type || "").toLowerCase();
    if (/(color|colour|shade)/i.test(n)) {
      const val = String(opt?.value || opt?.label || "").trim();
      if (val) return cleanVariantValue(val);
    }
  }

  // 2) Attributes object
  const attrs = v.attributes && typeof v.attributes === "object" ? v.attributes : null;
  if (attrs) {
    for (const k of Object.keys(attrs)) {
      if (!/(color|colour|shade)/i.test(k)) continue;
      const val = String(attrs?.[k] || "").trim();
      if (val) return cleanVariantValue(val);
    }
  }

  // 3) Common top-level keys
  const tryKeys = [
    "color",
    "colour",
    "shade",
    "colorName",
    "colourName",
    "shadeName",
    "swatchName",
    "skuSwatchName",
    "variant",
    "variantName",
    "variantTitle",
    "title",
    "name",
    "displayName",
    "label",
  ];
  for (const k of tryKeys) {
    const val = v?.[k];
    if (typeof val === "string" && val.trim()) {
      const cleaned = cleanVariantValue(val);
      if (!cleaned) continue;
      // Avoid returning product titles that are overly long.
      if (cleaned.length > 140) continue;
      return cleaned;
    }
  }

  return "";
}

async function getSephoraShadesViaApify(url) {
  const token = String(APIFY_TOKEN || "").trim();
  if (!token) return [];

  const actorId = encodeURIComponent(String(APIFY_SEPHORA_ACTOR_ID || "autofacts~sephora").trim());
  const endpoint = `https://api.apify.com/v2/acts/${actorId}/run-sync-get-dataset-items?token=${encodeURIComponent(token)}`;

  const startUrl = String(url || "").trim();

  const run = async (useResidential) => {
    const input = {
      startUrls: [{ url: startUrl }],
      proxy: {
        useApifyProxy: true,
        ...(useResidential ? { apifyProxyGroups: ["RESIDENTIAL"] } : {}),
      },
      maxConcurrency: APIFY_SEPHORA_MAX_CONCURRENCY,
      // 0 = unlimited (actor default). A value that's too low can cause empty/missing variants.
      maxRequestsPerCrawl: APIFY_SEPHORA_MAX_REQUESTS_PER_CRAWL,
    };
    return await fetchJsonPost(endpoint, input);
  };

  // Apify returns dataset items (array) for the finished run.
  // We try with residential proxies first (recommended), and if that fails due to
  // proxy availability, we retry once without specifying proxy group.
  let items;
  try {
    items = await run(APIFY_SEPHORA_USE_RESIDENTIAL);
  } catch (e) {
    const msg = String(e?.message || e);
    if (APIFY_DEBUG) console.warn("Apify Sephora run failed:", msg.slice(0, 500));

    const looksProxyGroupRelated = /RESIDENTIAL|proxy group|apifyProxyGroups|proxy/i.test(msg);
    if (APIFY_SEPHORA_USE_RESIDENTIAL && looksProxyGroupRelated) {
      try {
        if (APIFY_DEBUG) console.warn("Retrying Apify Sephora run without RESIDENTIAL proxy group...");
        items = await run(false);
      } catch (e2) {
        if (APIFY_DEBUG) console.warn("Apify retry failed:", String(e2?.message || e2).slice(0, 500));
        throw e2;
      }
    } else {
      throw e;
    }
  }

  const first = Array.isArray(items) ? items[0] : null;
  const variants = Array.isArray(first?.variants) ? first.variants : [];

  if (APIFY_DEBUG) {
    const title = String(first?.title || first?.name || "").trim();
    console.log(
      `Apify Sephora: ${variants.length} variants${title ? ` for ${title}` : ""} (${startUrl})`
    );
  }

  const out = [];
  const seen = new Set();

  for (const v of variants) {
    const label = extractColorLabelFromApifyVariant(v);
    if (!label) continue;

    // Filter out sizes.
    if (/(\boz\b|\bml\b|\bg\b|standard size|mini size|travel size)/i.test(label)) continue;

    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ value: label });

    if (out.length >= 200) break;
  }

  return out;
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


function retailerHeadersDesktop() {
  return {
    "user-agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "accept-language": "en-CA,en;q=0.9",
    // Allow compression for faster downloads. Node HTTPS fallback will decompress.
    "accept-encoding": "gzip, deflate, br",
    "upgrade-insecure-requests": "1",
  };
}

function retailerHeadersMobile() {
  return {
    "user-agent":
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1",
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "accept-language": "en-CA,en;q=0.9",
    "accept-encoding": "gzip, deflate, br",
    "upgrade-insecure-requests": "1",
  };
}

function retailerHeadersMinimal() {
  return {
    "user-agent": "Mozilla/5.0",
    accept: "text/html,*/*;q=0.8",
    "accept-language": "en-CA,en;q=0.9",
    "accept-encoding": "gzip, deflate",
  };
}

function looksBlockedRetailerHtml(html) {
  const t = String(html || "").toLowerCase();
  if (!t) return true;

  // Common bot/consent/blocked pages.
  const needles = [
    "access denied",
    "request blocked",
    "pardon our interruption",
    "are you a robot",
    "captcha",
    "enable cookies",
    "attention required",
    "forbidden",
  ];
  if (needles.some((n) => t.includes(n))) return true;

  // Some block pages render as a tiny HTML shell.
  if (t.length < 800 && (t.includes("error") || t.includes("blocked"))) return true;

  return false;
}

async function fetchHtmlOnce(target, headers, maxRedirects = 3) {
  const urlStr = String(target || "").trim();
  if (!urlStr) throw new Error("Missing retailer URL");

  // Node 18+ has global fetch. On older Node, fall back to native http/https.
  if (typeof fetch === "function") {
    const res = await fetch(urlStr, { method: "GET", headers, redirect: "manual" });

    if (res.status >= 300 && res.status < 400 && maxRedirects > 0) {
      const loc = res.headers.get("location");
      if (loc) {
        const next = new URL(loc, urlStr).toString();
        return await fetchHtmlOnce(next, headers, maxRedirects - 1);
      }
    }

    if (!res.ok) throw new Error(`Retailer fetch failed: ${res.status}`);
    return await res.text();
  }

  return await new Promise((resolve, reject) => {
    let resolved = false;
    try {
      const u = new URL(urlStr);
      const lib = u.protocol === "https:" ? https : http;

      const req = lib.request(
        {
          method: "GET",
          hostname: u.hostname,
          port: u.port ? Number(u.port) : undefined,
          path: `${u.pathname}${u.search}`,
          headers,
        },
        (res) => {
          const status = Number(res.statusCode || 0);
          const loc = res.headers?.location;

          if (status >= 300 && status < 400 && loc && maxRedirects > 0) {
            res.resume();
            const next = new URL(String(loc), urlStr).toString();
            fetchHtmlOnce(next, headers, maxRedirects - 1).then(resolve).catch(reject);
            return;
          }

          if (status < 200 || status >= 300) {
            res.resume();
            reject(new Error(`Retailer fetch failed: ${status}`));
            return;
          }

          let stream = res;
          const enc = String(res.headers?.["content-encoding"] || "").toLowerCase();
          try {
            if (enc.includes("gzip")) stream = res.pipe(zlib.createGunzip());
            else if (enc.includes("deflate")) stream = res.pipe(zlib.createInflate());
            else if (enc.includes("br") && typeof zlib.createBrotliDecompress === "function") {
              stream = res.pipe(zlib.createBrotliDecompress());
            }
          } catch {
            stream = res;
          }

          let data = "";
          stream.setEncoding("utf8");

          stream.on("data", (chunk) => {
            if (resolved) return;
            data += String(chunk || "");
            // Protect server memory: cap HTML size.
            if (data.length > 6_000_000) {
              resolved = true;
              req.destroy();
              reject(new Error("Retailer response too large"));
            }
          });

          stream.on("end", () => {
            if (resolved) return;
            resolved = true;
            resolve(data);
          });

          stream.on("error", (e) => {
            if (resolved) return;
            resolved = true;
            reject(e);
          });
        }
      );

      req.on("error", (e) => {
        if (resolved) return;
        resolved = true;
        reject(e);
      });

      req.end();
    } catch (e) {
      if (resolved) return;
      resolved = true;
      reject(e);
    }
  });
}

async function fetchHtml(url, maxRedirects = 3) {
  const target = String(url || "").trim();
  if (!target) throw new Error("Missing retailer URL");

  const profiles = [retailerHeadersDesktop(), retailerHeadersMobile(), retailerHeadersMinimal()];

  let lastErr = null;
  for (const headers of profiles) {
    try {
      const html = await fetchHtmlOnce(target, headers, maxRedirects);
      if (looksBlockedRetailerHtml(html)) throw new Error("Retailer returned blocked/consent HTML");
      return html;
    } catch (e) {
      lastErr = e;
    }
  }

  throw lastErr || new Error("Retailer fetch failed");
}


function cleanVariantValue(raw) {
  let s = compactSpaces(safeDecodeJsonString(raw));
  if (!s) return "";

  // Remove common trailing marketing tokens.
  s = s.replace(/\bNew\b\s*$/i, "").trim();
  s = s.replace(/\b(online only|limited edition|exclusive)\b\s*$/i, "").trim();
  return s;
}

function extractSephoraColorVariantsFromEmbeddedJson(html) {
  const s = String(html || "");
  if (!s) return [];

  const out = [];
  const seen = new Set();

  const push = (valueRaw, descRaw) => {
    const value = cleanVariantValue(valueRaw);
    const desc = compactSpaces(safeDecodeJsonString(descRaw));
    const vLow = value.toLowerCase();
    if (!value) return;

    // Filter out sizes and other non-color variations.
    if (/(\boz\b|\bml\b|\bg\b|standard size|mini size|travel size)/i.test(value)) return;
    if (value.length > 140) return;

    const key = `${vLow}::${String(desc || "").toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);

    out.push({ value, desc: desc || undefined });
  };

  const walk = (node, depth = 0) => {
    if (!node || depth > 40) return;
    if (Array.isArray(node)) {
      for (const it of node) walk(it, depth + 1);
      return;
    }
    if (typeof node !== "object") return;

    const vt =
      node.variationType ??
      node.variation_type ??
      node.variation_type_name ??
      node.variationTypeName ??
      node.variationTypeDisplayName;

    const vd =
      node.variationDesc ??
      node.variation_desc ??
      node.variationDescription ??
      node.variation_description ??
      node.colorDescription ??
      node.shadeDescription;

    const vv =
      node.variationValue ??
      node.variation_value ??
      node.variationName ??
      node.variation_name ??
      node.variationValueName ??
      node.colorName ??
      node.colourName ??
      node.shadeName ??
      node.skuSwatchName ??
      node.swatchName;

    const vtLow = String(vt || "").toLowerCase();
    const isColorType = /(color|colour|shade)/i.test(vtLow);

    const hasSku =
      node.skuId ||
      node.sku_id ||
      node.skuID ||
      node.sku ||
      node.skuType ||
      node.sku_type;

    if (vv && (isColorType || (!vt && hasSku))) {
      push(vv, vd);
    }

    for (const k of Object.keys(node)) {
      walk(node[k], depth + 1);
    }
  };

  const tryParseJson = (jsonText) => {
    const t = String(jsonText || "").trim();
    if (!t) return;
    try {
      const parsed = JSON.parse(t);
      walk(parsed, 0);
    } catch {
      // ignore
    }
  };

  // Next.js payload (common on Sephora)
  const mNext = /<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i.exec(s);
  if (mNext?.[1]) tryParseJson(mNext[1]);

  // Some pages embed a preloaded state object
  const mPre = /__PRELOADED_STATE__\s*=\s*({[\s\S]*?})\s*;/.exec(s);
  if (mPre?.[1]) tryParseJson(mPre[1]);

  return out;
}


function extractSephoraDisplayedColorFromHtml(html) {
  const s = String(html || "");
  if (!s) return "";

  const markers = ["Color:", "Shade:", "Colour:"];
  for (const marker of markers) {
    const idx = s.toLowerCase().indexOf(marker.toLowerCase());
    if (idx < 0) continue;

    // Take a small window after the marker, strip tags, then parse the value.
    const window = s.slice(idx, idx + 1600);
    const plain = compactSpaces(window.replace(/<[^>]*>/g, " "));

    // Example plain text: "Color: Whiskey - rich brown matte Size 0.04 oz ..."
    const escaped = marker.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
    const re = new RegExp(escaped + "\\s*([^\\n\\r]{1,220})", "i");
    const m = re.exec(plain);
    if (!m || !m[1]) continue;

    let val = compactSpaces(m[1]);
    // Stop at common next-field labels.
    val = val.split(/\bSize\b|\bFinish\b|\bStandard size\b|\bMini size\b|\bTravel size\b|\bFormulation\b|\bCoverage\b|\bShipping\b|\bSign in\b/i)[0].trim();
    val = val.replace(/\s*\|.*$/g, "").trim();

    if (val && val.length <= 180) return val;
  }

  return "";
}

function extractSephoraColorVariantsFromHtml(html) {
  const s = String(html || "");
  if (!s) return [];

  // 1) Try embedded JSON payloads first
  const fromJson = extractSephoraColorVariantsFromEmbeddedJson(s);

  const out = Array.isArray(fromJson) ? [...fromJson] : [];
  const seen = new Set(out.map((x) => `${String(x?.value || "").toLowerCase()}::${String(x?.desc || "").toLowerCase()}`));

  const push = (valueRaw, descRaw) => {
    const value = cleanVariantValue(valueRaw);
    const desc = compactSpaces(safeDecodeJsonString(descRaw));
    const vLow = value.toLowerCase();
    if (!value) return;

    // Filter out sizes and other non-color variations.
    if (/(\boz\b|\bml\b|\bg\b|standard size|mini size|travel size)/i.test(value)) return;
    if (value.length > 140) return;

    const key = `${vLow}::${String(desc || "").toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);

    out.push({ value, desc: desc || undefined });
  };

  // If JSON already gave us a healthy list, stop here.
  if (out.length >= 6) return out;

  // 2) Extract from aria-label/title attributes (often used on swatches)
  const reAria = /aria-label\s*=\s*"([^"]*(?:Color|Shade)[^"]*)"/gi;
  for (const m of s.matchAll(reAria)) {
    const label = compactSpaces(String(m?.[1] || ""));
    const m2 = /(?:color|shade)\s*:?\s*(.+)/i.exec(label);
    if (!m2?.[1]) continue;
    let val = String(m2[1] || "");
    // Trim common trailing tokens.
    val = val.replace(/\bNew\b\s*$/i, "").trim();
    val = val.replace(/\b(Size|Standard size|Mini size)\b.*$/i, "").trim();
    push(val, "");
  }

  const reTitle = /title\s*=\s*"([^"]*(?:Color|Shade)[^"]*)"/gi;
  for (const m of s.matchAll(reTitle)) {
    const label = compactSpaces(String(m?.[1] || ""));
    const m2 = /(?:color|shade)\s*:?\s*(.+)/i.exec(label);
    if (!m2?.[1]) continue;
    let val = String(m2[1] || "");
    val = val.replace(/\bNew\b\s*$/i, "").trim();
    val = val.replace(/\b(Size|Standard size|Mini size)\b.*$/i, "").trim();
    push(val, "");
  }

  // 3) Scrape common embedded sku blocks (unescaped)
  const reColorBlock = /"variationType"\s*:\s*"(?:Color|Shade|Colour)"[\s\S]{0,3000}?"variationValue"\s*:\s*"([^"]+)"(?:[\s\S]{0,1600}?"variationDesc"\s*:\s*"([^"]+)")?/g;
  for (const m of s.matchAll(reColorBlock)) {
    push(m?.[1], m?.[2]);
  }

  // 4) Scrape escaped JSON blobs (e.g., in attributes)
  const reColorBlockEsc = /\"variationType\"\s*:\s*\"(?:Color|Shade|Colour)\"[\s\S]{0,3000}?\"variationValue\"\s*:\s*\"([^\"]+)\"(?:[\s\S]{0,1600}?\"variationDesc\"\s*:\s*\"([^\"]+)\")?/g;
  for (const m of s.matchAll(reColorBlockEsc)) {
    push(m?.[1], m?.[2]);
  }

  // 5) Fallback: grab any sku blocks that include variationValue/variationDesc.
  if (out.length < 2) {
    const reSku = /"skuId"\s*:\s*"?(\d+)"?[\s\S]{0,2000}?"variationValue"\s*:\s*"([^"]+)"(?:[\s\S]{0,1200}?"variationDesc"\s*:\s*"([^"]+)")?/g;
    for (const m of s.matchAll(reSku)) {
      push(m?.[2], m?.[3]);
    }

    const reSkuEsc = /\"skuId\"\s*:\s*\"?(\d+)\"?[\s\S]{0,2000}?\"variationValue\"\s*:\s*\"([^\"]+)\"(?:[\s\S]{0,1200}?\"variationDesc\"\s*:\s*\"([^\"]+)\")?/g;
    for (const m of s.matchAll(reSkuEsc)) {
      push(m?.[2], m?.[3]);
    }
  }

  // 6) Last-resort fallback: capture the currently selected Color/Shade label from the page.
  // Some Sephora pages don’t embed full variant lists in the initial HTML, but they do render
  // the selected color as visible text (e.g., "Color: Fenty Glow - shimmering rose nude").
  if (out.length < 1) {
    const displayed = extractSephoraDisplayedColorFromHtml(s);
    if (displayed) push(displayed, "");
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
      ? ["warm", "gold", "golden", "yellow", "peach", "apricot", "olive", "bronze", "caramel", "ginger", "honey", "melon", "terracotta", "brick", "chili", "coral"]
      : dir === "cool"
        ? ["cool", "pink", "rosy", "rose", "berry", "plum", "blue", "red", "pansy", "heather", "ballerina", "mauve", "cranberry"]
        : ["neutral", "beige", "balanced", "natural", "nude", "taupe", "fig"];
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



// Curated fallbacks (real shade/color names) used if Sephora blocks scraping or the page structure changes.
// We keep this small on purpose; the primary path is live extraction + caching.
const STATIC_SEPHORA_SHADE_FALLBACK = {
  [normalizeRetailerUrl('https://www.sephora.com/ca/en/product/cheek-pop-P384996')]: [
    { value: 'Pansy Pop' },
    { value: 'Peach Pop' },
    { value: 'Melon Pop' },
    { value: 'Ballerina Pop' },
    { value: 'Heather Pop' },
    { value: 'Ginger Pop' },
    { value: 'Blush Pop' },
    { value: 'Nude Pop' },
    { value: 'Black Honey Pop' },
    { value: 'Fig Pop' },
    { value: 'Pink Honey Pop' },
    { value: 'Cola Pop' },
    { value: 'Pink Pop' },
  ],
  [normalizeRetailerUrl('https://www.sephora.com/ca/en/product/rare-beauty-by-selena-gomez-soft-pinch-liquid-blush-P97989778')]: [
    { value: 'Hope', desc: 'nude mauve (dewy)' },
    { value: 'Joy', desc: 'muted peach (dewy)' },
    { value: 'Happy', desc: 'cool pink (dewy)' },
    { value: 'Encourage', desc: 'soft neutral pink (dewy)' },
    { value: 'Believe', desc: 'true mauve (dewy)' },
    { value: 'Virtue', desc: 'beige peach (dewy)' },
    { value: 'Grateful', desc: 'true red (dewy)' },
    { value: 'Faith', desc: 'deep berry (matte)' },
    { value: 'Bliss', desc: 'nude pink (matte)' },
    { value: 'Love', desc: 'terracotta (matte)' },
    { value: 'Grace', desc: 'bright rose mauve (matte)' },
  ],
  [normalizeRetailerUrl('https://www.sephora.com/ca/en/product/backstage-face-body-foundation-P432500')]: [
    { value: '0W', desc: 'WARM - Very fair skin with golden undertones' },
    { value: '0.5N', desc: 'NEUTRAL - Very fair skin with neutral undertones' },
    { value: '1C', desc: 'COOL - Fair skin with cool undertones' },
    { value: '1N', desc: 'NEUTRAL - Fair skin with neutral undertones' },
    { value: '1W', desc: 'WARM - Fair skin with golden undertones' },
    { value: '2N', desc: 'NEUTRAL - Light skin with neutral undertones' },
    { value: '2W', desc: 'WARM - Light skin with golden undertones' },
    { value: '3N', desc: 'NEUTRAL - Light to medium skin with neutral undertones' },
    { value: '3W', desc: 'WARM - Light to medium skin with golden undertones' },
    { value: '4WP', desc: 'WARM PEACH - Medium skin with peach undertones' },
  ],
  [normalizeRetailerUrl('https://www.sephora.com/product/luminous-silk-natural-glow-blurring-liquid-foundation-with-24-hour-wear-P519887')]: [
    { value: '4.5', desc: 'light, neutral peach' },
    { value: '5', desc: 'light, neutral pink' },
    { value: '5.1', desc: 'light, cool pink' },
    { value: '6', desc: 'light to medium, warm peach' },
    { value: '6.25', desc: 'medium, warm peach' },
    { value: '6.5', desc: 'medium, neutral' },
    { value: '7', desc: 'medium to tan with a peach undertone' },
    { value: '7.5', desc: 'tan with a peach undertone' },
  ],
};


async function getSephoraShadesForUrl(url) {
  const uRaw = String(url || "").trim();
  if (!uRaw) return [];

  const u = normalizeRetailerUrl(uRaw);

  const cached = shadeCache.get(u);
  const now = Date.now();
  if (cached && now - (cached.fetchedAt || 0) < SHADE_CACHE_TTL_MS) {
    return Array.isArray(cached.shades) ? cached.shades : [];
  }

  let shades = [];

  // (1) Fast path: fetch product HTML directly and extract variants
  try {
    const html = await fetchHtml(u);
    shades = extractSephoraColorVariantsFromHtml(html);
  } catch {
    shades = [];
  }

  // (2) Reliability fallback: Apify actor (optional)
  // This is the only approach that tends to work consistently across Sephora's anti-bot changes.
  if ((!Array.isArray(shades) || shades.length < APIFY_MIN_SHADES_THRESHOLD) && APIFY_TOKEN && isAllowedRetailerUrl(u)) {
    try {
      const apifyShades = await getSephoraShadesViaApify(u);
      const merged = [];
      const seen = new Set();
      const add = (sh) => {
        const v = String(sh?.value || "").trim();
        const d = String(sh?.desc || "").trim();
        if (!v) return;
        const key = `${v.toLowerCase()}::${d.toLowerCase()}`;
        if (seen.has(key)) return;
        seen.add(key);
        merged.push({ value: v, desc: d || undefined });
      };
      (Array.isArray(shades) ? shades : []).forEach(add);
      (Array.isArray(apifyShades) ? apifyShades : []).forEach(add);
      shades = merged;
    } catch (e) {
      if (APIFY_DEBUG) console.warn("Apify shades fetch failed:", String(e?.message || e).slice(0, 500));
    }
  }

  // (3) Curated static fallbacks (kept small; only used if live extraction fails)
  const fallback = STATIC_SEPHORA_SHADE_FALLBACK?.[u];
  if (Array.isArray(fallback) && fallback.length) {
    const merged = [];
    const seen = new Set();
    const add = (sh) => {
      const v = String(sh?.value || "").trim();
      const d = String(sh?.desc || "").trim();
      if (!v) return;
      const key = `${v.toLowerCase()}::${d.toLowerCase()}`;
      if (seen.has(key)) return;
      seen.add(key);
      merged.push({ value: v, desc: d || undefined });
    };
    (Array.isArray(shades) ? shades : []).forEach(add);
    fallback.forEach(add);
    shades = merged;
  }

  shadeCache.set(u, { fetchedAt: now, shades });
  return shades;
}

// Product lists (expanded; picked deterministically per scan)
// We keep a larger pool so thousands of faces can yield varied recommendations,
// while always attaching *real* retailer color names.
const FOUNDATION_POOL = [
  "Estée Lauder Double Wear Stay-in-Place Foundation",
  "NARS Light Reflecting Foundation",
  "Fenty Beauty Pro Filt'r Soft Matte Longwear Foundation",
  "Dior Backstage Face & Body Foundation",
  "Giorgio Armani Luminous Silk Foundation",
  "Make Up For Ever HD Skin Foundation",
  "Charlotte Tilbury Beautiful Skin Foundation",
  "Rare Beauty Liquid Touch Weightless Foundation",
  "Too Faced Born This Way Undetectable Medium-To-Full Coverage Foundation",
  "HUDA BEAUTY Easy Blur Natural Airbrush Foundation with Niacinamide",
];

const CHEEKS_POOL = [
  "Clinique Cheek Pop Blush",
  "Rare Beauty Soft Pinch Liquid Blush",
  "NARS Talc-Free Powder Blush",
  "Fenty Beauty Cheeks Out Freestyle Cream Blush",
  "MAKEUP BY MARIO Soft Pop Cream Blush Stick",
  "MILK MAKEUP Lip + Cheek Non-Comedogenic Cream Blush Stick",
  "Benefit Cosmetics Silky-Soft Powder Blush",
  "Hourglass Ambient Lighting Blush Collection",
  "DIOR Rosy Glow Powder Blush",
  "PAT McGRATH LABS Skin Fetish: Divine Powder Blush",
];

const EYES_POOL = [
  "Urban Decay 24/7 Glide-On Waterproof Eyeliner Pencil",
  "Charlotte Tilbury Rock 'N' Kohl Long-Lasting Eyeliner Pencil",
  "MAKE UP FOR EVER Artist Color Pencil Longwear Eyeliner",
  "Bobbi Brown Long-Wear Waterproof Cream Eyeshadow Stick",
  "Laura Mercier Caviar Stick Cream Eyeshadow",
];

const LIPS_POOL = [
  "MAC Cosmetics MACximal Silky Matte Lipstick",
  "Charlotte Tilbury Matte Revolution Lipstick",
  "Fenty Beauty Gloss Bomb Universal Lip Luminizer",
  "Rare Beauty by Selena Gomez Kind Words Matte Lipstick",
];

const BUY_RECS_SERVER = {
  cool: { foundation: FOUNDATION_POOL, cheeks: CHEEKS_POOL, eyes: EYES_POOL, lips: LIPS_POOL },
  "neutral-cool": { foundation: FOUNDATION_POOL, cheeks: CHEEKS_POOL, eyes: EYES_POOL, lips: LIPS_POOL },
  neutral: { foundation: FOUNDATION_POOL, cheeks: CHEEKS_POOL, eyes: EYES_POOL, lips: LIPS_POOL },
  "neutral-warm": { foundation: FOUNDATION_POOL, cheeks: CHEEKS_POOL, eyes: EYES_POOL, lips: LIPS_POOL },
  warm: { foundation: FOUNDATION_POOL, cheeks: CHEEKS_POOL, eyes: EYES_POOL, lips: LIPS_POOL },
};

// Sephora product URLs (preferred when known). If missing, we resolve via Sephora keyword search.
// NOTE: Some products may resolve to US pages; those still provide real shade names.
const PRODUCT_URLS = {
  // Foundation
  "Estée Lauder Double Wear Stay-in-Place Foundation": "https://www.sephora.com/ca/en/product/double-wear-stay-in-place-makeup-P378284",
  "NARS Light Reflecting Foundation": "https://www.sephora.com/ca/en/product/nars-light-reflecting-advance-skincare-foundation-P479338",
  "Fenty Beauty Pro Filt'r Soft Matte Longwear Foundation": "https://www.sephora.com/ca/en/product/pro-filtr-soft-matte-longwear-foundation-P87985432",
  "Dior Backstage Face & Body Foundation": "https://www.sephora.com/ca/en/product/backstage-face-body-foundation-P432500",
  "Giorgio Armani Luminous Silk Foundation": "https://www.sephora.com/product/luminous-silk-natural-glow-blurring-liquid-foundation-with-24-hour-wear-P519887",
  "Make Up For Ever HD Skin Foundation": "https://www.sephora.com/ca/en/product/make-up-for-ever-hd-skin-foundation-P479712",
  "Charlotte Tilbury Beautiful Skin Foundation": "https://www.sephora.com/ca/en/product/charlotte-tilbury-beautiful-skin-medium-coverage-liquid-foundation-with-hyaluronic-acid-P480286",
  "Rare Beauty Liquid Touch Weightless Foundation": "https://www.sephora.com/ca/en/product/rare-beauty-by-selena-gomez-liquid-touch-weightless-foundation-P49848448",
  "Too Faced Born This Way Undetectable Medium-To-Full Coverage Foundation": "https://www.sephora.com/ca/en/product/too-faced-born-this-way-natural-finish-foundation-P517843",
  "HUDA BEAUTY Easy Blur Natural Airbrush Foundation with Niacinamide": "https://www.sephora.com/ca/en/product/huda-beauty-easy-blur-smoothing-foundation-P512640",

  // Cheeks
  "Clinique Cheek Pop Blush": "https://www.sephora.com/ca/en/product/cheek-pop-P384996",
  "Rare Beauty Soft Pinch Liquid Blush": "https://www.sephora.com/ca/en/product/rare-beauty-by-selena-gomez-soft-pinch-liquid-blush-P97989778",
  "NARS Talc-Free Powder Blush": "https://www.sephora.com/ca/en/product/blush-P2855",
  "Fenty Beauty Cheeks Out Freestyle Cream Blush": "https://www.sephora.com/ca/en/product/fenty-beauty-rihanna-cheeks-out-freestyle-cream-blush-P19700127",
  "MAKEUP BY MARIO Soft Pop Cream Blush Stick": "https://www.sephora.com/ca/en/product/soft-pop-blush-stick-P516566",
  "MILK MAKEUP Lip + Cheek Non-Comedogenic Cream Blush Stick": "https://www.sephora.com/ca/en/product/milk-lip-cheek-cream-blush-stick-P437097",
  "Benefit Cosmetics Silky-Soft Powder Blush": "https://www.sephora.com/ca/en/product/box-o-powder-blush-P500253",
  "Hourglass Ambient Lighting Blush Collection": "https://www.sephora.com/ca/en/product/ambient-lighting-blush-collection-P384963",
  "DIOR Rosy Glow Powder Blush": "https://www.sephora.com/ca/en/product/dior-rosy-glow-blush-P454762",
  "PAT McGRATH LABS Skin Fetish: Divine Powder Blush": "https://www.sephora.com/ca/en/product/pat-mcgrath-labs-skin-fetish-divine-powder-blush-P472489",

  // Eyes
  "Urban Decay 24/7 Glide-On Waterproof Eyeliner Pencil": "https://www.sephora.com/ca/en/product/24-7-glide-on-eye-pencil-P133707",
  "Charlotte Tilbury Rock 'N' Kohl Long-Lasting Eyeliner Pencil": "https://www.sephora.com/ca/en/product/rock-n-kohl-long-lasting-eye-pencils-P516579",
  "MAKE UP FOR EVER Artist Color Pencil Longwear Eyeliner": "https://www.sephora.com/ca/en/product/make-up-for-ever-artist-color-pencil-longwear-eyeliner-P511574",
  "Bobbi Brown Long-Wear Waterproof Cream Eyeshadow Stick": "https://www.sephora.com/ca/en/product/long-wear-waterproof-cream-eyeshadow-stick-P378145",
  "Laura Mercier Caviar Stick Cream Eyeshadow": "https://www.sephora.com/ca/en/product/laura-mercier-caviar-shimmer-eyeshadow-stick-reform-P512549",

  // Lips
  "MAC Cosmetics MACximal Silky Matte Lipstick": "https://www.sephora.com/ca/en/product/P510799",
  "Charlotte Tilbury Matte Revolution Lipstick": "https://www.sephora.com/ca/en/product/matte-revolution-lipstick-P433530",
  "Fenty Beauty Gloss Bomb Universal Lip Luminizer": "https://www.sephora.com/ca/en/product/gloss-bomb-universal-lip-luminizer-P67988453",
  "Rare Beauty by Selena Gomez Kind Words Matte Lipstick": "https://www.sephora.com/ca/en/product/kind-words-matte-lipstick-P500637",
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

function hash32FNV1a(str) {
  const s = String(str || "");
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function pickStable(list, count, seed) {
  const arr = Array.isArray(list) ? list : [];
  const seen = new Set();
  const uniq = [];
  for (const x of arr) {
    const v = String(x || "").trim();
    if (!v) continue;
    const k = v.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    uniq.push(v);
  }
  const s = String(seed || "");
  uniq.sort((a, b) => {
    const ha = hash32FNV1a(`${s}|${a}`);
    const hb = hash32FNV1a(`${s}|${b}`);
    if (ha !== hb) return ha < hb ? -1 : 1;
    return a.localeCompare(b);
  });
  const n = Number.isFinite(Number(count)) ? Math.max(0, Math.floor(Number(count))) : 0;
  return uniq.slice(0, n);
}

const PRODUCT_URL_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const productUrlCache = new Map(); // nameLower -> { url: string, fetchedAt: number }

async function resolveSephoraProductUrlByName(name) {
  const key = String(name || "").trim();
  if (!key) return "";
  const kLow = key.toLowerCase();

  const cached = productUrlCache.get(kLow);
  const now = Date.now();
  if (cached?.url && now - (cached.fetchedAt || 0) < PRODUCT_URL_CACHE_TTL_MS) {
    return String(cached.url || "");
  }

  // Try keyword search pages (works without needing Sephora internal APIs).
  // CA-EN is preferred because the app is Canada-first, but the US site can
  // carry SKUs that aren't listed on Sephora.ca.
  const searchUrls = [
    `https://www.sephora.com/ca/en/search?keyword=${encodeURIComponent(key)}`,
    `https://www.sephora.com/search?keyword=${encodeURIComponent(key)}`,
  ];

  let html = "";
  for (const u of searchUrls) {
    try {
      html = await fetchHtml(u);
    } catch {
      html = "";
    }
    if (html) break;
  }

  const candidates = [];
  const push = (path) => {
    const p = String(path || "").trim();
    if (!p) return;
    if (!/\b-P\d+\b/i.test(p)) return;
    candidates.push(p);
  };

  if (html) {
    // Common: href="/ca/en/product/...-P123456"
    const reHref = /href\s*=\s*"(\/(?:ca\/en\/)?product\/[^"?#]+-P\d+[^"?#]*)"/gi;
    for (const m of html.matchAll(reHref)) push(m?.[1]);

    // Some responses include JSON with targetUrl / productUrl.
    const reUrl = /"(?:targetUrl|productUrl|url)"\s*:\s*"(\/(?:ca\/en\/)?product\/[^"?#]+-P\d+[^"?#]*)"/gi;
    for (const m of html.matchAll(reUrl)) push(m?.[1]);

    // Last resort: any /product/...-P123456 path.
    const reAny = /(\/(?:ca\/en\/)?product\/[^\s"'#]+-P\d+[^\s"'#]*)/gi;
    for (const m of html.matchAll(reAny)) push(m?.[1]);
  }

  // Pick the first unique candidate.
  const seen = new Set();
  const first = candidates.find((p) => {
    const u = normalizeRetailerUrl(new URL(p, "https://www.sephora.com").toString());
    if (seen.has(u)) return false;
    seen.add(u);
    return true;
  });

  const resolved = first ? normalizeRetailerUrl(new URL(first, "https://www.sephora.com").toString()) : "";
  if (resolved) productUrlCache.set(kLow, { url: resolved, fetchedAt: now });
  return resolved;
}


async function buildProductLines({ products, category, undertone, season, toneNumber, toneDepth }) {
  const out = [];
  const list = Array.isArray(products) ? products : [];

  const desiredCount = 1;
  const seed = `${String(category || "").toLowerCase()}|${undertone}|${season}|${String(toneNumber ?? "")}|${String(toneDepth ?? "")}`;

  // Try more candidates so we can avoid returning "(unavailable)" whenever possible.
  const candidates = pickStable(list, Math.min(list.length, desiredCount * 6), seed);

  const tried = new Set();
  const chosen = [];
  const fallbacks = [];

  for (const name of candidates) {
    const n = String(name || "").trim();
    if (!n || tried.has(n)) continue;
    tried.add(n);

    let url = PRODUCT_URLS[n] || "";
    if (!url) {
      try {
        url = await resolveSephoraProductUrlByName(n);
      } catch {
        url = "";
      }
    }

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

    if (label) {
      chosen.push(`- ${n} — Color: ${label}`);
    } else {
      fallbacks.push(`- ${n} — Color: (unavailable)`);
    }

    if (chosen.length >= desiredCount) break;
  }

  // If we couldn't find enough with colors, fill remaining with unavailable ones.
  while (chosen.length < desiredCount && fallbacks.length) {
    chosen.push(fallbacks.shift());
  }

  return chosen;
}



async function callOpenAIForSephoraRecs({ undertone, season, toneDepth, toneNumber }) {
  if (!OPENAI_API_KEY) {
    throw new Error("Missing OPENAI_API_KEY on server");
  }

  const recItem = {
    type: "object",
    additionalProperties: false,
    properties: {
      product_name: { type: "string" },
      product_url: { type: "string" },
      color_name: { type: "string" },
    },
    required: ["product_name", "product_url", "color_name"],
  };

  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      foundation: recItem,
      cheeks: recItem,
      eyes: recItem,
      lips: recItem,
    },
    required: ["foundation", "cheeks", "eyes", "lips"],
  };

  const undertoneTxt = String(undertone || "neutral");
  const seasonTxt = String(season || "summer");
  const depthTxt = String(toneDepth || "").trim();
  const numberTxt = typeof toneNumber === "number" && Number.isFinite(toneNumber) ? String(toneNumber) : String(toneNumber || "").trim();

  const systemPrompt =
    "You are a professional makeup artist assistant." +
    " Use ONLY Sephora (sephora.com) to choose products and their exact color/variant names." +
    " You must choose products ONLY from the Supported Sephora products list provided in the user message." +
    " You MUST use web search to verify that each recommended color/variant exists for that specific product on Sephora." +
    " Choose exactly ONE recommendation for each category: foundation, cheeks, eyes, lips." +
    " For each recommendation, provide:" +
    " (1) product_name as listed on Sephora, (2) product_url to the Sephora product page, (3) color_name EXACTLY as shown in Sephora's Color selector (include numbers/codes and short descriptors if present)." +
    " IMPORTANT: return a real, verifiable color_name for ALL 4 categories." +
    " If your first product pick in a category does not have a discoverable color selector or you cannot find an exact color_name, pick a different product from the supported list and try again." +
    " Only set color_name to '(unavailable)' if you tried at least TWO different products for that category and still cannot find a verifiable color_name. Never guess." +
    " Prefer products that clearly have many color options on Sephora (foundation shades, blush shades, eyeliner/eyeshadow stick shades, lipstick/gloss shades)." +
    " Do not include any extra keys. Output JSON that matches the provided schema.";

  const formatSupportedList = (title, names) => {
    const arr = Array.isArray(names) ? names : [];
    const lines = [];
    lines.push(`${title}:`);
    for (const raw of arr) {
      const name = String(raw || "").trim();
      if (!name) continue;
      const url = String(PRODUCT_URLS?.[name] || "").trim();
      if (url) lines.push(`- ${name} — ${url}`);
      else lines.push(`- ${name}`);
    }
    return lines.join("\n");
  };

  const supportedProductsText =
    "\nSupported Sephora products (choose ONLY from these; use the listed URL as product_url):\n" +
    `${formatSupportedList("Foundation", FOUNDATION_POOL)}\n` +
    `${formatSupportedList("Cheeks", CHEEKS_POOL)}\n` +
    `${formatSupportedList("Eyes", EYES_POOL)}\n` +
    `${formatSupportedList("Lips", LIPS_POOL)}\n`;

  const userPrompt =
    `Person attributes:\n` +
    `- undertone: ${undertoneTxt}\n` +
    `- season: ${seasonTxt}\n` +
    (depthTxt ? `- depth: ${depthTxt}\n` : "") +
    (numberTxt ? `- tone_number (approx 1-10): ${numberTxt}\n` : "") +
    "\nTask:\n" +
    "1) Using Sephora only, choose ONE good product per category (foundation, cheeks, eyes, lips).\n" +
    "2) For each chosen product, look up its Sephora color/variant list and choose the best matching variant name for the person above.\n" +
    "3) Return JSON only." + supportedProductsText;

  const payload = {
    model: OPENAI_RECS_MODEL || "gpt-5-mini",
    temperature: 0,
    reasoning: { effort: "low" },
    tools: [
      {
        type: "web_search",
        filters: { allowed_domains: ["sephora.com"] },
        user_location: { type: "approximate", country: "CA", timezone: "America/Vancouver" },
      },
    ],
    tool_choice: "auto",
    max_tool_calls: OPENAI_RECS_MAX_TOOL_CALLS,
    max_output_tokens: OPENAI_RECS_MAX_OUTPUT_TOKENS,
    input: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    text: {
      format: {
        type: "json_schema",
        name: "undertone_sephora_recommendations",
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

  const { text: outText, refusal } = extractOutputText(data);
  if (refusal) throw new Error(refusal);
  if (!outText) throw new Error("OpenAI returned no text output");

  try {
    return JSON.parse(outText);
  } catch {
    throw new Error("OpenAI returned non-JSON output");
  }
}

async function callOpenAIForSephoraCategoryRepair({
  categoryKey,
  categoryTitle,
  undertone,
  season,
  toneDepth,
  toneNumber,
  preferredName,
  preferredUrl,
}) {
  if (!OPENAI_API_KEY) {
    throw new Error("Missing OPENAI_API_KEY on server");
  }

  const pools = {
    foundation: FOUNDATION_POOL,
    cheeks: CHEEKS_POOL,
    eyes: EYES_POOL,
    lips: LIPS_POOL,
  };

  const pool = Array.isArray(pools?.[categoryKey]) ? pools[categoryKey] : [];
  const title = String(categoryTitle || categoryKey || "").trim() || "Category";

  const recItem = {
    type: "object",
    additionalProperties: false,
    properties: {
      product_name: { type: "string" },
      product_url: { type: "string" },
      color_name: { type: "string" },
    },
    required: ["product_name", "product_url", "color_name"],
  };

  const undertoneTxt = String(undertone || "neutral");
  const seasonTxt = String(season || "summer");
  const depthTxt = String(toneDepth || "").trim();
  const numberTxt =
    typeof toneNumber === "number" && Number.isFinite(toneNumber)
      ? String(toneNumber)
      : String(toneNumber || "").trim();

  const formatSupportedList = (names) => {
    const arr = Array.isArray(names) ? names : [];
    const lines = [];
    for (const raw of arr) {
      const name = String(raw || "").trim();
      if (!name) continue;
      const url = String(PRODUCT_URLS?.[name] || "").trim();
      if (url) lines.push(`- ${name} — ${url}`);
      else lines.push(`- ${name}`);
    }
    return lines.join("\n");
  };

  const preferredNameTxt = String(preferredName || "").trim();
  const preferredUrlTxt = String(preferredUrl || "").trim();

  const systemPrompt =
    "You are a professional makeup artist assistant." +
    " Use ONLY Sephora (sephora.com)." +
    " You MUST use web search to verify the exact color/variant name for the product on Sephora." +
    " Do NOT guess and do NOT invent color names." +
    ` You are fixing ONLY the ${title} recommendation.` +
    " You must choose ONE product from the Supported list." +
    " Prefer the Preferred product if provided, but if you cannot find a verifiable color for it, pick another supported product." +
    " Return JSON ONLY matching the provided schema.";

  const userPrompt =
    `Person attributes:\n` +
    `- undertone: ${undertoneTxt}\n` +
    `- season: ${seasonTxt}\n` +
    (depthTxt ? `- depth: ${depthTxt}\n` : "") +
    (numberTxt ? `- tone_number (approx 1-10): ${numberTxt}\n` : "") +
    (preferredNameTxt ? `\nPreferred product: ${preferredNameTxt}\n` : "") +
    (preferredUrlTxt ? `Preferred URL: ${preferredUrlTxt}\n` : "") +
    `\nTask:\n` +
    `1) Choose ONE supported Sephora product for ${title}.\n` +
    `2) Find its EXACT Sephora color/variant name (from the Color/Shade selector) that best fits the person.\n` +
    `3) Return JSON only.\n\n` +
    `Supported Sephora products for ${title} (choose ONLY from these; use the listed URL as product_url):\n` +
    formatSupportedList(pool);

  const payload = {
    model: OPENAI_RECS_MODEL || "gpt-5-mini",
    temperature: 0,
    reasoning: { effort: "low" },
    tools: [
      {
        type: "web_search",
        filters: { allowed_domains: ["sephora.com"] },
        user_location: { type: "approximate", country: "CA", timezone: "America/Vancouver" },
      },
    ],
    tool_choice: "auto",
    max_tool_calls: OPENAI_RECS_REPAIR_MAX_TOOL_CALLS,
    max_output_tokens: OPENAI_RECS_REPAIR_MAX_OUTPUT_TOKENS,
    input: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    text: {
      format: {
        type: "json_schema",
        name: "undertone_sephora_category_repair",
        strict: true,
        schema: recItem,
      },
    },
  };

  if (OPENAI_RECS_DEBUG) {
    payload.include = ["web_search_call.action.sources"];
  }

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

  const { text: outText, refusal } = extractOutputText(data);
  if (refusal) throw new Error(refusal);
  if (!outText) throw new Error("OpenAI returned no text output");

  try {
    return JSON.parse(outText);
  } catch {
    throw new Error("OpenAI returned non-JSON output");
  }
}


async function repairMissingSephoraColorNames(recs, { undertone, season, toneDepth, toneNumber }) {
  const obj = recs && typeof recs === "object" ? recs : null;
  if (!obj) return;

  const sections = [
    { key: "foundation", title: "Foundation" },
    { key: "cheeks", title: "Cheeks" },
    { key: "eyes", title: "Eyes" },
    { key: "lips", title: "Lips" },
  ];

  for (const sec of sections) {
    const item = obj?.[sec.key];
    if (!item || typeof item !== "object") continue;

    const name = String(item?.product_name || "").trim();
    let url = String(item?.product_url || "").trim();

    // Ensure we have a valid Sephora product URL.
    if ((!url || !isAllowedRetailerUrl(url)) && name) {
      url = String(PRODUCT_URLS?.[name] || "").trim();
      if (!url) {
        try {
          url = await resolveSephoraProductUrlByName(name);
        } catch {
          url = "";
        }
      }
    }

    const color0 = String(item?.color_name || "").trim();
    let isUnavailable = !color0 || /^\(unavailable\)$/i.test(color0);

    const hasRetailerUrl = Boolean(url && isAllowedRetailerUrl(url));
    const normUrl = hasRetailerUrl ? normalizeRetailerUrl(url) : "";
    if (normUrl) item.product_url = normUrl;

    // (1) Try server-side HTML extraction (fast when it works, but can be blocked)
    if (isUnavailable && normUrl) {
      try {
        const shades = await getSephoraShadesForUrl(normUrl);
        const best = pickBestShadeForCategory({
          shades,
          category: sec.title,
          undertone,
          season,
          toneNumber,
          toneDepth,
        });
        const label = best ? shadeLabel(best) : "";
        if (label) item.color_name = label;
      } catch {
        // ignore
      }
    }

    const color1 = String(item?.color_name || "").trim();
    isUnavailable = !color1 || /^\(unavailable\)$/i.test(color1);

    // (2) Reliability: if still unavailable, do a small targeted web_search repair call.
    if (isUnavailable && OPENAI_RECS_REPAIR_ENABLED) {
      try {
        const fixed = await callOpenAIForSephoraCategoryRepair({
          categoryKey: sec.key,
          categoryTitle: sec.title,
          undertone,
          season,
          toneDepth,
          toneNumber,
          preferredName: name,
          preferredUrl: normUrl || url || "",
        });

        const f = fixed && typeof fixed === "object" ? fixed : null;
        if (f) {
          const newName = String(f.product_name || "").trim();
          const newUrl = String(f.product_url || "").trim();
          const newColor = String(f.color_name || "").trim();

          if (newName) item.product_name = newName;
          if (newUrl && isAllowedRetailerUrl(newUrl)) item.product_url = normalizeRetailerUrl(newUrl);
          if (newColor) item.color_name = newColor;
        }
      } catch (e) {
        if (OPENAI_RECS_DEBUG) {
          console.warn(`Sephora color repair failed for ${sec.title}:`, String(e?.message || e).slice(0, 500));
        }
      }
    }
  }
}

app.post("/recommend-products", authRequired, async (req, res) => {
  try {
    const undertone = normalizeUndertoneKeyServer(req?.body?.undertone);
    const season = normalizeSeasonKeyServer(req?.body?.season);
    const toneNumber = req?.body?.tone_number;
    const toneDepth = req?.body?.tone_depth;

    // Primary path: reasoning model + web_search (Sephora only)
    if (OPENAI_RECS_USE_WEB_SEARCH) {
      try {
        const recs = await callOpenAIForSephoraRecs({
          undertone,
          season,
          toneDepth,
          toneNumber,
        });

        await repairMissingSephoraColorNames(recs, { undertone, season, toneDepth, toneNumber });

        if (recs && typeof recs === "object") {
          const lines = [];
          lines.push("Recommended products:");

          const sections = [
            { title: "Foundation", key: "foundation" },
            { title: "Cheeks", key: "cheeks" },
            { title: "Eyes", key: "eyes" },
            { title: "Lips", key: "lips" },
          ];

          for (const sec of sections) {
            const item = recs?.[sec.key] || null;
            const name = String(item?.product_name || "").trim();
            const url = String(item?.product_url || "").trim();
            const color = String(item?.color_name || "").trim() || "(unavailable)";

            lines.push("");
            lines.push(`${sec.title}:`);
            if (name) {
              // Include URL so the variant name is auditable.
              const urlPart = url ? ` (Sephora: ${url})` : "";
              lines.push(`- ${name} — Color: ${color}${urlPart}`);
            } else {
              lines.push(`- (unavailable) — Color: ${color}`);
            }
          }

          return res.json({ ok: true, text: lines.join("\n"), source: "sephora_web_search" });
        }
      } catch (e) {
        console.error("recommend-products (web_search) failed:", e);
        // Fall through to legacy fallback.
      }
    }

    // Fallback path: curated product pools + best-effort shade extraction.
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

    return res.json({ ok: true, text: lines.join("\n"), source: "fallback" });
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
