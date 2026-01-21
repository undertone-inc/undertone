import * as SQLite from 'expo-sqlite';
import * as SecureStore from 'expo-secure-store';

// SecureStore is great for secrets (tokens), but not for large, evolving
// datasets (Catalog / KitLog). This module stores those blobs in SQLite.

export const IO_DB_NAME = 'io.db';

// Base document keys (legacy keys used by older versions)
export const DOC_KEYS = {
  catalog: 'io_catalog_v1',
  kitlog: 'io_kitlog_v1',
  faceAnalysisHistory: 'io_face_analysis_history_v1',
  faceChatHistory: 'io_face_chat_history_v1',
} as const;

type KvRow = { v: string };

let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;

async function getDb(): Promise<SQLite.SQLiteDatabase> {
  if (!dbPromise) {
    dbPromise = (async () => {
      const db = await SQLite.openDatabaseAsync(IO_DB_NAME);
      // WAL helps with concurrency + performance on mobile.
      await db.execAsync(`
        PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS io_kv (
          k TEXT PRIMARY KEY NOT NULL,
          v TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
      `);
      return db;
    })();
  }
  return dbPromise;
}

export function makeScopedKey(baseKey: string, scope?: string | number | null): string {
  const s = String(scope ?? '').trim();
  if (!s) return baseKey;
  return `${baseKey}::${s}`;
}

export async function getString(key: string): Promise<string | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<KvRow>('SELECT v FROM io_kv WHERE k = ?', key);
  return row?.v ?? null;
}

export async function setString(key: string, value: string): Promise<void> {
  const db = await getDb();
  const now = Date.now();

  // Upsert.
  await db.runAsync(
    'INSERT INTO io_kv (k, v, updated_at) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at',
    key,
    value,
    now,
  );
}

export async function deleteKey(key: string): Promise<void> {
  const db = await getDb();
  await db.runAsync('DELETE FROM io_kv WHERE k = ?', key);
}

export async function getJson<T = any>(key: string): Promise<T | null> {
  const raw = await getString(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function setJson(key: string, value: any): Promise<void> {
  await setString(key, JSON.stringify(value));
}

async function migrateOneKeyFromSecureStore(baseKey: string, scope?: string | number | null): Promise<void> {
  const targetKey = makeScopedKey(baseKey, scope);

  // If SQLite already has the doc, only clean up legacy SecureStore.
  const existing = await getString(targetKey);
  if (existing) {
    try {
      await SecureStore.deleteItemAsync(baseKey);
    } catch {}
    try {
      await SecureStore.deleteItemAsync(targetKey);
    } catch {}
    return;
  }

  let raw: string | null = null;
  try {
    // Prefer any scoped value first.
    raw = await SecureStore.getItemAsync(targetKey);
  } catch {
    raw = null;
  }

  if (!raw) {
    try {
      // Legacy unscoped value.
      raw = await SecureStore.getItemAsync(baseKey);
    } catch {
      raw = null;
    }
  }

  if (!raw) return;

  try {
    await setString(targetKey, raw);
  } catch {
    // If the write fails, keep legacy storage intact.
    return;
  }

  // Best-effort cleanup.
  try {
    await SecureStore.deleteItemAsync(baseKey);
  } catch {}
  try {
    await SecureStore.deleteItemAsync(targetKey);
  } catch {}
}

async function migrateOneKeyFromLegacySQLite(baseKey: string, scope?: string | number | null): Promise<void> {
  const s = String(scope ?? '').trim();
  if (!s) return;

  const targetKey = makeScopedKey(baseKey, s);
  if (targetKey === baseKey) return;

  // If scoped already exists, don't touch legacy.
  const existing = await getString(targetKey);
  if (existing) return;

  const legacy = await getString(baseKey);
  if (!legacy) return;

  await setString(targetKey, legacy);
  // Best-effort cleanup.
  try {
    await deleteKey(baseKey);
  } catch {
    // ignore
  }
}

// One-time migration: move legacy Catalog/KitLog blobs out of SecureStore
// and into SQLite (scoped per user).
export async function migrateLegacySecureStoreIfNeeded(scope?: string | number | null): Promise<void> {
  const s = String(scope ?? '').trim();
  if (!s) return;

  const keys = [DOC_KEYS.catalog, DOC_KEYS.kitlog, DOC_KEYS.faceAnalysisHistory, DOC_KEYS.faceChatHistory];

  // 1) Move legacy *SQLite* unscoped docs into the scoped namespace.
  try {
    for (const k of keys) {
      await migrateOneKeyFromLegacySQLite(k, s);
    }
  } catch {
    // ignore
  }

  // 2) Move legacy *SecureStore* docs into SQLite (and clean up SecureStore).
  try {
    for (const k of keys) {
      await migrateOneKeyFromSecureStore(k, s);
    }
  } catch {
    // ignore
  }
}
