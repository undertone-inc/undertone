import * as SecureStore from 'expo-secure-store';

// Auth token
const TOKEN_KEY = 'io_token';

// Cached profile fields (non-secret but useful offline / when API is unreachable)
const EMAIL_KEY = 'io_auth_email';
const USER_ID_KEY = 'io_auth_user_id';
const ACCOUNT_NAME_KEY = 'io_auth_account_name';
const PLAN_TIER_KEY = 'io_auth_plan_tier';

export type AuthProfile = {
  email: string | null;
  userId: string | null;
  accountName: string | null;
  planTier: string | null;
};

function cleanStr(v: any): string {
  return String(v ?? '').trim();
}

async function setOrDelete(key: string, value: string | null | undefined) {
  if (value === undefined) return;
  const v = cleanStr(value);
  try {
    if (v) await SecureStore.setItemAsync(key, v);
    else await SecureStore.deleteItemAsync(key);
  } catch {
    // ignore
  }
}

export async function saveToken(token: string) {
  await SecureStore.setItemAsync(TOKEN_KEY, cleanStr(token));
}

export async function getToken(): Promise<string | null> {
  const v = await SecureStore.getItemAsync(TOKEN_KEY);
  return v ? cleanStr(v) : null;
}

export async function saveAuthProfile(patch: Partial<AuthProfile>) {
  await Promise.all([
    setOrDelete(EMAIL_KEY, patch.email),
    setOrDelete(USER_ID_KEY, patch.userId),
    setOrDelete(ACCOUNT_NAME_KEY, patch.accountName),
    setOrDelete(PLAN_TIER_KEY, patch.planTier),
  ]);
}

export async function getAuthProfile(): Promise<AuthProfile> {
  const [email, userId, accountName, planTier] = await Promise.all([
    SecureStore.getItemAsync(EMAIL_KEY),
    SecureStore.getItemAsync(USER_ID_KEY),
    SecureStore.getItemAsync(ACCOUNT_NAME_KEY),
    SecureStore.getItemAsync(PLAN_TIER_KEY),
  ]);

  return {
    email: email ? cleanStr(email) : null,
    userId: userId ? cleanStr(userId) : null,
    accountName: accountName ? cleanStr(accountName) : null,
    planTier: planTier ? cleanStr(planTier) : null,
  };
}

export async function clearAuthProfile() {
  try {
    await Promise.all([
      SecureStore.deleteItemAsync(EMAIL_KEY),
      SecureStore.deleteItemAsync(USER_ID_KEY),
      SecureStore.deleteItemAsync(ACCOUNT_NAME_KEY),
      SecureStore.deleteItemAsync(PLAN_TIER_KEY),
    ]);
  } catch {
    // ignore
  }
}

export async function clearToken() {
  // Clearing a token should also clear cached profile fields.
  try {
    await SecureStore.deleteItemAsync(TOKEN_KEY);
  } catch {}
  await clearAuthProfile();
}
