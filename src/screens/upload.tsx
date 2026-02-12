import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  Image,
  TextInput,
  StyleSheet,
  TouchableOpacity,
  TouchableWithoutFeedback,
  Keyboard,
  Platform,
  Modal,
  Pressable,
  ActivityIndicator,
  Alert,
  ScrollView,
  Linking,
} from 'react-native';
import { useBottomTabBarHeight } from '@react-navigation/bottom-tabs';
import Ionicons from '@expo/vector-icons/Ionicons';
import Constants from 'expo-constants';
import * as ImagePicker from 'expo-image-picker';
import * as ImageManipulator from 'expo-image-manipulator';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { DOC_KEYS, getJson, getString, makeScopedKey, setJson } from '../localstore';

const INVENTORY_STORAGE_KEY = DOC_KEYS.inventory;
const CATALOG_STORAGE_KEY = DOC_KEYS.catalog;
const ANALYSIS_HISTORY_KEY = DOC_KEYS.faceAnalysisHistory;
const CHAT_HISTORY_KEY = DOC_KEYS.faceChatHistory;

const EXPIRING_WINDOW_DAYS = 60;
const UPCOMING_WINDOW_DAYS = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

// Must match the selfie oval guidance in Camera.
// Used here to crop camera captures for better undertone analysis.
const FACE_OVAL_CENTER_Y = 0.42;
const FACE_OVAL_RX = 0.34;
const FACE_OVAL_RY = 0.32;

// How the bar sits when keyboard is CLOSED
// (Adds a little more breathing room above the bottom nav divider)
const CLOSED_BOTTOM_PADDING = 28;

// Extra space ABOVE the keyboard when it’s OPEN
// (Raised to make the lift clearly noticeable)
const KEYBOARD_GAP = 33;

// Read API base (env overrides app.json extra)
// IMPORTANT: Strip trailing slashes so we never generate URLs like "//analyze-face".
const RAW_API_BASE =
  process.env.EXPO_PUBLIC_API_BASE ??
  (Constants as any).expoConfig?.extra?.EXPO_PUBLIC_API_BASE ??
  'http://localhost:3000';
const API_BASE = String(RAW_API_BASE || '').replace(/\/+$/, '');

function safeParseDate(value?: string): number | null {
  if (!value) return null;
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : null;
}

function isExpiring(expiryDate?: string, windowDays = EXPIRING_WINDOW_DAYS): boolean {
  const ts = safeParseDate(expiryDate);
  if (!ts) return false;
  return ts - Date.now() <= windowDays * 24 * 60 * 60 * 1000;
}

function countNeedsAttentionFromRaw(raw: string | null): number {
  if (!raw) return 0;
  try {
    const parsed = JSON.parse(raw);
    const cats = Array.isArray(parsed?.categories) ? parsed.categories : [];

    let low = 0;
    let empty = 0;
    let expiring = 0;

    cats.forEach((c: any) => {
      const items = Array.isArray(c?.items) ? c.items : [];
      items.forEach((it: any) => {
        if (it?.status === 'low') low += 1;
        if (it?.status === 'empty') empty += 1;
        if (isExpiring(it?.expiryDate)) expiring += 1;
      });
    });

    return low + empty + expiring;
  } catch {
    return 0;
  }
}

function safeParseCalendarDate(value?: string): number | null {
  if (!value) return null;

  const s = value.trim();
  if (!s) return null;

  // Parse YYYY-MM-DD as LOCAL date to avoid timezone shifts.
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(s);
  const t = new Date(dateOnly ? `${s}T00:00:00` : s).getTime();
  return Number.isFinite(t) ? t : null;
}

function startOfTodayLocalMs(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function isWithinNextDaysCalendar(dateStr?: string, windowDays = UPCOMING_WINDOW_DAYS): boolean {
  const ts = safeParseCalendarDate(dateStr);
  if (!ts) return false;

  const today = startOfTodayLocalMs();
  const diff = ts - today;
  return diff >= 0 && diff <= windowDays * DAY_MS;
}

function readListsFromCatalog(parsed: any): any[] {
  if (!parsed || typeof parsed !== 'object') return [];
  const lists = (parsed as any)?.lists;
  if (Array.isArray(lists)) return lists;
  // Legacy support (older versions stored the array under a different key).
  const legacyKey = 'cl' + 'ients';
  const legacy = (parsed as any)?.[legacyKey];
  return Array.isArray(legacy) ? legacy : [];
}

function countUpcomingListsFromRaw(raw: string | null): number {
  if (!raw) return 0;
  try {
    const parsed = JSON.parse(raw);
    const lists = readListsFromCatalog(parsed);

    let upcoming = 0;
    lists.forEach((c: any) => {
      if (isWithinNextDaysCalendar(c?.trialDate) || isWithinNextDaysCalendar(c?.finalDate)) {
        upcoming += 1;
      }
    });

    return upcoming;
  } catch {
    return 0;
  }
}

function getImageSizeAsync(uri: string): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    const u = String(uri || '').trim();
    if (!u) return resolve(null);

    try {
      Image.getSize(
        u,
        (width, height) => resolve({ width, height }),
        () => resolve(null)
      );
    } catch {
      resolve(null);
    }
  });
}

type UploadScreenProps = {
  navigation: any;
  route: any;
  email?: string | null;
  userId?: string | number | null;
  token?: string | null;
  onLogout?: () => void;
};

function capWord(s: string): string {
  const t = String(s || '').trim();
  if (!t) return '';
  return t.charAt(0).toUpperCase() + t.slice(1);
}

type PickedPhoto = {
  uri: string;
  mimeType: string;
  fileName: string;
  source: 'camera' | 'library';
  width?: number;
  height?: number;
};

type HistoryItem = {
  id: string;
  createdAt: string;
  analysis: any;
};

type ChatRole = 'user' | 'assistant';

type ChatMessageKind = 'analysis' | 'kit_recs' | 'buy_recs';

type ChatMessage = {
  id: string;
  role: ChatRole;
  text: string;
  createdAt: string;
  kind?: ChatMessageKind;
  // When kind === 'kit_recs', we keep the structured picks so “Save” can
  // persist the exact products that were recommended.
  kitProducts?: SavedKitProduct[];
  savedListId?: string;
};

type ChatStore = Record<string, ChatMessage[]>;

type DiscoverTone = 'cool' | 'neutral' | 'warm';
type DiscoverCategory = 'Base' | 'Sculpt' | 'Cheeks' | 'Eyes' | 'Lips';

const DISCOVER_TYPES_BY_CATEGORY: Record<DiscoverCategory, string[]> = {
  Base: ['Foundation', 'Concealer', 'Corrector', 'Powder'],
  Sculpt: ['Contour', 'Highlighter'],
  Cheeks: ['Blush', 'Bronzer'],
  Eyes: ['Eyeshadow', 'Eyeliner', 'Mascara', 'Lashes'],
  Lips: ['Lipstick', 'Lipliner', 'Lip gloss', 'Lip balm/treatments'],
};

function getDiscoverTypes(category: DiscoverCategory | null): string[] {
  if (!category) return [];
  const arr = (DISCOVER_TYPES_BY_CATEGORY as any)?.[category];
  return Array.isArray(arr) ? arr : [];
}

