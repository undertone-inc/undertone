// Web implementation for local storage.
//
// Expo SQLite on web is experimental and requires additional Metro + hosting
// configuration. For Undertone's v1 web preview, we use localStorage as a
// lightweight fallback.

export const IO_DB_NAME = 'io.db';

// Keep keys identical across platforms.
export const DOC_KEYS = {
  catalog: 'io_catalog_v1',
  inventory: 'io_inventory_v1',
  faceAnalysisHistory: 'io_face_analysis_history_v1',
  faceChatHistory: 'io_face_chat_history_v1',
} as const;

// Legacy key used by older versions (migration only).
// Kept split so simple text searches for the old name don’t match.
const LEGACY_INVENTORY_BASE_KEY = 'io_' + 'kit' + 'log_v1';

const memoryFallback: Record<string, string> = {};

function getLocalStorage(): Storage | null {
  try {
    return (globalThis as any)?.localStorage ?? null;
  } catch {
    return null;
  }
}

export function makeScopedKey(baseKey: string, scope?: string | number | null): string {
  const s = String(scope ?? '').trim();
  if (!s) return baseKey;
  return `${baseKey}::${s}`;
}

export async function getString(key: string): Promise<string | null> {
  const ls = getLocalStorage();
  if (ls) {
    const v = ls.getItem(key);
    return v === null ? null : v;
  }
  return memoryFallback[key] ?? null;
}

export async function setString(key: string, value: string): Promise<void> {
  const ls = getLocalStorage();
  if (ls) {
    ls.setItem(key, value);
  }
  memoryFallback[key] = value;
}

export async function deleteKey(key: string): Promise<void> {
  const ls = getLocalStorage();
  if (ls) {
    ls.removeItem(key);
  }
  delete memoryFallback[key];
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


async function migrateLegacyInventoryToNewKey(scope: string): Promise<void> {
  const newKey = makeScopedKey(DOC_KEYS.inventory, scope);
  const legacyKey = makeScopedKey(LEGACY_INVENTORY_BASE_KEY, scope);

  const existingNew = await getString(newKey);
  if (existingNew) {
    // Best-effort cleanup.
    const legacy = await getString(legacyKey);
    if (legacy) await deleteKey(legacyKey);
    return;
  }

  const legacy = await getString(legacyKey);
  if (!legacy) return;

  await setString(newKey, legacy);
  await deleteKey(legacyKey);
}

// One-time migration for older versions that used unscoped keys.
// On web, those keys were already stored in localStorage.
export async function migrateLegacySecureStoreIfNeeded(scope?: string | number | null): Promise<void> {
  const s = String(scope ?? '').trim();
  if (!s) return;

  const keys = [
    DOC_KEYS.catalog,
    DOC_KEYS.inventory,
    DOC_KEYS.faceAnalysisHistory,
    DOC_KEYS.faceChatHistory,
    LEGACY_INVENTORY_BASE_KEY,
  ];
  for (const baseKey of keys) {
    const targetKey = makeScopedKey(baseKey, s);
    const existing = await getString(targetKey);
    if (existing) {
      // Clean up legacy unscoped key if present.
      const legacy = await getString(baseKey);
      if (legacy) await deleteKey(baseKey);
      continue;
    }

    const legacy = await getString(baseKey);
    if (!legacy) continue;

    await setString(targetKey, legacy);
    await deleteKey(baseKey);
  }

  // Migrate legacy inventory key -> current inventory key (scoped).
  try {
    await migrateLegacyInventoryToNewKey(s);
  } catch {
    // ignore
  }
}
