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

const KITLOG_STORAGE_KEY = DOC_KEYS.kitlog;
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

// Read API base from app.json -> expo.extra.EXPO_PUBLIC_API_BASE
// IMPORTANT: Strip trailing slashes so we never generate URLs like "//analyze-face".
const RAW_API_BASE =
  (Constants as any).expoConfig?.extra?.EXPO_PUBLIC_API_BASE ??
  process.env.EXPO_PUBLIC_API_BASE ??
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

function countUpcomingClientsFromRaw(raw: string | null): number {
  if (!raw) return 0;
  try {
    const parsed = JSON.parse(raw);
    const clients = Array.isArray(parsed?.clients) ? parsed.clients : [];

    let upcoming = 0;
    clients.forEach((c: any) => {
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
};

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
  savedClientId?: string;
};

type ChatStore = Record<string, ChatMessage[]>;

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

type KitLogLite = {
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

function safeParseKitLog(raw: string | null): KitLogLite {
  if (!raw) return { categories: [] };
  try {
    const parsed = JSON.parse(raw);
    const cats = Array.isArray(parsed?.categories) ? parsed.categories : [];
    return { categories: cats } as KitLogLite;
  } catch {
    return { categories: [] };
  }
}

function categoryItems(kit: KitLogLite, nameWant: string): KitItemLite[] {
  const cats = Array.isArray(kit?.categories) ? kit.categories : [];
  let want = String(nameWant || '').trim().toLowerCase();
  // Migration/alias: "Base" is now "Foundation" in Your Kit.
  if (want === 'base') want = 'foundation';
  if (!want) return [];

  const exact = cats.find((c) => String(c?.name || '').trim().toLowerCase() === want);
  const fuzzy =
    exact ||
    cats.find((c) => {
      const n = String(c?.name || '').trim().toLowerCase();
      return n === want || n.includes(want);
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
    eyes: ['Natasha Denona Glam Palette', 'Urban Decay Naked2 Basics Palette', 'Make Up For Ever Artist Color Pencil'],
    lips: ['MAC Matte Lipstick', 'Charlotte Tilbury Matte Revolution Lipstick', 'Fenty Beauty Gloss Bomb'],
  },
  'neutral-cool': {
	    base: ['Dior Backstage Face & Body Foundation', 'NARS Light Reflecting Foundation', "Fenty Beauty Pro Filt'r Foundation"],
    cheeks: ['Clinique Cheek Pop', 'Rare Beauty Soft Pinch Liquid Blush', 'NARS Blush'],
    eyes: ['Natasha Denona Glam Palette', 'Urban Decay Naked2 Basics Palette', 'Make Up For Ever Artist Color Pencil'],
    lips: ['MAC Satin Lipstick', 'Charlotte Tilbury Matte Revolution Lipstick', 'Fenty Beauty Gloss Bomb'],
  },
  neutral: {
    base: ['Dior Backstage Face & Body Foundation', 'Fenty Beauty Eaze Drop Blurring Skin Tint', 'NARS Light Reflecting Foundation'],
    cheeks: ['Rare Beauty Soft Pinch Liquid Blush', 'Clinique Cheek Pop', 'NARS Blush'],
    eyes: ['Natasha Denona Glam Palette', 'Urban Decay Naked3 Palette', 'Make Up For Ever Artist Color Pencil'],
    lips: ['Charlotte Tilbury Matte Revolution Lipstick', 'MAC Satin Lipstick', 'Fenty Beauty Gloss Bomb'],
  },
  'neutral-warm': {
    base: ['Giorgio Armani Luminous Silk Foundation', 'Dior Backstage Face & Body Foundation', 'Make Up For Ever HD Skin Foundation'],
    cheeks: ['Rare Beauty Soft Pinch Liquid Blush', 'Fenty Beauty Cheeks Out Cream Blush', 'NARS Blush'],
    eyes: ['Natasha Denona Bronze Palette', 'Huda Beauty Nude Obsessions Palette', 'Make Up For Ever Artist Color Pencil'],
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

  const kit = safeParseKitLog(opts.kitRaw);

  // "Base" migrated to "Foundation" in Your Kit.
  const foundationItems = categoryItems(kit, 'foundation');
  const cheekItems = categoryItems(kit, 'cheeks');
  const eyeItems = categoryItems(kit, 'eyes');
  const lipItems = categoryItems(kit, 'lips');

  const foundationPicks = pickBestKitItems(foundationItems, u, 2);
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

  block('Foundation', 'Foundation', foundationPicks, true);
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
  lines.push('Recommended products:');

  const addBlock = (label: string, arr: string[], colorLabel: string) => {
    const list = Array.isArray(arr) ? arr.slice(0, 1) : []; // keep it concise
    if (!list.length) return;
    lines.push('');
    lines.push(`${label}:`);
    list.forEach((x) => lines.push(`- ${x} — ${colorLabel}`));
  };

  addBlock(
    'Foundation',
    buy.base,
    `Color: ${foundationColorLabel({ undertone: u, toneNumberRaw: opts.toneNumberRaw, toneDepthRaw: opts.toneDepthRaw })}`
  );
  addBlock('Cheeks', buy.cheeks, `Color: ${colorHint('cheeks', u, season)}`);
  addBlock('Eyes', buy.eyes, `Color: ${colorHint('eyes', u, season)}`);
  addBlock('Lips', buy.lips, `Color: ${colorHint('lips', u, season)}`);

  return lines.join('\n');
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


const Upload: React.FC<UploadScreenProps> = ({ navigation, route, email, userId, token }) => {
  // Scope local data per user (stable id preferred; fall back to email).
  const scope = useMemo(() => {
    const stable = String(userId ?? '').trim();
    if (stable) return stable;
    const e = String(email ?? '').trim().toLowerCase();
    return e || null;
  }, [email, userId]);

  const kitlogKey = useMemo(() => makeScopedKey(KITLOG_STORAGE_KEY, scope), [scope]);
  const catalogKey = useMemo(() => makeScopedKey(CATALOG_STORAGE_KEY, scope), [scope]);
  const historyKey = useMemo(() => makeScopedKey(ANALYSIS_HISTORY_KEY, scope), [scope]);
  const chatKey = useMemo(() => makeScopedKey(CHAT_HISTORY_KEY, scope), [scope]);

  const tokenTrimmed = String(token ?? '').trim();

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
  const [upcomingClientCount, setUpcomingClientCount] = useState(0);

  const [analysisId, setAnalysisId] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<any | null>(null);

  // When true, we intentionally keep the chat blank (don’t auto-restore last scan).
  const [newScanMode, setNewScanMode] = useState(false);

  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [chatStore, setChatStore] = useState<ChatStore>({});

  const [chatListOpen, setChatListOpen] = useState(false);
  const [chatListQuery, setChatListQuery] = useState('');
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [chatLoading, setChatLoading] = useState(false);

  const [photoPicking, setPhotoPicking] = useState(false);

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
      void analyzePhoto({ ...captured, uri } as PickedPhoto);
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

  // Bottom tab UX: tapping the active "scan" icon should open the photo sheet.
  useEffect(() => {
    const unsubscribe = navigation?.addListener?.('tabPress', () => {
      const focused = typeof navigation?.isFocused === 'function' ? navigation.isFocused() : false;
      if (!focused) return;
      Keyboard.dismiss();
      void choosePhoto('camera');
    });

    return () => {
      if (typeof unsubscribe === 'function') unsubscribe();
    };
  }, [navigation, choosePhoto]);

  // Load counts + history + chat store when screen focuses.
  useEffect(() => {
    let alive = true;

    const refresh = async () => {
      try {
        const raw = await getString(kitlogKey);
        const count = countNeedsAttentionFromRaw(raw);
        if (alive) setNeedsAttentionCount(count);
      } catch {
        if (alive) setNeedsAttentionCount(0);
      }

      try {
        const raw = await getString(catalogKey);
        const count = countUpcomingClientsFromRaw(raw);
        if (alive) setUpcomingClientCount(count);
      } catch {
        if (alive) setUpcomingClientCount(0);
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

      // If we don't have an active analysis yet, restore the most recent.
      if (alive && !analysisId && !newScanMode && loadedHistory.length) {
        const mostRecent = loadedHistory[0];
        if (mostRecent?.id) {
          setAnalysisId(String(mostRecent.id));
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
  }, [navigation, kitlogKey, catalogKey, historyKey, chatKey, analysisId, newScanMode]);

  useEffect(() => {
    // Auto-scroll when chat updates.
    const t = setTimeout(() => {
      scrollRef.current?.scrollToEnd({ animated: true });
    }, 0);
    return () => clearTimeout(t);
  }, [analysisId, chatStore]);

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

  const getChatFor = (id: string | null): ChatMessage[] => {
    if (!id) return [];
    const arr = (chatStore as any)?.[id];
    return Array.isArray(arr) ? arr : [];
  };

  const upsertChatFor = async (id: string, messages: ChatMessage[]) => {
    const limited = messages.slice(-60);
    const next: ChatStore = { ...(chatStore || {}) };
    next[id] = limited;
    await saveChatStore(next);
  };

  const activeChat = getChatFor(analysisId);

  const hasKitRecs = useMemo(() => activeChat.some((m) => m?.kind === 'kit_recs'), [activeChat]);
  const hasBuyRecs = useMemo(() => activeChat.some((m) => m?.kind === 'buy_recs'), [activeChat]);

  const lastUnsavedKitRecId = useMemo(() => {
    for (let i = activeChat.length - 1; i >= 0; i--) {
      const m = activeChat[i];
      if (m?.kind === 'kit_recs' && !m?.savedClientId) return m.id;
    }
    return null;
  }, [activeChat]);

  const activeChatTitle = useMemo(() => {
    if (!analysisId) return 'New scan';
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

  const analyzePhoto = async (picked: PickedPhoto) => {
    if (!tokenTrimmed) {
      Alert.alert('Not logged in', 'Please log in again.');
      return;
    }

    setComposer('');
    Keyboard.dismiss();

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

      const id = String(data?.analysisId || makeId());
      const nextAnalysis = data?.analysisStable ?? data?.analysis ?? null;

      setAnalysisId(id);
      setAnalysis(nextAnalysis);

      setNewScanMode(false);

      // Save analysis history (local)
      const nextHistory: HistoryItem[] = [
        { id, createdAt: new Date().toISOString(), analysis: nextAnalysis },
        ...history,
      ].slice(0, 20);
      await saveHistory(nextHistory);


      // Seed chat with: "photo uploaded" + analysis summary.
	  const seedMsgs: ChatMessage[] = [
	    {
	      id: makeId(),
	      role: 'user',
	      text: 'Uploaded face photo.',
	      createdAt: new Date().toISOString(),
	    },
	    {
	      id: makeId(),
	      role: 'assistant',
	      kind: 'analysis',
	      text: formatAnalysisToText(nextAnalysis),
	      createdAt: new Date().toISOString(),
	    },
	  ];

	  await upsertChatFor(id, seedMsgs);
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

  const startNewChat = () => {
    setChatListOpen(false);
    setChatListQuery('');
    Keyboard.dismiss();

    // Immediately switch UI to a fresh, blank chat.
    setComposer('');
    setAnalysisId(null);
    setAnalysis(null);
    setNewScanMode(true);

    setTimeout(() => {
      void choosePhoto('camera');
    }, 0);
  };

  const selectChat = (item: HistoryItem) => {
    const id = String(item?.id || '').trim();
    if (!id) return;
    setAnalysisId(id);
    setAnalysis(item?.analysis ?? null);
    setNewScanMode(false);
    setChatListOpen(false);
  };

  const deleteChat = (id: string) => {
    Alert.alert('Delete scan?', 'This will remove the scan and its messages from this device.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          const nextHistory = history.filter((h) => String(h?.id) !== String(id));
          await saveHistory(nextHistory);

          const nextStore: ChatStore = { ...(chatStore || {}) };
          delete (nextStore as any)[id];
          await saveChatStore(nextStore);

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
      kitRaw = await getString(kitlogKey);
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

      const t = String(serverText || fallback || '').trim();
      if (!t) return;

      const assistantMsg: ChatMessage = {
        id: makeId(),
        role: 'assistant',
        kind: 'buy_recs',
        text: t,
        createdAt: new Date().toISOString(),
      };

      const current = getChatFor(analysisId);
      await upsertChatFor(analysisId, [...current, assistantMsg]);
    } finally {
      setChatLoading(false);
    }
  };

  const saveKitRecsToClients = async (kitMsgId: string) => {
    if (!analysisId) return;
    const msgs = getChatFor(analysisId);
    const hit = msgs.find((m) => m.id === kitMsgId);
    if (!hit || hit.kind !== 'kit_recs') return;
    if (hit.savedClientId) return;

    const products = Array.isArray(hit.kitProducts) ? hit.kitProducts : [];

    // Read existing catalog
    let catalog: any = null;
    try {
      catalog = await getJson<any>(catalogKey);
    } catch {
      catalog = null;
    }

    const existingClients = Array.isArray(catalog?.clients) ? catalog.clients : [];

    // Default to "Untitled scan" (with numbering if needed)
    const baseName = 'Untitled scan';
    let max = 0;
    existingClients.forEach((c: any) => {
      const name = String(c?.displayName || '').trim();
      const m = /^untitled\s+scan(?:\s+(\d+))?$/i.exec(name);
      if (!m) return;
      const n = m[1] ? Number(m[1]) : 1;
      if (Number.isFinite(n) && n > max) max = n;
    });
    const nextN = max + 1;
    const scanLabel = nextN === 1 ? baseName : `${baseName} ${nextN}`;

    const now = Date.now();
    const uid = (prefix: string) => `${prefix}_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

    const undertoneKey = normalizeUndertoneKey(analysis?.undertone);
    const seasonKey = normalizeSeasonKey(analysis?.season);

    const clientId = uid('client');
    const clientProducts = products.map((p) => ({
      id: uid('prod'),
      category: String(p?.category || 'Foundation'),
      name: String(p?.name || '').trim(),
      shade: String(p?.shade || '').trim(),
      notes: 'Recommended from kit',
      createdAt: now,
      updatedAt: now,
    })).filter((p: any) => !!p.name);

    const nextClient: any = {
      id: clientId,
      displayName: scanLabel,
      undertone: (undertoneKey || 'unknown') as any,
      season: seasonKey || null,
      trialDate: '',
      finalDate: '',
      eventType: '',
      notes: '',
      products: clientProducts,
      createdAt: now,
      updatedAt: now,
    };

    const nextCatalog = {
      version: 1,
      clients: [nextClient, ...existingClients],
    };

    try {
      await setJson(catalogKey, nextCatalog);
    } catch (e: any) {
      Alert.alert('Save failed', String(e?.message || e));
      return;
    }

    const nextMsgs = msgs.map((m) => (m.id === kitMsgId ? { ...m, savedClientId: clientId } : m));
    await upsertChatFor(analysisId, nextMsgs);

    Alert.alert('Saved', `${scanLabel} was added to Clients.`);
  };


  const sendChat = async (text: string) => {
    const msg = String(text || '').trim();
    if (!msg) return;

    if (!analysisId) {
      Alert.alert('Scan a face photo first', 'Tap “Scan” to upload or take a face photo.');
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
        throw new Error(data?.error || `HTTP ${res.status}`);
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
          {/* Top bar: Your scans + scan */}
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

            <TouchableOpacity
              style={styles.uploadChip}
              onPress={startNewChat}
              accessibilityRole="button"
            >
              <Text style={styles.uploadChipText}>Scan</Text>
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

                    {m.id === lastUnsavedKitRecId ? (
                      <View style={styles.kitSaveRow}>
                        <TouchableOpacity
                          style={[styles.kitSaveBtn, (analysisLoading || chatLoading) && { opacity: 0.6 }]}
                          disabled={analysisLoading || chatLoading}
                          onPress={() => {
                            Keyboard.dismiss();
                            void saveKitRecsToClients(m.id);
                          }}
                          accessibilityRole="button"
                        >
                          <Text style={styles.kitSaveBtnText}>Save</Text>
                        </TouchableOpacity>
                      </View>
                    ) : null}
                  </View>
                ))
              ) : null}

              {!analysisLoading && analysisId && analysis && (!hasKitRecs || !hasBuyRecs) ? (
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
                      <Text style={styles.recommendBtnText}>Recommend items from kit</Text>
                    </TouchableOpacity>
                  ) : null}

                  {!hasBuyRecs ? (
                    <TouchableOpacity
                      style={[styles.recommendBtn, (analysisLoading || chatLoading) && { opacity: 0.6 }]}
                      disabled={analysisLoading || chatLoading}
                      onPress={() => {
                        Keyboard.dismiss();
                        void recommendToBuy();
                      }}
                      accessibilityRole="button"
                    >
                      <Text style={styles.recommendBtnText}>Recommend products</Text>
                    </TouchableOpacity>
                  ) : null}
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

          {/* Bottom input bar */}
          <View style={styles.inputBar}>
            <View style={styles.inputContainer}>
              <TextInput
                style={styles.textInput}
                value={composer}
                onChangeText={setComposer}
                placeholder="Take a photo..."
                placeholderTextColor="#999999"
                returnKeyType="send"
                onSubmitEditing={handleSubmit}
                blurOnSubmit={false}
                editable={!chatLoading && !analysisLoading}
              />

              {/* Camera icon: opens the face scan camera */}
              <TouchableOpacity
                style={[styles.iconButton, (analysisLoading || chatLoading || photoPicking) && { opacity: 0.6 }]}
                disabled={analysisLoading || chatLoading || photoPicking}
                onPress={() => {
                  Keyboard.dismiss();
                  void choosePhoto('camera');
                }}
                onLongPress={() => {
                  Keyboard.dismiss();
                  void choosePhoto('library');
                }}
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
                      <Text style={styles.chatListEmptySub}>Tap “Scan” to upload a face photo.</Text>
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
    fontWeight: '600',
  },

  // Chat
  chatArea: {
    flex: 1,
  },
  chatScroll: {
    paddingTop: 6,
    paddingBottom: 8,
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
    maxWidth: '92%',
    alignSelf: 'flex-start',
    flexDirection: 'row',
    gap: 10,
    marginTop: 2,
  },
  recommendBtn: {
    flex: 1,
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
    fontWeight: '500',
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

  // Bottom input
  inputBar: {
    paddingTop: 8,
  },
  inputContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#e0e0e0',
    borderRadius: 22,
    paddingLeft: 18,
    paddingRight: 6,
    backgroundColor: '#ffffff',
    minHeight: 44,
  },
  textInput: {
    flex: 1,
    fontSize: 14,
    paddingVertical: 8,
    paddingRight: 8,
    color: '#111827',
  },
  iconButton: {
    marginLeft: 4,
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: '#111111',
    alignItems: 'center',
    justifyContent: 'center',
  },// Photo sheet

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
