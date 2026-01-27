-- db/schema.sql
-- Minimal schema for Undertone v1 (accounts + doc storage)
-- Safe to run multiple times (idempotent)

CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  email TEXT NOT NULL,
  email_norm TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  account_name TEXT NOT NULL DEFAULT '',

  -- Subscription state (synced from RevenueCat)
  -- plan_tier: 'free' | 'pro'
  plan_tier TEXT NOT NULL DEFAULT 'free',
  -- plan_interval: 'month' | 'year'
  plan_interval TEXT NOT NULL DEFAULT 'month',
  -- Product identifier that granted access (e.g. 'monthly' | 'yearly')
  plan_product_id TEXT,
  -- Start of the current entitlement period (used for yearly quota enforcement)
  plan_started_at TIMESTAMPTZ,
  -- Entitlement expiration (when available)
  plan_expires_at TIMESTAMPTZ,
  -- Last time we synced plan state from RevenueCat
  rc_last_synced_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Backfill / upgrade existing tables (idempotent)
ALTER TABLE users ADD COLUMN IF NOT EXISTS plan_tier TEXT NOT NULL DEFAULT 'free';
ALTER TABLE users ADD COLUMN IF NOT EXISTS plan_interval TEXT NOT NULL DEFAULT 'month';
ALTER TABLE users ADD COLUMN IF NOT EXISTS plan_product_id TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS plan_started_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS plan_expires_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS rc_last_synced_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_users_plan_tier ON users(plan_tier);

CREATE TABLE IF NOT EXISTS user_docs (
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  doc_key TEXT NOT NULL,
  doc_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  rev INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, doc_key)
);

-- Helpful index for fetching per-user docs quickly
CREATE INDEX IF NOT EXISTS idx_user_docs_user_id ON user_docs(user_id);

-- --- Auth sessions (opaque bearer tokens) ---
-- NOTE: We store ONLY a sha256 hash of the token in the DB.
CREATE TABLE IF NOT EXISTS sessions (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);

-- --- Password reset tokens (2-step: request + consume) ---
-- In production you must deliver the reset token out-of-band (email/SMS).
CREATE TABLE IF NOT EXISTS password_resets (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_password_resets_user_id ON password_resets(user_id);
CREATE INDEX IF NOT EXISTS idx_password_resets_expires_at ON password_resets(expires_at);

-- --- Face analyses (for upload counts + optional history) ---
-- NOTE: We do NOT store the raw image bytes. Only a sha256 hash (optional)
-- and the structured analysis JSON for later reference.
CREATE TABLE IF NOT EXISTS face_analyses (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  image_sha256 TEXT,
  source TEXT,
  analysis_json JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_face_analyses_user_id_created_at
  ON face_analyses(user_id, created_at DESC);
