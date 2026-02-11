import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  StyleSheet,
  TouchableOpacity,
  TouchableWithoutFeedback,
  Keyboard,
  Text,
  TextInput,
  Platform,
  ScrollView,
  Modal,
  Alert,
  ActivityIndicator,
  StatusBar,
  useWindowDimensions,
} from 'react-native';
import Constants from 'expo-constants';
import { SafeAreaView, useSafeAreaInsets, initialWindowMetrics } from 'react-native-safe-area-context';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useFocusEffect } from '@react-navigation/native';
import { useBottomTabBarHeight } from '@react-navigation/bottom-tabs';
import { DOC_KEYS, getString, makeScopedKey, setString } from '../localstore';
import { PlanTier, PLAN_LIMITS } from '../api';
import { getToken } from '../auth';

type InventoryScreenProps = {
  navigation: any;
  route: any;
  email?: string | null;
  userId?: string | number | null;
  planTier?: PlanTier;
};

type ItemStatus = 'inKit' | 'low' | 'empty';

type KitItem = {
  id: string;
  name: string;
  subcategory?: string;
  type?: string;
  brand?: string;
  shade?: string;
  placement?: string;
  undertone?: string;
  form?: string;
  location?: string;
  quantity?: string;
  status: ItemStatus;
  purchaseDate?: string; // YYYY-MM-DD
  openedDate?: string; // YYYY-MM-DD
  expiryDate?: string; // YYYY-MM-DD
  notes?: string;
  createdAt: number;
  updatedAt: number;
};

type KitCategory = {
  id: string;
  name: string;
  createdAt: number;
  items: KitItem[];
};

type InventoryData = {
  version: 1;
  categories: KitCategory[];
};

type ViewMode = 'all' | 'low' | 'empty' | 'expiring';
type HomeAttentionMode = 'low' | 'empty' | 'expiring';

const TONE_OPTIONS = [
  { key: 'cool', label: 'Cool' },
  { key: 'neutral', label: 'Neutral' },
  { key: 'warm', label: 'Warm' },
] as const;

const BASE_SUBSET_OPTIONS = ['Foundation', 'Concealer', 'Corrector', 'Powder'] as const;
const CHEEKS_SUBSET_OPTIONS = ['Blush', 'Bronzer'] as const;
const SCULPT_SUBSET_OPTIONS = ['Contour', 'Highlighter'] as const;
const LIPS_SUBSET_OPTIONS = ['Lipstick', 'Lipliner', 'Lip gloss', 'Lip balm/treatments'] as const;
const EYES_SUBSET_OPTIONS = ['Eyeshadow', 'Eyeliner', 'Mascara', 'Lashes'] as const;
const BROWS_SUBSET_OPTIONS = ['Pencil', 'Powder', 'Gel'] as const;

const EYESHADOW_TYPE_OPTIONS = ['Individual', 'Palette'] as const;
const EYELINER_TYPE_OPTIONS = ['Pencil', 'Liquid', 'Gel'] as const;

const BASE_FORM_OPTIONS = ['Cream', 'Powder', 'Liquid'] as const;
const EYES_COLOR_ROLE_OPTIONS = ['Base/prime', 'Enhance/crease', 'Smoke', 'Pop (shimmer/glitter)'] as const;


const STORAGE_KEY = DOC_KEYS.inventory;

// Category bar fills up as you add items; reaches 100% at 100 items.
const CATEGORY_BAR_TARGET = 100;


// Where the bottom input bar rests when the keyboard is CLOSED.
// (Matches the old visual spacing above the tab bar, but we dock the bar absolutely
// so there is no non-scrollable "dead" zone at the bottom.)
const FOOTER_REST_OFFSET = 28;

// Approximate height footprint of the bottom input bar.
// Used to pad ScrollView content so the last rows aren't hidden behind the docked bar.
const FOOTER_BAR_HEIGHT = 62;

// Extra space ABOVE the keyboard when it’s OPEN
// (Raised to make the lift clearly noticeable)
const KEYBOARD_GAP = 33;

// Read API base from app.json -> expo.extra.EXPO_PUBLIC_API_BASE
// IMPORTANT: Strip trailing slashes so we never generate URLs like "//infer-undertone".
const RAW_API_BASE =
  (Constants as any).expoConfig?.extra?.EXPO_PUBLIC_API_BASE ??
  process.env.EXPO_PUBLIC_API_BASE ??
  'http://localhost:3000';
const API_BASE = String(RAW_API_BASE || '').replace(/\/+$/, '');

