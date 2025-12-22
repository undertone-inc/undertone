-- db/schema.sql
-- Minimal schema for Undertone v1 (accounts + doc storage)
-- Safe to run multiple times (idempotent)

CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  email TEXT NOT NULL,
  email_norm TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  account_name TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

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
