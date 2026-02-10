import Constants from "expo-constants";

const fromEnv = process.env.EXPO_PUBLIC_API_BASE as string | undefined;
const fromExtra = (Constants.expoConfig?.extra as any)?.EXPO_PUBLIC_API_BASE as string | undefined;
const RAW_BASE = fromEnv ?? fromExtra ?? "";
const API_BASE = RAW_BASE.replace(/\/+$/, ""); // strip trailing slashes

function url(path: string) {
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${API_BASE}${p}`;
}

async function api(path: string, init: RequestInit = {}, token?: string) {
  if (!API_BASE) throw new Error("Missing EXPO_PUBLIC_API_BASE (set in app.json > extra or .env).");
  const headers = new Headers(init.headers || {});
  headers.set("content-type", "application/json");
  if (token) headers.set("authorization", `Bearer ${token}`);
  const u = url(path);

  let res: Response;
  try {
    res = await fetch(u, { ...init, headers });
  } catch (e: any) {
    console.warn("api() network error", { url: u, error: String(e?.message || e) });
    throw e;
  }

  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch {}

  if (!res.ok) {
    const msg = json?.error || json?.message || text || `HTTP ${res.status} ${res.statusText}`;
    console.warn("api() failed", { url: u, status: res.status, statusText: res.statusText, body: text?.slice(0, 300) });
    throw new Error(msg);
  }

  // Detect unexpected HTML (e.g., Codespaces port/login page)
  const lower = (text || "").toLowerCase();
  if (!json && lower.includes("<html")) {
    console.warn("api() unexpected HTML", { url: u, bodyPreview: text?.slice(0, 200) });
    throw new Error("Server returned HTML instead of JSON. Make sure your API base is PUBLIC.");
  }

  return json ?? {};
}

export async function login(identifier: string, password: string) {
  const payload = { identifier: identifier?.trim?.() ?? identifier, password };
  return api("/api/v1/auth/login", { method: "POST", body: JSON.stringify(payload) });
}

export async function me(token: string) { return api("/api/v1/users/me", { method: "GET" }, token); }
export async function updateMe(token: string, username: string) {
  return api("/api/v1/users/me", { method: "PUT", body: JSON.stringify({ username }) }, token);
}
export async function getPosts(token: string, cursor?: string) {
  const q = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
  return api(`/api/v1/posts${q}`, { method: "GET" }, token);
}
export async function createPost(token: string, content: string) {
  return api("/api/v1/posts", { method: "POST", body: JSON.stringify({ content }) }, token);
}


export async function deletePost(token: string, id: string) {
  const q = `?id=${encodeURIComponent(id)}`;
  return api(`/api/v1/posts${q}`, { method: "DELETE" }, token);
}



export async function updateAccountName(token: string, accountName: string) {
  return api("/api/v1/users/me", { method: "PUT", body: JSON.stringify({ accountName }) }, token);
}

export async function updateBio(token: string, bio: string) {
  return api("/api/v1/users/me", { method: "PUT", body: JSON.stringify({ bio }) }, token);
}

export async function updateLink(token: string, accountLink: string) {
  return api("/api/v1/users/me", { method: "PUT", body: JSON.stringify({ accountLink }) }, token);
}

export async function getAccountLog(token: string) {
  return api("/api/v1/account/log", { method: "GET" }, token);
}

export async function saveAccountLog(
  token: string,
  items: { title: string; description: string }[]
) {
  return api("/api/v1/account/log", {
    method: "PUT",
    body: JSON.stringify({ items }),
  }, token);
}
export type ChatMsg = { id: string; text: string; dir: "out" | "in"; ts: number };
export type Inbox = "ALL" | "VIP";
export type ChatState = {
  openChats: string[];
  messages: Record<string, ChatMsg[]>;
  activeChat?: string | null;
  unreadCounts?: Record<string, number>;
  updatedAt?: number;
  inbox?: Record<string, Inbox>;
};

export async function getChats(token: string): Promise<ChatState> {
  return api("/api/v1/chats", { method: "GET" }, token);
}

export async function putChats(token: string, patch: Partial<ChatState>): Promise<ChatState> {
  return api("/api/v1/chats", { method: "PUT", body: JSON.stringify(patch) }, token);
}


export async function searchUsers(token: string, q: string) {
  const qq = encodeURIComponent(q || '');
  return api(`/api/users?q=${qq}`, { method: "GET" }, token);
}


export async function getUserByUsername(username: string) {
  const safe = encodeURIComponent(username || '');
  return api(`/api/v1/users/${safe}`, { method: "GET" });
}
export async function getPostsByUsername(username: string, cursor?: string) {
  const q = new URLSearchParams();
  if (username) q.set("username", username);
  if (cursor) q.set("cursor", cursor);
  const qs = q.toString();
  return api(`/api/v1/posts${qs ? `?${qs}` : ""}`, { method: "GET" });
}

// Comments API
export async function getComments(token: string, postId: string) {
  const q = `?postId=${encodeURIComponent(postId)}`;
  return api(`/api/v1/comments${q}`, { method: "GET" }, token);
}
export async function createComment(token: string, postId: string, content: string) {
  return api(`/api/v1/comments`, { method: "POST", body: JSON.stringify({ postId, content }) }, token);
}
export async function deleteComment(token: string, id: string) {
  return api(`/api/v1/comments/${encodeURIComponent(id)}`, { method: "DELETE" }, token);
}


// Replies API
export async function getCommentReplies(token: string, commentId: string) {
  const q = `?commentId=${encodeURIComponent(commentId)}`;
  return api(`/api/v1/comments${q}`, { method: "GET" }, token);
}
export async function createReply(token: string, commentId: string, content: string) {
  return api(`/api/v1/comments`, { method: "POST", body: JSON.stringify({ commentId, content }) }, token);
}


// ---- Client-side in-memory overrides for placeholder/offline mode ----
export const __clientChatLocal: {
  inbox?: Record<string, Inbox>;
  deleted?: Record<string, true>;
  messages?: Record<string, ChatMsg[]>;
  openChats?: string[];
} = {};

export function mergeClientChat(patch: Partial<ChatState>) {
  if (patch.inbox) __clientChatLocal.inbox = { ...(__clientChatLocal.inbox || {}), ...(patch.inbox || {}) };
  if (patch.messages) __clientChatLocal.messages = { ...(__clientChatLocal.messages || {}), ...(patch.messages || {}) };
  if (patch.openChats) __clientChatLocal.openChats = Array.from(new Set([...(__clientChatLocal.openChats || []), ...patch.openChats]));
}

export function markClientChatDeleted(user: string) {
  __clientChatLocal.deleted = { ...(__clientChatLocal.deleted || {}), [user]: true };
}

export function applyClientChatTo(state: ChatState): ChatState {
  let inbox = { ...(state.inbox || {}), ...(__clientChatLocal.inbox || {}) };
  let open = Array.from(new Set([...(state.openChats || []), ...(__clientChatLocal.openChats || [])]));
  let messages = { ...(state.messages || {}), ...(__clientChatLocal.messages || {}) };
  if (__clientChatLocal.deleted) {
    for (const u of Object.keys(__clientChatLocal.deleted)) {
      delete messages[u];
      open = open.filter((x) => x !== u);
      delete inbox[u];
    }
  }
  return { ...state, openChats: open, messages, inbox };
}
// ----------------------------------------------------------------------


// -------------------------------
// Plan config & limits
// -------------------------------

export type PlanTier = 'free' | 'pro';

export const PLAN_CONFIG: Record<
  PlanTier,
  { label: string; priceLabel: string; features: string[] }
> = {
  free: {
    label: 'Free',
    priceLabel: '$0',
    features: ['Up to 5 scans / mo', 'Up to 5 names on your list', 'Up to 5 custom categories', 'Up to 5 kit items'],
  },
  pro: {
    label: 'Undertone Pro',
    priceLabel: '$20 / mo',
    features: [
      'Up to 100 scans per month',
      'Up to 1,000 names on your list',
      'Up to 1,000 items in your kit',
      'Undertone e-mail support',
    ],
  },
};

export const PLAN_LIMITS: Record<
  PlanTier,
  { uploads: number; lists: number; categories: number; items: number }
> = {
  free: { uploads: 5, lists: 5, categories: 5, items: 5 },
  // NOTE: items = total across all categories.
  pro: { uploads: 100, lists: 1000, categories: Infinity, items: 1000 },
};

export const PLAN_RANK: Record<PlanTier, number> = { free: 0, pro: 1 };

export function normalizePlanTier(value: any): PlanTier {
  const v = String(value ?? '').trim().toLowerCase();
  if (v === 'pro') return 'pro';
  if (v === 'free') return 'free';
  if (v.includes('pro')) return 'pro';
  // "Plus" is no longer offered; treat it as "Pro" so legacy values don't break UI.
  if (v === 'plus' || v.includes('plus')) return 'pro';
  return 'free';
}