function uid(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

const BASE_CATEGORY_NAME = 'Base';
const PREP_FINISH_CATEGORY_NAME = 'Prep & Finish';
const CHEEKS_CATEGORY_NAME = 'Cheeks';
const SCULPT_CATEGORY_NAME = 'Sculpt';

// Core/default categories (non-deletable). User-added categories are deletable.
const CORE_CATEGORY_ORDER = [
  PREP_FINISH_CATEGORY_NAME,
  BASE_CATEGORY_NAME,
  CHEEKS_CATEGORY_NAME,
  SCULPT_CATEGORY_NAME,
  'Lips',
  'Eyes',
  'Brows',
  'Tools',
  'Hygiene & Disposables',
  'Other',
];

const CORE_CATEGORY_NAME_SET = new Set(CORE_CATEGORY_ORDER.map((n) => n.trim().toLowerCase()));

function isCoreCategoryName(name: string): boolean {
  return CORE_CATEGORY_NAME_SET.has((name || '').trim().toLowerCase());
}

function normalizeCategoryName(raw: any): string {
  const t = typeof raw === 'string' ? raw.trim() : '';
  if (!t) return '';
  const key = t.toLowerCase();

  // Migration: "Prep & Skin" -> "Prep & Finish".
  if (key === 'prep & skin' || key === 'prep and skin' || key === 'prep/skin') return PREP_FINISH_CATEGORY_NAME;
  if (key === 'prep & finish' || key === 'prep and finish') return PREP_FINISH_CATEGORY_NAME;

  // Migration: "Foundation" -> "Base".
  if (key === 'foundation') return BASE_CATEGORY_NAME;
  // Canonicalize casing.
  if (key === 'base') return BASE_CATEGORY_NAME;

  if (key === 'cheeks') return CHEEKS_CATEGORY_NAME;
  if (key === 'sculpt') return SCULPT_CATEGORY_NAME;

  // Legacy standalone Lashes category is now Eyes → Lashes (Subset).
  if (key === 'lashes') return 'Eyes';

  // Removed: Body / FX → fold into Other.
  if (
    key === 'body / fx / extras' ||
    key === 'body/fx/extras' ||
    key === 'body fx extras' ||
    key === 'body & fx' ||
    key === 'body and fx' ||
    key === 'body / fx' ||
    key === 'body/fx' ||
    key === 'body fx' ||
    key === 'bodyfx'
  ) {
    return 'Other';
  }

  return t;
}

function defaultCategories(): KitCategory[] {
  const now = Date.now();
  return CORE_CATEGORY_ORDER.map((name) => ({
    id: uid('cat'),
    name,
    createdAt: now,
    items: [],
  }));
}

function safeParseDate(value?: string): number | null {
  if (!value) return null;
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : null;
}

function daysUntil(ts: number) {
  const diff = ts - Date.now();
  return Math.ceil(diff / (1000 * 60 * 60 * 24));
}

function expiringLabel(expiryDate?: string, windowDays = 60) {
  const ts = safeParseDate(expiryDate);
  if (!ts) return '';
  const withinWindow = ts - Date.now() <= windowDays * 24 * 60 * 60 * 1000;
  if (!withinWindow) return '';

  const d = daysUntil(ts);
  if (d < 0) return 'Expired';
  if (d === 0) return 'Expires today';
  if (d === 1) return 'Expires in 1 day';
  return `Expires in ${d} days`;
}

function statusLabel(s: ItemStatus) {
  if (s === 'inKit') return 'In kit';
  if (s === 'low') return 'Low';
  return 'Empty';
}

function nextStatus(s: ItemStatus): ItemStatus {
  if (s === 'inKit') return 'low';
  if (s === 'low') return 'empty';
  return 'inKit';
}

type InferredUndertone = {
  undertone: 'cool' | 'neutral' | 'warm' | 'unknown';
  confidence: number; // 0-100
  reason: string;
};

function inferProductUndertoneLocal(args: {
  name?: string;
  brand?: string;
  shade?: string;
  notes?: string;
}): InferredUndertone {
  const name = String(args?.name || '').trim();
  const brand = String(args?.brand || '').trim();
  const shade = String(args?.shade || '').trim();
  const notes = String(args?.notes || '').trim();

  const text = `${name} ${brand} ${shade} ${notes}`.toLowerCase();

  const has = (re: RegExp) => re.test(text);

  // Strong explicit signals
  if (has(/\bneutral\b|\bneut\b/)) {
    return { undertone: 'neutral', confidence: 84, reason: 'Text includes “neutral”.' };
  }
  if (has(/\bwarm\b|\bgolden\b|\byellow\b|\bolive\b/)) {
    return { undertone: 'warm', confidence: 82, reason: 'Text includes a warm cue (warm/golden/yellow/olive).' };
  }
  if (has(/\bcool\b|\bpink\b|\brosy\b|\brose\b/)) {
    return { undertone: 'cool', confidence: 80, reason: 'Text includes a cool cue (cool/pink/rosy/rose).' };
  }

  // Common shade-code patterns like 2N / 3W / 1C
  // (We keep this conservative and only accept a single trailing letter.)
  const m = text.match(/\b\d+(?:\.\d+)?\s*([ncw])\b/);
  if (m && m[1]) {
    const code = String(m[1] || '').toLowerCase();
    if (code === 'n') return { undertone: 'neutral', confidence: 68, reason: 'Shade code looks like “N” (often neutral).' };
    if (code === 'w') return { undertone: 'warm', confidence: 66, reason: 'Shade code looks like “W” (often warm).' };
    if (code === 'c') return { undertone: 'cool', confidence: 66, reason: 'Shade code looks like “C” (often cool).' };
  }

  return {
    undertone: 'unknown',
    confidence: 20,
    reason: 'Not enough information in the product name/shade text to guess confidently. Try adding the shade code (e.g., 2N / 3W) or the full shade name.',
  };
}

function viewLabel(v: ViewMode) {
  if (v === 'all') return 'In kit';
  if (v === 'low') return 'Low';
  if (v === 'empty') return 'Empty';
  return 'Expiring';
}

function itemCountLabel(n: number) {
  if (n === 1) return '1 item';
  return `${n} items`;
}

// Keep storage backwards-compatible with earlier versions.
function normalizeData(input: any): InventoryData {
  const base: InventoryData = { version: 1, categories: defaultCategories() };

  try {
    const cats = Array.isArray(input?.categories) ? input.categories : null;
    if (!cats) return base;

    const normalizedCats: KitCategory[] = cats
      .map((c: any) => {
        if (!c) return null;
        const id = typeof c.id === 'string' ? c.id : uid('cat');
        const rawName = typeof c.name === 'string' ? c.name.trim() : '';
        const rawKey = rawName.toLowerCase();
        const name = normalizeCategoryName(rawName) || 'Untitled';
        const createdAt = typeof c.createdAt === 'number' ? c.createdAt : Date.now();
        const itemsRaw = Array.isArray(c.items) ? c.items : [];

        const items: KitItem[] = itemsRaw
          .map((it: any) => {
            if (!it) return null;
            const itemId = typeof it.id === 'string' ? it.id : uid('item');
            const itemName = typeof it.name === 'string' ? it.name : '';
            const status: ItemStatus =
              it.status === 'low' || it.status === 'empty' || it.status === 'inKit' ? it.status : 'inKit';

            const created = typeof it.createdAt === 'number' ? it.createdAt : Date.now();
            const updated = typeof it.updatedAt === 'number' ? it.updatedAt : created;

            const brand = typeof it.brand === 'string' ? it.brand : '';

            let shade = typeof it.shade === 'string' ? it.shade : '';
            let placement = typeof it.placement === 'string' ? it.placement : '';
            let type = typeof it.type === 'string' ? it.type : '';

            // Backfill subcategory (Subset) for migrated categories.
            const subcategoryRaw = typeof it.subcategory === 'string' ? it.subcategory : '';
            let subcategory = subcategoryRaw;

            // If this came from the old standalone "Lashes" category, treat it as Eyes → Lashes (Subset).
            if (!subcategory.trim() && rawKey === 'lashes') {
              subcategory = 'Lashes';
            }

            // Base defaults: Foundation / Concealer / Corrector / Powder
            if (!subcategory.trim() && name.trim().toLowerCase() === BASE_CATEGORY_NAME.toLowerCase()) {
              const blob = `${brand} ${itemName} ${shade} ${String(it?.notes || '')}`.trim().toLowerCase();
              const has = (s: string) => blob.includes(s);
              if (has('corrector')) subcategory = 'Corrector';
              else if (has('concealer')) subcategory = 'Concealer';
              else if (has('powder')) subcategory = 'Powder';
              else subcategory = 'Foundation';
            }

            // Lips: canonicalize legacy subcategory names.
            if (name.trim().toLowerCase() === 'lips') {
              const subKey = (subcategory || '').trim().toLowerCase();
              if (subKey === 'lip liner' || subKey === 'lipliner') subcategory = 'Lipliner';
            }

            // Eyes: migrate legacy subset + keep role selection in `shade`.
            if (name.trim().toLowerCase() === 'eyes') {
              const subKey0 = (subcategory || '').trim().toLowerCase();

              // Legacy: "Eyeshadow palette/singles" -> Subset "Eyeshadow" + Type.
              if (subKey0 === 'eyeshadow palette' || subKey0 === 'eyeshadow singles') {
                subcategory = 'Eyeshadow';
                if (!type.trim()) type = subKey0 === 'eyeshadow palette' ? 'Palette' : 'Individual';
              }

              const subKey = (subcategory || '').trim().toLowerCase();

              // Sanitize Type based on Subset.
              if (subKey === 'eyeshadow') {
                const allowedTypes = EYESHADOW_TYPE_OPTIONS as readonly string[];
                const current = (type || '').trim();
                if (current && !allowedTypes.includes(current as any)) type = '';
              } else if (subKey === 'eyeliner') {
                const allowedTypes = EYELINER_TYPE_OPTIONS as readonly string[];
                const current = (type || '').trim();
                if (current && !allowedTypes.includes(current as any)) type = '';
              } else {
                type = '';
              }

              // Migration: older Eyes items stored the role in `placement`.
              const shadeTrim = (shade || '').trim();
              const placeTrim = (placement || '').trim();
              const allowedRoles = EYES_COLOR_ROLE_OPTIONS as readonly string[];
              const isAllowedRole = (v: string) => allowedRoles.includes(v as any);

              if (subKey === 'eyeshadow') {
                if (!shadeTrim && placeTrim && isAllowedRole(placeTrim)) {
                  shade = placeTrim;
                }
                if (shadeTrim && !isAllowedRole(shadeTrim)) {
                  shade = '';
                }
              }

              // Drop the deprecated field.
              placement = '';
            }

            return {
              id: itemId,
              name: itemName,
              subcategory,
              type,
              brand,
              shade,
              placement,
              undertone: typeof it.undertone === 'string' ? it.undertone : '',
              form: typeof it.form === 'string' ? it.form : '',
              location: typeof it.location === 'string' ? it.location : '',
              quantity: typeof it.quantity === 'string' ? it.quantity : '',
              status,
              purchaseDate: typeof it.purchaseDate === 'string' ? it.purchaseDate : '',
              openedDate: typeof it.openedDate === 'string' ? it.openedDate : '',
              expiryDate: typeof it.expiryDate === 'string' ? it.expiryDate : '',
              notes: typeof it.notes === 'string' ? it.notes : '',
              createdAt: created,
              updatedAt: updated,
            } as KitItem;
          })
          .filter(Boolean) as KitItem[];

        return { id, name, createdAt, items } as KitCategory;
      })
      .filter(Boolean) as KitCategory[];

    if (normalizedCats.length === 0) return base;

    // Merge duplicate categories created by migration (e.g., "Base" + "Foundation" / "Cheeks").
    const merged: KitCategory[] = [];
    const byName = new Map<string, number>();
    for (const cat of normalizedCats) {
      const key = (cat.name || '').trim().toLowerCase();
      const idx = byName.get(key);
      if (idx === undefined) {
        byName.set(key, merged.length);
        merged.push(cat);
      } else {
        const existing = merged[idx];
        merged[idx] = {
          ...existing,
          createdAt: Math.min(existing.createdAt, cat.createdAt),
          items: [...existing.items, ...cat.items],
        };
      }
    }

    // Ensure all core categories exist, and keep their ordering stable.
    const now = Date.now();
    const byLower = new Map<string, KitCategory>();
    merged.forEach((c) => byLower.set((c.name || '').trim().toLowerCase(), c));

    const ordered: KitCategory[] = [];
    for (const n of CORE_CATEGORY_ORDER) {
      const key = (n || '').trim().toLowerCase();
      const hit = byLower.get(key);
      if (hit) {
        ordered.push(hit);
        byLower.delete(key);
      } else {
        ordered.push({ id: uid('cat'), name: n, createdAt: now, items: [] });
      }
    }

    // Append non-core categories (preserve their existing relative order).
    for (const c of merged) {
      const key = (c.name || '').trim().toLowerCase();
      if (!byLower.has(key)) continue;
      ordered.push(c);
      byLower.delete(key);
    }

    // Post-pass migrations for newer category structure.
    const lower = (s: string) => (s || '').trim().toLowerCase();
    const nextCats: KitCategory[] = ordered.map((c) => ({
      ...c,
      items: Array.isArray(c.items) ? [...c.items] : [],
    }));

    const baseIdx = nextCats.findIndex((c) => lower(c.name) === lower(BASE_CATEGORY_NAME));
    const cheeksIdx = nextCats.findIndex((c) => lower(c.name) === lower(CHEEKS_CATEGORY_NAME));
    const sculptIdx = nextCats.findIndex((c) => lower(c.name) === lower(SCULPT_CATEGORY_NAME));

    if (baseIdx >= 0) {
      const baseItems = Array.isArray(nextCats[baseIdx]?.items) ? nextCats[baseIdx].items : [];
      const keep: KitItem[] = [];
      const toCheeks: KitItem[] = [];
      const toSculpt: KitItem[] = [];

      baseItems.forEach((it) => {
        const k = lower((it as any)?.subcategory);
        if (k === 'blush' || k === 'bronzer') toCheeks.push(it);
        else if (k === 'contour' || k === 'highlighter') toSculpt.push(it);
        else keep.push(it);
      });

      nextCats[baseIdx] = { ...nextCats[baseIdx], items: keep };

      if (cheeksIdx >= 0 && toCheeks.length) {
        nextCats[cheeksIdx] = { ...nextCats[cheeksIdx], items: [...nextCats[cheeksIdx].items, ...toCheeks] };
      }
      if (sculptIdx >= 0 && toSculpt.length) {
        nextCats[sculptIdx] = { ...nextCats[sculptIdx], items: [...nextCats[sculptIdx].items, ...toSculpt] };
      }
    }



    // Migration: Cheeks/Sculpt swap (Highlighter -> Sculpt, Bronzer -> Cheeks)
    if (cheeksIdx >= 0 && sculptIdx >= 0) {
      // Move Highlighter out of Cheeks and into Sculpt
      {
        const cheeksItems = Array.isArray(nextCats[cheeksIdx]?.items) ? nextCats[cheeksIdx].items : [];
        const toSculpt: KitItem[] = [];
        const keep: KitItem[] = [];
        cheeksItems.forEach((it) => {
          const k = lower((it as any)?.subcategory);
          if (k === 'highlighter') toSculpt.push(it);
          else keep.push(it);
        });

        if (toSculpt.length) {
          nextCats[cheeksIdx] = { ...nextCats[cheeksIdx], items: keep };
          nextCats[sculptIdx] = { ...nextCats[sculptIdx], items: [...nextCats[sculptIdx].items, ...toSculpt] };
        }
      }

      // Move Bronzer out of Sculpt and into Cheeks
      {
        const sculptItems = Array.isArray(nextCats[sculptIdx]?.items) ? nextCats[sculptIdx].items : [];
        const toCheeks: KitItem[] = [];
        const keep: KitItem[] = [];
        sculptItems.forEach((it) => {
          const k = lower((it as any)?.subcategory);
          if (k === 'bronzer') toCheeks.push(it);
          else keep.push(it);
        });

        if (toCheeks.length) {
          nextCats[sculptIdx] = { ...nextCats[sculptIdx], items: keep };
          nextCats[cheeksIdx] = { ...nextCats[cheeksIdx], items: [...nextCats[cheeksIdx].items, ...toCheeks] };
        }
      }
    }
    return { version: 1, categories: nextCats };
  } catch {
    return base;
  }
}

const Inventory: React.FC<InventoryScreenProps> = ({ navigation, email, userId, planTier = 'free' }) => {
  // Scope local data per user (stable id preferred; fall back to email).
  const scope = userId ?? (email ? String(email).trim().toLowerCase() : null);
  const storageKey = useMemo(() => makeScopedKey(STORAGE_KEY, scope), [scope]);

  const [data, setData] = useState<InventoryData>({ version: 1, categories: defaultCategories() });
  const [hydrated, setHydrated] = useState(false);
  const persistTimer = useRef<any>(null);
  const lastHydratedRawRef = useRef<string | null>(null);
  const editorScrollRef = useRef<any>(null);

  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const tabBarHeight = useBottomTabBarHeight();

  // On first mount of a tab screen, safe-area insets can briefly report 0.
  // Use a stable fallback so the screen never “drops” into place.
  const insets = useSafeAreaInsets();
  const { width: winW, height: winH } = useWindowDimensions();
  const isLandscape = winW > winH;
  const initialTop = Number((initialWindowMetrics as any)?.insets?.top || 0);
  const iosStatusBar = Number((Constants as any)?.statusBarHeight || 0);
  const androidStatusBar = Number((StatusBar as any)?.currentHeight || 0);
  const safeTop = Number(insets?.top || 0);
  const fallbackTop = Platform.OS === 'android' ? androidStatusBar : iosStatusBar;
  const stableTopInset = isLandscape ? safeTop : Math.max(safeTop, initialTop, fallbackTop);

  const [mode, setMode] = useState<'home' | 'category' | 'item'>('home');
  const [activeCategoryId, setActiveCategoryId] = useState<string | null>(null);
  const [activeItemId, setActiveItemId] = useState<string | null>(null);
  const [newItemId, setNewItemId] = useState<string | null>(null);

  const [search, setSearch] = useState('');
  const [view, setView] = useState<ViewMode>('all');
  const [homeAttention, setHomeAttention] = useState<HomeAttentionMode>('low');

  const [newCategoryText, setNewCategoryText] = useState('');
  const [quickAddText, setQuickAddText] = useState('');
  const [toneMenuOpen, setToneMenuOpen] = useState(false);
  const [subcategoryMenuOpen, setSubcategoryMenuOpen] = useState(false);
  const [typeMenuOpen, setTypeMenuOpen] = useState(false);
  const [formMenuOpen, setFormMenuOpen] = useState(false);
  const [colorMenuOpen, setColorMenuOpen] = useState(false);
  const [undertoneGuessBusy, setUndertoneGuessBusy] = useState(false);

  // Close any inline dropdowns when navigating between screens/items.
  useEffect(() => {
    setToneMenuOpen(false);
    setSubcategoryMenuOpen(false);
    setTypeMenuOpen(false);
    setFormMenuOpen(false);
    setColorMenuOpen(false);
  }, [mode, activeCategoryId, activeItemId]);

  // keyboard spacer
  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';

    const showSub = Keyboard.addListener(showEvent as any, (e: any) => {
      setKeyboardHeight(e?.endCoordinates?.height ?? 0);
    });
    const hideSub = Keyboard.addListener(hideEvent as any, () => setKeyboardHeight(0));

    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, [storageKey]);

  // load
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const raw = await getString(storageKey);
        if (!alive) return;
        if (raw) {
          lastHydratedRawRef.current = raw;
          const parsed = JSON.parse(raw);
          setData(normalizeData(parsed));
        }
      } catch {
        // ignore
      } finally {
        if (alive) setHydrated(true);
      }
    })();

    return () => {
      alive = false;
    };
  }, [storageKey]);

  // Rehydrate when returning to this tab so newly-added items (e.g. from Discover)
  // appear immediately without needing an app restart.
  useFocusEffect(
    useCallback(() => {
      let alive = true;
      (async () => {
        if (!hydrated) return;
        try {
          const raw = await getString(storageKey);
          if (!alive) return;
          if (!raw) return;
          if (raw === lastHydratedRawRef.current) return;
          lastHydratedRawRef.current = raw;
          const parsed = JSON.parse(raw);
          setData(normalizeData(parsed));
        } catch {
          // ignore
        }
      })();

      return () => {
        alive = false;
      };
    }, [hydrated, storageKey])
  );

  // persist (debounced)
  useEffect(() => {
    if (!hydrated) return;

    if (persistTimer.current) clearTimeout(persistTimer.current);
    persistTimer.current = setTimeout(() => {
      setString(storageKey, JSON.stringify(data)).catch(() => {});
    }, 450);

    return () => {
      if (persistTimer.current) clearTimeout(persistTimer.current);
    };
  }, [data, hydrated, storageKey]);

  // Screens render ABOVE the tab bar, so subtract its height to avoid a jump.
  const keyboardInset = keyboardHeight > 0 ? Math.max(0, keyboardHeight - tabBarHeight) : 0;

  // Dock the input bar absolutely (so swipes in the lower area still scroll), and
  // keep its resting position consistent with the previous layout.
  const footerBottom = keyboardHeight > 0 ? keyboardInset + KEYBOARD_GAP : FOOTER_REST_OFFSET;
  const scrollPadBottom = footerBottom + FOOTER_BAR_HEIGHT + 14;

  const activeCategory = useMemo(() => {
    if (!activeCategoryId) return null;
    return data.categories.find((c) => c.id === activeCategoryId) ?? null;
  }, [data.categories, activeCategoryId]);

  const activeItem = useMemo(() => {
    if (!activeCategory || !activeItemId) return null;
    return activeCategory.items.find((it) => it.id === activeItemId) ?? null;
  }, [activeCategory, activeItemId]);
  const activeCategoryKey = (activeCategory?.name ?? '').trim().toLowerCase();
  const showBaseFormSelect = activeCategoryKey === BASE_CATEGORY_NAME.toLowerCase();

  const subsetOptions = useMemo(() => {
    if (activeCategoryKey === BASE_CATEGORY_NAME.toLowerCase()) return [...BASE_SUBSET_OPTIONS];
    if (activeCategoryKey === CHEEKS_CATEGORY_NAME.toLowerCase()) return [...CHEEKS_SUBSET_OPTIONS];
    if (activeCategoryKey === SCULPT_CATEGORY_NAME.toLowerCase()) return [...SCULPT_SUBSET_OPTIONS];
    if (activeCategoryKey === 'lips') return [...LIPS_SUBSET_OPTIONS];
    if (activeCategoryKey === 'eyes') return [...EYES_SUBSET_OPTIONS];
    if (activeCategoryKey === 'brows') return [...BROWS_SUBSET_OPTIONS];
    return [] as string[];
  }, [activeCategoryKey]);

  const showSubset = subsetOptions.length > 0;
  const subsetKey = (activeItem?.subcategory ?? '').trim().toLowerCase();
  const eyesTypeKey = (activeItem?.type ?? '').trim().toLowerCase();

  const showEyelinerPencilColorInput = activeCategoryKey === 'eyes' && subsetKey === 'eyeliner' && eyesTypeKey === 'pencil';

  const formPlaceholder = useMemo(() => {
    if (activeCategoryKey === 'lips') {
      if (subsetKey === 'lipliner') return 'Waterproof';
      if (subsetKey === 'lipstick') return 'Matte';
    }
    return 'Cream';
  }, [activeCategoryKey, subsetKey]);

  const showEyesColorSelect = activeCategoryKey === 'eyes' && subsetKey === 'eyeshadow';
  const showEyesTypeSelect = activeCategoryKey === 'eyes' && (subsetKey === 'eyeshadow' || subsetKey === 'eyeliner');
  const eyesTypeOptions = useMemo(() => {
    if (activeCategoryKey !== 'eyes') return [] as string[];
    if (subsetKey === 'eyeshadow') return [...EYESHADOW_TYPE_OPTIONS];
    if (subsetKey === 'eyeliner') return [...EYELINER_TYPE_OPTIONS];
    return [] as string[];
  }, [activeCategoryKey, subsetKey]);

  const categoryHasNoToneFormColor =
    activeCategoryKey === PREP_FINISH_CATEGORY_NAME.toLowerCase() ||
    activeCategoryKey === 'tools' ||
    activeCategoryKey === 'hygiene & disposables' ||
    activeCategoryKey === 'brows';

  const hideUndertone =
    categoryHasNoToneFormColor ||
    (activeCategoryKey === 'eyes' && (subsetKey === 'mascara' || subsetKey === 'lashes')) ||
    (activeCategoryKey === 'lips' && (subsetKey === 'lip gloss' || subsetKey === 'lip balm/treatments'));

  const hideForm =
    categoryHasNoToneFormColor ||
    (activeCategoryKey === BASE_CATEGORY_NAME.toLowerCase() && (subsetKey === 'concealer' || subsetKey === 'powder')) ||
    (activeCategoryKey === 'eyes' && (subsetKey === 'mascara' || subsetKey === 'lashes')) ||
    (activeCategoryKey === 'lips' && (subsetKey === 'lip gloss' || subsetKey === 'lip balm/treatments')) ||
    showEyelinerPencilColorInput;

  const hideColor = categoryHasNoToneFormColor;

  const visibleCategories = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = !q
      ? data.categories
      : data.categories.filter((c) => {
          if (c.name.toLowerCase().includes(q)) return true;
          return c.items.some((it) => {
            const name = (it.name ?? '').toLowerCase();
            const brand = (it.brand ?? '').toLowerCase();
            return name.includes(q) || brand.includes(q);
          });
        });

    // Keep Prep & Finish first, then the core face areas.
    const priority = [
      PREP_FINISH_CATEGORY_NAME.toLowerCase(),
      BASE_CATEGORY_NAME.toLowerCase(),
      CHEEKS_CATEGORY_NAME.toLowerCase(),
      SCULPT_CATEGORY_NAME.toLowerCase(),
      'lips',
      'eyes',
      'brows',
    ];
    const rank = new Map<string, number>(priority.map((n, i) => [n, i]));

    // Stable sort: preserve existing order for non-priority categories.
    return filtered
      .map((c, idx) => ({ c, idx }))
      .sort((a, b) => {
        const ra = rank.get(a.c.name.trim().toLowerCase());
        const rb = rank.get(b.c.name.trim().toLowerCase());

        const aHas = ra !== undefined;
        const bHas = rb !== undefined;
        if (aHas && bHas) return (ra as number) - (rb as number);
        if (aHas) return -1;
        if (bHas) return 1;
        return a.idx - b.idx;
      })
      .map((row) => row.c);
  }, [data.categories, search]);

      const lowItems = useMemo(() => {
    const out: { categoryId: string; categoryName: string; item: KitItem }[] = [];
    data.categories.forEach((c) => {
      c.items.forEach((it) => {
        if (it.status === 'low') out.push({ categoryId: c.id, categoryName: c.name, item: it });
      });
    });
    out.sort((a, b) => b.item.updatedAt - a.item.updatedAt);
    return out;
  }, [data.categories]);

  const emptyItems = useMemo(() => {
    const out: { categoryId: string; categoryName: string; item: KitItem }[] = [];
    data.categories.forEach((c) => {
      c.items.forEach((it) => {
        if (it.status === 'empty') out.push({ categoryId: c.id, categoryName: c.name, item: it });
      });
    });
    out.sort((a, b) => b.item.updatedAt - a.item.updatedAt);
    return out;
  }, [data.categories]);

  const expiringItems = useMemo(() => {
    const out: { categoryId: string; categoryName: string; item: KitItem; label: string }[] = [];
    data.categories.forEach((c) => {
      c.items.forEach((it) => {
        const label = expiringLabel(it.expiryDate);
        if (label) out.push({ categoryId: c.id, categoryName: c.name, item: it, label });
      });
    });
    const ts = (row: { item: KitItem }) => safeParseDate(row.item.expiryDate) ?? Number.POSITIVE_INFINITY;
    out.sort((a, b) => ts(a) - ts(b));
    return out;
  }, [data.categories]);

  const homeLowItems = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return lowItems;
    return lowItems.filter((row) => {
      const hay = `${row.item.name ?? ''} ${row.item.brand ?? ''} ${row.categoryName ?? ''}`.toLowerCase();
      return hay.includes(q);
    });
  }, [lowItems, search]);

  const homeEmptyItems = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return emptyItems;
    return emptyItems.filter((row) => {
      const hay = `${row.item.name ?? ''} ${row.item.brand ?? ''} ${row.categoryName ?? ''}`.toLowerCase();
      return hay.includes(q);
    });
  }, [emptyItems, search]);

  const homeExpiringItems = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return expiringItems;
    return expiringItems.filter((row) => {
      const hay = `${row.item.name ?? ''} ${row.item.brand ?? ''} ${row.categoryName ?? ''}`.toLowerCase();
      return hay.includes(q);
    });
  }, [expiringItems, search]);

  const visibleItemsInCategory = useMemo(() => {
    if (!activeCategory) return [] as KitItem[];
    let items = [...activeCategory.items];

    // view filter
    if (view === 'low') items = items.filter((it) => it.status === 'low');
    if (view === 'empty') items = items.filter((it) => it.status === 'empty');
    if (view === 'expiring') {
      const windowDays = 60;
      items = items.filter((it) => {
        const ts = safeParseDate(it.expiryDate);
        if (!ts) return false;
        return ts - Date.now() <= windowDays * 24 * 60 * 60 * 1000;
      });
    }

    // search inside category
    const q = search.trim().toLowerCase();
    if (q) {
      items = items.filter((it) => {
        const hay = `${it.name ?? ''} ${it.brand ?? ''} ${it.shade ?? ''} ${it.location ?? ''}`.toLowerCase();
        return hay.includes(q);
      });
    }

    // sort
    if (view === 'expiring') {
      const ts = (it: KitItem) => safeParseDate(it.expiryDate) ?? Number.POSITIVE_INFINITY;
      items.sort((a, b) => ts(a) - ts(b));
    } else {
      items.sort((a, b) => b.updatedAt - a.updatedAt);
    }

    return items;
  }, [activeCategory, view, search]);

  function openCategory(categoryId: string) {
    setActiveCategoryId(categoryId);
    setMode('category');
    setView('all');
    setQuickAddText('');
    setNewItemId(null);
  }

  function closeCategory() {
    setMode('home');
    setActiveCategoryId(null);
    setActiveItemId(null);
    setView('all');
    setQuickAddText('');
    setSearch('');
    setNewItemId(null);
  }

  function openItemDirect(categoryId: string, itemId: string) {
    setActiveCategoryId(categoryId);
    setActiveItemId(itemId);
    setMode('item');
    setView('all');
    setQuickAddText('');
    setSearch('');
    setNewItemId(null);
  }

  function openItem(itemId: string) {
    setActiveItemId(itemId);
    setMode('item');
    setNewItemId(null);
  }

  function isBlankItem(it: KitItem): boolean {
    const nameEmpty = !(it.name || '').trim();
    const subsetEmpty = !(it.subcategory || '').trim();
    const typeEmpty = !(it.type || '').trim();
    const brandEmpty = !(it.brand || '').trim();
    const shadeEmpty = !(it.shade || '').trim();
    const undertoneEmpty = !(it.undertone || '').trim();
    const formEmpty = !(it.form || '').trim();
    const locationEmpty = !(it.location || '').trim();
    const qtyEmpty = !(it.quantity || '').trim();
    const purchaseEmpty = !(it.purchaseDate || '').trim();
    const openedEmpty = !(it.openedDate || '').trim();
    const expiryEmpty = !(it.expiryDate || '').trim();
    const notesEmpty = !(it.notes || '').trim();
    const statusDefault = it.status === 'inKit';

    return (
      nameEmpty &&
      subsetEmpty &&
      typeEmpty &&
      brandEmpty &&
      shadeEmpty &&
      undertoneEmpty &&
      formEmpty &&
      locationEmpty &&
      qtyEmpty &&
      purchaseEmpty &&
      openedEmpty &&
      expiryEmpty &&
      notesEmpty &&
      statusDefault
    );
  }

  function closeItem() {
    const catId = activeCategoryId;
    const itemId = activeItemId;

    // If the user opened the panel from the + button without filling anything,
    // discard the empty placeholder item on close.
    if (catId && itemId && newItemId === itemId && activeItem && isBlankItem(activeItem)) {
      setData((prev) => ({
        ...prev,
        categories: prev.categories.map((c) => {
          if (c.id !== catId) return c;
          return { ...c, items: c.items.filter((it) => it.id !== itemId) };
        }),
      }));
    }

    setMode('category');
    setActiveItemId(null);
    setNewItemId(null);
  }

  function addCategoryFromBar() {
    const name = normalizeCategoryName(newCategoryText).trim();
    if (!name) {
      Keyboard.dismiss();
      return;
    }

    // If the category already exists, jump to it instead of creating a duplicate.
    const existing = data.categories.find((c) => (c.name || '').trim().toLowerCase() === name.toLowerCase());
    if (existing) {
      setNewCategoryText('');
      Keyboard.dismiss();
      openCategory(existing.id);
      return;
    }

    const limit = PLAN_LIMITS[planTier].categories;
    const used = Array.isArray(data.categories)
      ? data.categories.filter((c) => !isCoreCategoryName(c.name)).length
      : 0;
    if (limit !== Infinity && used >= limit) {
      const isPro = planTier === 'pro';
      const msg = isPro
        ? `You've reached your limit of ${limit.toLocaleString()} custom categories.`
        : `You've reached your limit of ${limit.toLocaleString()} custom categories. Upgrade to Pro to add more.`;

      const title = isPro ? 'Limit reached' : 'Upgrade to Pro';

      Alert.alert(
        title,
        msg,
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

    const now = Date.now();
    const cat: KitCategory = { id: uid('cat'), name, createdAt: now, items: [] };

    // Append so the default/core category order stays intact.
    setData((prev) => ({ ...prev, categories: [...prev.categories, cat] }));
    setNewCategoryText('');
    Keyboard.dismiss();
  }

  function confirmDeleteCategory(categoryId: string) {
    const cat = data.categories.find((c) => c.id === categoryId);
    if (!cat) return;

    // Only user-added categories can be deleted.
    if (isCoreCategoryName(cat.name)) return;

    Alert.alert('Delete category?', `"${cat.name}" and all its items will be removed.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => {
          setData((prev) => ({
            ...prev,
            categories: prev.categories.filter((c) => c.id !== categoryId),
          }));
          if (activeCategoryId === categoryId) closeCategory();
        },
      },
    ]);
  }

  function confirmDeleteItem(categoryId: string, itemId: string) {
    Alert.alert('Delete item?', 'This item will be removed from your kit.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => {
          setData((prev) => ({
            ...prev,
            categories: prev.categories.map((c) => {
              if (c.id !== categoryId) return c;
              return { ...c, items: c.items.filter((it) => it.id !== itemId) };
            }),
          }));
          if (activeItemId === itemId) closeItem();
        },
      },
    ]);
  }

  function quickAddItem() {
    if (!activeCategoryId) return;
    const text = quickAddText.trim();

    const limit = PLAN_LIMITS[planTier].items;
    const used = Array.isArray(data.categories)
      ? data.categories.reduce((sum, c) => sum + (Array.isArray(c.items) ? c.items.length : 0), 0)
      : 0;
    if (limit !== Infinity && used >= limit) {
      const isPro = planTier === 'pro';
      const msg = isPro
        ? `You've reached your limit of ${limit.toLocaleString()} kit items.`
        : `You've reached your limit of ${limit.toLocaleString()} kit items. Upgrade to Pro to add more.`;

      const title = isPro ? 'Limit reached' : 'Upgrade to Pro';

      Alert.alert(
        title,
        msg,
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

    const now = Date.now();
    const newId = uid('item');

    const item: KitItem = {
      id: newId,
      name: text,
      subcategory: '',
      type: '',
      brand: '',
      shade: '',
      placement: '',
      undertone: '',
      form: '',
      location: '',
      quantity: '',
      status: 'inKit',
      purchaseDate: '',
      openedDate: '',
      expiryDate: '',
      notes: '',
      createdAt: now,
      updatedAt: now,
    };

    setData((prev) => ({
      ...prev,
      categories: prev.categories.map((c) => {
        if (c.id !== activeCategoryId) return c;
        return { ...c, items: [item, ...c.items] };
      }),
    }));

    setQuickAddText('');
    Keyboard.dismiss();

    // Open item editor immediately so user can fill details.
    setActiveItemId(newId);
    setNewItemId(newId);
    setMode('item');
  }

  function updateItemField(field: keyof KitItem, value: string) {
    if (!activeCategoryId || !activeItemId) return;

    setData((prev) => ({
      ...prev,
      categories: prev.categories.map((c) => {
        if (c.id !== activeCategoryId) return c;
        return {
          ...c,
          items: c.items.map((it) => {
            if (it.id !== activeItemId) return it;
            return { ...it, [field]: value, updatedAt: Date.now() };
          }),
        };
      }),
    }));
  }

  async function guessUndertoneForActiveItem() {
    const item = activeItem;
    if (!item) return;

    const name = String(item?.name || '').trim();
    const brand = String(item?.brand || '').trim();
    const shade = String(item?.shade || '').trim();
    const notes = String(item?.notes || '').trim();

    if (!name && !brand && !shade) {
      Alert.alert('Add a product name', 'Enter at least a product name (or shade) so Undertone can guess the undertone.');
      return;
    }

    // Close inline menus + keyboard so the result feels intentional.
    setToneMenuOpen(false);
    setSubcategoryMenuOpen(false);
    setTypeMenuOpen(false);
    setFormMenuOpen(false);
    setColorMenuOpen(false);
    Keyboard.dismiss();

    setUndertoneGuessBusy(true);

    try {
      let result: InferredUndertone | null = null;

      const token = String((await getToken()) || '').trim();

      // Prefer server-side AI if possible.
      if (token) {
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 9000);

          try {
            const res = await fetch(`${API_BASE}/infer-undertone`, {
              method: 'POST',
              headers: {
                authorization: `Bearer ${token}`,
                'content-type': 'application/json',
                accept: 'application/json',
              } as any,
              body: JSON.stringify({
                name,
                brand,
                shade,
                notes,
                category: activeCategory?.name ?? '',
                subcategory: item?.subcategory ?? '',
                group: item?.type ?? '',
              }),
              signal: controller.signal,
            } as any);

            const data = await res.json().catch(() => ({}));
            if (!res.ok || data?.ok === false) {
              const msg = String(data?.error || `HTTP ${res.status}`);
              throw new Error(msg);
            }

            const undertoneRaw = String(data?.undertone ?? data?.tone ?? '').trim().toLowerCase();
            const confidenceRaw = Number(data?.confidence ?? 0);
            const reasonRaw = String(data?.reason || data?.rationale || '').trim();

            const undertone: InferredUndertone['undertone'] =
              undertoneRaw === 'cool' || undertoneRaw === 'neutral' || undertoneRaw === 'warm' || undertoneRaw === 'unknown'
                ? (undertoneRaw as any)
                : 'unknown';

            const confidence = Number.isFinite(confidenceRaw)
              ? Math.max(0, Math.min(100, Math.round(confidenceRaw)))
              : 0;

            result = {
              undertone,
              confidence,
              reason: reasonRaw || 'AI guess based on the product name/shade.',
            };
          } finally {
            clearTimeout(timer);
          }
        } catch {
          result = null;
        }
      }

      // Fallback: local heuristic if server is unreachable or user isn't signed in.
      if (!result) {
        result = inferProductUndertoneLocal({ name, brand, shade, notes });
      }

      if (result.undertone === 'unknown') {
        Alert.alert('Not sure', result.reason || 'I couldn’t infer the undertone from the name. Try adding a shade code (e.g., 2N / 3W).');
        return;
      }

      const label = TONE_OPTIONS.find((o) => o.key === result!.undertone)?.label || result.undertone;
      const pct = Number.isFinite(result.confidence) ? Math.round(result.confidence) : 0;
      const body = `Confidence: ${pct}%`;

      Alert.alert(`Suggested: ${label}`, body, [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Set',
          onPress: () => {
            updateItemField('undertone', result!.undertone);
          },
        },
      ]);
    } catch (e: any) {
      Alert.alert('Couldn’t guess undertone', String(e?.message || e));
    } finally {
      setUndertoneGuessBusy(false);
    }
  }

  function setItemStatus(next: ItemStatus) {
    if (!activeCategoryId || !activeItemId) return;

    setData((prev) => ({
      ...prev,
      categories: prev.categories.map((c) => {
        if (c.id !== activeCategoryId) return c;
        return {
          ...c,
          items: c.items.map((it) => {
            if (it.id !== activeItemId) return it;
            return { ...it, status: next, updatedAt: Date.now() };
          }),
        };
      }),
    }));
  }

  function cycleItemStatus(categoryId: string, itemId: string) {
    setData((prev) => ({
      ...prev,
      categories: prev.categories.map((c) => {
        if (c.id !== categoryId) return c;
        return {
          ...c,
          items: c.items.map((it) => {
            if (it.id !== itemId) return it;
            return { ...it, status: nextStatus(it.status), updatedAt: Date.now() };
          }),
        };
      }),
    }));
  }

  function openStatusPicker() {
    // Simple + compact (no large segmented tabs)
    Alert.alert('Status', '', [
      { text: 'In kit', onPress: () => setItemStatus('inKit') },
      { text: 'Low', onPress: () => setItemStatus('low') },
      { text: 'Empty', onPress: () => setItemStatus('empty') },
      { text: 'Cancel', style: 'cancel' },
    ]);
  }

  const searchPlaceholder = mode === 'home' ? 'Search categories' : 'Search items';

  return (
    <TouchableWithoutFeedback onPress={Keyboard.dismiss}>
      <SafeAreaView style={[styles.safeArea, { paddingTop: stableTopInset }]} edges={['left', 'right']}>
        <View style={styles.container}>
          {/* Top bar */}
          <View style={styles.topBar}>
            <View style={styles.searchPill}>
              <Ionicons name="search-outline" size={16} color="#111111" style={{ marginRight: 8 }} />
              <TextInput
                style={styles.searchInput}
                value={search}
                onChangeText={setSearch}
                placeholder={searchPlaceholder}
                placeholderTextColor="#999999"
                returnKeyType="search"
              />
              {!!search.trim() && (
                <TouchableOpacity style={styles.clearBtn} onPress={() => setSearch('')} accessibilityRole="button">
                  <Ionicons name="close" size={18} color="#9ca3af" />
                </TouchableOpacity>
              )}
            </View>
          </View>

          {/* HOME */}
          {mode === 'home' && (
            <View style={{ flex: 1 }}>
              <ScrollView
                style={{ flex: 1 }}
                contentContainerStyle={{
                  paddingBottom: scrollPadBottom,
                  paddingTop: 18,
                  paddingLeft: 6,
                  paddingRight: 0,
                }}
                keyboardShouldPersistTaps="handled"
                showsVerticalScrollIndicator={false}
              >
                <View style={[styles.sectionHeader, styles.homeSectionHeader]}>
                  <Text style={styles.sectionTitle}>Category</Text>
                  <Text style={styles.sectionMeta}>{data.categories.length}</Text>
                </View>

                <View style={[styles.hairline, styles.homeHeaderDivider]} />

                {visibleCategories.length === 0 ? (
                  <View style={styles.emptyPad}>
                    <Text style={styles.emptyText}>No categories found.</Text>
                  </View>
                ) : (
                  <View style={styles.categoryList}>
                    {visibleCategories.map((cat, idx) => {
                      const isLast = idx === visibleCategories.length - 1;
                      const isCore = isCoreCategoryName(cat.name);
                      const total = cat.items.length;
                      const inKitCount = cat.items.reduce((acc, it) => acc + (it.status === 'inKit' ? 1 : 0), 0);
                      const lowCount = cat.items.reduce((acc, it) => acc + (it.status === 'low' ? 1 : 0), 0);
                      const emptyCount = cat.items.reduce((acc, it) => acc + (it.status === 'empty' ? 1 : 0), 0);
                      const expCount = cat.items.reduce((acc, it) => acc + (expiringLabel(it.expiryDate) ? 1 : 0), 0);

                      const fillUnits = Math.min(total, CATEGORY_BAR_TARGET);
                      const emptyUnits = Math.max(CATEGORY_BAR_TARGET - fillUnits, 0);

                      const metaBits: string[] = [];
                      if (lowCount) metaBits.push(`${lowCount} low`);
                      if (emptyCount) metaBits.push(`${emptyCount} empty`);
                      if (expCount) metaBits.push(`${expCount} expiring`);

                      // Only show meta when it adds information.
                      // (User requested removing the "All good" filler text.)
                      const meta = metaBits.join(' • ');

                      return (
                        <View key={cat.id} style={!isLast ? { marginBottom: 15 } : null}>
                          <TouchableOpacity
                            style={styles.categoryListRow}
                            activeOpacity={0.9}
                            onPress={() => openCategory(cat.id)}
                            accessibilityRole="button"
                          >
                            <View style={styles.categoryListRowMain}>
                              <View style={styles.categoryRowTitleLine}>
                                <Text style={styles.categoryRowName} numberOfLines={1}>
                                  {cat.name}
                                </Text>
                                <Text style={[styles.categoryRowItemCount, total === 0 ? styles.categoryRowItemCountZero : null]} numberOfLines={1}>
                                  {itemCountLabel(total)}
                                </Text>
                              </View>

                              <View style={[styles.categoryRackBar, !isCore ? styles.categoryRackBarShort : null]}>
                                {fillUnits > 0 ? (
                                  <View style={[styles.categoryRackFill, { flex: fillUnits }]}>
                                    {inKitCount > 0 ? (
                                      <View style={[styles.categoryRackSeg, { flex: inKitCount, backgroundColor: '#111111' }]} />
                                    ) : null}
                                    {lowCount > 0 ? (
                                      <View style={[styles.categoryRackSeg, { flex: lowCount, backgroundColor: '#6b7280' }]} />
                                    ) : null}
                                    {emptyCount > 0 ? (
                                      <View style={[styles.categoryRackSeg, { flex: emptyCount, backgroundColor: '#d1d5db' }]} />
                                    ) : null}
                                  </View>
                                ) : null}

                                {emptyUnits > 0 ? <View style={{ flex: emptyUnits }} /> : null}
                              </View>

                              {!!meta ? (
                                <Text
                                  style={styles.categoryRackMeta}
                                  numberOfLines={1}
                                >
                                  {meta}
                                </Text>
                              ) : null}
                            </View>

                            {!isCore ? (
                              <View style={styles.categoryListRowActions}>
                                <TouchableOpacity
                                  style={styles.categoryDeleteBtn}
                                  onPress={() => confirmDeleteCategory(cat.id)}
                                  accessibilityRole="button"
                                  hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                                >
                                  <Ionicons name="trash-outline" size={18} color="#9ca3af" />
                                </TouchableOpacity>
                              </View>
                            ) : null}
                          </TouchableOpacity>
                        </View>
                      );
                    })}
                  </View>
                )}

                <View style={[styles.hairline, styles.homeSectionDivider]} />

                <View>
                  <View style={[styles.sectionHeader, styles.homeSectionHeader, styles.needsAttentionHeader]}>
                    <Text style={[styles.sectionTitle, styles.needsAttentionTitle]}>Needs attention</Text>
                    <Text style={styles.sectionMeta}>
                      {homeLowItems.length + homeEmptyItems.length + homeExpiringItems.length}
                    </Text>
                  </View>

                  <View style={styles.homeAttentionTabs}>
                    {([
                      { key: 'low', label: 'Low', count: homeLowItems.length },
                      { key: 'empty', label: 'Empty', count: homeEmptyItems.length },
                      { key: 'expiring', label: 'Expiring', count: homeExpiringItems.length },
                    ] as const).map((t) => {
                      const on = homeAttention === t.key;
                      return (
                        <TouchableOpacity
                          key={t.key}
                          style={[styles.homeAttentionTab, on ? styles.homeAttentionTabOn : null]}
                          activeOpacity={0.9}
                          onPress={() => setHomeAttention(t.key)}
                          accessibilityRole="button"
                        >
                          <Text style={[styles.homeAttentionTabText, on ? styles.homeAttentionTabTextOn : null]}>
                            {t.label}
                          </Text>
                          <View style={[styles.homeAttentionCountBubble, on ? styles.homeAttentionCountBubbleOn : null]}>
                            <Text style={[styles.homeAttentionCountText, on ? styles.homeAttentionCountTextOn : null]}>
                              {t.count}
                            </Text>
                          </View>
                        </TouchableOpacity>
                      );
                    })}
                  </View>

                  <View style={styles.attentionCard}>
                    {(() => {
                      const rows =
                        homeAttention === 'low'
                          ? homeLowItems
                          : homeAttention === 'empty'
                          ? homeEmptyItems
                          : homeExpiringItems;

                      if (rows.length === 0) {
                        const msg =
                          homeAttention === 'low'
                            ? 'No low items.'
                            : homeAttention === 'empty'
                            ? 'No empty items.'
                            : 'No expiring items.';
                        return (
                          <View style={styles.emptyPad}>
                            <Text style={styles.emptyText}>{msg}</Text>
                          </View>
                        );
                      }

                      const limit = 8;
                      return rows.slice(0, limit).map((row: any, idx: number) => {
                        const isLast = idx === Math.min(rows.length, limit) - 1;
                        const sub = [row.categoryName, row.item.brand].filter(Boolean).join(' • ');

                        const icon =
                          homeAttention === 'low'
                            ? ('alert-circle-outline' as any)
                            : homeAttention === 'empty'
                            ? ('remove-circle-outline' as any)
                            : ('time-outline' as any);

                        const pill =
                          homeAttention === 'expiring' ? row.label : homeAttention === 'low' ? 'Low' : 'Empty';

                        return (
                          <View key={`${row.categoryId}_${row.item.id}`}>
                            <TouchableOpacity
                              style={styles.alertRow}
                              activeOpacity={0.85}
                              onPress={() => openItemDirect(row.categoryId, row.item.id)}
                            >
                              <View style={styles.alertIcon}>
                                <Ionicons name={icon} size={18} color="#111111" />
                              </View>

                              <View style={{ flex: 1, paddingRight: 10 }}>
                                <Text style={styles.alertTitle} numberOfLines={1}>
                                  {row.item.name || 'Untitled'}
                                </Text>
                                {!!sub && (
                                  <Text style={styles.alertSub} numberOfLines={1}>
                                    {sub}
                                  </Text>
                                )}
                              </View>

                              <View style={[styles.alertPill, homeAttention === 'expiring' ? styles.alertPillWide : null]}>
                                <Text style={styles.alertPillText} numberOfLines={1}>
                                  {pill}
                                </Text>
                              </View>

                              <Ionicons name="chevron-forward" size={16} color="#9ca3af" />
                            </TouchableOpacity>

                            {!isLast ? <View style={styles.hairline} /> : null}
                          </View>
                        );
                      });
                    })()}
                  </View>
                </View>
              </ScrollView>

              {/* White underlay to mask scroll content between the docked bar and the tab bar */}
              <View style={[styles.inputBarUnderlay, { height: footerBottom }]} pointerEvents="none" />

              {/* Bottom bar (home) – create category */}
              <View style={[styles.inputBarDock, { bottom: footerBottom }]} pointerEvents="box-none">
                <View style={styles.inputBar} pointerEvents="box-none">
                  <View style={styles.inputContainer} pointerEvents="box-none">
                  <TextInput
                    style={styles.textInput}
                    value={newCategoryText}
                    onChangeText={setNewCategoryText}
                    placeholder="Add category…"
                    placeholderTextColor="#999999"
                    returnKeyType="done"
                    onSubmitEditing={addCategoryFromBar}
                    blurOnSubmit={false}
                  />

                  <TouchableOpacity style={styles.iconButton} onPress={addCategoryFromBar} accessibilityRole="button">
                    <Ionicons name="add" size={20} color="#ffffff" />
                  </TouchableOpacity>
                  </View>
                </View>
              </View>
            </View>
          )}

          {/* CATEGORY */}
          {mode === 'category' && activeCategory && (
            <View style={{ flex: 1 }}>
              <View style={styles.catNavRow}>
                <TouchableOpacity style={styles.catNavBack} onPress={closeCategory} accessibilityRole="button">
                  <Ionicons name="chevron-back" size={18} color="#111111" />
                  <Text style={styles.catNavBackText}>Categories</Text>
                </TouchableOpacity>

                <Text style={styles.catNavTitle} numberOfLines={1}>
                  {activeCategory.name}
                </Text>
              </View>

              {/* View tabs (pill style) */}
              <View style={styles.viewTabs}>
                {(['all', 'low', 'empty', 'expiring'] as ViewMode[]).map((v) => {
                  const on = view === v;
                  return (
                    <TouchableOpacity
                      key={v}
                      style={[styles.viewTab, on ? styles.viewTabOn : null]}
                      activeOpacity={0.9}
                      onPress={() => setView(v)}
                      accessibilityRole="button"
                    >
                      <Text style={[styles.viewTabText, on ? styles.viewTabTextOn : null]}>{viewLabel(v)}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>

              <ScrollView
                style={{ flex: 1 }}
                contentContainerStyle={{ paddingBottom: scrollPadBottom, paddingTop: 12 }}
                keyboardShouldPersistTaps="handled"
                showsVerticalScrollIndicator={false}
              >
                <View style={styles.listCard}>
                  {visibleItemsInCategory.length === 0 ? (
                    <View style={styles.emptyPad}>
                      <Text style={styles.emptyText}>No items.</Text>
                      <Text style={styles.emptySub}>Add one with the bar below.</Text>
                    </View>
                  ) : (
                    visibleItemsInCategory.map((it, idx) => {
                      const isLast = idx === visibleItemsInCategory.length - 1;

                      const expLine = expiringLabel(it.expiryDate);
                      const subKey = (it.subcategory ?? '').trim().toLowerCase();
                      const showShade = activeCategoryKey !== 'eyes' || subKey === 'eyeshadow palette' || subKey === 'eyeshadow singles';
                      const subBits = [it.subcategory, it.brand, showShade ? it.shade : '', it.location].filter(Boolean).join(' • ');
                      const sub = expLine ? [subBits, expLine].filter(Boolean).join(' • ') : subBits;

                      return (
                        <View key={it.id}>
                          <TouchableOpacity style={styles.itemRow} activeOpacity={0.85} onPress={() => openItem(it.id)}>
                            <View style={{ flex: 1, paddingRight: 10 }}>
                              <Text style={styles.itemName} numberOfLines={1}>
                                {it.name || 'Untitled'}
                              </Text>
                              {!!sub && (
                                <Text style={styles.itemSub} numberOfLines={2}>
                                  {sub}
                                </Text>
                              )}
                            </View>

                            <TouchableOpacity
                              style={[styles.statusChip, it.status !== 'inKit' ? styles.statusChipWarn : null]}
                              activeOpacity={0.85}
                              onPress={() => cycleItemStatus(activeCategory.id, it.id)}
                              accessibilityRole="button"
                            >
                              <Text
                                style={[
                                  styles.statusChipText,
                                  it.status !== 'inKit' ? styles.statusChipTextWarn : null,
                                ]}
                              >
                                {statusLabel(it.status)}
                              </Text>
                            </TouchableOpacity>

                            <TouchableOpacity
                              style={styles.rowIcon}
                              onPress={() => confirmDeleteItem(activeCategory.id, it.id)}
                              accessibilityRole="button"
                            >
                              <Ionicons name="trash-outline" size={18} color="#9ca3af" />
                            </TouchableOpacity>
                          </TouchableOpacity>

                          {!isLast ? <View style={styles.hairline} /> : null}
                        </View>
                      );
                    })
                  )}
                </View>
              </ScrollView>

              {/* White underlay to mask scroll content between the docked bar and the tab bar */}
              <View style={[styles.inputBarUnderlay, { height: footerBottom }]} pointerEvents="none" />

              {/* Bottom bar (category) – add item */}
              <View style={[styles.inputBarDock, { bottom: footerBottom }]} pointerEvents="box-none">
                <View style={styles.inputBar} pointerEvents="box-none">
                  <View style={styles.inputContainer} pointerEvents="box-none">
                  <TextInput
                    style={styles.textInput}
                    value={quickAddText}
                    onChangeText={setQuickAddText}
                    placeholder="Add item…"
                    placeholderTextColor="#999999"
                    returnKeyType="done"
                    onSubmitEditing={quickAddItem}
                    blurOnSubmit={false}
                  />

                    <TouchableOpacity style={styles.iconButton} onPress={quickAddItem} accessibilityRole="button">
                      <Ionicons name="add" size={20} color="#ffffff" />
                    </TouchableOpacity>
                  </View>
                </View>
              </View>
            </View>
          )}

          {/* ITEM EDITOR */}
          <Modal
            visible={mode === 'item'}
            animationType="slide"
            presentationStyle={Platform.OS === 'ios' ? 'pageSheet' : 'fullScreen'}
            onRequestClose={closeItem}
          >
            <SafeAreaView style={styles.modalSafe} edges={['top', 'left', 'right']}>
              <View style={styles.modalContainer}>
                <View style={styles.modalHeader}>
                  <TouchableOpacity style={styles.modalBack} onPress={closeItem} accessibilityRole="button">
                    <Ionicons name="chevron-back" size={20} color="#111111" />
                    <Text style={styles.modalBackText}>Items</Text>
                  </TouchableOpacity>
                </View>

                <ScrollView
                  ref={editorScrollRef}
                  style={{ flex: 1 }}
                  contentContainerStyle={{
                    paddingTop: 12,
                    paddingBottom: keyboardHeight > 0 ? keyboardHeight + 40 : 28,
                  }}
                  keyboardShouldPersistTaps="handled"
                  showsVerticalScrollIndicator={false}
                >
                  {/* Compact header row: name + status */}
                  <View style={styles.editorCard}>
                    <View style={styles.itemHeaderRow}>
                      <TextInput
                        value={activeItem?.name ?? ''}
                        onChangeText={(v) => updateItemField('name', v)}
                        placeholder="Name"
                        placeholderTextColor="#9ca3af"
                        style={styles.itemNameInline}
                        autoCorrect={false}
                      />

                      <View style={styles.statusMini}>
                        {(['inKit', 'low', 'empty'] as ItemStatus[]).map((s) => {
                          const on = (activeItem?.status ?? 'inKit') === s;
                          return (
                            <TouchableOpacity
                              key={s}
                              style={[styles.statusMiniBtn, on ? styles.statusMiniBtnOn : null]}
                              activeOpacity={0.9}
                              onPress={() => setItemStatus(s)}
                            >
                              <Text style={[styles.statusMiniText, on ? styles.statusMiniTextOn : null]}>
                                {statusLabel(s)}
                              </Text>
                            </TouchableOpacity>
                          );
                        })}
                      </View>
                    </View>
                  </View>

                  <View style={{ height: 12 }} />

                  <View style={styles.editorCard}>
                    {showSubset ? (
                      <>
                        <View style={styles.formRow}>
                          <Text style={styles.formLabel}>Type</Text>
                          <TouchableOpacity
                            style={styles.toneDropdownButton}
                            activeOpacity={0.9}
                            onPress={() => {
                              setToneMenuOpen(false);
                              setTypeMenuOpen(false);
                              setFormMenuOpen(false);
                              setColorMenuOpen(false);
                              setSubcategoryMenuOpen((v) => !v);
                            }}
                            accessibilityRole="button"
                          >
                            <Text
                              style={[
                                styles.toneDropdownText,
                                (activeItem?.subcategory ?? '').trim() ? null : styles.toneDropdownPlaceholder,
                              ]}
                            >
                              {(activeItem?.subcategory ?? '').trim() || 'Select'}
                            </Text>
                          </TouchableOpacity>
                        </View>

                        {subcategoryMenuOpen ? (
                          <>
                            <View style={styles.rowDivider} />
                            <TouchableOpacity
                              style={styles.toneOptionRow}
                              activeOpacity={0.9}
                              onPress={() => {
                                updateItemField('subcategory', '');
                                updateItemField('type', '');
                                if (activeCategoryKey === 'eyes') {
                                  updateItemField('shade', '');
                                  updateItemField('placement', '');
                                }
                                if (activeCategoryKey === 'lips') {
                                  // keep Color (shade) but clear dependent fields
                                  updateItemField('undertone', '');
                                  updateItemField('form', '');
                                }
                                if (activeCategoryKey === BASE_CATEGORY_NAME.toLowerCase()) {
                                  updateItemField('form', '');
                                }
                                if (activeCategoryKey === 'brows') {
                                  updateItemField('undertone', '');
                                  updateItemField('shade', '');
                                  updateItemField('form', '');
                                  updateItemField('type', '');
                                }
                                setToneMenuOpen(false);
                                setTypeMenuOpen(false);
                                setFormMenuOpen(false);
                                setColorMenuOpen(false);
                                setSubcategoryMenuOpen(false);
                              }}
                              accessibilityRole="button"
                            >
                              <View style={styles.toneOptionLabelSpacer} />
                              <View style={styles.toneOptionContent}>
                                <Text style={styles.toneOptionText}>None</Text>
                                {!(activeItem?.subcategory ?? '').trim() ? (
                                  <Ionicons name="checkmark" size={18} color="#111111" />
                                ) : (
                                  <View style={{ width: 18 }} />
                                )}
                              </View>
                            </TouchableOpacity>
                            <View style={styles.rowDivider} />

                            {subsetOptions.map((t, idx) => {
                              const current = (activeItem?.subcategory ?? '').trim();
                              const on = current === t;
                              return (
                                <React.Fragment key={t}>
                                  <TouchableOpacity
                                    style={styles.toneOptionRow}
                                    activeOpacity={0.9}
                                    onPress={() => {
                                      const next = t;
                                      const k = next.trim().toLowerCase();

                                      updateItemField('subcategory', next);

                                      // Base: hide Form for Concealer/Powder
                                      if (
                                        activeCategoryKey === BASE_CATEGORY_NAME.toLowerCase() &&
                                        (k === 'concealer' || k === 'powder')
                                      ) {
                                        updateItemField('form', '');
                                      }

                                      // Eyes: manage dependent fields
                                      if (activeCategoryKey === 'eyes') {
                                        if (k === 'eyeshadow') {
                                          const allowedTypes = EYESHADOW_TYPE_OPTIONS as readonly string[];
                                          const curType = (activeItem?.type ?? '').trim();
                                          if (curType && !allowedTypes.includes(curType as any)) {
                                            updateItemField('type', '');
                                          }

                                          const currentShade = (activeItem?.shade ?? '').trim();
                                          const allowedRoles = EYES_COLOR_ROLE_OPTIONS as readonly string[];
                                          if (currentShade && !allowedRoles.includes(currentShade as any)) {
                                            updateItemField('shade', '');
                                          }
                                          // drop deprecated
                                          if ((activeItem?.placement ?? '').trim()) updateItemField('placement', '');
                                        } else if (k === 'eyeliner') {
                                          const allowedTypes = EYELINER_TYPE_OPTIONS as readonly string[];
                                          const curType = (activeItem?.type ?? '').trim();
                                          if (curType && !allowedTypes.includes(curType as any)) {
                                            updateItemField('type', '');
                                          }
                                          updateItemField('shade', '');
                                          updateItemField('placement', '');
                                        } else {
                                          // Mascara / Lashes
                                          updateItemField('type', '');
                                          updateItemField('shade', '');
                                          updateItemField('placement', '');
                                          updateItemField('undertone', '');
                                          updateItemField('form', '');
                                        }
                                      }

                                      // Lips: hide Undertone/Form for gloss & balm/treatments
                                      if (
                                        activeCategoryKey === 'lips' &&
                                        (k === 'lip gloss' || k === 'lip balm/treatments')
                                      ) {
                                        updateItemField('undertone', '');
                                        updateItemField('form', '');
                                      }

                                      // Brows: remove Undertone/Color/Form
                                      if (activeCategoryKey === 'brows') {
                                        updateItemField('undertone', '');
                                        updateItemField('shade', '');
                                        updateItemField('form', '');
                                        updateItemField('type', '');
                                      }

                                      setToneMenuOpen(false);
                                      setTypeMenuOpen(false);
                                      setFormMenuOpen(false);
                                      setColorMenuOpen(false);
                                      setSubcategoryMenuOpen(false);
                                    }}
                                    accessibilityRole="button"
                                  >
                                    <View style={styles.toneOptionLabelSpacer} />
                                    <View style={styles.toneOptionContent}>
                                      <Text style={styles.toneOptionText}>{t}</Text>
                                      {on ? (
                                        <Ionicons name="checkmark" size={18} color="#111111" />
                                      ) : (
                                        <View style={{ width: 18 }} />
                                      )}
                                    </View>
                                  </TouchableOpacity>
                                  {idx < subsetOptions.length - 1 ? <View style={styles.rowDivider} /> : null}
                                </React.Fragment>
                              );
                            })}
                          </>
                        ) : null}

                        {showEyesTypeSelect ? (
                          <>
                            <View style={styles.rowDivider} />
                            <View style={styles.formRow}>
                              <Text style={styles.formLabel}>Group</Text>
                              <TouchableOpacity
                                style={styles.toneDropdownButton}
                                activeOpacity={0.9}
                                onPress={() => {
                                  setToneMenuOpen(false);
                                  setSubcategoryMenuOpen(false);
                                  setFormMenuOpen(false);
                                  setColorMenuOpen(false);
                                  setTypeMenuOpen((v) => !v);
                                }}
                                accessibilityRole="button"
                              >
                                <Text
                                  style={[
                                    styles.toneDropdownText,
                                    (activeItem?.type ?? '').trim() ? null : styles.toneDropdownPlaceholder,
                                  ]}
                                >
                                  {(activeItem?.type ?? '').trim() || 'Select'}
                                </Text>
                              </TouchableOpacity>
                            </View>

                            {typeMenuOpen ? (
                              <>
                                <View style={styles.rowDivider} />
                                <TouchableOpacity
                                  style={styles.toneOptionRow}
                                  activeOpacity={0.9}
                                  onPress={() => {
                                    updateItemField('type', '');
                                    setTypeMenuOpen(false);
                                  }}
                                  accessibilityRole="button"
                                >
                                  <View style={styles.toneOptionLabelSpacer} />
                                  <View style={styles.toneOptionContent}>
                                    <Text style={styles.toneOptionText}>None</Text>
                                    {!(activeItem?.type ?? '').trim() ? (
                                      <Ionicons name="checkmark" size={18} color="#111111" />
                                    ) : (
                                      <View style={{ width: 18 }} />
                                    )}
                                  </View>
                                </TouchableOpacity>
                                <View style={styles.rowDivider} />

                                {eyesTypeOptions.map((t, idx) => {
                                  const current = (activeItem?.type ?? '').trim();
                                  const on = current === t;
                                  return (
                                    <React.Fragment key={t}>
                                      <TouchableOpacity
                                        style={styles.toneOptionRow}
                                        activeOpacity={0.9}
                                        onPress={() => {
                                          updateItemField('type', t);
                                          if (subsetKey === 'eyeliner' && t.trim().toLowerCase() === 'pencil') {
                                            updateItemField('form', '');
                                          }
                                          setTypeMenuOpen(false);
                                        }}
                                        accessibilityRole="button"
                                      >
                                        <View style={styles.toneOptionLabelSpacer} />
                                        <View style={styles.toneOptionContent}>
                                          <Text style={styles.toneOptionText}>{t}</Text>
                                          {on ? (
                                            <Ionicons name="checkmark" size={18} color="#111111" />
                                          ) : (
                                            <View style={{ width: 18 }} />
                                          )}
                                        </View>
                                      </TouchableOpacity>
                                      {idx < eyesTypeOptions.length - 1 ? <View style={styles.rowDivider} /> : null}
                                    </React.Fragment>
                                  );
                                })}
                              </>
                            ) : null}
                          </>
                        ) : null}

                        <View style={styles.rowDivider} />
                      </>
                    ) : null}

                    <FormRow
                      label="Brand"
                      value={activeItem?.brand ?? ''}
                      placeholder="Dior"
                      onChangeText={(v) => updateItemField('brand', v)}
                    />

                    {activeCategoryKey === 'eyes' ? (
                      showEyesColorSelect ? (
                        <>
                          <View style={styles.rowDivider} />
                          <View style={styles.formRow}>
                            <Text style={styles.formLabel}>Color</Text>
                            <TouchableOpacity
                              style={styles.toneDropdownButton}
                              activeOpacity={0.9}
                              onPress={() => {
                                setToneMenuOpen(false);
                                setSubcategoryMenuOpen(false);
                                setTypeMenuOpen(false);
                                setFormMenuOpen(false);
                                setColorMenuOpen((v) => !v);
                              }}
                              accessibilityRole="button"
                            >
                              <Text
                                style={[
                                  styles.toneDropdownText,
                                  (activeItem?.shade ?? '').trim() ? null : styles.toneDropdownPlaceholder,
                                ]}
                              >
                                {(activeItem?.shade ?? '').trim() || 'Select'}
                              </Text>
                            </TouchableOpacity>
                          </View>

                          {colorMenuOpen ? (
                            <>
                              <View style={styles.rowDivider} />
                              <TouchableOpacity
                                style={styles.toneOptionRow}
                                activeOpacity={0.9}
                                onPress={() => {
                                  updateItemField('shade', '');
                                  updateItemField('placement', '');
                                  setColorMenuOpen(false);
                                }}
                                accessibilityRole="button"
                              >
                                <View style={styles.toneOptionLabelSpacer} />
                                <View style={styles.toneOptionContent}>
                                  <Text style={styles.toneOptionText}>None</Text>
                                  {!(activeItem?.shade ?? '').trim() ? (
                                    <Ionicons name="checkmark" size={18} color="#111111" />
                                  ) : (
                                    <View style={{ width: 18 }} />
                                  )}
                                </View>
                              </TouchableOpacity>
                              <View style={styles.rowDivider} />

                              {EYES_COLOR_ROLE_OPTIONS.map((t, idx) => {
                                const current = (activeItem?.shade ?? '').trim();
                                const on = current === t;
                                return (
                                  <React.Fragment key={t}>
                                    <TouchableOpacity
                                      style={styles.toneOptionRow}
                                      activeOpacity={0.9}
                                      onPress={() => {
                                        updateItemField('shade', t);
                                        updateItemField('placement', '');
                                        setColorMenuOpen(false);
                                      }}
                                      accessibilityRole="button"
                                    >
                                      <View style={styles.toneOptionLabelSpacer} />
                                      <View style={styles.toneOptionContent}>
                                        <Text style={styles.toneOptionText}>{t}</Text>
                                        {on ? (
                                          <Ionicons name="checkmark" size={18} color="#111111" />
                                        ) : (
                                          <View style={{ width: 18 }} />
                                        )}
                                      </View>
                                    </TouchableOpacity>
                                    {idx < EYES_COLOR_ROLE_OPTIONS.length - 1 ? (
                                      <View style={styles.rowDivider} />
                                    ) : null}
                                  </React.Fragment>
                                );
                              })}
                            </>
                          ) : null}
                        </>
                      ) : showEyelinerPencilColorInput ? (
                      <>
                        <View style={styles.rowDivider} />
                        <FormRow
                          label="Color"
                          value={activeItem?.shade ?? ''}
                          placeholder="Black"
                          onChangeText={(v) => updateItemField('shade', v)}
                        />
                      </>
                    ) : null
                    ) : !hideColor ? (
                      <>
                        <View style={styles.rowDivider} />
                        <FormRow
                          label="Color"
                          value={activeItem?.shade ?? ''}
                          placeholder="0N - Neutral"
                          onChangeText={(v) => updateItemField('shade', v)}
                        />
                      </>
                    ) : null}

                    {!hideUndertone ? (
                      <>
                        <View style={styles.rowDivider} />
                        <View style={styles.formRow}>
                          <Text style={styles.formLabel}>Undertone</Text>

                          <TouchableOpacity
                            style={styles.toneDropdownButton}
                            activeOpacity={0.9}
                            onPress={() => {
                              setSubcategoryMenuOpen(false);
                              setTypeMenuOpen(false);
                              setFormMenuOpen(false);
                              setColorMenuOpen(false);
                              setToneMenuOpen((v) => !v);
                            }}
                            accessibilityRole="button"
                          >
                            <Text
                              style={[
                                styles.toneDropdownText,
                                (activeItem?.undertone ?? '').trim() ? null : styles.toneDropdownPlaceholder,
                              ]}
                            >
                              {(() => {
                                const v = (activeItem?.undertone ?? '').trim().toLowerCase();
                                const opt = TONE_OPTIONS.find((o) => o.key === v);
                                return opt ? opt.label : 'Select';
                              })()}
                            </Text>
                          </TouchableOpacity>

                          <TouchableOpacity
                            style={styles.toneAssistButton}
                            activeOpacity={0.85}
                            onPress={guessUndertoneForActiveItem}
                            disabled={undertoneGuessBusy}
                            accessibilityRole="button"
                            accessibilityLabel="Search undertone"
                          >
                            {undertoneGuessBusy ? (
                              <ActivityIndicator size="small" color="#111111" />
                            ) : (
                              <Ionicons name="search-outline" size={16} color="#111111" />
                            )}
                          </TouchableOpacity>
                        </View>

                        {toneMenuOpen ? (
                          <>
                            <View style={styles.rowDivider} />
                            <TouchableOpacity
                              style={styles.toneOptionRow}
                              activeOpacity={0.9}
                              onPress={() => {
                                updateItemField('undertone', '');
                                setToneMenuOpen(false);
                              }}
                              accessibilityRole="button"
                            >
                              <View style={styles.toneOptionLabelSpacer} />
                              <View style={styles.toneOptionContent}>
                                <Text style={styles.toneOptionText}>None</Text>
                                {!(activeItem?.undertone ?? '').trim() ? (
                                  <Ionicons name="checkmark" size={18} color="#111111" />
                                ) : (
                                  <View style={{ width: 18 }} />
                                )}
                              </View>
                            </TouchableOpacity>
                            <View style={styles.rowDivider} />

                            {TONE_OPTIONS.map((t, idx) => {
                              const current = (activeItem?.undertone ?? '').trim().toLowerCase();
                              const on = current === t.key;
                              return (
                                <React.Fragment key={t.key}>
                                  <TouchableOpacity
                                    style={styles.toneOptionRow}
                                    activeOpacity={0.9}
                                    onPress={() => {
                                      updateItemField('undertone', t.key);
                                      setToneMenuOpen(false);
                                    }}
                                    accessibilityRole="button"
                                  >
                                    <View style={styles.toneOptionLabelSpacer} />
                                    <View style={styles.toneOptionContent}>
                                      <Text style={styles.toneOptionText}>{t.label}</Text>
                                      {on ? (
                                        <Ionicons name="checkmark" size={18} color="#111111" />
                                      ) : (
                                        <View style={{ width: 18 }} />
                                      )}
                                    </View>
                                  </TouchableOpacity>
                                  {idx < TONE_OPTIONS.length - 1 ? <View style={styles.rowDivider} /> : null}
                                </React.Fragment>
                              );
                            })}
                          </>
                        ) : null}
                      </>
                    ) : null}

                    {!hideForm ? (
                      <>
                        <View style={styles.rowDivider} />
                        {showBaseFormSelect ? (
                          <>
                            <View style={styles.formRow}>
                              <Text style={styles.formLabel}>Form</Text>
                              <TouchableOpacity
                                style={styles.toneDropdownButton}
                                activeOpacity={0.9}
                                onPress={() => {
                                  setToneMenuOpen(false);
                                  setSubcategoryMenuOpen(false);
                                  setTypeMenuOpen(false);
                                  setColorMenuOpen(false);
                                  setFormMenuOpen((v) => !v);
                                }}
                                accessibilityRole="button"
                              >
                                <Text
                                  style={[
                                    styles.toneDropdownText,
                                    (activeItem?.form ?? '').trim() ? null : styles.toneDropdownPlaceholder,
                                  ]}
                                >
                                  {(activeItem?.form ?? '').trim() || 'Select'}
                                </Text>
                              </TouchableOpacity>
                            </View>

                            {formMenuOpen ? (
                              <>
                                <View style={styles.rowDivider} />
                                <TouchableOpacity
                                  style={styles.toneOptionRow}
                                  activeOpacity={0.9}
                                  onPress={() => {
                                    updateItemField('form', '');
                                    setFormMenuOpen(false);
                                  }}
                                  accessibilityRole="button"
                                >
                                  <View style={styles.toneOptionLabelSpacer} />
                                  <View style={styles.toneOptionContent}>
                                    <Text style={styles.toneOptionText}>None</Text>
                                    {!(activeItem?.form ?? '').trim() ? (
                                      <Ionicons name="checkmark" size={18} color="#111111" />
                                    ) : (
                                      <View style={{ width: 18 }} />
                                    )}
                                  </View>
                                </TouchableOpacity>
                                <View style={styles.rowDivider} />

                                {BASE_FORM_OPTIONS.map((t, idx) => {
                                  const current = (activeItem?.form ?? '').trim();
                                  const on = current === t;
                                  return (
                                    <React.Fragment key={t}>
                                      <TouchableOpacity
                                        style={styles.toneOptionRow}
                                        activeOpacity={0.9}
                                        onPress={() => {
                                          updateItemField('form', t);
                                          setFormMenuOpen(false);
                                        }}
                                        accessibilityRole="button"
                                      >
                                        <View style={styles.toneOptionLabelSpacer} />
                                        <View style={styles.toneOptionContent}>
                                          <Text style={styles.toneOptionText}>{t}</Text>
                                          {on ? (
                                            <Ionicons name="checkmark" size={18} color="#111111" />
                                          ) : (
                                            <View style={{ width: 18 }} />
                                          )}
                                        </View>
                                      </TouchableOpacity>
                                      {idx < BASE_FORM_OPTIONS.length - 1 ? <View style={styles.rowDivider} /> : null}
                                    </React.Fragment>
                                  );
                                })}
                              </>
                            ) : null}
                          </>
                        ) : (
                          <FormRow
                            label="Form"
                            value={activeItem?.form ?? ''}
                            placeholder={formPlaceholder}
                            onChangeText={(v) => updateItemField('form', v)}
                          />
                        )}
                      </>
                    ) : null}
                  </View>

                  <View style={{ height: 12 }} />

                  <View style={styles.editorCard}>
                    <FormRow
                      label="Location"
                      value={activeItem?.location ?? ''}
                      placeholder="Case A"
                      onChangeText={(v) => updateItemField('location', v)}
                    />
                    <View style={styles.rowDivider} />
                    <FormRow
                      label="Qty"
                      value={activeItem?.quantity ?? ''}
                      placeholder="1"
                      keyboardType="numeric"
                      onChangeText={(v) => updateItemField('quantity', v)}
                    />
                  </View>

                  <View style={{ height: 12 }} />

                  <View style={styles.editorCard}>
                    <FormRow
                      label="Purchase"
                      value={activeItem?.purchaseDate ?? ''}
                      placeholder="YYYY-MM-DD"
                      onChangeText={(v) => updateItemField('purchaseDate', v)}
                    />
                    <View style={styles.rowDivider} />
                    <FormRow
                      label="Opened"
                      value={activeItem?.openedDate ?? ''}
                      placeholder="YYYY-MM-DD"
                      onChangeText={(v) => updateItemField('openedDate', v)}
                    />
                    <View style={styles.rowDivider} />
                    <FormRow
                      label="Expiry"
                      value={activeItem?.expiryDate ?? ''}
                      placeholder="YYYY-MM-DD"
                      onChangeText={(v) => updateItemField('expiryDate', v)}
                    />
                  </View>

                  <View style={{ height: 12 }} />

                  <View style={styles.editorCard}>
                    <View style={styles.formRowMultilineCompact}>
                      <Text style={styles.formLabel}>Notes</Text>
                      <TextInput
                        value={activeItem?.notes ?? ''}
                        onChangeText={(v) => updateItemField('notes', v)}
                        onFocus={() => {
                          setTimeout(() => {
                            editorScrollRef.current?.scrollToEnd?.({ animated: true });
                          }, 250);
                        }}
                        style={[styles.formInput, styles.notesInputCompact]}
                        multiline
                        textAlignVertical="top"
                      />
                    </View>
                  </View>

                </ScrollView>
              </View>
            </SafeAreaView>
          </Modal>
        </View>
      </SafeAreaView>
    </TouchableWithoutFeedback>
  );
};

function FormRow(props: {
  label: string;
  value: string;
  placeholder?: string;
  onChangeText: (v: string) => void;
  keyboardType?: any;
  multiline?: boolean;
}) {
  return (
    <View style={[styles.formRow, props.multiline ? styles.formRowMultiline : null]}>
      <Text style={styles.formLabel}>{props.label}</Text>
      <TextInput
        value={props.value}
        onChangeText={props.onChangeText}
        placeholder={props.placeholder}
        placeholderTextColor="#9ca3af"
        style={[styles.formInput, props.multiline ? styles.formInputMultiline : null]}
        keyboardType={props.keyboardType}
        autoCorrect={false}
        multiline={props.multiline}
        textAlignVertical={props.multiline ? 'top' : 'center'}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#ffffff',
  },
  container: {
    flex: 1,
    backgroundColor: '#ffffff',
    paddingHorizontal: 16,
  },

  // Top bar
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 8,
    marginBottom: 10,
  },
  searchPill: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 18,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    backgroundColor: '#ffffff',
    paddingLeft: 14,
    paddingRight: 10,
    minHeight: 38,
  },
  searchInput: {
    flex: 1,
    fontSize: 14,
    color: '#111111',
    paddingVertical: 0,
    fontWeight: '400',
  },
  clearBtn: {
    marginLeft: 6,
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  accountChip: {
    marginLeft: 10,
    paddingHorizontal: 16,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: '#111111',
    backgroundColor: '#ffffff',
    justifyContent: 'center',
    alignItems: 'center',
    minHeight: 38,
  },
  accountChipText: {
    color: '#111111',
    fontSize: 13,
    fontWeight: '500',
  },

  // Section headers (home)
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    marginBottom: 10,
  },
  homeSectionHeader: {
    paddingRight: 10,
  },
  homeHeaderDivider: {
    marginTop: 13,
    marginBottom: 26,
    marginRight: 10,
    backgroundColor: '#d1d5db',
  },
  homeSectionDivider: {
    marginTop: 30,
    marginBottom: 42,
    marginRight: 10,
    backgroundColor: '#d1d5db',
  },
  needsAttentionHeader: {
    marginBottom: 16,
  },
  needsAttentionTitle: {
    marginLeft: 4,
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: '500',
    color: '#111111',
  },
  sectionMeta: {
    fontSize: 12,
    color: '#6b7280',
  },

  hairline: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: '#eef2f7',
  },

  // View tabs (category)
  viewTabs: {
    flexDirection: 'row',
    marginTop: 10,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 12,
    overflow: 'hidden',
    backgroundColor: '#f9fafb',
  },
  viewTab: {
    flex: 1,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  viewTabOn: {
    backgroundColor: '#111111',
  },
  viewTabText: {
    fontSize: 12,
    fontWeight: '500',
    color: '#111111',
  },
  viewTabTextOn: {
    color: '#ffffff',
  },

  // Attention lists (home)
  // Home attention tabs (home)
  homeAttentionTabs: {
    flexDirection: 'row',
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 12,
    overflow: 'hidden',
    backgroundColor: '#f9fafb',
    marginBottom: 22,
  },
  homeAttentionTab: {
    flex: 1,
    height: 36,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  homeAttentionTabOn: {
    backgroundColor: '#111111',
  },
  homeAttentionTabText: {
    fontSize: 12,
    fontWeight: '500',
    color: '#111111',
  },
  homeAttentionTabTextOn: {
    color: '#ffffff',
  },
  homeAttentionCountBubble: {
    marginLeft: 8,
    paddingHorizontal: 8,
    height: 20,
    borderRadius: 10,
    backgroundColor: '#e5e7eb',
    alignItems: 'center',
    justifyContent: 'center',
  },
  homeAttentionCountBubbleOn: {
    backgroundColor: '#ffffff',
  },
  homeAttentionCountText: {
    fontSize: 11,
    fontWeight: '600',
    color: '#111111',
  },
  homeAttentionCountTextOn: {
    color: '#111111',
  },

  attentionCard: {
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 14,
    backgroundColor: '#ffffff',
    overflow: 'hidden',
  },
  attentionRow: {
    paddingHorizontal: 14,
    paddingVertical: 12,
    flexDirection: 'row',
    alignItems: 'center',
  },
  attentionTitle: {
    fontSize: 14,
    fontWeight: '500',
    color: '#111111',
  },
  attentionSub: {
    marginTop: 4,
    fontSize: 12,
    color: '#6b7280',
  },
  attentionRight: {
    fontSize: 12,
    color: '#6b7280',
    marginRight: 10,
    maxWidth: 140,
    textAlign: 'right',
  },

  // Home alert rows (Low / Empty / Expiring)
  alertRow: {
    paddingHorizontal: 14,
    paddingVertical: 12,
    flexDirection: 'row',
    alignItems: 'center',
  },
  alertIcon: {
    width: 34,
    height: 34,
    borderRadius: 17,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    backgroundColor: '#ffffff',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 10,
  },
  alertTitle: {
    fontSize: 14,
    fontWeight: '500',
    color: '#111111',
  },
  alertSub: {
    marginTop: 4,
    fontSize: 12,
    color: '#6b7280',
  },
  alertPill: {
    paddingHorizontal: 10,
    height: 28,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    backgroundColor: '#f9fafb',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 10,
    maxWidth: 120,
  },
  alertPillWide: {
    maxWidth: 160,
  },
  alertPillText: {
    fontSize: 11,
    fontWeight: '500',
    color: '#111111',
  },

  // Lists
  listCard: {
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 14,
    backgroundColor: '#ffffff',
    overflow: 'hidden',
  },

  // Category list (home)
  categoryList: {
    // No outer border/dividers. Rows handle spacing.
  },
  categoryListRow: {
    // No outer borders or dividers; keep rows light.
    backgroundColor: 'transparent',
    borderRadius: 16,
    paddingLeft: 0,
    paddingRight: 0,
    paddingVertical: 10,
    // Keep visual spacing identical to when the 34px action icon existed.
    // (Trash icon removed, but the row height shouldn't visually collapse.)
    minHeight: 54,
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
  },
  categoryListRowMain: {
    flex: 1,
    // Keep a tiny right inset so the progress bar doesn't feel "too long" / flush.
    // This matches where the old action icon ended (marginRight: 2).
    paddingRight: 2,
  },
  categoryListRowActions: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 0,
  },

  categoryDeleteBtn: {
    width: 34,
    height: 34,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
  },
  categoryDeletePlaceholder: {
    width: 34,
    height: 34,
  },

  categoryCard: {
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 16,
    backgroundColor: '#ffffff',
    paddingHorizontal: 10,
    paddingVertical: 12,
  },
  categoryCardTop: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
  },
  categoryCardTopRight: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 1,
  },
  categoryCardName: {
    flex: 1,
    fontSize: 14,
    fontWeight: '600',
    color: '#111111',
    lineHeight: 18,
    paddingRight: 10,
  },
  categoryCardCountPill: {
    paddingHorizontal: 10,
    height: 26,
    borderRadius: 13,
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: '#e5e7eb',
    alignItems: 'center',
    justifyContent: 'center',
  },
  categoryCardCountText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#111111',
  },
  categoryCardTrash: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 6,
  },
  categoryCardBar: {
    marginTop: 10,
    height: 6,
    borderRadius: 999,
    overflow: 'hidden',
    backgroundColor: '#f3f4f6',
    flexDirection: 'row',
  },
  categoryCardFill: {
    flexDirection: 'row',
    height: '100%',
  },
  categoryCardSeg: {
    height: 6,
  },
  categoryCardMeta: {
    marginTop: 10,
    fontSize: 12,
    color: '#6b7280',
  },
  categoryCardMetaOk: {
    color: '#9ca3af',
  },

  categoryListCard: {
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 16,
    backgroundColor: '#ffffff',
    overflow: 'hidden',
  },
  categoryRowNew: {
    paddingHorizontal: 14,
    paddingVertical: 12,
    flexDirection: 'row',
    alignItems: 'center',
  },
  categoryCountBubble: {
    width: 38,
    height: 38,
    borderRadius: 19,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
    backgroundColor: '#ffffff',
  },
  categoryCountText: {
    fontSize: 13,
    fontWeight: '500',
    color: '#111111',
  },
  categoryRowName: {
    fontSize: 14,
    fontWeight: '500',
    color: '#111111',
    flexShrink: 1,
    minWidth: 0,
  },
  categoryRowTitleLine: {
    flexDirection: 'row',
    alignItems: 'baseline',
  },
  categoryRowItemCount: {
    marginLeft: 8,
    fontSize: 12,
    fontWeight: '400',
    color: '#6b7280',
    flexShrink: 0,
  },
  categoryRowItemCountZero: {
    color: '#9ca3af',
  },
  categoryRowMeta: {
    marginTop: 4,
    fontSize: 12,
    color: '#6b7280',
  },
  categoryRowTrash: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 2,
  },

  // New category rack layout (progress bar + meta)
  categoryRack: {
    // No outer border – rows + hairlines do the separation.
    borderWidth: 0,
    backgroundColor: '#ffffff',
  },
  categoryRackRow: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    flexDirection: 'row',
    alignItems: 'center',
  },
  categoryRackTop: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
  },
  categoryRackName: {
    fontSize: 14,
    fontWeight: '500',
    color: '#111111',
  },
  categoryRackCount: {
    fontSize: 14,
    fontWeight: '500',
    color: '#111111',
  },
  categoryRackBar: {
    marginTop: 8,
    // Slight right inset so the bar doesn't feel flush/overextended.
    marginRight: 8,
    height: 6,
    borderRadius: 999,
    overflow: 'hidden',
    backgroundColor: '#f3f4f6',
    flexDirection: 'row',
  },
  categoryRackBarShort: {
    marginRight: 8,
  },
  categoryRackFill: {
    flexDirection: 'row',
    height: '100%',
  },
  categoryRackSeg: {
    height: 6,
  },
  categoryRackMeta: {
    marginTop: 8,
    fontSize: 12,
    color: '#6b7280',
  },
  categoryRackTrash: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyPad: {
    paddingHorizontal: 14,
    paddingVertical: 18,
  },
  emptyText: {
    fontSize: 13,
    fontWeight: '500',
    color: '#111111',
  },
  emptySub: {
    marginTop: 6,
    fontSize: 12,
    color: '#6b7280',
  },

  rowIcon: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 2,
  },

  // Bottom bar
  inputBarUnderlay: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: '#ffffff',
  },
  inputBarDock: {
    position: 'absolute',
    left: 0,
    right: 0,
    backgroundColor: '#ffffff',
  },
  inputBar: {
    paddingTop: 8,
  },
  inputContainer: {
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
  textInput: {
    flex: 1,
    fontSize: 14,
    paddingVertical: 8,
    paddingRight: 8,
    color: '#111111',
    fontWeight: '400',
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

  // Category nav
  catNavRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 8,
    marginBottom: 6,
  },
  catNavBack: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    height: 36,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    backgroundColor: '#ffffff',
    marginRight: 10,
  },
  catNavBackText: {
    marginLeft: 6,
    fontSize: 13,
    fontWeight: '500',
    color: '#111111',
  },
  catNavTitle: {
    flex: 1,
    fontSize: 16,
    fontWeight: '500',
    color: '#111111',
  },

  // Item rows
  itemRow: {
    paddingHorizontal: 14,
    paddingVertical: 12,
    flexDirection: 'row',
    alignItems: 'center',
  },
  itemName: {
    fontSize: 14,
    fontWeight: '500',
    color: '#111111',
  },
  itemSub: {
    marginTop: 4,
    fontSize: 12,
    color: '#6b7280',
  },
  statusChip: {
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    backgroundColor: '#ffffff',
    marginRight: 6,
  },
  statusChipWarn: {
    borderColor: '#111111',
  },
  statusChipText: {
    fontSize: 12,
    fontWeight: '500',
    color: '#111111',
  },
  statusChipTextWarn: {},

  // Modal
  modalSafe: {
    flex: 1,
    backgroundColor: '#ffffff',
  },
  modalContainer: {
    flex: 1,
    paddingHorizontal: 16,
    paddingTop: 18,
    backgroundColor: '#ffffff',
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  modalBack: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    height: 40,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    backgroundColor: '#ffffff',
  },
  modalBackText: {
    marginLeft: 6,
    fontSize: 13,
    fontWeight: '500',
    color: '#111111',
  },

  // Minimal item editor (white background, smaller name + status)
  editorTop: {
    flexDirection: 'row',
    alignItems: 'flex-end',
  },
  nameInput: {
    marginTop: 6,
    fontSize: 14,
    fontWeight: '500',
    color: '#111111',
    paddingVertical: 4,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#e5e7eb',
  },
  statusSelect: {
    marginLeft: 12,
    paddingHorizontal: 12,
    height: 32,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    backgroundColor: '#ffffff',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  statusSelectText: {
    fontSize: 12,
    fontWeight: '500',
    color: '#111111',
  },
  sectionRule: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: '#eef2f7',
    marginVertical: 14,
  },
  gridRow: {
    flexDirection: 'row',
    marginBottom: 12,
  },
  field: {
    minHeight: 54,
  },
  fieldLabel: {
    fontSize: 12,
    color: '#6b7280',
  },
  fieldInput: {
    marginTop: 6,
    flex: 1,
    fontSize: 14,
    color: '#111111',
    paddingVertical: 0,
    fontWeight: '400',
  },
  fieldInputMultiline: {
    minHeight: 54,
    maxHeight: 140,
    paddingTop: 6,
    paddingBottom: 6,
  },
  fieldUnderline: {
    marginTop: 8,
    height: StyleSheet.hairlineWidth,
    backgroundColor: '#e5e7eb',
  },

  // Item editor cards
  editorCard: {
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 16,
    backgroundColor: '#ffffff',
    overflow: 'hidden',
  },
  rowDivider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: '#eef2f7',
  },

  itemHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  itemNameInline: {
    flex: 1,
    fontSize: 15,
    fontWeight: '500',
    color: '#111111',
    paddingVertical: 0,
    paddingRight: 10,
  },
  statusMini: {
    flexDirection: 'row',
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 10,
    overflow: 'hidden',
    backgroundColor: '#f9fafb',
    height: 30,
  },
  statusMiniBtn: {
    paddingHorizontal: 10,
    height: 30,
    alignItems: 'center',
    justifyContent: 'center',
  },
  statusMiniBtnOn: {
    backgroundColor: '#111111',
  },
  statusMiniText: {
    fontSize: 11,
    fontWeight: '500',
    color: '#111111',
  },
  statusMiniTextOn: {
    color: '#ffffff',
  },

  toneChips: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    height: 30,
  },
  toneChip: {
    flex: 1,
    height: 30,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 999,
    backgroundColor: '#f9fafb',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 10,
  },
  toneChipSpacer: {
    marginLeft: 8,
  },
  toneChipOn: {
    borderColor: '#111111',
    backgroundColor: '#111111',
  },
  toneChipInner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  toneChipIcon: {
    marginRight: 6,
  },
  toneChipText: {
    fontSize: 12,
    fontWeight: '500',
    color: '#111111',
  },
  toneChipTextOn: {
    color: '#ffffff',
  },

  // Tone dropdown (inline)
  toneDropdownButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-start',
  },
  toneAssistButton: {
    height: 28,
    width: 28,
    paddingHorizontal: 0,
    borderRadius: 14,
    marginLeft: 8,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#ffffff',
  },
  toneAssistText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#111111',
  },
  toneDropdownText: {
    flex: 1,
    fontSize: 14,
    fontWeight: '400',
    color: '#111111',
    textAlign: 'left',
  },
  toneDropdownPlaceholder: {
    color: '#9ca3af',
  },
  toneOptionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  toneOptionLabelSpacer: {
    width: 74,
  },
  toneOptionContent: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  toneOptionText: {
    fontSize: 14,
    fontWeight: '500',
    color: '#111111',
  },


  // Row form
  formRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  formRowMultiline: {
    alignItems: 'flex-start',
    paddingVertical: 14,
  },
  formLabel: {
    width: 74,
    fontSize: 12,
    color: '#6b7280',
    paddingTop: 2,
  },
  formInput: {
    flex: 1,
    fontSize: 14,
    color: '#111111',
    paddingVertical: 0,
    fontWeight: '400',
  },
  formInputMultiline: {
    minHeight: 84,
    paddingTop: 8,
    paddingBottom: 8,
  },

  // Notes row (compact)
  formRowMultilineCompact: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  notesInputCompact: {
    minHeight: 64,
    maxHeight: 160,
    paddingTop: 0,
    paddingBottom: 8,
    includeFontPadding: false,
    lineHeight: 18,
  },
});

export default Inventory;