function makeId() {
  return `io_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function compactList(arr: unknown, max = 10): string {
  const a = Array.isArray(arr) ? arr : [];
  return a
    .map((x) => String(x || '').trim())
    .filter(Boolean)
    .slice(0, max)
    .join(', ');
}

function displayUndertone(raw: unknown): string {
  const s = String(raw || '').trim().toLowerCase();
  if (!s) return '';
  // Normalize legacy value.
  if (s === 'olive') return 'Neutral';
  // Title-case dash-delimited labels.
  return s
    .split('-')
    .filter(Boolean)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join('-');
}

type SeasonKey = 'spring' | 'summer' | 'autumn' | 'winter';

function normalizeSeasonKey(raw: unknown): SeasonKey | null {
  const s = String(raw || '').trim().toLowerCase();
  if (s === 'spring' || s === 'summer' || s === 'autumn' || s === 'winter') return s as SeasonKey;
  return null;
}

function displaySeason(raw: unknown): string {
  const s = normalizeSeasonKey(raw);
  if (!s) return '';
  return s.charAt(0).toUpperCase() + s.slice(1);
}



type UndertoneKey = 'cool' | 'neutral-cool' | 'neutral' | 'neutral-warm' | 'warm';

type KitItemLite = {
  id?: string;
  name?: string;
  brand?: string;
  shade?: string;
  undertone?: string;
  status?: 'inKit' | 'low' | 'empty';
  expiryDate?: string;
  notes?: string;
};

type KitCategoryLite = {
  name?: string;
  items?: KitItemLite[];
};

type InventoryLite = {
  categories?: KitCategoryLite[];
};

function normalizeUndertoneKey(raw: unknown): UndertoneKey | null {
  const s0 = String(raw || '').trim().toLowerCase();
  if (!s0) return null;
  const s = s0.replace(/_/g, '-');

  // Legacy value.
  if (s === 'olive') return 'neutral';

  if (s === 'cool' || s === 'neutral-cool' || s === 'neutral' || s === 'neutral-warm' || s === 'warm') {
    return s as UndertoneKey;
  }

  // Heuristics for messy strings.
  if (s.includes('neutral') && s.includes('cool') && !s.includes('warm')) return 'neutral-cool';
  if (s.includes('neutral') && s.includes('warm') && !s.includes('cool')) return 'neutral-warm';
  if (s.includes('warm') && !s.includes('cool')) return 'warm';
  if (s.includes('cool') && !s.includes('warm')) return 'cool';
  if (s.includes('neutral')) return 'neutral';

  return null;
}

function undertoneToNumber(u: UndertoneKey): number {
  // warmth scale: cool=-2 ... warm=+2
  if (u === 'cool') return -2;
  if (u === 'neutral-cool') return -1;
  if (u === 'neutral') return 0;
  if (u === 'neutral-warm') return 1;
  return 2;
}

function safeParseInventory(raw: string | null): InventoryLite {
  if (!raw) return { categories: [] };
  try {
    const parsed = JSON.parse(raw);
    const cats = Array.isArray(parsed?.categories) ? parsed.categories : [];
    return { categories: cats } as InventoryLite;
  } catch {
    return { categories: [] };
  }
}

function categoryItems(kit: InventoryLite, nameWant: string): KitItemLite[] {
  const cats = Array.isArray(kit?.categories) ? kit.categories : [];
  const want0 = String(nameWant || '').trim().toLowerCase();
  if (!want0) return [];

  // Migrations/aliases:
  // - legacy kits used "Foundation"; canonical category is now "Base"
  const wantAliases = want0 === 'base' || want0 === 'foundation' ? ['base', 'foundation'] : [want0];

  // Prefer exact match by category name, then fall back to a simple substring match.
  const exact = cats.find((c) => wantAliases.includes(String(c?.name || '').trim().toLowerCase()));
  const fuzzy =
    exact ||
    cats.find((c) => {
      const n = String(c?.name || '').trim().toLowerCase();
      return wantAliases.some((w) => n === w || n.includes(w) || w.includes(n));
    });

  const items = Array.isArray((fuzzy as any)?.items) ? (fuzzy as any).items : [];
  return items as KitItemLite[];
}

function inferItemUndertone(item: KitItemLite): UndertoneKey | null {
  const direct = normalizeUndertoneKey(item?.undertone);
  if (direct) return direct;

  const blob = `${item?.brand || ''} ${item?.name || ''} ${item?.shade || ''} ${item?.notes || ''}`
    .trim()
    .toLowerCase();

  if (!blob) return null;

  // explicit neutral-lean cues
  if (blob.includes('neutral-cool') || blob.includes('neutral cool') || blob.includes('nc')) return 'neutral-cool';
  if (blob.includes('neutral-warm') || blob.includes('neutral warm') || blob.includes('nw')) return 'neutral-warm';

  // warm cues
  const warm =
    blob.includes('warm') ||
    blob.includes('golden') ||
    blob.includes('yellow') ||
    blob.includes('olive') ||
    blob.includes('peach') ||
    blob.includes('coral') ||
    blob.includes('terracotta') ||
    blob.includes('bronze');

  // cool cues
  const cool =
    blob.includes('cool') ||
    blob.includes('rosy') ||
    blob.includes('pink') ||
    blob.includes('berry') ||
    blob.includes('mauve') ||
    blob.includes('plum') ||
    blob.includes('blue-red') ||
    blob.includes('ash');

  if (warm && !cool) return 'warm';
  if (cool && !warm) return 'cool';

  if (blob.includes('neutral')) return 'neutral';

  return null;
}

function statusBoost(status?: string): number {
  if (status === 'inKit') return 3;
  if (status === 'low') return 1;
  if (status === 'empty') return -10;
  return 0;
}

function compatibilityScore(client: UndertoneKey, product: UndertoneKey | null): number {
  if (!product) return 0;
  const d = Math.abs(undertoneToNumber(client) - undertoneToNumber(product));
  // d: 0..4
  return 10 - d * 3; // 10,7,4,1,-2
}

function formatKitItemLine(it: KitItemLite): string {
  const brand = String(it?.brand || '').trim();
  const name = String(it?.name || '').trim();
  const shade = String(it?.shade || '').trim();

  const base = [brand, name].filter(Boolean).join(' ').trim() || 'Unnamed item';
  const withShade = shade ? `${base} — ${shade}` : base;

  const tags: string[] = [];
  const st = String(it?.status || '').trim();
  if (st === 'low') tags.push('low');
  if (st === 'empty') tags.push('empty');
  if (isExpiring(it?.expiryDate)) tags.push('expiring');

  return tags.length ? `${withShade} (${tags.join(', ')})` : withShade;
}

function pickBestKitItems(items: KitItemLite[], client: UndertoneKey, n = 2): KitItemLite[] {
  const arr = Array.isArray(items) ? items : [];

  const scored = arr
    .filter((it) => {
      const name = String(it?.name || '').trim();
      if (!name) return false;
      // Prefer usable items.
      return String(it?.status || 'inKit') !== 'empty';
    })
    .map((it) => {
      const inferred = inferItemUndertone(it);
      const score = compatibilityScore(client, inferred) + statusBoost(it?.status) - (isExpiring(it?.expiryDate) ? 2 : 0);
      return { it, score };
    })
    .sort((a, b) => b.score - a.score);

  return scored.slice(0, Math.max(0, n)).map((x) => x.it);
}

const BUY_RECS: Record<UndertoneKey, { base: string[]; cheeks: string[]; eyes: string[]; lips: string[] }> = {
  cool: {
    base: [
      'Estée Lauder Double Wear Stay-in-Place Foundation',
      'NARS Light Reflecting Foundation',
	      "Fenty Beauty Pro Filt'r Soft Matte Longwear Foundation",
    ],
    cheeks: ['Rare Beauty Soft Pinch Liquid Blush', 'Clinique Cheek Pop', 'NARS Blush'],
    eyes: ['Natasha Denona Glam Palette', 'Urban Decay Naked2 Basics Palette', 'Laura Mercier Caviar Stick Cream Eyeshadow'],
    lips: ['MAC Matte Lipstick', 'Charlotte Tilbury Matte Revolution Lipstick', 'Fenty Beauty Gloss Bomb'],
  },
  'neutral-cool': {
	    base: ['Dior Backstage Face & Body Foundation', 'NARS Light Reflecting Foundation', "Fenty Beauty Pro Filt'r Foundation"],
    cheeks: ['Clinique Cheek Pop', 'Rare Beauty Soft Pinch Liquid Blush', 'NARS Blush'],
    eyes: ['Natasha Denona Glam Palette', 'Urban Decay Naked2 Basics Palette', 'Laura Mercier Caviar Stick Cream Eyeshadow'],
    lips: ['MAC Satin Lipstick', 'Charlotte Tilbury Matte Revolution Lipstick', 'Fenty Beauty Gloss Bomb'],
  },
  neutral: {
    base: ['Dior Backstage Face & Body Foundation', 'Fenty Beauty Eaze Drop Blurring Skin Tint', 'NARS Light Reflecting Foundation'],
    cheeks: ['Rare Beauty Soft Pinch Liquid Blush', 'Clinique Cheek Pop', 'NARS Blush'],
    eyes: ['Natasha Denona Glam Palette', 'Urban Decay Naked3 Palette', 'Laura Mercier Caviar Stick Cream Eyeshadow'],
    lips: ['Charlotte Tilbury Matte Revolution Lipstick', 'MAC Satin Lipstick', 'Fenty Beauty Gloss Bomb'],
  },
  'neutral-warm': {
    base: ['Giorgio Armani Luminous Silk Foundation', 'Dior Backstage Face & Body Foundation', 'Make Up For Ever HD Skin Foundation'],
    cheeks: ['Rare Beauty Soft Pinch Liquid Blush', 'Fenty Beauty Cheeks Out Cream Blush', 'NARS Blush'],
    eyes: ['Natasha Denona Bronze Palette', 'Huda Beauty Nude Obsessions Palette', 'Laura Mercier Caviar Stick Cream Eyeshadow'],
    lips: ['Charlotte Tilbury K.I.S.S.I.N.G Lipstick', 'MAC Matte Lipstick', 'Fenty Beauty Gloss Bomb'],
  },
  warm: {
    base: ['Giorgio Armani Luminous Silk Foundation', 'Charlotte Tilbury Beautiful Skin Foundation', 'Make Up For Ever HD Skin Foundation'],
    cheeks: ['Fenty Beauty Cheeks Out Cream Blush', 'Rare Beauty Soft Pinch Liquid Blush', 'NARS Blush'],
    eyes: ['Natasha Denona Bronze Palette', 'Huda Beauty Nude Obsessions Palette', 'Too Faced Natural Eyes Palette'],
    lips: ['Charlotte Tilbury K.I.S.S.I.N.G Lipstick', 'MAC Matte Lipstick', 'Fenty Beauty Gloss Bomb'],
  },
};

type SavedKitProduct = { category: string; name: string; shade?: string };

function buildKitRecommendationsPayload(opts: {
  undertoneRaw: unknown;
  kitRaw: string | null;
}): { text: string; products: SavedKitProduct[] } {
  const u = normalizeUndertoneKey(opts.undertoneRaw);
  if (!u) return { text: '', products: [] };

  const kit = safeParseInventory(opts.kitRaw);

  // Legacy kits used "Foundation"; canonical category is now "Base".
  const baseItems = categoryItems(kit, 'base');
  const sculptItems = categoryItems(kit, 'sculpt');
  const cheekItems = categoryItems(kit, 'cheeks');
  const eyeItems = categoryItems(kit, 'eyes');
  const lipItems = categoryItems(kit, 'lips');

  const basePicks = pickBestKitItems(baseItems, u, 2);
  const sculptPicks = pickBestKitItems(sculptItems, u, 2);
  const cheekPicks = pickBestKitItems(cheekItems, u, 2);
  const eyePicks = pickBestKitItems(eyeItems, u, 2);
  const lipPicks = pickBestKitItems(lipItems, u, 2);

  const products: SavedKitProduct[] = [];
  const lines: string[] = [];
  lines.push('Best matches from your kit:');

  const addProducts = (category: string, picks: KitItemLite[]) => {
    picks.forEach((it) => {
      const brand = String(it?.brand || '').trim();
      const name = String(it?.name || '').trim();
      const shade = String(it?.shade || '').trim();
      const fullName = [brand, name].filter(Boolean).join(' ').trim() || 'Unnamed item';
      products.push({ category, name: fullName, shade: shade || undefined });
    });
  };

  const block = (label: string, category: string, picks: KitItemLite[], first = false) => {
    if (!first) lines.push('');
    if (!picks.length) {
      lines.push(`${label}: (add items to your kit...)`);
      return;
    }
    lines.push(`${label}:`);
    picks.forEach((it) => lines.push(`- ${formatKitItemLine(it)}`));
    addProducts(category, picks);
  };

  block('Base', 'Base', basePicks, true);
  block('Sculpt', 'Sculpt', sculptPicks);
  block('Cheeks', 'Cheeks', cheekPicks);
  block('Eyes', 'Eyes', eyePicks);
  block('Lips', 'Lips', lipPicks);

  return { text: lines.join('\n'), products };
}

function undertoneDirection(u: UndertoneKey): 'cool' | 'neutral' | 'warm' {
  const n = undertoneToNumber(u);
  if (n > 0) return 'warm';
  if (n < 0) return 'cool';
  return 'neutral';
}

function seasonNuance(season: SeasonKey): string {
  return season === 'winter' ? 'clear' : season === 'autumn' ? 'rich' : season === 'spring' ? 'fresh' : 'soft';
}

function clampNumber(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

function roundToHalf(n: number): number {
  return Math.round(n * 2) / 2;
}

function formatHalf(n: number): string {
  const x = roundToHalf(n);
  return Number.isInteger(x) ? String(x) : x.toFixed(1);
}

function normalizeToneNumber(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
  if (!Number.isFinite(n)) return null;
  return clampNumber(roundToHalf(n), 1, 10);
}

type ToneDepth = 'very fair' | 'fair' | 'light' | 'medium' | 'tan' | 'deep';

function toneDepthFromNumber(n: number): ToneDepth {
  if (n <= 2) return 'very fair';
  if (n <= 3.5) return 'fair';
  if (n <= 5) return 'light';
  if (n <= 6.5) return 'medium';
  if (n <= 8) return 'tan';
  return 'deep';
}

function normalizeToneDepth(raw: unknown): ToneDepth | null {
  const s = String(raw || '').trim().toLowerCase();
  if (!s) return null;
  if (s === 'very fair' || s === 'very_fair' || s === 'very-fair') return 'very fair';
  if (s === 'fair') return 'fair';
  if (s === 'light') return 'light';
  if (s === 'medium') return 'medium';
  if (s === 'tan') return 'tan';
  if (s === 'deep') return 'deep';
  return null;
}

function foundationDescriptor(u: UndertoneKey): string {
  if (u === 'warm') return 'golden peach';
  if (u === 'neutral-warm') return 'neutral peach';
  if (u === 'neutral-cool') return 'neutral rosy';
  if (u === 'cool') return 'cool rosy';
  return 'neutral beige';
}

function foundationColorLabel(opts: { undertone: UndertoneKey; toneNumberRaw?: unknown; toneDepthRaw?: unknown }): string {
  const num = normalizeToneNumber(opts.toneNumberRaw) ?? 4.5;
  const depth = normalizeToneDepth(opts.toneDepthRaw) ?? toneDepthFromNumber(num);
  const desc = foundationDescriptor(opts.undertone);
  return `${formatHalf(num)} - ${depth}, ${desc}`;
}

function colorHint(category: 'cheeks' | 'eyes' | 'lips', u: UndertoneKey, season: SeasonKey): string {
  const dir = undertoneDirection(u);

  const pick = (cool: string, neutral: string, warm: string) => (dir === 'cool' ? cool : dir === 'warm' ? warm : neutral);

  let base = '';

  if (category === 'cheeks') {
    if (season === 'spring') base = pick('cool pink', 'peach-pink', 'peach/coral');
    else if (season === 'summer') base = pick('soft rose', 'dusty rose', 'soft peach');
    else if (season === 'autumn') base = pick('mauve-rose', 'rose-bronze', 'apricot/terracotta');
    else base = pick('berry', 'deep rose', 'warm red');

    return base;
  }

  if (category === 'eyes') {
    if (season === 'spring') base = pick('cool champagne', 'taupe-champagne', 'golden champagne');
    else if (season === 'summer') base = pick('cool taupe', 'soft taupe', 'warm taupe');
    else if (season === 'autumn') base = pick('cool brown', 'mushroom brown', 'bronze/olive');
    else base = pick('charcoal/plum', 'deep taupe', 'deep bronze');

    return base;
  }

  // lips
  if (season === 'spring') base = pick('raspberry pink', 'warm rose', 'coral');
  else if (season === 'summer') base = pick('mauve', 'rose', 'warm rose');
  else if (season === 'autumn') base = pick('berry-brown', 'rose-brown', 'brick/terracotta');
  else base = pick('blue-red/cranberry', 'classic red', 'true red');

  return base;
}

function buildBuyRecommendationsText(opts: {
  undertoneRaw: unknown;
  seasonRaw: unknown;
  toneNumberRaw?: unknown;
  toneDepthRaw?: unknown;
}): string {
  const u = normalizeUndertoneKey(opts.undertoneRaw);
  if (!u) return '';

  const season = normalizeSeasonKey(opts.seasonRaw) || 'summer';
  const buy = BUY_RECS[u] || BUY_RECS.neutral;

  const lines: string[] = [];
  lines.push('Recommended products (suggested colors):');

  const addBlock = (label: string, arr: string[], colorLabel: string) => {
    const list = Array.isArray(arr) ? arr.slice(0, 2) : [];
    if (!list.length) return;
    lines.push('');
    lines.push(`${label}:`);
    list.forEach((x) => {
      lines.push(`- ${x}`);
      if (colorLabel) lines.push(`- ${colorLabel}`);
    });
  };

  addBlock(
    'Base',
    buy.base,
    `Suggested color: ${foundationColorLabel({ undertone: u, toneNumberRaw: opts.toneNumberRaw, toneDepthRaw: opts.toneDepthRaw })}`
  );
  addBlock('Cheeks', buy.cheeks, `Suggested color: ${colorHint('cheeks', u, season)}`);
  addBlock('Eyes', buy.eyes, `Suggested color: ${colorHint('eyes', u, season)}`);
  addBlock('Lips', buy.lips, `Suggested color: ${colorHint('lips', u, season)}`);

  return lines.join('\n');
}

function formatBuyRecTextForChat(text: string): string {
  const src = String(text || '').replace(/\r\n/g, '\n');
  if (!src.trim()) return '';

  const lines = src.split('\n');
  const out: string[] = [];

  for (const line of lines) {
    const raw = String(line || '');
    if (!raw.startsWith('- ')) {
      out.push(raw);
      continue;
    }

    const body = raw.slice(2);
    const seps = [' — ', ' – ', ' - '];
    let split = false;

    for (const sep of seps) {
      const idx = body.indexOf(sep);
      if (idx <= 0) continue;

      const left = body.slice(0, idx).trim();
      const right0 = body.slice(idx + sep.length).trim();
      if (!left || !right0) continue;

      const rLower = right0.toLowerCase();
      const right =
        rLower.includes('color') || rLower.includes('shade') || rLower.includes('suggested')
          ? right0
          : `Color: ${right0}`;

      out.push(`- ${left}`);
      out.push(`- ${right}`);
      split = true;
      break;
    }

    if (!split) out.push(raw);
  }

  return out.join('\n');
}

function formatAnalysisToText(analysis: any): string {
  const undertone = displayUndertone(analysis?.undertone) || 'Unknown';
  const seasonKey = normalizeSeasonKey(analysis?.season);
  const seasonLabel = seasonKey ? `${seasonKey} (${seasonNuance(seasonKey)})` : 'unknown';

  const bestNeutrals = compactList(analysis?.recommendations?.best_neutrals);
  const accentColors = compactList(analysis?.recommendations?.accent_colors);
  const metals = compactList(analysis?.recommendations?.metals);
  const makeupTips = Array.isArray(analysis?.recommendations?.makeup_tips)
    ? (analysis.recommendations.makeup_tips as any[]).map((x) => String(x || '').trim()).filter(Boolean).slice(0, 6)
    : [];
  const avoid = Array.isArray(analysis?.recommendations?.avoid)
    ? (analysis.recommendations.avoid as any[]).map((x) => String(x || '').trim()).filter(Boolean).slice(0, 6)
    : [];

  const lines: string[] = [];
  lines.push(`Undertone: ${undertone}`);
  lines.push(`Season: ${seasonLabel}`);

  if (analysis?.photo_quality?.notes) {
    const q = String(analysis.photo_quality.notes).trim();
    if (q) {
      lines.push('');
      lines.push(`Photo notes: ${q}`);
    }
  }

  if (analysis?.reasoning_summary) {
    const rs = String(analysis.reasoning_summary).trim();
    if (rs) {
      lines.push('');
      lines.push(rs);
    }
  }

  if (bestNeutrals || accentColors || metals) {
    lines.push('');
    if (bestNeutrals) lines.push(`Best neutrals: ${bestNeutrals}`);
    if (accentColors) lines.push(`Accent colors: ${accentColors}`);
    if (metals) lines.push(`Metals: ${metals}`);
  }

  if (makeupTips.length) {
    lines.push('');
    lines.push('Makeup tips:');
    makeupTips.forEach((t) => lines.push(`- ${t}`));
  }

  if (avoid.length) {
    lines.push('');
    lines.push('Avoid:');
    avoid.forEach((t) => lines.push(`- ${t}`));
  }

  if (analysis?.disclaimer) {
    const d = String(analysis.disclaimer).trim();
    if (d) {
      lines.push('');
      lines.push(d);
    }
  }

  return lines.join('\n');
}

function formatChatTitle(item: HistoryItem): string {
  const a = item?.analysis ?? null;
  const undertone = displayUndertone(a?.undertone);

  return undertone || 'Scan';
}

function formatChatDate(iso: string): string {
  try {
    const d = new Date(iso);
    if (!Number.isFinite(d.getTime())) return '';
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  } catch {
    return '';
  }
}


const Upload: React.FC<UploadScreenProps> = ({ navigation, route, email, userId, token, onLogout }) => {
  // Scope local data per user (stable id preferred; fall back to email).
  const scope = useMemo(() => {
    const stable = String(userId ?? '').trim();
    if (stable) return stable;
    const e = String(email ?? '').trim().toLowerCase();
    return e || null;
  }, [email, userId]);

  const inventoryKey = useMemo(() => makeScopedKey(INVENTORY_STORAGE_KEY, scope), [scope]);
  const catalogKey = useMemo(() => makeScopedKey(CATALOG_STORAGE_KEY, scope), [scope]);
  const historyKey = useMemo(() => makeScopedKey(ANALYSIS_HISTORY_KEY, scope), [scope]);
  const chatKey = useMemo(() => makeScopedKey(CHAT_HISTORY_KEY, scope), [scope]);

  const tokenTrimmed = String(token ?? '').trim();

  const sessionExpiredRef = useRef(false);

  const maybeHandleUnauthorized = (status: number, msg: string): boolean => {
    const m = String(msg || '').trim();
    const looksUnauthorized =
      status === 401 ||
      status === 403 ||
      /invalid or expired session/i.test(m) ||
      /missing authorization token/i.test(m) ||
      /unauthor/i.test(m);

    if (!looksUnauthorized) return false;
    if (sessionExpiredRef.current) return true;
    sessionExpiredRef.current = true;

    Alert.alert('Session expired', 'Please log in again.', [
      {
        text: 'OK',
        onPress: () => {
          try {
            onLogout?.();
          } catch {
            // ignore
          }
        },
      },
    ]);

    return true;
  };

  // Safe-area insets can report 0 the first time a RN <Modal> is mounted.
  // Use Constants.statusBarHeight as an immediate fallback so the “Your scans” sheet
  // never renders too high on first open.
  const insets = useSafeAreaInsets();
  const tabBarHeight = useBottomTabBarHeight();
  const statusBarHeight = Number((Constants as any)?.statusBarHeight || 0);
  const topInsetFallback = Platform.OS === 'ios' ? statusBarHeight : 0;
  const chatListTopPad = Math.max(insets.top, topInsetFallback) + 10;
  // This sheet is anchored to the top (dropdown style). Bottom safe-area padding
  // adds a big empty gap on devices with a home indicator, so keep it tight.
  const chatListBottomPad = 12;

  const scrollRef = useRef<ScrollView | null>(null);

  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const [composer, setComposer] = useState('');

  const [needsAttentionCount, setNeedsAttentionCount] = useState(0);
  const [upcomingListCount, setUpcomingListCount] = useState(0);

  const [analysisId, setAnalysisId] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<any | null>(null);

  // A "draft" thread is created when the user taps the top “Scan” chip.
  // It keeps the UI on a fresh, blank chat while the camera is opened and
  // before the server returns an analysisId.
  const draftThreadIdRef = useRef<string | null>(null);

  // Keep a ref to the current active thread id so async flows (camera return)
  // can reliably attach analysis to the correct thread.
  const activeThreadIdRef = useRef<string | null>(null);
  useEffect(() => {
    activeThreadIdRef.current = analysisId;
  }, [analysisId]);

  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [chatStore, setChatStore] = useState<ChatStore>({});

  const [chatListOpen, setChatListOpen] = useState(false);
  const [chatListQuery, setChatListQuery] = useState('');
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [chatLoading, setChatLoading] = useState(false);

  const [photoPicking, setPhotoPicking] = useState(false);

  // Discover flow (manual undertone/season -> category -> type -> product rec)
  const [discoverOpen, setDiscoverOpen] = useState(false);
  const [discoverStep, setDiscoverStep] = useState<'tone' | 'category' | 'type' | 'results'>('tone');
  const [discoverTone, setDiscoverTone] = useState<DiscoverTone | null>(null);
  const [discoverSeason, setDiscoverSeason] = useState<SeasonKey | null>(null);
  const [discoverCategory, setDiscoverCategory] = useState<DiscoverCategory | null>(null);
  const [discoverType, setDiscoverType] = useState<string | null>(null);
  const [discoverLoading, setDiscoverLoading] = useState(false);
  const [discoverResults, setDiscoverResults] = useState<Array<{ name: string; shade?: string; itemType?: string }>>([]);
  const [discoverAdded, setDiscoverAdded] = useState<Record<string, boolean>>({});

  const discoverLauncherLabel = useMemo(() => {
    if (!discoverOpen) return 'Open discovery';

    const parts: string[] = [];
    if (discoverTone) parts.push(capWord(discoverTone));
    if (discoverSeason) parts.push(capWord(discoverSeason));
    if (discoverCategory) parts.push(discoverCategory);
    if (discoverType) parts.push(discoverType);

    if (!parts.length) return 'Open discovery';
    return parts.join(' • ');
  }, [discoverOpen, discoverTone, discoverSeason, discoverCategory, discoverType]);

  const discoverLauncherPlaceholder =
    !discoverOpen || (!discoverTone && !discoverSeason && !discoverCategory && !discoverType);

  // When returning from the Camera screen, it passes a `capturedPhoto` param.
  // Consume it once and immediately trigger analysis.
  const lastCapturedUriRef = useRef<string | null>(null);
  useEffect(() => {
    const captured: PickedPhoto | undefined = (route as any)?.params?.capturedPhoto;
    const uri = String((captured as any)?.uri || '').trim();
    if (!uri) return;

    // Guard against duplicate param merges.
    if (lastCapturedUriRef.current === uri) return;
    lastCapturedUriRef.current = uri;

    // Clear the param ASAP so it doesn't retrigger.
    try {
      navigation?.setParams?.({ capturedPhoto: undefined });
    } catch {
      // ignore
    }

    if (!analysisLoading && !chatLoading) {
      // Always prefer attaching the captured photo to the current *draft* thread
      // (created by the top “Scan” chip). This prevents the “Analyzing…” bubble
      // from ever jumping back into a previous, already-saved chat.
      void analyzePhoto({ ...captured, uri } as PickedPhoto, {
        targetThreadId: draftThreadIdRef.current,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [(route as any)?.params?.capturedPhoto]);

  // Keyboard tracking so the input bar stays above it.
  useEffect(() => {
    const showEvent = Platform.OS === 'android' ? 'keyboardDidShow' : 'keyboardWillShow';
    const hideEvent = Platform.OS === 'android' ? 'keyboardDidHide' : 'keyboardWillHide';

    const showListener = Keyboard.addListener(showEvent, (event) => {
      const height = (event as any)?.endCoordinates?.height ?? 0;
      setKeyboardHeight(height);
    });

    const hideListener = Keyboard.addListener(hideEvent, () => {
      setKeyboardHeight(0);
    });

    return () => {
      showListener.remove();
      hideListener.remove();
    };
  }, []);

  // Load counts + history + chat store when screen focuses.
  useEffect(() => {
    let alive = true;

    const refresh = async () => {
      try {
        const raw = await getString(inventoryKey);
        const count = countNeedsAttentionFromRaw(raw);
        if (alive) setNeedsAttentionCount(count);
      } catch {
        if (alive) setNeedsAttentionCount(0);
      }

      try {
        const raw = await getString(catalogKey);
        const count = countUpcomingListsFromRaw(raw);
        if (alive) setUpcomingListCount(count);
      } catch {
        if (alive) setUpcomingListCount(0);
      }

      let loadedHistory: HistoryItem[] = [];
      try {
        const stored = await getJson<HistoryItem[]>(historyKey);
        loadedHistory = Array.isArray(stored) ? stored : [];
      } catch {
        loadedHistory = [];
      }
      if (alive) setHistory(loadedHistory);

      try {
        const storedChat = await getJson<ChatStore>(chatKey);
        if (alive && storedChat && typeof storedChat === 'object') setChatStore(storedChat as any);
        if (alive && (!storedChat || typeof storedChat !== 'object')) setChatStore({});
      } catch {
        if (alive) setChatStore({});
      }

      // If we don't have an active analysis thread yet (including a draft thread),
      // restore the most recent from history.
      //
      // IMPORTANT: do NOT rely on `analysisId` here — this effect intentionally does
      // not depend on it, so it can be stale. Use refs for the current thread instead.
      const currentThread = String(activeThreadIdRef.current || '').trim();
      const currentDraft = String(draftThreadIdRef.current || '').trim();
      if (alive && !currentThread && !currentDraft && loadedHistory.length) {
        const mostRecent = loadedHistory[0];
        if (mostRecent?.id) {
          const id = String(mostRecent.id);
          activeThreadIdRef.current = id;
          draftThreadIdRef.current = null;
          setAnalysisId(id);
          setAnalysis(mostRecent.analysis ?? null);
        }
      }
    };

    refresh();
    const unsubscribe = navigation.addListener('focus', refresh);

    return () => {
      alive = false;
      if (typeof unsubscribe === 'function') unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navigation, inventoryKey, catalogKey, historyKey, chatKey]);

  useEffect(() => {
    // Auto-scroll when chat updates.
    const t = setTimeout(() => {
      scrollRef.current?.scrollToEnd({ animated: true });
    }, 0);
    return () => clearTimeout(t);
  }, [analysisId, chatStore]);

  useEffect(() => {
    // Auto-scroll when Discover results appear.
    if (!discoverOpen) return;
    if (discoverStep !== 'results') return;
    const t = setTimeout(() => {
      scrollRef.current?.scrollToEnd({ animated: true });
    }, 0);
    return () => clearTimeout(t);
  }, [discoverOpen, discoverStep, discoverResults.length]);

  const saveHistory = async (items: HistoryItem[]) => {
    setHistory(items);
    try {
      await setJson(historyKey, items);
    } catch {
      // ignore
    }
  };

  const saveChatStore = async (store: ChatStore) => {
    setChatStore(store);
    try {
      await setJson(chatKey, store);
    } catch {
      // ignore
    }
  };

  const readHistoryFromStorage = async (): Promise<HistoryItem[]> => {
    try {
      const stored = await getJson<HistoryItem[]>(historyKey);
      return Array.isArray(stored) ? stored : [];
    } catch {
      return [];
    }
  };

  const readChatStoreFromStorage = async (): Promise<ChatStore> => {
    try {
      const stored = await getJson<ChatStore>(chatKey);
      if (stored && typeof stored === 'object') return stored as any;
      return {};
    } catch {
      return {};
    }
  };

  const ensureHistoryEntry = async (id: string, nextAnalysis: any, createdAt?: string) => {
    const idStr = String(id || '').trim();
    if (!idStr) return;

    const base = await readHistoryFromStorage();
    const idx = base.findIndex((h) => String(h?.id || '') === idStr);
    const ts = String(createdAt || '').trim() || new Date().toISOString();

    let next: HistoryItem[] = [];
    if (idx >= 0) {
      const existing = base[idx];
      const merged: HistoryItem = {
        id: idStr,
        createdAt: String(existing?.createdAt || ts),
        analysis: nextAnalysis ?? existing?.analysis ?? null,
      };

      next = [merged, ...base.filter((_, i) => i !== idx)].slice(0, 20);
    } else {
      next = [{ id: idStr, createdAt: ts, analysis: nextAnalysis ?? null }, ...base].slice(0, 20);
    }

    await saveHistory(next);
  };

  const getChatFor = (id: string | null): ChatMessage[] => {
    if (!id) return [];
    const arr = (chatStore as any)?.[id];
    return Array.isArray(arr) ? arr : [];
  };

  const upsertChatFor = async (id: string, messages: ChatMessage[]) => {
    const limited = messages.slice(-60);

    // Merge with what’s on-disk so a slow initial load can’t overwrite prior chats.
    const fromDisk = await readChatStoreFromStorage();
    const merged: ChatStore = { ...(fromDisk || {}), ...(chatStore || {}) };
    merged[id] = limited;

    await saveChatStore(merged);
  };

  const activeChat = getChatFor(analysisId);

  const hasKitRecs = useMemo(() => activeChat.some((m) => m?.kind === 'kit_recs'), [activeChat]);
  const hasBuyRecs = useMemo(() => activeChat.some((m) => m?.kind === 'buy_recs'), [activeChat]);

  const lastUnsavedKitRecId = useMemo(() => {
    for (let i = activeChat.length - 1; i >= 0; i--) {
      const m = activeChat[i];
      if (m?.kind === 'kit_recs' && !m?.savedListId) return m.id;
    }
    return null;
  }, [activeChat]);

  const activeChatTitle = useMemo(() => {
    if (!analysisId) return 'Your scans';
    const hit = history.find((h) => String(h?.id || '') === String(analysisId));
    return hit ? formatChatTitle(hit) : 'Your scans';
  }, [analysisId, history]);

  const filteredHistory = useMemo(() => {
    const q = String(chatListQuery || '').trim().toLowerCase();
    if (!q) return history;
    return history.filter((h) => {
      const title = formatChatTitle(h).toLowerCase();
      const date = formatChatDate(String(h?.createdAt || '')).toLowerCase();
      return title.includes(q) || date.includes(q);
    });
  }, [history, chatListQuery]);

  const promptOpenSettings = (title: string, message: string) => {
    Alert.alert(title, message, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Open Settings',
        onPress: () => {
          try {
            void Linking.openSettings();
          } catch {
            // ignore
          }
        },
      },
    ]);
  };

  // --- Discover helpers ---
  const openDiscover = () => {
    Keyboard.dismiss();
    setDiscoverStep('tone');
    setDiscoverTone(null);
    setDiscoverSeason(null);
    setDiscoverCategory(null);
    setDiscoverType(null);
    setDiscoverResults([]);
    setDiscoverAdded({});
    setDiscoverLoading(false);
    setDiscoverOpen(true);
  };

  const closeDiscover = () => {
    Keyboard.dismiss();
    setDiscoverOpen(false);
  };

  const fetchDiscoverRecommendations = async (selectedType: string) => {
    const type = String(selectedType || '').trim();
    if (!type) return;

    if (!tokenTrimmed) {
      Alert.alert('Not logged in', 'Please log in again.');
      return;
    }
    if (!discoverTone || !discoverCategory) return;
    if (discoverLoading) return;

    setDiscoverLoading(true);
    setDiscoverResults([]);
    setDiscoverAdded({});

    const endpoints = ['/discover-recommend', '/api/discover-recommend', '/api/v1/discover-recommend'];

    try {
      let lastErr: any = null;

      for (const ep of endpoints) {
        const resp = await fetch(`${API_BASE}${ep}`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${tokenTrimmed}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            undertone: discoverTone,
            season: discoverSeason,
            category: discoverCategory,
            productType: type,
            tone_number: typeof (analysis as any)?.tone_number === 'number' ? (analysis as any).tone_number : undefined,
            tone_depth: String((analysis as any)?.tone_depth || '').trim() || undefined,
          }),
        });

        const txt = await resp.text().catch(() => '');
        let json: any = null;
        try {
          json = txt ? JSON.parse(txt) : null;
        } catch {
          json = null;
        }

        const errMsg = String(json?.error || json?.message || `HTTP ${resp.status}`);
        const errCode = String(json?.code || '').trim();

        // Token expired / invalid: force re-login.
        if (maybeHandleUnauthorized(resp.status, errMsg)) {
          return;
        }

        // If this path doesn't exist on the server, try the next alias.
        if (resp.status === 404) {
          lastErr = new Error(`HTTP 404`);
          continue;
        }

        // Plan/usage limits
        if (resp.status === 402 && errCode === 'DISCOVERY_LIMIT_REACHED') {
          const limit = Number(json?.limit ?? NaN);
          const hasLimit = Number.isFinite(limit);
          const isPro = hasLimit ? limit > 1 : false;
          const period = String(json?.period || '').trim();
          const periodLabel = period === 'year' ? ' this year' : period === 'month' ? ' this month' : '';

          const unit = hasLimit && limit === 1 ? 'product discovery' : 'product discoveries';
          const base = hasLimit
            ? `You've reached your limit of ${limit.toLocaleString()} ${unit}${isPro ? periodLabel : ''}.`
            : `You've reached your ${unit} limit${isPro ? periodLabel : ''}.`;

          const message = isPro ? base : `${base} Upgrade to Pro to add more.`;

          const title = isPro ? 'Limit reached' : 'Upgrade to Pro';

          Alert.alert(
            title,
            message,
            isPro
              ? [{ text: 'OK' }]
              : [
                  { text: 'Later', style: 'cancel' },
                  {
                    text: 'Upgrade',
                    onPress: () => {
                      try {
                        navigation.navigate('Account', { openUpgrade: true });
                      } catch {
                        navigation.navigate('Account');
                      }
                    },
                  },
                ]
          );
          return;
        }

        if (!resp.ok || !json?.ok) {
          throw new Error(errMsg);
        }

        const list = Array.isArray(json?.products) ? json.products : [];
        const wantsTwo = type.toLowerCase() === 'eyeshadow';
        const normalized = list
          .map((p: any) => ({
            name: String(p?.name || p?.product_name || '').trim(),
            // Always prefer an explicit shade/variant label; we never show "why" text in Discover results.
            shade: String(p?.shade || p?.color_name || p?.color || p?.variant || '').trim() || undefined,
            itemType: String(p?.item_type || p?.itemType || '').trim() || undefined,
          }))
          .filter((p: any) => !!p.name)
          .slice(0, wantsTwo ? 2 : 1);

        setDiscoverResults(normalized);
        setDiscoverStep('results');
        return;
      }

      // If all aliases 404, surface a clearer error.
      throw lastErr || new Error('HTTP 404');
    } catch (e: any) {
      Alert.alert('Discover failed', String(e?.message || e));
    } finally {
      setDiscoverLoading(false);
    }
  };

  const addDiscoverItemToKit = async (productName: string, shade?: string, itemType?: string) => {
    const name = String(productName || '').trim();
    if (!name) return;
    const category = discoverCategory;
    const subcategory = String(discoverType || '').trim();
    if (!category || !subcategory) return;

    const shadeTrimmed = String(shade || '').trim();
    const addedKey = `${name}__${shadeTrimmed}`;
    if (discoverAdded[addedKey]) return;

    // Optimistic UI feedback (no pop-up)
    setDiscoverAdded((prev) => ({ ...prev, [addedKey]: true }));

    const now = Date.now();
    const uid = (prefix: string) => `${prefix}_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

    const DEFAULT_KIT_CATS = [
      'Prep & Finish',
      'Base',
      'Cheeks',
      'Sculpt',
      'Lips',
      'Eyes',
      'Brows',
      'Tools',
      'Hygiene & Disposables',
      'Other',
    ];

    let kit: any = null;
    try {
      kit = await getJson<any>(inventoryKey);
    } catch {
      kit = null;
    }

    let categories = Array.isArray(kit?.categories)
      ? kit.categories
      : DEFAULT_KIT_CATS.map((n) => ({ id: uid('cat'), name: n, createdAt: now, items: [] }));

    const idx = categories.findIndex(
      (c: any) => String(c?.name || '').trim().toLowerCase() === String(category).trim().toLowerCase()
    );

    if (idx < 0) {
      categories = [{ id: uid('cat'), name: category, createdAt: now, items: [] }, ...categories];
    }

    const catObj = idx >= 0 ? categories[idx] : categories[0];
    const items = Array.isArray(catObj?.items) ? catObj.items : [];

    const nextItem = {
      id: uid('item'),
      name,
      shade: String(shade || '').trim() || undefined,
      type: String(itemType || '').trim() || undefined,
      subcategory,
      status: 'inKit',
      notes: 'Added from Discover',
      createdAt: now,
      updatedAt: now,
    };

    catObj.items = [nextItem, ...items];

    try {
      await setJson(inventoryKey, { version: 1, categories });
    } catch (e: any) {
      setDiscoverAdded((prev) => {
        const next = { ...prev };
        delete next[addedKey];
        return next;
      });
      Alert.alert('Add failed', String(e?.message || e));
    }
  };

  const requestLibrary = async (): Promise<boolean> => {
    // iOS: if user previously denied, request may not prompt again unless they change Settings.
    // We check current status first, then request if possible.
    let perm = await ImagePicker.getMediaLibraryPermissionsAsync();
    if (!perm.granted && perm.canAskAgain) {
      perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    }
    if (!perm.granted) {
      promptOpenSettings('Permission needed', 'Please allow Photos access to upload a picture.');
      return false;
    }
    return true;
  };

  const requestCamera = async (): Promise<boolean> => {
    let perm = await ImagePicker.getCameraPermissionsAsync();
    if (!perm.granted && perm.canAskAgain) {
      perm = await ImagePicker.requestCameraPermissionsAsync();
    }
    if (!perm.granted) {
      promptOpenSettings('Permission needed', 'Please allow Camera access to take a picture.');
      return false;
    }
    return true;
  };

  const pickPhoto = async (source: 'camera' | 'library'): Promise<PickedPhoto | null> => {
    if (source === 'library') {
      const ok = await requestLibrary();
      if (!ok) {
        return null;
      }

      let result: ImagePicker.ImagePickerResult;
      try {
        // Expo SDK 54+: mediaTypes is an array of MediaType strings.
        // https://docs.expo.dev/versions/latest/sdk/imagepicker/
        result = await ImagePicker.launchImageLibraryAsync({
          mediaTypes: ['images'],
          allowsEditing: false,
          quality: 0.92,
          selectionLimit: 1,
        });
      } catch (e: any) {
        Alert.alert('Upload photo failed', String(e?.message || e));
        return null;
      }

      if (result.canceled) return null;
      const asset = result.assets?.[0];
      if (!asset?.uri) return null;

      return {
        uri: asset.uri,
        fileName: asset.fileName || 'face.jpg',
        mimeType: asset.mimeType || 'image/jpeg',
        source,
      };
    }

    const ok = await requestCamera();
    if (!ok) {
      return null;
    }

    let result: ImagePicker.ImagePickerResult;
    try {
      result = await ImagePicker.launchCameraAsync({
        mediaTypes: ['images'],
        allowsEditing: false,
        quality: 0.92,
        cameraType: ImagePicker.CameraType.front,
      });
    } catch (e: any) {
      Alert.alert('Take photo failed', String(e?.message || e));
      return null;
    }

    if (result.canceled) return null;
    const asset = result.assets?.[0];
    if (!asset?.uri) return null;

    return {
      uri: asset.uri,
      fileName: asset.fileName || 'face.jpg',
      mimeType: asset.mimeType || 'image/jpeg',
      source,
      width: (asset as any)?.width,
      height: (asset as any)?.height,
    };
  };

  const analyzePhoto = async (
    picked: PickedPhoto,
    opts?: {
      targetThreadId?: string | null;
    }
  ) => {
    if (!tokenTrimmed) {
      Alert.alert('Not logged in', 'Please log in again.');
      return;
    }

    setComposer('');
    Keyboard.dismiss();

    // Decide which chat thread should receive this photo's analysis.
    //
    // If the user already opened a fresh blank chat using the top “Scan” chip,
    // we keep that draft thread active while we show “Analyzing…”. Otherwise,
    // a new photo should NOT overwrite the currently-open scan thread — so we
    // create a new draft thread automatically.
    const requested = String(opts?.targetThreadId ?? '').trim();
    const currentId = String(analysisId ?? '').trim();
    const currentDraft = String(draftThreadIdRef.current ?? '').trim();
    const requestedIsDraft = !!requested && requested === currentDraft;
    const currentIsDraft = !!currentId && currentId === currentDraft;

    let draftThreadId: string;

    if (requestedIsDraft) {
      draftThreadId = requested;
    } else if (currentIsDraft) {
      draftThreadId = currentId;
    } else {
      // Best-effort: make sure the current scan exists in history before switching away.
      if (currentId && analysis) {
        try {
          await ensureHistoryEntry(currentId, analysis);
        } catch {
          // ignore
        }
      }

      draftThreadId = makeId();
      draftThreadIdRef.current = draftThreadId;
      activeThreadIdRef.current = draftThreadId;
      lastCapturedUriRef.current = null;

      setAnalysisId(draftThreadId);
    }

    // Make sure downstream async flows always attach to this draft thread.
    activeThreadIdRef.current = draftThreadId;
    draftThreadIdRef.current = draftThreadId;

    // Ensure the UI is on the draft thread while loading.
    if (String(analysisId ?? '').trim() !== draftThreadId) {
      setAnalysisId(draftThreadId);
    }
    setAnalysis(null);

    setAnalysisLoading(true);

    try {
      // Normalize inputs for Vision reliability:
      // - Convert to JPEG (avoids HEIC/HEIF issues)
      // - Center-crop library photos to a portrait-ish frame
      // - Resize to a sane max width
      let prepared: PickedPhoto = picked;

      try {
        const uriLower = String(prepared?.uri || '').toLowerCase();
        const mtLower = String(prepared?.mimeType || '').toLowerCase();
        const looksHeic =
          mtLower.includes('heic') ||
          mtLower.includes('heif') ||
          uriLower.endsWith('.heic') ||
          uriLower.endsWith('.heif') ||
          uriLower.includes('heic');

        const shouldCenterCrop = prepared.source === 'library';
        const shouldReencodeCamera = prepared.source === 'camera';

        // Use provided dimensions when available (ImagePicker often gives these).
        // If missing, try to resolve them from the file uri.
        let w = Number(prepared.width || 0);
        let h = Number(prepared.height || 0);
        if ((shouldCenterCrop || shouldReencodeCamera) && (!w || !h)) {
          const size = await getImageSizeAsync(prepared.uri);
          if (size) {
            w = Number(size.width || 0);
            h = Number(size.height || 0);
          }
        }

        const actions: any[] = [];

        // Library photos: center-crop to a portrait-ish frame (keeps face centered without relying on overlay math).
        if (shouldCenterCrop && w > 0 && h > 0) {
          // Portrait-ish aspect ratio (width / height).
          const targetAspect = 3 / 4;

          let cropW = w;
          let cropH = Math.round(cropW / targetAspect);

          if (cropH > h) {
            cropH = h;
            cropW = Math.round(cropH * targetAspect);
          }

          const originX = Math.max(0, Math.round((w - cropW) / 2));
          const originY = Math.max(0, Math.round((h - cropH) / 2));

          actions.push({
            crop: { originX, originY, width: cropW, height: cropH },
          });

          // Resize down if huge (keeps uploads fast and consistent).
          const maxWidth = 1536;
          if (w > maxWidth) {
            actions.push({ resize: { width: maxWidth } });
          }
        } else {
          // If we couldn't crop, still resize down if huge.
          const maxWidth = 1536;
          if (w > maxWidth) {
            actions.push({ resize: { width: maxWidth } });
          }
        }

        // Re-encode camera images to consistent JPEG (helps Vision), and also re-encode when converting HEIC/HEIF or applying transforms.
        if (looksHeic || actions.length > 0 || shouldReencodeCamera) {
          const result = await ImageManipulator.manipulateAsync(
            prepared.uri,
            actions.length ? actions : [],
            { compress: 0.95, format: ImageManipulator.SaveFormat.JPEG }
          );

          if (result?.uri) {
            prepared = {
              ...prepared,
              uri: result.uri,
              mimeType: 'image/jpeg',
              fileName: prepared.fileName?.replace(/\.(heic|heif)$/i, '.jpg') || 'face.jpg',
            };
          }
        } else if (mtLower && !mtLower.includes('jpeg') && !mtLower.includes('jpg')) {
          // Some platforms report odd mime types even for jpg; force to jpeg.
          prepared = { ...prepared, mimeType: 'image/jpeg' };
        }
      } catch {
        // ignore preprocessing errors; we can still try sending the original
      }

      const form = new FormData();
      form.append('image', {
        uri: prepared.uri,
        name: prepared.fileName,
        type: prepared.mimeType,
      } as any);
      form.append('source', prepared.source);

      const res = await fetch(`${API_BASE}/analyze-face`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${tokenTrimmed}`,
          accept: 'application/json',
        } as any,
        body: form as any,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.ok === false) {
        const code = String(data?.code || '').trim();
        const msg = String(data?.error || `HTTP ${res.status}`);

        if (maybeHandleUnauthorized(res.status, msg)) {
          return;
        }

        if (res.status === 402 && code === 'UPLOAD_LIMIT_REACHED') {
          const limit = Number(data?.limit ?? NaN);
          const period = String(data?.period || '').trim();
          const hasLimit = Number.isFinite(limit);
          const isPro = hasLimit ? limit > 5 : false;
          const unit = hasLimit && limit === 1 ? 'scan' : 'scans';
          const periodLabel = period === 'year' ? ' this year' : period === 'month' ? ' this month' : '';

          const base = hasLimit
            ? `You've reached your limit of ${limit.toLocaleString()} ${unit}${isPro ? periodLabel : ''}.`
            : `You've reached your ${unit} limit${isPro ? periodLabel : ''}.`;

          const message = isPro ? base : `${base} Upgrade to Pro to add more.`;

          const title = isPro ? 'Limit reached' : 'Upgrade to Pro';

          Alert.alert(
            title,
            message,
            isPro
              ? [{ text: 'OK' }]
              : [
                  { text: 'Later', style: 'cancel' },
                  {
                    text: 'Upgrade',
                    onPress: () => {
                      try {
                        navigation.navigate('Account', { openUpgrade: true });
                      } catch {
                        navigation.navigate('Account');
                      }
                    },
                  },
                ]
          );
          return;
        }

        if (res.status === 422 && code === 'NO_HUMAN_FACE') {
          Alert.alert('No human face detected', msg);
          return;
        }
        if (res.status === 422) {
          Alert.alert('Photo not usable', msg);
          return;
        }

        throw new Error(msg);
      }

      const serverId = String(data?.analysisId || makeId());
      const nextAnalysis = data?.analysisStable ?? data?.analysis ?? null;
      const createdAtIso = new Date().toISOString();

      // We now have a stable server analysisId, so leave draft-mode.
      draftThreadIdRef.current = null;
      activeThreadIdRef.current = serverId;

      setAnalysisId(serverId);
      setAnalysis(nextAnalysis);

      // Save analysis history (local) using what's currently on-disk as base.
      const baseHistory = await readHistoryFromStorage();
      const nextHistory: HistoryItem[] = [
        { id: serverId, createdAt: createdAtIso, analysis: nextAnalysis },
        ...baseHistory.filter((h) => String(h?.id || '') !== String(serverId)),
      ].slice(0, 20);
      await saveHistory(nextHistory);

      // Seed chat with: "photo uploaded" + analysis summary.
      const seedMsgs: ChatMessage[] = [
        {
          id: makeId(),
          role: 'user',
          text: 'Uploaded face photo.',
          createdAt: createdAtIso,
        },
        {
          id: makeId(),
          role: 'assistant',
          kind: 'analysis',
          text: formatAnalysisToText(nextAnalysis),
          createdAt: createdAtIso,
        },
      ];

      await upsertChatFor(serverId, seedMsgs);
    } catch (e: any) {
      Alert.alert('Analysis failed', String(e?.message || e));
    } finally {
      setAnalysisLoading(false);
    }
  };

  async function choosePhoto(source: 'camera' | 'library') {
    if (analysisLoading || photoPicking) return;
    Keyboard.dismiss();

    if (source === 'camera') {
      // Web builds: prefer ImagePicker's camera (more reliable than expo-camera web capture).
      if (Platform.OS === 'web') {
        setPhotoPicking(true);
        try {
          const picked = await pickPhoto('camera');
          if (!picked) return;
          await analyzePhoto(picked);
        } finally {
          setPhotoPicking(false);
        }
        return;
      }

      try {
        navigation.navigate('Camera');
      } catch {
        // ignore
      }
      return;
    }

    setPhotoPicking(true);
    try {
      const picked = await pickPhoto('library');
      if (!picked) return;

      await analyzePhoto(picked);
    } finally {
      setPhotoPicking(false);
    }
  }


  const openChatList = () => {
    Keyboard.dismiss();
    setChatListOpen(true);
  };

  const startNewChat = async () => {
    setChatListOpen(false);
    setChatListQuery('');
    Keyboard.dismiss();

    const currentId = String(analysisId || '').trim();
    const isDraft = !!currentId && draftThreadIdRef.current === currentId;

    // Ensure the currently-open chat is present in history so it shows in “Your scans”.
    if (currentId && analysis && !isDraft) {
      try {
        await ensureHistoryEntry(currentId, analysis);
      } catch {
        // ignore
      }
    }

    // Open a fresh blank thread (no camera here — camera is triggered from the bottom icon).
    const nextDraftId = makeId();
    draftThreadIdRef.current = nextDraftId;
    activeThreadIdRef.current = nextDraftId;
    lastCapturedUriRef.current = null;

    setAnalysisId(nextDraftId);
    setAnalysis(null);
    setComposer('');
  };

  const selectChat = (item: HistoryItem) => {
    const id = String(item?.id || '').trim();
    if (!id) return;
    draftThreadIdRef.current = null;
    activeThreadIdRef.current = id;
    setAnalysisId(id);
    setAnalysis(item?.analysis ?? null);
    setChatListOpen(false);
  };

  const deleteChat = (id: string) => {
    Alert.alert('Delete scan?', 'This will remove the scan and its messages from this device.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          const baseHistory = await readHistoryFromStorage();
          const nextHistory = baseHistory.filter((h) => String(h?.id) !== String(id));
          await saveHistory(nextHistory);

          const fromDisk = await readChatStoreFromStorage();
          const merged: ChatStore = { ...(fromDisk || {}), ...(chatStore || {}) };
          delete (merged as any)[id];
          await saveChatStore(merged);

          if (String(analysisId) === String(id)) {
            const fallback = nextHistory[0] || null;
            setAnalysisId(fallback?.id ? String(fallback.id) : null);
            setAnalysis(fallback?.analysis ?? null);
          }
        },
      },
    ]);
  };

  const recommendFromKit = async () => {
    if (!analysisId) return;
    const undertoneRaw = analysis?.undertone;

    let kitRaw: string | null = null;
    try {
      kitRaw = await getString(inventoryKey);
    } catch {
      kitRaw = null;
    }

    const payload = buildKitRecommendationsPayload({ undertoneRaw, kitRaw });
    const text = String(payload?.text || '').trim();
    if (!text) return;

    const assistantMsg: ChatMessage = {
      id: makeId(),
      role: 'assistant',
      kind: 'kit_recs',
      text,
      kitProducts: Array.isArray(payload?.products) ? payload.products : [],
      createdAt: new Date().toISOString(),
    };

    const current = getChatFor(analysisId);
    await upsertChatFor(analysisId, [...current, assistantMsg]);
  };

  const saveScanToList = async () => {
    if (!analysis) return;

    // Grab the most recent kit recommendations (if any) so Save can persist them.
    const latestKitMsg = [...activeChat].reverse().find((m) => m?.kind === 'kit_recs');
    const kitProducts = Array.isArray((latestKitMsg as any)?.kitProducts) ? (latestKitMsg as any).kitProducts : [];

    // Read existing catalog
    let catalog: any = null;
    try {
      catalog = await getJson<any>(catalogKey);
    } catch {
      catalog = null;
    }

    const existingLists = readListsFromCatalog(catalog);

    const scanKey = String(analysisId || '').trim();
    const existingIdx = scanKey
      ? existingLists.findIndex((c: any) => String(c?.scanAnalysisId || '').trim() === scanKey)
      : -1;

    // Next "Scan N" label
    let max = 0;
    existingLists.forEach((c: any) => {
      const name = String(c?.displayName || '').trim();
      const m = /^scan\s+(\d+)$/i.exec(name);
      if (!m) return;
      const n = Number(m[1]);
      if (Number.isFinite(n) && n > max) max = n;
    });
    const scanLabel = existingIdx >= 0 ? String(existingLists[existingIdx]?.displayName || '').trim() || `Scan ${max + 1}` : `Scan ${max + 1}`;

    const now = Date.now();
    const uid = (prefix: string) => `${prefix}_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

    const undertoneKey = normalizeUndertoneKey(analysis?.undertone);
    const seasonKey = normalizeSeasonKey(analysis?.season);

    const makeListProducts = (arr: any[]) =>
      arr
        .map((p: any) => ({
          id: uid('prod'),
          category: String(p?.category || 'Base'),
          name: String(p?.name || '').trim(),
          shade: String(p?.shade || '').trim(),
          notes: 'Recommended from kit',
          createdAt: now,
          updatedAt: now,
        }))
        .filter((p: any) => !!p.name);

    const nextProducts = makeListProducts(kitProducts);

    const mergeProducts = (baseArr: any[], addArr: any[]) => {
      const base = Array.isArray(baseArr) ? baseArr : [];
      if (!addArr.length) return base;
      const seen = new Set(base.map((p: any) => `${String(p?.category || '')}|${String(p?.name || '')}`.toLowerCase()));
      const merged = [...base];
      addArr.forEach((p: any) => {
        const k = `${String(p?.category || '')}|${String(p?.name || '')}`.toLowerCase();
        if (seen.has(k)) return;
        seen.add(k);
        merged.push(p);
      });
      return merged;
    };

    const baseList = existingIdx >= 0 ? existingLists[existingIdx] : null;
    const listId = String(baseList?.id || '') || uid('list');

    const nextList: any = {
      ...(baseList || {}),
      id: listId,
      displayName: String(baseList?.displayName || scanLabel),
      undertone: (undertoneKey || 'unknown') as any,
      season: seasonKey || null,
      trialDate: String(baseList?.trialDate || ''),
      finalDate: String(baseList?.finalDate || ''),
      eventType: String(baseList?.eventType || ''),
      notes: String(baseList?.notes || ''),
      products: mergeProducts(baseList?.products, nextProducts),
      createdAt: typeof baseList?.createdAt === 'number' ? baseList.createdAt : now,
      updatedAt: now,
      scanAnalysisId: scanKey || undefined,
    };

    const nextLists = existingIdx >= 0
      ? existingLists.map((c: any, i: number) => (i === existingIdx ? nextList : c))
      : [nextList, ...existingLists];

    const nextCatalog = {
      version: 1,
      lists: nextLists,
    };

    try {
      await setJson(catalogKey, nextCatalog);
      Alert.alert('Saved', `${nextList.displayName} was added to List.`);
    } catch (e: any) {
      Alert.alert('Save failed', String(e?.message || e));
    }
  };

  const recommendToBuy = async () => {
    if (!analysisId) return;
    if (!tokenTrimmed) {
      Alert.alert('Not logged in', 'Please log in again.');
      return;
    }
    if (chatLoading) return;

    setChatLoading(true);

    try {
      // Prefer server-side recommendations so we can attach real retailer color names.
      let serverText = '';
      try {
        const resp = await fetch(`${API_BASE}/recommend-products`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${tokenTrimmed}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            undertone: analysis?.undertone,
            season: analysis?.season,
            tone_number: (analysis as any)?.tone_number,
            tone_depth: (analysis as any)?.tone_depth,
          }),
        });

        const json = await resp.json().catch(() => null);
        const errMsg = String(json?.error || json?.message || `HTTP ${resp.status}`);
        if (maybeHandleUnauthorized(resp.status, errMsg)) {
          return;
        }
        if (resp.ok && json?.ok && typeof json?.text === 'string') {
          serverText = String(json.text || '').trim();
        }
      } catch {
        serverText = '';
      }

      // Fallback: local color guidance (no retailer shade names).
      const fallback = buildBuyRecommendationsText({
        undertoneRaw: analysis?.undertone,
        seasonRaw: analysis?.season,
        toneNumberRaw: (analysis as any)?.tone_number,
        toneDepthRaw: (analysis as any)?.tone_depth,
      });

      const tRaw = String(serverText || fallback || '').trim();
      if (!tRaw) return;

      const t = formatBuyRecTextForChat(tRaw);

      const assistantMsg: ChatMessage = {
        id: makeId(),
        role: 'assistant',
        kind: 'buy_recs',
        text: t,
        createdAt: new Date().toISOString(),
      };

      const current = getChatFor(analysisId);
      await upsertChatFor(analysisId, [...current, assistantMsg]);
    } catch (e: any) {
      Alert.alert('Recommend products failed', String(e?.message || e));
    } finally {
      setChatLoading(false);
    }
  };

  const saveKitRecsToList = async (kitMsgId: string) => {
    if (!analysisId) return;
    const msgs = getChatFor(analysisId);
    const hit = msgs.find((m) => m.id === kitMsgId);
    if (!hit || hit.kind !== 'kit_recs') return;
    if (hit.savedListId) return;

    const products = Array.isArray(hit.kitProducts) ? hit.kitProducts : [];

    // Read existing catalog
    let catalog: any = null;
    try {
      catalog = await getJson<any>(catalogKey);
    } catch {
      catalog = null;
    }

    const existingLists = readListsFromCatalog(catalog);

    // Next "Scan N" label
    let max = 0;
    existingLists.forEach((c: any) => {
      const name = String(c?.displayName || '').trim();
      const m = /^scan\s+(\d+)$/i.exec(name);
      if (!m) return;
      const n = Number(m[1]);
      if (Number.isFinite(n) && n > max) max = n;
    });
    const scanLabel = `Scan ${max + 1}`;

    const now = Date.now();
    const uid = (prefix: string) => `${prefix}_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

    const undertoneKey = normalizeUndertoneKey(analysis?.undertone);
    const seasonKey = normalizeSeasonKey(analysis?.season);

    const listId = uid('list');
    const listProducts = products.map((p) => ({
      id: uid('prod'),
      category: String(p?.category || 'Base'),
      name: String(p?.name || '').trim(),
      shade: String(p?.shade || '').trim(),
      notes: 'Recommended from kit',
      createdAt: now,
      updatedAt: now,
    })).filter((p: any) => !!p.name);

    const nextList: any = {
      id: listId,
      displayName: scanLabel,
      undertone: (undertoneKey || 'unknown') as any,
      season: seasonKey || null,
      trialDate: '',
      finalDate: '',
      eventType: '',
      notes: '',
      products: listProducts,
      createdAt: now,
      updatedAt: now,
    };

    const nextCatalog = {
      version: 1,
      lists: [nextList, ...existingLists],
    };

    try {
      await setJson(catalogKey, nextCatalog);
    } catch (e: any) {
      Alert.alert('Save failed', String(e?.message || e));
      return;
    }

    const nextMsgs = msgs.map((m) => (m.id === kitMsgId ? { ...m, savedListId: listId } : m));
    await upsertChatFor(analysisId, nextMsgs);

    Alert.alert('Saved', `${scanLabel} was added to List.`);
  };


  const sendChat = async (text: string) => {
    const msg = String(text || '').trim();
    if (!msg) return;

    if (!analysisId || !analysis) {
      Alert.alert('Scan a face photo first', 'Take a face photo in this chat before messaging.');
      return;
    }
    if (!tokenTrimmed) {
      Alert.alert('Not logged in', 'Please log in again.');
      return;
    }
    if (chatLoading) return;

    setComposer('');

    const userMsg: ChatMessage = {
      id: makeId(),
      role: 'user',
      text: msg,
      createdAt: new Date().toISOString(),
    };

    const nextMsgs = [...activeChat, userMsg];
    await upsertChatFor(analysisId, nextMsgs);

    setChatLoading(true);
    try {
      const historyForServer = nextMsgs
        .slice(-14)
        .slice(0, -1)
        .map((m) => ({ role: m.role, content: m.text }));

      const res = await fetch(`${API_BASE}/analysis-chat`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${tokenTrimmed}`,
          accept: 'application/json',
          'Content-Type': 'application/json',
        } as any,
        body: JSON.stringify({
          analysisId,
          message: msg,
          history: historyForServer,
        }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.ok === false) {
        const errMsg = String(data?.error || data?.message || `HTTP ${res.status}`);
        if (maybeHandleUnauthorized(res.status, errMsg)) {
          return;
        }
        throw new Error(errMsg);
      }

      const replyText = String(data?.reply || '').trim();
      if (!replyText) throw new Error('Empty reply');

      const assistantMsg: ChatMessage = {
        id: makeId(),
        role: 'assistant',
        text: replyText,
        createdAt: new Date().toISOString(),
      };

      await upsertChatFor(analysisId, [...nextMsgs, assistantMsg]);
    } catch (e: any) {
      Alert.alert('Chat failed', String(e?.message || e));
    } finally {
      setChatLoading(false);
    }
  };

  const handleSubmit = () => {
    const trimmed = composer.trim();
    if (!trimmed) {
      Keyboard.dismiss();
      return;
    }
    void sendChat(trimmed);
  };

  // Use different bottom padding depending on keyboard state.
  // Screens render ABOVE the tab bar, so subtract its height to avoid an oversized jump.
  const keyboardInset = keyboardHeight > 0 ? Math.max(0, keyboardHeight - tabBarHeight) : 0;
  const bottomPadding = keyboardHeight > 0 ? keyboardInset + KEYBOARD_GAP : CLOSED_BOTTOM_PADDING;

  return (
    <TouchableWithoutFeedback onPress={Keyboard.dismiss}>
      <SafeAreaView style={styles.safeArea} edges={['top', 'left', 'right']}>
        <View style={[styles.container, { paddingBottom: bottomPadding }]}>
          {/* Top bar: Your scans */}
          <View style={styles.topBar}>
            <TouchableOpacity
              style={styles.chatSearchPill}
              activeOpacity={0.85}
              onPress={openChatList}
              accessibilityRole="button"
            >
              <Ionicons name="search-outline" size={16} color="#111827" style={{ marginRight: 8 }} />
              <Text style={styles.chatSearchText} numberOfLines={1}>
                {activeChatTitle}
              </Text>
              <Ionicons name="chevron-down" size={16} color="#9ca3af" style={styles.chatSearchChevron} />
            </TouchableOpacity>
          </View>

          {/* Chat area */}
          <View style={styles.chatArea}>
            <ScrollView
              ref={(r) => {
                scrollRef.current = r;
              }}
              contentContainerStyle={styles.chatScroll}
              keyboardShouldPersistTaps="handled"
            >
              {activeChat.length ? (
                activeChat.map((m) => (
                  <View key={m.id}>
                    <View
                      style={[
                        styles.chatBubble,
                        m.role === 'user' ? styles.chatBubbleUser : styles.chatBubbleAssistant,
                      ]}
                    >
                      <Text style={[styles.chatBubbleText, m.role === 'user' && styles.chatBubbleTextUser]}>
                        {m.text}
                      </Text>
                    </View>
                  </View>
                ))
              ) : null}

	              {discoverOpen && discoverStep === 'results' ? (
	                <View style={[styles.chatBubble, styles.chatBubbleAssistant, styles.discoverChatBubble]}>
	                  <View>
	                    {discoverResults.length ? (
	                      <View style={styles.discoverResultsList}>
	                        {discoverResults.map((p) => {
	                          const shadeTrimmed = String(p?.shade || '').trim();
	                          const addedKey = `${String(p?.name || '').trim()}__${shadeTrimmed}`;
	                          const added = !!discoverAdded[addedKey];
	
	                          return (
	                            <View key={addedKey || p.name} style={styles.discoverResultCard}>
	                              <Text style={styles.discoverResultName}>{p.name}</Text>
	                              {p.shade ? <Text style={styles.discoverResultWhy}>{p.shade}</Text> : null}

	                              <TouchableOpacity
	                                style={[styles.discoverAddBtn, added && styles.discoverAddBtnAdded]}
	                                disabled={added}
	                                onPress={() => {
	                                  void addDiscoverItemToKit(p.name, p.shade, p.itemType);
	                                }}
	                                accessibilityRole="button"
	                              >
	                                {added ? (
	                                  <View style={styles.discoverAddBtnRow}>
	                                    <Ionicons name="checkmark" size={16} color="#111827" style={{ marginRight: 6 }} />
	                                    <Text style={[styles.discoverAddBtnText, styles.discoverAddBtnTextAdded]}>Added</Text>
	                                  </View>
	                                ) : (
	                                  <Text style={styles.discoverAddBtnText}>Add to kit</Text>
	                                )}
	                              </TouchableOpacity>
	                            </View>
	                          );
	                        })}
	                      </View>
	                    ) : (
	                      <Text style={styles.discoverEmptyText}>No recommendations yet.</Text>
	                    )}

	                    <TouchableOpacity
	                      style={[styles.discoverPrimaryBtn, { marginTop: 10 }]}
	                      onPress={closeDiscover}
	                      accessibilityRole="button"
	                    >
	                      <Text style={styles.discoverPrimaryBtnText}>Done</Text>
	                    </TouchableOpacity>
	                  </View>
	                </View>
	              ) : null}

              {!analysisLoading && analysisId && analysis ? (
                <View style={styles.recommendRow}>
                  {!hasKitRecs ? (
                    <TouchableOpacity
                      style={[styles.recommendBtn, (analysisLoading || chatLoading) && { opacity: 0.6 }]}
                      disabled={analysisLoading || chatLoading}
                      onPress={() => {
                        Keyboard.dismiss();
                        void recommendFromKit();
                      }}
                      accessibilityRole="button"
                    >
                      <Text style={styles.recommendBtnText}>Recommend from kit</Text>
                    </TouchableOpacity>
                  ) : null}

                  <TouchableOpacity
                    style={[styles.recommendBtn, (analysisLoading || chatLoading) && { opacity: 0.6 }]}
                    disabled={analysisLoading || chatLoading}
                    onPress={() => {
                      Keyboard.dismiss();
                      void saveScanToList();
                    }}
                    accessibilityRole="button"
                  >
                    <Text style={styles.recommendBtnText}>Save to list</Text>
                  </TouchableOpacity>
                </View>
              ) : null}

              {analysisLoading ? (
                <View style={[styles.chatBubble, styles.chatBubbleAssistant, styles.loadingBubble]}>
                  <ActivityIndicator />
                  <Text style={[styles.chatBubbleText, { marginLeft: 10 }]}>Analyzing…</Text>
                </View>
              ) : null}
            </ScrollView>
          </View>

          {/* Bottom actions */}
	          <View style={styles.actionsBar}>
	            {discoverOpen && discoverStep !== 'results' ? (
	              <View style={styles.discoverComposerPanel}>
	                {discoverStep === 'tone' ? (
	                  <View>
	                    <Text style={styles.discoverSectionTitle}>Choose undertone</Text>
	                    <View style={styles.discoverChipRow}>
	                      {(['cool', 'neutral', 'warm'] as DiscoverTone[]).map((t) => {
	                        const selected = discoverTone === t;
	                        return (
	                          <TouchableOpacity
	                            key={t}
	                            style={[styles.discoverChip, selected && styles.discoverChipSelected]}
	                            onPress={() => setDiscoverTone(t)}
	                            accessibilityRole="button"
	                          >
	                            <Text style={[styles.discoverChipText, selected && styles.discoverChipTextSelected]}>
	                              {capWord(t)}
	                            </Text>
	                          </TouchableOpacity>
	                        );
	                      })}
	                    </View>

	                    <Text style={[styles.discoverSectionTitle, { marginTop: 14 }]}>Color season (optional)</Text>
	                    <ScrollView
	                      horizontal
	                      showsHorizontalScrollIndicator={false}
	                      contentContainerStyle={styles.discoverSeasonRow}
	                      keyboardShouldPersistTaps="handled"
	                    >
	                      {(['spring', 'summer', 'autumn', 'winter'] as SeasonKey[]).map((s) => {
	                        const selected = discoverSeason === s;
	                        return (
	                          <TouchableOpacity
	                            key={s}
	                            style={[styles.discoverChip, selected && styles.discoverChipSelected]}
	                            onPress={() => setDiscoverSeason(selected ? null : s)}
	                            accessibilityRole="button"
	                          >
	                            <Text style={[styles.discoverChipText, selected && styles.discoverChipTextSelected]}>
	                              {capWord(s)}
	                            </Text>
	                          </TouchableOpacity>
	                        );
	                      })}
	                    </ScrollView>

	                    <TouchableOpacity
	                      style={[styles.discoverPrimaryBtn, !discoverTone && { opacity: 0.5 }]}
	                      disabled={!discoverTone}
	                      onPress={() => setDiscoverStep('category')}
	                      accessibilityRole="button"
	                    >
	                      <Text style={styles.discoverPrimaryBtnText}>Continue</Text>
	                    </TouchableOpacity>
	                  </View>
	                ) : null}

	                {discoverStep === 'category' ? (
	                  <View>
	                    <Text style={styles.discoverSectionTitle}>Choose a category</Text>
	                    <View style={styles.discoverChipRow}>
	                      {(['Base', 'Sculpt', 'Cheeks', 'Eyes', 'Lips'] as DiscoverCategory[]).map((c) => {
	                        const selected = discoverCategory === c;
	                        return (
	                          <TouchableOpacity
	                            key={c}
	                            style={[styles.discoverChip, selected && styles.discoverChipSelected]}
	                            onPress={() => {
	                              setDiscoverCategory(c);
	                              setDiscoverType(null);
	                              setDiscoverResults([]);
	                              setDiscoverStep('type');
	                            }}
	                            accessibilityRole="button"
	                          >
	                            <Text style={[styles.discoverChipText, selected && styles.discoverChipTextSelected]}>
	                              {c}
	                            </Text>
	                          </TouchableOpacity>
	                        );
	                      })}
	                    </View>

	                    <TouchableOpacity
	                      style={styles.discoverSecondaryBtn}
	                      onPress={() => setDiscoverStep('tone')}
	                      accessibilityRole="button"
	                    >
	                      <Text style={styles.discoverSecondaryBtnText}>Back</Text>
	                    </TouchableOpacity>
	                  </View>
	                ) : null}

	                {discoverStep === 'type' ? (
	                  <View>
	                    <Text style={styles.discoverSectionTitle}>
	                      {discoverCategory ? `Choose a type (${discoverCategory})` : 'Choose a type'}
	                    </Text>

	                    <View style={styles.discoverChipRow}>
	                      {getDiscoverTypes(discoverCategory).map((t) => {
	                        const selected = discoverType === t;
	                        return (
	                          <TouchableOpacity
	                            key={t}
	                            style={[styles.discoverChip, selected && styles.discoverChipSelected]}
	                            onPress={() => {
	                              setDiscoverType(t);
	                              void fetchDiscoverRecommendations(String(t));
	                            }}
	                            accessibilityRole="button"
	                          >
	                            <Text style={[styles.discoverChipText, selected && styles.discoverChipTextSelected]}>
	                              {t}
	                            </Text>
	                          </TouchableOpacity>
	                        );
	                      })}
	                    </View>

	                    {discoverLoading ? (
	                      <View style={styles.discoverLoadingRow}>
	                        <ActivityIndicator />
	                        <Text style={styles.discoverLoadingText}>Finding matches…</Text>
	                      </View>
	                    ) : null}

	                    <TouchableOpacity
	                      style={styles.discoverSecondaryBtn}
	                      onPress={() => setDiscoverStep('category')}
	                      accessibilityRole="button"
	                    >
	                      <Text style={styles.discoverSecondaryBtnText}>Back</Text>
	                    </TouchableOpacity>
	                  </View>
	                ) : null}
	              </View>
	            ) : null}

	            <View style={styles.discoverInputContainer}>
	              <TouchableOpacity
	                style={[styles.discoverLauncherPressable, (analysisLoading || chatLoading) && { opacity: 0.6 }]}
	                disabled={analysisLoading || chatLoading}
	                activeOpacity={0.85}
	                onPress={() => {
	                  Keyboard.dismiss();
	                  if (discoverOpen) {
	                    if (discoverStep === 'results') {
	                      scrollRef.current?.scrollToEnd({ animated: true });
	                    } else {
	                      closeDiscover();
	                    }
	                    return;
	                  }
	                  openDiscover();
	                }}
	                accessibilityRole="button"
	              >
	                <View style={styles.discoverLauncherRow}>
	                  <Text
	                    style={[
	                      styles.discoverLauncherText,
	                      discoverLauncherPlaceholder && styles.discoverLauncherTextPlaceholder,
	                    ]}
	                    numberOfLines={1}
	                  >
	                    {discoverLauncherLabel}
	                  </Text>
	                  <Ionicons
	                    name={discoverOpen ? 'chevron-up' : 'chevron-down'}
	                    size={16}
	                    color={discoverLauncherPlaceholder ? '#999999' : '#6b7280'}
	                    style={{ marginLeft: 8 }}
	                  />
	                </View>
	              </TouchableOpacity>

	              <TouchableOpacity
	                style={[styles.iconButton, (analysisLoading || chatLoading || photoPicking) && { opacity: 0.6 }]}
	                disabled={analysisLoading || chatLoading || photoPicking}
	                onPress={() => {
	                  Keyboard.dismiss();
	                  if (discoverOpen && discoverStep !== 'results') closeDiscover();
	                  void choosePhoto('camera');
	                }}
	                accessibilityRole="button"
	              >
	                <Ionicons name="camera-outline" size={18} color="#ffffff" />
	              </TouchableOpacity>
	            </View>
	          </View>
          {/* Your scans list */}
          <Modal
            visible={chatListOpen}
            transparent
            animationType="fade"
            onRequestClose={() => setChatListOpen(false)}
          >
            <View style={styles.chatListOverlay}>
              <Pressable style={styles.chatListBackdrop} onPress={() => setChatListOpen(false)} />

              <View
                style={[
                  styles.chatListSheet,
                  { paddingTop: chatListTopPad, paddingBottom: chatListBottomPad },
                ]}
              >
                <View style={styles.chatListHeader}>
                  <Text style={styles.chatListTitle}>Your scans</Text>
                  <TouchableOpacity
                    style={styles.chatListClose}
                    onPress={() => setChatListOpen(false)}
                    accessibilityRole="button"
                  >
                    <Ionicons name="close" size={20} color="#111827" />
                  </TouchableOpacity>
                </View>

                <View style={styles.chatListSearchRow}>
                  <Ionicons name="search-outline" size={16} color="#6b7280" style={{ marginRight: 8 }} />
                  <TextInput
                    style={styles.chatListSearchInput}
                    value={chatListQuery}
                    onChangeText={setChatListQuery}
                    placeholder="Search scans"
                    placeholderTextColor="#9ca3af"
                    autoCorrect={false}
                    autoCapitalize="none"
                    returnKeyType="search"
                  />
                </View>

                <ScrollView contentContainerStyle={styles.chatListScroll} keyboardShouldPersistTaps="handled">
                  {filteredHistory.length ? (
                    filteredHistory.map((h) => {
                      const id = String(h?.id || '');
                      const selected = String(analysisId) === id;
                      const title = formatChatTitle(h);
                      const date = formatChatDate(String(h?.createdAt || ''));

                      return (
                        <Pressable
                          key={id}
                          style={[styles.chatListItem, selected && styles.chatListItemSelected]}
                          onPress={() => selectChat(h)}
                        >
                          <View style={{ flex: 1 }}>
                            <Text style={styles.chatListItemTitle} numberOfLines={1}>
                              {title}
                            </Text>
                            {date ? (
                              <Text style={styles.chatListItemSub} numberOfLines={1}>
                                {date}
                              </Text>
                            ) : null}
                          </View>

                          <Pressable
                            style={styles.chatListTrash}
                            onPress={(e) => {
                              (e as any)?.stopPropagation?.();
                              deleteChat(id);
                            }}
                            accessibilityRole="button"
                          >
                            <Ionicons name="trash-outline" size={18} color="#6b7280" />
                          </Pressable>
                        </Pressable>
                      );
                    })
                  ) : (
                    <View style={styles.chatListEmpty}>
                      <Text style={styles.chatListEmptyText}>No scans yet.</Text>
	                      <Text style={styles.chatListEmptySub}>Tap the camera to upload a face photo.</Text>
                    </View>
                  )}
                </ScrollView>
              </View>
            </View>
          </Modal>
        </View>
      </SafeAreaView>
    </TouchableWithoutFeedback>
  );
};

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#ffffff',
  },
  container: {
    flex: 1,
    backgroundColor: '#ffffff',
    paddingHorizontal: 16,
    paddingBottom: 0, // dynamic padding is applied via bottomPadding
  },

  // Top bar
  topBar: {
    marginTop: 8,
    marginBottom: 10,
    flexDirection: 'row',
    alignItems: 'center',
  },
  chatSearchPill: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 18,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    backgroundColor: '#ffffff',
    paddingLeft: 12,
    paddingRight: 12,
    minHeight: 38,
  },
  chatSearchText: {
    color: '#111827',
    fontSize: 13,
    fontWeight: '400',
  },
  chatSearchChevron: {
    marginLeft: 'auto',
  },
  uploadChip: {
    marginLeft: 10,
    paddingHorizontal: 16,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: '#111827',
    backgroundColor: '#ffffff',
    justifyContent: 'center',
    alignItems: 'center',
    minHeight: 38,
  },
  uploadChipText: {
    color: '#111827',
    fontSize: 13,
    fontWeight: '500',
  },

  // Chat
  chatArea: {
    flex: 1,
  },
  chatScroll: {
    paddingTop: 6,
    // Give enough room for shadows on the last message (e.g., Discover results + Done button).
    paddingBottom: 14,
    gap: 10,
  },
  chatBubble: {
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    maxWidth: '92%',
  },
  chatBubbleAssistant: {
    backgroundColor: '#f9fafb',
    alignSelf: 'flex-start',
  },
  chatBubbleUser: {
    backgroundColor: '#111111',
    borderColor: '#111111',
    alignSelf: 'flex-end',
  },
  chatBubbleText: {
    color: '#111827',
    lineHeight: 18,
  },
  chatBubbleTextUser: {
    color: '#ffffff',
  },
  recommendRow: {
    width: '92%',
    alignSelf: 'flex-start',
    flexDirection: 'column',
    gap: 10,
    marginTop: 2,
  },
  recommendBtn: {
    width: '100%',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    backgroundColor: '#ffffff',
    paddingVertical: 10,
    paddingHorizontal: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  recommendBtnText: {
    color: '#111827',
    fontWeight: '400',
    fontSize: 13,
  },
  kitSaveRow: {
    maxWidth: '92%',
    alignSelf: 'flex-start',
    marginTop: 8,
  },
  kitSaveBtn: {
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#111111',
    backgroundColor: '#111111',
    paddingVertical: 10,
    paddingHorizontal: 14,
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'flex-start',
  },
  kitSaveBtnText: {
    color: '#ffffff',
    fontWeight: '600',
    fontSize: 13,
  },
  loadingBubble: {
    flexDirection: 'row',
    alignItems: 'center',
  },

  // Bottom actions
  actionsBar: {
    paddingTop: 10,
  },
  discoverComposerPanel: {
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 18,
    backgroundColor: '#ffffff',
    paddingHorizontal: 12,
    paddingVertical: 12,
    marginBottom: 10,
    shadowColor: '#000',
    shadowOpacity: 0.06,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
    elevation: 3,
  },
  discoverComposerHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  discoverComposerTitle: {
    flex: 1,
    fontSize: 13,
    fontWeight: '500',
    color: '#111827',
  },
  discoverComposerClose: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
  },
  discoverInputContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 22,
    paddingLeft: 18,
    paddingRight: 6,
    backgroundColor: '#ffffff',
    minHeight: 44,
  },
  discoverLauncherPressable: {
    flex: 1,
    paddingVertical: 10,
    paddingRight: 8,
  },
  discoverLauncherRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  discoverLauncherText: {
    flex: 1,
    fontSize: 14,
    color: '#111111',
    fontWeight: '400',
  },
  discoverLauncherTextPlaceholder: {
    color: '#999999',
  },
  iconButton: {
    marginLeft: 4,
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: '#111111',
    alignItems: 'center',
    justifyContent: 'center',
  },

// Discover
  discoverChatBubble: {
    width: '92%',
    maxWidth: '92%',
    // Keep the results aligned like a chat bubble, but remove the *outer* box styling.
    // The inner result cards + buttons should be what defines the “box”.
    backgroundColor: 'transparent',
    borderWidth: 0,
    borderColor: 'transparent',
    // Leave a small inset so shadows don't get clipped by the ScrollView edge.
    // (Still wider than the original bubble padding, so the results “fill out” more.)
    paddingHorizontal: 8,
    paddingVertical: 0,
    borderRadius: 0,
  },
  discoverChatHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 10,
  },
  discoverChatHeaderText: {
    fontSize: 14,
    fontWeight: '500',
    color: '#111827',
  },
  discoverChatClose: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#e5e7eb',
    backgroundColor: '#ffffff',
  },
  discoverOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.25)',
    justifyContent: 'flex-end',
  },
  discoverBackdrop: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
  },
  discoverSheet: {
    backgroundColor: '#ffffff',
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    paddingHorizontal: 16,
    paddingTop: 14,
  },
  discoverHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingBottom: 10,
  },
  discoverTitle: {
    fontSize: 16,
    fontWeight: '500',
    color: '#111827',
  },
  discoverClose: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#e5e7eb',
  },
  discoverSectionTitle: {
    fontSize: 13,
    fontWeight: '500',
    color: '#111827',
    marginBottom: 8,
  },
  discoverChipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  discoverSeasonRow: {
    flexDirection: 'row',
    gap: 10,
    paddingBottom: 2,
  },
  discoverChip: {
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 16,
    paddingVertical: 8,
    paddingHorizontal: 12,
    backgroundColor: '#ffffff',
  },
  discoverChipSelected: {
    borderColor: '#111111',
  },
  discoverChipText: {
    fontSize: 13,
    color: '#111827',
    fontWeight: '400',
  },
  discoverChipTextSelected: {
    color: '#111827',
  },
  discoverPrimaryBtn: {
    marginTop: 16,
    width: '100%',
    borderRadius: 12,
    borderWidth: 0,
    backgroundColor: '#ffffff',
    paddingVertical: 12,
    paddingHorizontal: 14,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.06,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 1,
  },
  discoverPrimaryBtnText: {
    color: '#111827',
    fontWeight: '600',
    fontSize: 13,
  },
  discoverSecondaryBtn: {
    marginTop: 14,
    width: '100%',
    borderRadius: 12,
    borderWidth: 0,
    backgroundColor: '#ffffff',
    paddingVertical: 12,
    paddingHorizontal: 14,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.06,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 1,
  },
  discoverSecondaryBtnText: {
    color: '#111827',
    fontWeight: '400',
    fontSize: 13,
  },
  discoverGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  discoverGridBtn: {
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 12,
    backgroundColor: '#ffffff',
    minWidth: '47%',
    alignItems: 'center',
    justifyContent: 'center',
  },
  discoverGridBtnText: {
    fontSize: 13,
    color: '#111827',
    fontWeight: '400',
  },
  discoverLoadingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 12,
  },
  discoverLoadingText: {
    marginLeft: 10,
    color: '#111827',
    fontSize: 13,
  },
  discoverResultsList: {
    marginTop: 0,
  },
  discoverResultCard: {
    borderWidth: 0,
    borderRadius: 14,
    width: '100%',
    paddingHorizontal: 12,
    paddingVertical: 12,
    marginBottom: 10,
    backgroundColor: '#ffffff',
    shadowColor: '#000',
    shadowOpacity: 0.05,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 1,
  },
  discoverResultName: {
    color: '#111827',
    fontSize: 13,
    fontWeight: '500',
  },
  discoverResultWhy: {
    color: '#6b7280',
    fontSize: 12,
    marginTop: 6,
    lineHeight: 16,
  },
  discoverAddBtn: {
    marginTop: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    backgroundColor: '#ffffff',
    // Smaller button (matches older feel) + outline instead of shadow.
    paddingVertical: 8,
    paddingHorizontal: 12,
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'flex-start',
  },
  discoverAddBtnAdded: {
    opacity: 0.55,
  },
  discoverAddBtnRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  discoverAddBtnText: {
    color: '#111827',
    fontWeight: '600',
    fontSize: 13,
  },
  discoverAddBtnTextAdded: {
    color: '#111827',
  },
  discoverEmptyText: {
    color: '#6b7280',
    fontSize: 13,
    marginTop: 8,
  },

  // Chat list
  chatListOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.25)',
    justifyContent: 'flex-start',
  },
  chatListBackdrop: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
  },
  chatListSheet: {
    backgroundColor: '#ffffff',
    borderBottomLeftRadius: 18,
    borderBottomRightRadius: 18,
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 12,
  },
  chatListHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingBottom: 10,
  },
  chatListTitle: {
    fontSize: 16,
    fontWeight: '500',
    color: '#111827',
  },
  chatListClose: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#e5e7eb',
  },
  chatListSearchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 12,
  },
  chatListSearchInput: {
    flex: 1,
    fontSize: 13,
    color: '#111827',
    paddingVertical: 0,
  },
  chatListScroll: {
    paddingBottom: 12,
    gap: 10,
  },
  chatListItem: {
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 14,
    paddingVertical: 12,
    paddingHorizontal: 14,
    flexDirection: 'row',
    alignItems: 'center',
  },
  chatListItemSelected: {
    borderColor: '#111111',
  },
  chatListItemTitle: {
    color: '#111827',
    fontWeight: '500',
    marginBottom: 2,
  },
  chatListItemSub: {
    color: '#6b7280',
    fontSize: 12,
  },
  chatListTrash: {
    marginLeft: 10,
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#e5e7eb',
  },
  chatListEmpty: {
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 14,
    paddingVertical: 18,
    paddingHorizontal: 14,
  },
  chatListEmptyText: {
    color: '#111827',
    fontWeight: '500',
    marginBottom: 6,
  },
  chatListEmptySub: {
    color: '#6b7280',
  },
sheetModalRoot: {
  flex: 1,
  justifyContent: 'flex-end',
},
sheetBackdrop: {
  position: 'absolute',
  top: 0,
  right: 0,
  bottom: 0,
  left: 0,
  backgroundColor: 'rgba(0,0,0,0.35)',
},
sheet: {
    zIndex: 1,
    backgroundColor: '#ffffff',
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 47,
  },
  sheetTips: {
    paddingVertical: 8,
  },
  sheetTipText: {
    color: '#374151',
    lineHeight: 18,
    marginBottom: 2,
  },
  sheetAction: {
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 14,
    paddingVertical: 12,
    paddingHorizontal: 14,
    marginTop: 10,
    flexDirection: 'row',
    alignItems: 'center',
  },
  sheetActionText: {
    color: '#111827',
    fontWeight: '700',
  },
  sheetCancel: {
    borderColor: '#111111',
  },
  sheetCancelText: {
    color: '#111111',
    fontWeight: '800',
    textAlign: 'center',
    width: '100%',
  },
});

export default Upload;
