import * as SecureStore from "expo-secure-store";

const NEW_KEY = "io_token";
const OLD_KEY = "ioul_token";

export async function saveToken(token: string) {
  await SecureStore.setItemAsync(NEW_KEY, token);
  // clean up old key if present
  try { await SecureStore.deleteItemAsync(OLD_KEY); } catch {}
}

export async function getToken(): Promise<string | null> {
  const v = await SecureStore.getItemAsync(NEW_KEY);
  if (v) return v;
  const legacy = await SecureStore.getItemAsync(OLD_KEY);
  if (legacy) {
    // migrate on read
    try {
      await SecureStore.setItemAsync(NEW_KEY, legacy);
      await SecureStore.deleteItemAsync(OLD_KEY);
    } catch {}
    return legacy;
  }
  return null;
}

export async function clearToken() {
  try { await SecureStore.deleteItemAsync(NEW_KEY); } catch {}
  try { await SecureStore.deleteItemAsync(OLD_KEY); } catch {}
}
