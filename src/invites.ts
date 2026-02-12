import { deleteKey, getString, setString } from './localstore';

// Persisted invite context. Used to require phone number on invite sign-ups.
// NOTE: Storage keys must use the brand prefix "io".
const INVITE_CODE_KEY = 'io_invite_code';

function clean(v: any): string {
  return String(v ?? '').trim();
}

export function normalizeInviteCode(code: any): string {
  // Keep codes URL-safe + case-insensitive for matching.
  const raw = clean(code).toUpperCase();
  if (!raw) return '';

  // Allow only simple alphanumerics to avoid accidental punctuation.
  const normalized = raw.replace(/[^A-Z0-9]/g, '');
  return normalized;
}

export async function getInviteCode(): Promise<string | null> {
  try {
    const raw = await getString(INVITE_CODE_KEY);
    const code = normalizeInviteCode(raw);
    return code || null;
  } catch {
    return null;
  }
}

export async function setInviteCode(code: string): Promise<void> {
  const c = normalizeInviteCode(code);
  if (!c) return;
  try {
    await setString(INVITE_CODE_KEY, c);
  } catch {
    // ignore
  }
}

export async function clearInviteCode(): Promise<void> {
  try {
    await deleteKey(INVITE_CODE_KEY);
  } catch {
    // ignore
  }
}

export function parseInviteCodeFromUrl(url: string | null | undefined): string | null {
  const u = clean(url);
  if (!u) return null;

  // 1) Try the URL parser (works on web and most RN runtimes).
  try {
    const parsed = new URL(u);
    const qp =
      parsed.searchParams.get('code') ||
      parsed.searchParams.get('invite') ||
      parsed.searchParams.get('inviteCode');
    const fromQuery = normalizeInviteCode(qp);
    if (fromQuery) return fromQuery;

    // Path formats:
    //   https://host/invites/<CODE>
    //   undertone://invite/<CODE>
    const path = String(parsed.pathname || '');
    const m = path.match(/\/(?:invites|invite)\/?([A-Za-z0-9_-]{4,})/i);
    if (m && m[1]) {
      const fromPath = normalizeInviteCode(m[1]);
      if (fromPath) return fromPath;
    }
  } catch {
    // ignore
  }

  // 2) Regex fallback.
  const qm = u.match(/[?&](?:code|invite|inviteCode)=([^&#]+)/i);
  if (qm && qm[1]) {
    const fromQuery = normalizeInviteCode(decodeURIComponent(qm[1]));
    if (fromQuery) return fromQuery;
  }

  const pm = u.match(/\/(?:invites|invite)\/?([A-Za-z0-9_-]{4,})/i);
  if (pm && pm[1]) {
    const fromPath = normalizeInviteCode(pm[1]);
    if (fromPath) return fromPath;
  }

  return null;
}

export async function captureInviteCodeFromUrl(url: string | null | undefined): Promise<string | null> {
  const code = parseInviteCodeFromUrl(url);
  if (!code) return null;
  await setInviteCode(code);
  return code;
}

export async function copyToClipboard(text: string): Promise<boolean> {
  const t = clean(text);
  if (!t) return false;

  // Prefer expo-clipboard when available.
  try {
    const Clipboard = await import('expo-clipboard');
    await Clipboard.setStringAsync(t);
    return true;
  } catch {
    // Web fallback.
    try {
      const nav: any = typeof navigator !== 'undefined' ? (navigator as any) : null;
      if (nav?.clipboard?.writeText) {
        await nav.clipboard.writeText(t);
        return true;
      }
    } catch {
      // ignore
    }
  }

  return false;
}
