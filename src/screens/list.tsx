import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  StyleSheet,
  TouchableOpacity,
  TouchableWithoutFeedback,
  Keyboard,
  Text,
  TextInput,
  Platform,
  FlatList,
  Modal,
  ScrollView,
  Alert,
  Dimensions,
  StatusBar,
  useWindowDimensions,
} from 'react-native';
import Constants from 'expo-constants';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useBottomTabBarHeight } from '@react-navigation/bottom-tabs';
import { DOC_KEYS, getJson, getString, makeScopedKey, setString } from '../localstore';
import { PlanTier, PLAN_LIMITS } from '../api';
import { SafeAreaView, useSafeAreaInsets, initialWindowMetrics } from 'react-native-safe-area-context';

const STORAGE_KEY = DOC_KEYS.catalog;
const KITLOG_STORAGE_KEY = DOC_KEYS.kitlog;

// Keep enough room to show most/all categories without scrolling,
// but still scroll safely if the list grows.
const SHEET_MAX_HEIGHT = Math.round(Dimensions.get('window').height * 0.8);

// Default KitLog categories (used only if KitLog hasn't been opened yet)
const DEFAULT_KITLOG_CATEGORIES = [
  // Match KitLog category ordering
  'Prep & Skin',
  'Foundation',
  'Lips',
  'Cheeks',
  'Eyes',
  'Brows',
  'Lashes',
  'Tools',
  'Hygiene & Disposables',
  'Other',
];

const FALLBACK_CATEGORY_NAME = 'Foundation';

// How the bottom bars sit when the keyboard is CLOSED
// (Adds a little more breathing room above the bottom nav divider)
const CLOSED_BOTTOM_PADDING = 28;

// Extra space ABOVE the keyboard when it’s OPEN
// (Raised to make the lift clearly noticeable)
const KEYBOARD_GAP = 33;

// Modal gets a bit more lift than the main screen.
const MODAL_CLOSED_BOTTOM_PADDING = 56;

// When typing in the client editor, keep the add-product bar slightly above the keyboard.
const MODAL_KEYBOARD_GAP = 12;

type Season4 = 'spring' | 'summer' | 'autumn' | 'winter';
type Undertone = 'cool' | 'neutral-cool' | 'neutral' | 'neutral-warm' | 'warm' | 'unknown';

const EVENT_TYPE_OPTIONS = [
  'Wedding',
  'Photoshoot',
  'Other',
] as const;

type EventType = (typeof EVENT_TYPE_OPTIONS)[number];

// Category is driven by KitLog (dynamic), so store it as a string (category name).
type PlanCategory = string;

type ClientProduct = {
  id: string;
  category: PlanCategory;
  name: string;
  shade?: string;
  notes?: string;
  createdAt: number;
  updatedAt: number;
};

type ClientRecord = {
  id: string;
  displayName: string;
  undertone: Undertone;
  season: Season4 | null;
  trialDate?: string; // YYYY-MM-DD
  finalDate?: string; // YYYY-MM-DD
  eventType: EventType | '';
  notes?: string;
  products: ClientProduct[];
  createdAt: number;
  updatedAt: number;
};

type ClientsData = {
  version: 1;
  clients: ClientRecord[];
};

const EMPTY_CATALOG: ClientsData = { version: 1, clients: [] };

type ClientsScreenProps = {
  navigation: any;
  route: any;
  email?: string | null;
  userId?: string | number | null;
  planTier?: PlanTier;
};

function uid(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function seasonLabel(s: Season4 | null): string {
  if (!s) return '—';
  if (s === 'spring') return 'Spring';
  if (s === 'summer') return 'Summer';
  if (s === 'autumn') return 'Autumn';
  return 'Winter';
}

function undertoneLabel(u: Undertone): string {
  if (u === 'cool') return 'Cool';
  if (u === 'neutral-cool') return 'Neutral-cool';
  if (u === 'neutral') return 'Neutral';
  if (u === 'neutral-warm') return 'Neutral-warm';
  if (u === 'warm') return 'Warm';
  return '—';
}

function categoryLabel(c: PlanCategory): string {
  const t = (c || '').toString().trim();
  return t || '—';
}

function formatShortDate(ts: number): string {
  try {
    return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  } catch {
    return '';
  }
}

function normalizeDateString(raw: any): string {
  if (typeof raw === 'string') return raw.trim();
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    try {
      // Persist as YYYY-MM-DD for readability and stable sorting.
      return new Date(raw).toISOString().slice(0, 10);
    } catch {
      return '';
    }
  }
  return '';
}

function formatDateInput(raw: string): string {
  // Accept digits only and format as YYYY-MM-DD while typing.
  const digits = (raw || '').replace(/\D/g, '').slice(0, 8);
  if (digits.length <= 4) return digits;
  if (digits.length <= 6) return `${digits.slice(0, 4)}-${digits.slice(4)}`;
  return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6)}`;
}


const DAY_MS = 24 * 60 * 60 * 1000;
const UPCOMING_WINDOW_DAYS = 3;

function parseYMDToUtcStartMs(ymd: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec((ymd || '').trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  const d = Number(m[3]);
  if (!Number.isFinite(y) || !Number.isFinite(mo) || !Number.isFinite(d)) return null;
  if (mo < 0 || mo > 11 || d < 1 || d > 31) return null;
  return Date.UTC(y, mo, d);
}

function daysUntilUtcStart(targetUtcStart: number, todayUtcStart: number): number {
  return Math.floor((targetUtcStart - todayUtcStart) / DAY_MS);
}

function nextUpcomingUtcStartForClient(c: ClientRecord, todayUtcStart: number, windowDays: number): number | null {
  const candidates: number[] = [];

  const trial = (c.trialDate || '').trim();
  const final = (c.finalDate || '').trim();

  for (const dateStr of [trial, final]) {
    if (!dateStr) continue;
    const utc = parseYMDToUtcStartMs(dateStr);
    if (utc === null) continue;
    const days = daysUntilUtcStart(utc, todayUtcStart);
    if (days >= 0 && days <= windowDays) candidates.push(utc);
  }

  if (candidates.length === 0) return null;
  return Math.min(...candidates);
}

function isClientUpcoming(c: ClientRecord, todayUtcStart: number, windowDays: number): boolean {
  return nextUpcomingUtcStartForClient(c, todayUtcStart, windowDays) !== null;
}

function clientMatchesQuery(c: ClientRecord, q: string): boolean {
  const needle = (q || '').trim().toLowerCase();
  if (!needle) return true;

  const name = (c.displayName || '').toLowerCase();
  const notes = (c.notes || '').toLowerCase();
  const undertone = undertoneLabel(c.undertone).toLowerCase();
  const season = seasonLabel(c.season).toLowerCase();
  const products = (c.products || [])
    .map((p) => `${categoryLabel(p.category)} ${p.name || ''} ${p.shade || ''} ${p.notes || ''}`.toLowerCase())
    .join(' ');
  const dates = `${c.trialDate || ''} ${c.finalDate || ''}`.toLowerCase();
  const eventType = (String((c as any).eventType || '')).toLowerCase();

  return [name, notes, undertone, season, dates, products, eventType].some((s) => s.includes(needle));
}


function blankClient(): ClientRecord {
  const now = Date.now();
  return {
    id: uid('client'),
    displayName: '',
    undertone: 'unknown',
    season: null,
    trialDate: '',
    finalDate: '',
    eventType: '',
    notes: '',
    products: [],
    createdAt: now,
    updatedAt: now,
  };
}

function isBlankClient(c: ClientRecord): boolean {
  const nameEmpty = !c.displayName.trim();
  const notesEmpty = !(c.notes || '').trim();
  const noProducts = !Array.isArray(c.products) || c.products.length === 0;
  const noMatch = c.undertone === 'unknown' && !c.season;
  const datesEmpty = !(c.trialDate || '').trim() && !(c.finalDate || '').trim();
  const eventTypeEmpty = !(String((c as any).eventType || '')).trim();
  return nameEmpty && notesEmpty && noProducts && noMatch && datesEmpty && eventTypeEmpty;
}

// Backwards compatibility:
// Earlier versions stored a small fixed set of category *codes*.
// We now store the category *name* from KitLog.
const LEGACY_CATEGORY_CODES: Record<string, string> = {
  prep: 'Prep & Skin',
  base: 'Foundation',
  conceal: 'Foundation',
  cheek: 'Cheeks',
  brow: 'Brows',
  eye: 'Eyes',
  lashes: 'Lashes',
  lip: 'Lips',
  tools: 'Tools',
  hygiene: 'Hygiene & Disposables',
  bodyfx: 'Other',
  other: 'Other',
};

function normalizeCategory(raw: any): PlanCategory {
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return FALLBACK_CATEGORY_NAME;

    // Migration: older data used "Base"; it is now "Foundation".
    if (trimmed.toLowerCase() === 'base') return 'Foundation';

    // Only map exact legacy codes.
    const legacyMapped = (LEGACY_CATEGORY_CODES as any)[trimmed];
    if (typeof legacyMapped === 'string') return legacyMapped;

    return trimmed;
  }
  return FALLBACK_CATEGORY_NAME;
}

function normalizeData(input: any): ClientsData {
  const base: ClientsData = { version: 1, clients: [] };

  try {
    const clientsRaw = Array.isArray(input?.clients) ? input.clients : null;
    if (!clientsRaw) return base;

    const normalized: ClientRecord[] = clientsRaw
      .map((c: any) => {
        if (!c) return null;
        const id = typeof c.id === 'string' ? c.id : uid('client');
        const displayName = typeof c.displayName === 'string' ? c.displayName : '';
        const utRaw = typeof c.undertone === 'string' ? String(c.undertone).trim().toLowerCase() : '';
        let undertone: Undertone = 'unknown';
        if (utRaw === 'olive') undertone = 'neutral';
        else if (utRaw === 'cool' || utRaw === 'neutral-cool' || utRaw === 'neutral' || utRaw === 'neutral-warm' || utRaw === 'warm') {
          undertone = utRaw as Undertone;
        }
        const season: Season4 | null =
          c.season === 'spring' || c.season === 'summer' || c.season === 'autumn' || c.season === 'winter'
            ? c.season
            : null;

        const rawEventType = typeof (c as any)?.eventType === 'string' ? String((c as any).eventType).trim() : '';
        let eventType: EventType | '' = '';
        if (rawEventType) {
          const key = rawEventType.toLowerCase();
          // Migrate legacy event types to new options.
          if (key === 'corporate' || key === 'special occasion' || key === 'special_occasion' || key === 'special-occasion') {
            eventType = 'Other';
          } else if (key === 'tv' || key === 'fashion & editorial' || key === 'fashion&editorial') {
            eventType = 'Other';
          } else {
            const match = EVENT_TYPE_OPTIONS.find((opt) => opt.toLowerCase() === key);
            eventType = (match as any) || '';
          }
        }

        const createdAt = typeof c.createdAt === 'number' ? c.createdAt : Date.now();
        const updatedAt = typeof c.updatedAt === 'number' ? c.updatedAt : createdAt;

        const productsRaw = Array.isArray(c.products) ? c.products : [];
        const products: ClientProduct[] = productsRaw
          .map((p: any) => {
            if (!p) return null;
            const pid = typeof p.id === 'string' ? p.id : uid('prod');
            const category = normalizeCategory(p.category);
            const name = typeof p.name === 'string' ? p.name : '';
            const created = typeof p.createdAt === 'number' ? p.createdAt : Date.now();
            const updated = typeof p.updatedAt === 'number' ? p.updatedAt : created;
            return {
              id: pid,
              category,
              name,
              shade: typeof p.shade === 'string' ? p.shade : '',
              notes: typeof p.notes === 'string' ? p.notes : '',
              createdAt: created,
              updatedAt: updated,
            } as ClientProduct;
          })
          .filter(Boolean) as ClientProduct[];

        return {
          id,
          displayName,
          undertone,
          season,
          trialDate: normalizeDateString((c as any)?.trialDate),
          finalDate: normalizeDateString((c as any)?.finalDate),
          eventType,
          notes: typeof c.notes === 'string' ? c.notes : '',
          products,
          createdAt,
          updatedAt,
        } as ClientRecord;
      })
      .filter(Boolean) as ClientRecord[];

    return { version: 1, clients: normalized };
  } catch {
    return base;
  }
}

const List: React.FC<ClientsScreenProps> = ({ navigation, email, userId, planTier = 'free' }) => {
  // Scope local data per user (stable id preferred; fall back to email).
  const scope = userId ?? (email ? String(email).trim().toLowerCase() : null);
  const catalogKey = useMemo(() => makeScopedKey(STORAGE_KEY, scope), [scope]);
  const kitlogKey = useMemo(() => makeScopedKey(KITLOG_STORAGE_KEY, scope), [scope]);
  const [hydrated, setHydrated] = useState(false);
  const [data, setData] = useState<ClientsData>({ version: 1, clients: [] });
  const persistTimer = useRef<any>(null);

  const [search, setSearch] = useState('');
  const [newClientText, setNewClientText] = useState('');

  // Client editor modal state
  const [draft, setDraft] = useState<ClientRecord | null>(null);
  const [isDraftNew, setIsDraftNew] = useState(false);
  const [newProductText, setNewProductText] = useState('');
  const [kitlogCategories, setKitlogCategories] = useState<string[]>(DEFAULT_KITLOG_CATEGORIES);
  const [newProductCategory, setNewProductCategory] = useState<PlanCategory>(FALLBACK_CATEGORY_NAME);
  const [categoryPickerOpen, setCategoryPickerOpen] = useState(false);
  const [eventTypeMenuOpen, setEventTypeMenuOpen] = useState(false);
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

  // keyboard spacer (modal)
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
  }, [catalogKey]);

  async function refreshKitlogCategories() {
    try {
      const parsed = await getJson<any>(kitlogKey);
      if (!parsed) {
        setKitlogCategories(DEFAULT_KITLOG_CATEGORIES);
        setNewProductCategory((prev) => {
          if (DEFAULT_KITLOG_CATEGORIES.includes(prev)) return prev;
          if (DEFAULT_KITLOG_CATEGORIES.includes(FALLBACK_CATEGORY_NAME)) return FALLBACK_CATEGORY_NAME;
          return DEFAULT_KITLOG_CATEGORIES[0] || FALLBACK_CATEGORY_NAME;
        });
        return;
      }
      const catsRaw = Array.isArray(parsed?.categories) ? parsed.categories : [];
      const names = catsRaw
        .map((c: any) => {
          const n = typeof c?.name === 'string' ? c.name.trim() : '';
          if (!n) return '';
          // Migration: "Base" -> "Foundation".
          if (n.toLowerCase() === 'base') return 'Foundation';
          return n;
        })
        .filter(Boolean) as string[];

      // Deduplicate while preserving order.
      const uniq: string[] = [];
      for (const n of names) {
        if (!uniq.includes(n)) uniq.push(n);
      }

      const finalList = uniq.length > 0 ? uniq : DEFAULT_KITLOG_CATEGORIES;
      setKitlogCategories(finalList);
      setNewProductCategory((prev) => {
        if (finalList.includes(prev)) return prev;
        if (finalList.includes(FALLBACK_CATEGORY_NAME)) return FALLBACK_CATEGORY_NAME;
        return finalList[0] || FALLBACK_CATEGORY_NAME;
      });
    } catch {
      setKitlogCategories(DEFAULT_KITLOG_CATEGORIES);
      setNewProductCategory((prev) => {
        if (DEFAULT_KITLOG_CATEGORIES.includes(prev)) return prev;
        if (DEFAULT_KITLOG_CATEGORIES.includes(FALLBACK_CATEGORY_NAME)) return FALLBACK_CATEGORY_NAME;
        return DEFAULT_KITLOG_CATEGORIES[0] || FALLBACK_CATEGORY_NAME;
      });
    }
  }

  // Keep categories in sync with KitLog (on open + on focus)
  useEffect(() => {
    let alive = true;
    (async () => {
      if (!alive) return;
      await refreshKitlogCategories();
    })();

    const unsub = navigation?.addListener?.('focus', () => {
      refreshKitlogCategories();
    });

    return () => {
      alive = false;
      if (typeof unsub === 'function') unsub();
    };
  }, [navigation, kitlogKey]);

  // Load catalog
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const raw = await getString(catalogKey);
        const parsed = raw ? normalizeData(JSON.parse(raw)) : EMPTY_CATALOG;
        if (alive) {
          setData(parsed);
          setHydrated(true);
        }
      } catch {
        if (alive) {
          setData(EMPTY_CATALOG);
          setHydrated(true);
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [catalogKey]);

  // Persist catalog (debounced)
  useEffect(() => {
    if (!hydrated) return;
    if (persistTimer.current) clearTimeout(persistTimer.current);
    persistTimer.current = setTimeout(() => {
      setString(catalogKey, JSON.stringify(data)).catch(() => {});
    }, 250);
    return () => {
      if (persistTimer.current) clearTimeout(persistTimer.current);
    };
  }, [data, hydrated, catalogKey]);

  const now = new Date();
  const todayUtcStart = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  const query = search.trim().toLowerCase();
  const searchActive = query.length > 0;

  const sortedClients = useMemo(() => {
    return [...data.clients].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  }, [data.clients]);

  const upcomingAll = useMemo(() => {
    const scored = sortedClients
      .map((c) => ({ c, next: nextUpcomingUtcStartForClient(c, todayUtcStart, UPCOMING_WINDOW_DAYS) }))
      .filter((x) => x.next !== null) as Array<{ c: ClientRecord; next: number }>;

    scored.sort((a, b) => {
      const diff = a.next - b.next;
      if (diff !== 0) return diff;
      return (b.c.updatedAt ?? 0) - (a.c.updatedAt ?? 0);
    });

    return scored.map((x) => x.c);
  }, [sortedClients, todayUtcStart]);

  const nonUpcomingAll = useMemo(() => {
    return sortedClients.filter((c) => !isClientUpcoming(c, todayUtcStart, UPCOMING_WINDOW_DAYS));
  }, [sortedClients, todayUtcStart]);

  const upcomingVisible = useMemo(() => {
    if (!searchActive) return upcomingAll;
    return upcomingAll.filter((c) => clientMatchesQuery(c, query));
  }, [upcomingAll, query, searchActive]);

  const nonUpcomingVisible = useMemo(() => {
    if (!searchActive) return nonUpcomingAll;
    return nonUpcomingAll.filter((c) => clientMatchesQuery(c, query));
  }, [nonUpcomingAll, query, searchActive]);

  const hasUpcoming = upcomingAll.length > 0;
  const upcomingTotal = upcomingAll.length;
  const upcomingShowing = upcomingVisible.length;
  const clientsTotal = nonUpcomingAll.length;
  const clientsShowing = nonUpcomingVisible.length;

  const upcomingMeta = searchActive ? `${upcomingShowing} / ${upcomingTotal}` : `${upcomingTotal}`;
  const clientsMeta = searchActive ? `${clientsShowing} / ${clientsTotal}` : `${clientsTotal}`;

  type RowItem =
    | { kind: 'client'; key: string; client: ClientRecord }
    | { kind: 'sectionHeader'; key: string; title: string; meta: string };

  const rows = useMemo<RowItem[]>(() => {
    if (!hasUpcoming) {
      return nonUpcomingVisible.map((c) => ({ kind: 'client' as const, key: `c_${c.id}`, client: c }));
    }

    if (upcomingVisible.length === 0 && nonUpcomingVisible.length === 0) {
      return [];
    }

    return [
      ...upcomingVisible.map((c) => ({ kind: 'client' as const, key: `u_${c.id}`, client: c })),
      { kind: 'sectionHeader' as const, key: 'hdr_clients', title: 'List', meta: clientsMeta },
      ...nonUpcomingVisible.map((c) => ({ kind: 'client' as const, key: `c_${c.id}`, client: c })),
    ];
  }, [hasUpcoming, upcomingVisible, nonUpcomingVisible, clientsMeta]);


  // Screens render ABOVE the tab bar, so subtract its height to avoid a jump.
  const keyboardInset = keyboardHeight > 0 ? Math.max(0, keyboardHeight - tabBarHeight) : 0;
  const bottomPadding = keyboardHeight > 0 ? keyboardInset + KEYBOARD_GAP : CLOSED_BOTTOM_PADDING;
  const modalBottomPadding = keyboardHeight > 0 ? keyboardHeight + MODAL_KEYBOARD_GAP : MODAL_CLOSED_BOTTOM_PADDING;

  function addClientFromBar() {
    const name = newClientText.trim();
    Keyboard.dismiss();

    const limit = PLAN_LIMITS[planTier].clients;
    const used = Array.isArray(data.clients) ? data.clients.length : 0;
    if (limit !== Infinity && used >= limit) {
      const isPro = planTier === 'pro';
      const msg = isPro
        ? `You’ve reached the Pro plan limit of ${limit.toLocaleString()} clients.`
        : `Free plan allows up to ${limit.toLocaleString()} clients. Upgrade to Pro to add more.`;

      Alert.alert(
        'Client limit reached',
        msg,
        isPro
          ? [{ text: 'OK' }]
          : [
              { text: 'Not now', style: 'cancel' },
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
    const c = blankClient();
    if (name) {
      c.displayName = name;
      c.updatedAt = now;
    }

    setDraft(c);
    setIsDraftNew(true);
    setNewProductText('');
    setNewProductCategory(
      kitlogCategories.includes(FALLBACK_CATEGORY_NAME) ? FALLBACK_CATEGORY_NAME : kitlogCategories[0] || FALLBACK_CATEGORY_NAME
    );
    setNewClientText('');
  }

  function openClient(id: string) {
    Keyboard.dismiss();
    const found = data.clients.find((c) => c.id === id);
    if (!found) return;
    // deep-ish copy so edits don't mutate list until we save
    const copy: ClientRecord = {
      ...found,
      products: Array.isArray(found.products) ? found.products.map((p) => ({ ...p })) : [],
    };
    setDraft(copy);
    setIsDraftNew(false);
    setNewProductText('');
    setNewProductCategory(
      kitlogCategories.includes(FALLBACK_CATEGORY_NAME) ? FALLBACK_CATEGORY_NAME : kitlogCategories[0] || FALLBACK_CATEGORY_NAME
    );
  }

  function upsertClient(next: ClientRecord) {
    setData((prev) => {
      const exists = prev.clients.some((c) => c.id === next.id);
      const clients = exists
        ? prev.clients.map((c) => (c.id === next.id ? next : c))
        : [next, ...prev.clients];
      return { ...prev, clients };
    });
  }

  function closeClient() {
    setEventTypeMenuOpen(false);
    setCategoryPickerOpen(false);
    if (!draft) return;
    const cleaned: ClientRecord = {
      ...draft,
      displayName: (draft.displayName || '').trim(),
      trialDate: formatDateInput((draft.trialDate || '').trim()),
      finalDate: formatDateInput((draft.finalDate || '').trim()),
      eventType: (draft.eventType || '') as any,
      notes: (draft.notes || '').trim(),
      products: Array.isArray(draft.products)
        ? draft.products
            .map((p) => ({
              ...p,
              name: (p.name || '').trim(),
              shade: (p.shade || '').trim(),
              notes: (p.notes || '').trim(),
            }))
            .filter((p) => !!p.name)
        : [],
      updatedAt: Date.now(),
    };

    if (isDraftNew && isBlankClient(cleaned)) {
      setDraft(null);
      setIsDraftNew(false);
      return;
    }

    upsertClient(cleaned);
    setDraft(null);
    setIsDraftNew(false);
  }

  function deleteClient() {
    if (!draft) return;
    Alert.alert('Delete client', 'This removes the client from your catalog.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => {
          setData((prev) => ({ ...prev, clients: prev.clients.filter((c) => c.id !== draft.id) }));
          setDraft(null);
          setIsDraftNew(false);
        },
      },
    ]);
  }

  function setDraftUndertone(u: Undertone) {
    setDraft((prev) => {
      if (!prev) return prev;
      return { ...prev, undertone: prev.undertone === u ? 'unknown' : u, updatedAt: Date.now() };
    });
  }

  function setDraftSeason(s: Season4) {
    setDraft((prev) => {
      if (!prev) return prev;
      return { ...prev, season: prev.season === s ? null : s, updatedAt: Date.now() };
    });
  }

  function addProduct() {
    const trimmed = newProductText.trim();
    if (!draft || !trimmed) return;
    const now = Date.now();

    const prod: ClientProduct = {
      id: uid('prod'),
      category: newProductCategory,
      name: trimmed,
      shade: '',
      notes: '',
      createdAt: now,
      updatedAt: now,
    };

    setDraft((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        products: [...(prev.products || []), prod],
        updatedAt: now,
      };
    });
    setNewProductText('');
  }

  function removeProduct(id: string) {
    setDraft((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        products: (prev.products || []).filter((p) => p.id !== id),
        updatedAt: Date.now(),
      };
    });
  }

  async function openCategoryPicker() {
    Keyboard.dismiss();
    setEventTypeMenuOpen(false);
    await refreshKitlogCategories();
    setCategoryPickerOpen(true);
  }

  const topTitle = hasUpcoming ? 'Upcoming' : 'List';
  const topMeta = hasUpcoming ? upcomingMeta : clientsMeta;

  return (
    <TouchableWithoutFeedback onPress={Keyboard.dismiss}>
      <SafeAreaView style={[styles.safeArea, { paddingTop: stableTopInset }]} edges={['left', 'right']}>
        <View style={[styles.container, { paddingBottom: bottomPadding }]}>
          {/* Top bar: Search */}
          <View style={styles.topBar}>
            <View style={styles.searchPill}>
              <Ionicons name="search-outline" size={16} color="#111111" style={{ marginRight: 8 }} />
              <TextInput
                style={styles.searchInput}
                value={search}
                onChangeText={setSearch}
                placeholder="Search list"
                placeholderTextColor="#999999"
                returnKeyType="search"
              />
              {!!search.trim() && (
                <TouchableOpacity
                  style={styles.clearBtn}
                  onPress={() => setSearch('')}
                  accessibilityRole="button"
                >
                  <Ionicons name="close" size={18} color="#9ca3af" />
                </TouchableOpacity>
              )}
            </View>

            <TouchableOpacity style={styles.accountChip} onPress={() => navigation.navigate('Upload')}>
              <Text style={styles.accountChipText}>Scan</Text>
            </TouchableOpacity>
          </View>

          {/* Header (match KitLog) */}
          <View style={styles.listHeaderWrap}>
            <View style={styles.listHeaderRow}>
              <Text style={styles.listHeaderTitle}>{topTitle}</Text>
              <Text style={styles.listHeaderMeta}>{topMeta}</Text>
            </View>
            <View style={[styles.hairline, styles.listHeaderDivider]} />
          </View>

          {/* List */}
          <FlatList
            data={rows}
            keyExtractor={(item) => item.key}
            style={{ flex: 1 }}
            contentContainerStyle={{ paddingTop: 0, paddingBottom: 10 }}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
            ListEmptyComponent={
              searchActive ? (
                <View style={styles.emptyPad}>
                  <Text style={styles.emptyPadText}>No clients found.</Text>
                </View>
              ) : (
                <View style={{ height: 0 }} />
              )
            }
            renderItem={({ item }) => {
              if (item.kind === 'sectionHeader') {
                return (
                  <View style={styles.listHeaderWrap}>
                    <View style={styles.listHeaderRow}>
                      <Text style={styles.listHeaderTitle}>{item.title}</Text>
                      <Text style={styles.listHeaderMeta}>{item.meta}</Text>
                    </View>
                    <View style={[styles.hairline, styles.listHeaderDivider]} />
                  </View>
                );
              }

              const c = item.client;
              const title = c.displayName?.trim() ? c.displayName.trim() : 'Untitled client';
              const undertone = undertoneLabel(c.undertone);
              const season = seasonLabel(c.season);
              const updated = c.updatedAt ? formatShortDate(c.updatedAt) : '';
              const planCount = Array.isArray(c.products) ? c.products.length : 0;
              const planLabel = planCount === 1 ? '1 product' : `${planCount} products`;

              return (
                <TouchableOpacity
                  style={styles.clientCard}
                  activeOpacity={0.9}
                  onPress={() => openClient(c.id)}
                  accessibilityRole="button"
                >
                  <View style={styles.cardTopRow}>
                    <Text style={styles.clientName} numberOfLines={1}>
                      {title}
                    </Text>
                    {!!updated ? <Text style={styles.clientMeta}>{updated}</Text> : null}
                  </View>

                  <View style={styles.chipRow}>
                    <View style={styles.smallChip}>
                      <Text style={styles.smallChipText}>{undertone}</Text>
                    </View>
                    <View style={styles.smallChip}>
                      <Text style={styles.smallChipText}>{season}</Text>
                    </View>
                    <View style={styles.smallChip}>
                      <Text style={styles.smallChipText}>{planLabel}</Text>
                    </View>
                  </View>
                </TouchableOpacity>
              );
            }}
          />

          {/* Bottom bar: add client */}
          <View style={styles.inputBar}>
            <View style={styles.inputContainer}>
              <TextInput
                style={styles.textInput}
                value={newClientText}
                onChangeText={setNewClientText}
                placeholder="Add to list…"
                placeholderTextColor="#999999"
                returnKeyType="done"
                onSubmitEditing={addClientFromBar}
                blurOnSubmit={false}
              />

              <TouchableOpacity style={styles.iconButton} onPress={addClientFromBar} accessibilityRole="button">
                <Ionicons name="add" size={20} color="#ffffff" />
              </TouchableOpacity>
            </View>
          </View>
        </View>

        {/* Client editor */}
        <Modal
          visible={!!draft}
          animationType="slide"
          presentationStyle={Platform.OS === 'ios' ? 'pageSheet' : 'fullScreen'}
          onRequestClose={closeClient}
        >
          <TouchableWithoutFeedback onPress={Keyboard.dismiss}>
            <SafeAreaView style={styles.modalSafe} edges={['top', 'left', 'right']}>
              <View style={[styles.modalContainer, { paddingBottom: modalBottomPadding }]}>
                <View style={styles.modalHeader}>
                  <TouchableOpacity style={styles.modalBack} onPress={closeClient} accessibilityRole="button">
                    <Ionicons name="chevron-back" size={20} color="#111111" />
                    <Text style={styles.modalBackText}>List</Text>
                  </TouchableOpacity>

                  <TouchableOpacity style={styles.modalDelete} onPress={deleteClient} accessibilityRole="button">
                    <Ionicons name="trash-outline" size={18} color="#9ca3af" />
                  </TouchableOpacity>
                </View>

                <ScrollView
                  style={{ flex: 1 }}
                  contentContainerStyle={{
                    paddingTop: 12,
                    paddingBottom: 24,
                  }}
                  keyboardShouldPersistTaps="handled"
                  showsVerticalScrollIndicator={false}
                >
                  <View style={styles.editorCard}>
                    <TextInput
                      value={draft?.displayName ?? ''}
                      onChangeText={(v) => setDraft((prev) => (prev ? { ...prev, displayName: v, updatedAt: Date.now() } : prev))}
                      placeholder="Name"
                      placeholderTextColor="#9ca3af"
                      style={styles.nameInput}
                      autoCorrect={false}
                      returnKeyType="done"
                    />

                    <View style={styles.dateRow}>
                      <View style={[styles.dateField, { marginRight: 10 }]}>
                        <Text style={styles.dateLabel}>Trial date</Text>
                        <TextInput
                          value={draft?.trialDate ?? ''}
                          onChangeText={(v) =>
                            setDraft((prev) => (prev ? { ...prev, trialDate: formatDateInput(v), updatedAt: Date.now() } : prev))
                          }
                          placeholder="YYYY-MM-DD"
                          placeholderTextColor="#9ca3af"
                          style={styles.dateInput}
                          autoCorrect={false}
                          keyboardType={Platform.OS === 'ios' ? 'number-pad' : 'numeric'}
                          maxLength={10}
                          returnKeyType="done"
                        />
                      </View>

                      <View style={styles.dateField}>
                        <Text style={styles.dateLabel}>Event date</Text>
                        <TextInput
                          value={draft?.finalDate ?? ''}
                          onChangeText={(v) =>
                            setDraft((prev) => (prev ? { ...prev, finalDate: formatDateInput(v), updatedAt: Date.now() } : prev))
                          }
                          placeholder="YYYY-MM-DD"
                          placeholderTextColor="#9ca3af"
                          style={styles.dateInput}
                          autoCorrect={false}
                          keyboardType={Platform.OS === 'ios' ? 'number-pad' : 'numeric'}
                          maxLength={10}
                          returnKeyType="done"
                        />
                      </View>
                    </View>




                    <TouchableOpacity
                      style={styles.menuRow}
                      activeOpacity={0.9}
                      onPress={() => {
                        Keyboard.dismiss();
                        setEventTypeMenuOpen((v) => !v);
                      }}
                      accessibilityRole="button"
                    >
                      <Text style={styles.menuRowLabel}>Event type</Text>
                      <View style={styles.menuRowRight}>
                        <Text
                          style={[
                            styles.menuRowValue,
                            !(draft?.eventType || '').toString().trim() ? styles.menuRowValueMuted : null,
                          ]}
                          numberOfLines={1}
                        >
                          {(draft?.eventType || '').toString().trim() ? (draft?.eventType as any) : 'Select'}
                        </Text>
                        <Ionicons name="chevron-down" size={14} color="#6b7280" style={{ marginLeft: 6 }} />
                      </View>
                    </TouchableOpacity>

                    {eventTypeMenuOpen ? (
                      <View style={styles.eventMenu}>
                        {[('None' as const), ...EVENT_TYPE_OPTIONS].map((name, idx) => {
                          const value = name === 'None' ? '' : name;
                          const on = (draft?.eventType || '') === value;
                          const isLast = idx === EVENT_TYPE_OPTIONS.length;
                          return (
                            <View key={String(name)}>
                              <TouchableOpacity
                                style={styles.eventMenuRow}
                                activeOpacity={0.9}
                                onPress={() => {
                                  setDraft((prev) =>
                                    prev ? { ...prev, eventType: value as any, updatedAt: Date.now() } : prev
                                  );
                                  setEventTypeMenuOpen(false);
                                }}
                                accessibilityRole="button"
                              >
                                <Text style={styles.eventMenuText}>{name}</Text>
                                {on ? <Ionicons name="checkmark" size={18} color="#111111" /> : <View style={{ width: 18 }} />}
                              </TouchableOpacity>
                              {!isLast ? <View style={styles.eventMenuDivider} /> : null}
                            </View>
                          );
                        })}
                      </View>
                    ) : null}

                    <TextInput
                      value={draft?.notes ?? ''}
                      onChangeText={(v) => setDraft((prev) => (prev ? { ...prev, notes: v, updatedAt: Date.now() } : prev))}
                      placeholder="Notes (optional)"
                      placeholderTextColor="#9ca3af"
                      style={[styles.notesInput]}
                      multiline
                    />
                  </View>

                  <View style={styles.editorCard}>
                    <Text style={styles.sectionTitle}>Match</Text>

                    <Text style={styles.fieldLabel}>Undertone</Text>
                    <ScrollView
                      horizontal
                      showsHorizontalScrollIndicator={false}
                      contentContainerStyle={styles.pillRow}
                      keyboardShouldPersistTaps="handled"
                    >
                      {(['cool', 'neutral-cool', 'neutral', 'neutral-warm', 'warm'] as Undertone[]).map((u) => {
                        const on = (draft?.undertone ?? 'unknown') === u;
                        return (
                          <TouchableOpacity
                            key={u}
                            style={[styles.pillBtn, on ? styles.pillBtnOn : null]}
                            onPress={() => setDraftUndertone(u)}
                            activeOpacity={0.9}
                          >
                            <Text style={[styles.pillBtnText, on ? styles.pillBtnTextOn : null]}>{undertoneLabel(u)}</Text>
                          </TouchableOpacity>
                        );
                      })}
                    </ScrollView>

                    <Text style={[styles.fieldLabel, { marginTop: 10 }]}>Season</Text>
                    <ScrollView
                      horizontal
                      showsHorizontalScrollIndicator={false}
                      contentContainerStyle={styles.pillRow}
                      keyboardShouldPersistTaps="handled"
                    >
                      {(['spring', 'summer', 'autumn', 'winter'] as Season4[]).map((s) => {
                        const on = (draft?.season ?? null) === s;
                        return (
                          <TouchableOpacity
                            key={s}
                            style={[styles.pillBtn, on ? styles.pillBtnOn : null]}
                            onPress={() => setDraftSeason(s)}
                            activeOpacity={0.9}
                          >
                            <Text style={[styles.pillBtnText, on ? styles.pillBtnTextOn : null]}>{seasonLabel(s)}</Text>
                          </TouchableOpacity>
                        );
                      })}
                    </ScrollView>
                  </View>

                  <View style={styles.editorCard}>
                    <View style={styles.productsHeader}>
                      <Text style={styles.sectionTitle}>Products</Text>
                      <Text style={styles.productsMeta}>{(draft?.products || []).length}</Text>
                    </View>

                    {(draft?.products || []).length === 0 ? (
                      <Text style={styles.productsEmpty}>No products yet.</Text>
                    ) : (
                      <View style={styles.productsList}>
                        {(draft?.products || []).map((p, idx) => {
                          const isLast = idx === (draft?.products || []).length - 1;
                          return (
                            <View key={p.id}>
                              <View style={styles.productRow}>
                                <View style={{ flex: 1, paddingRight: 10 }}>
                                  <Text style={styles.productName} numberOfLines={2}>
                                    {p.name}
                                  </Text>
                                  <Text style={styles.productMeta} numberOfLines={1}>
                                    {categoryLabel(p.category)}
                                  </Text>
                                </View>
                                <TouchableOpacity
                                  style={styles.rowIcon}
                                  onPress={() => removeProduct(p.id)}
                                  accessibilityRole="button"
                                >
                                  <Ionicons name="trash-outline" size={18} color="#9ca3af" />
                                </TouchableOpacity>
                              </View>
                              {!isLast ? <View style={styles.hairline} /> : null}
                            </View>
                          );
                        })}
                      </View>
                    )}
                  </View>
                </ScrollView>

                {/* Bottom bar (add product) */}
                <View style={styles.inputBar}>
                  <View style={styles.inputContainer}>
                    <TextInput
                      style={styles.textInput}
                      value={newProductText}
                      onChangeText={setNewProductText}
                      placeholder="Add product…"
                      placeholderTextColor="#999999"
                      returnKeyType="done"
                      onSubmitEditing={addProduct}
                      blurOnSubmit={false}
                    />

                    <TouchableOpacity
                      style={styles.categoryInline}
                      onPress={openCategoryPicker}
                      accessibilityRole="button"
                    >
                      <Text style={styles.categoryInlineText}>{categoryLabel(newProductCategory)}</Text>
                      <Ionicons name="chevron-down" size={14} color="#6b7280" style={{ marginLeft: 6 }} />
                    </TouchableOpacity>

                    <TouchableOpacity style={styles.iconButton} onPress={addProduct} accessibilityRole="button">
                      <Ionicons name="add" size={20} color="#ffffff" />
                    </TouchableOpacity>
                  </View>
                </View>

                {/* Category picker (cross-platform) */}
                <Modal
                  visible={categoryPickerOpen}
                  transparent
                  animationType="fade"
                  onRequestClose={() => setCategoryPickerOpen(false)}
                >
                  <TouchableWithoutFeedback onPress={() => setCategoryPickerOpen(false)}>
                    <View style={styles.sheetBackdrop}>
                      <TouchableWithoutFeedback onPress={() => {}}>
                        <View style={styles.sheetContainer}>
                          <Text style={styles.sheetTitle}>Category</Text>

                          <View style={styles.sheetList}>
                            <ScrollView
                              style={styles.sheetScroll}
                              showsVerticalScrollIndicator
                              bounces={false}
                              keyboardShouldPersistTaps="handled"
                            >
                              {kitlogCategories.map((name, idx) => {
                                const on = newProductCategory === name;
                                const isLast = idx === kitlogCategories.length - 1;
                                return (
                                  <View key={name}>
                                    <TouchableOpacity
                                      style={styles.sheetRow}
                                      activeOpacity={0.9}
                                      onPress={() => {
                                        setNewProductCategory(name);
                                        setCategoryPickerOpen(false);
                                      }}
                                      accessibilityRole="button"
                                    >
                                      <Text style={styles.sheetRowText}>{name}</Text>
                                      {on ? <Ionicons name="checkmark" size={18} color="#111111" /> : null}
                                    </TouchableOpacity>
                                    {!isLast ? <View style={styles.sheetDivider} /> : null}
                                  </View>
                                );
                              })}
                            </ScrollView>
                          </View>

                          <TouchableOpacity
                            style={styles.sheetCancel}
                            activeOpacity={0.9}
                            onPress={() => setCategoryPickerOpen(false)}
                            accessibilityRole="button"
                          >
                            <Text style={styles.sheetCancelText}>Cancel</Text>
                          </TouchableOpacity>
                        </View>
                      </TouchableWithoutFeedback>
                    </View>
                  </TouchableWithoutFeedback>
                </Modal>
              </View>
            </SafeAreaView>
          </TouchableWithoutFeedback>
        </Modal>

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

  // List header (match KitLog)
  listHeaderWrap: {
    paddingTop: 18,
    paddingLeft: 6,
    paddingRight: 0,
  },
  listHeaderRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    marginBottom: 10,
    paddingRight: 10,
  },
  listHeaderTitle: {
    fontSize: 13,
    fontWeight: '500',
    color: '#111111',
  },
  listHeaderMeta: {
    fontSize: 12,
    color: '#6b7280',
  },
  listHeaderDivider: {
    marginTop: 13,
    marginBottom: 26,
    marginRight: 10,
    backgroundColor: '#d1d5db',
  },

  // Client cards
  clientCard: {
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 18,
    backgroundColor: '#ffffff',
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginBottom: 12,
  },
  cardTopRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
  },
  clientName: {
    flex: 1,
    paddingRight: 10,
    fontSize: 15,
    fontWeight: '600',
    color: '#111111',
  },
  clientMeta: {
    fontSize: 12,
    color: '#6b7280',
    fontWeight: '500',
  },
  chipRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    marginTop: 10,
  },
  smallChip: {
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: '#ffffff',
    marginRight: 8,
    marginBottom: 8,
  },
  smallChipText: {
    fontSize: 12,
    fontWeight: '500',
    color: '#111111',
  },
  previewText: {
    marginTop: 2,
    fontSize: 12,
    color: '#6b7280',
    lineHeight: 16,
  },

  // Empty list (search only)
  emptyPad: {
    paddingHorizontal: 14,
    paddingVertical: 18,
  },
  emptyPadText: {
    fontSize: 13,
    fontWeight: '500',
    color: '#111111',
  },

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
    justifyContent: 'space-between',
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
  modalDelete: {
    width: 40,
    height: 40,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    backgroundColor: '#ffffff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  editorCard: {
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 18,
    backgroundColor: '#ffffff',
    paddingHorizontal: 14,
    paddingVertical: 14,
    marginBottom: 12,
  },
  sectionTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: '#111111',
    marginBottom: 10,
  },
  nameInput: {
    fontSize: 15,
    fontWeight: '500',
    color: '#111111',
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#e5e7eb',
  },
  dateRow: {
    flexDirection: 'row',
    marginTop: 12,
  },
  dateField: {
    flex: 1,
  },
  dateLabel: {
    fontSize: 12,
    color: '#6b7280',
    fontWeight: '500',
    marginBottom: 6,
  },
  dateInput: {
    fontSize: 13,
    color: '#111111',
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 14,
    backgroundColor: '#ffffff',
  },

  menuRow: {
    marginTop: 10,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 14,
    paddingVertical: 10,
    paddingHorizontal: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#ffffff',
  },
  menuRowLabel: {
    fontSize: 13,
    color: '#6b7280',
    fontWeight: '500',
  },
  menuRowRight: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    justifyContent: 'flex-end',
    marginLeft: 12,
    minWidth: 0,
  },
  menuRowValue: {
    fontSize: 13,
    color: '#111111',
    fontWeight: '500',
    flexShrink: 1,
  },
  menuRowValueMuted: {
    color: '#9ca3af',
    fontWeight: '400',
  },

  // Inline event type menu
  eventMenu: {
    marginTop: 8,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 12,
    overflow: 'hidden',
    backgroundColor: '#ffffff',
  },
  eventMenuRow: {
    paddingVertical: 12,
    paddingHorizontal: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  eventMenuText: {
    fontSize: 13,
    color: '#111111',
    fontWeight: '500',
    flexShrink: 1,
  },
  eventMenuDivider: {
    height: 1,
    backgroundColor: '#f3f4f6',
  },
  notesInput: {
    marginTop: 10,
    fontSize: 13,
    color: '#111111',
    paddingVertical: 10,
    minHeight: 60,
    textAlignVertical: 'top',
  },
  fieldLabel: {
    fontSize: 12,
    color: '#6b7280',
    fontWeight: '500',
    marginBottom: 8,
  },
  pillRow: {
    flexDirection: 'row',
    flexWrap: 'nowrap',
    paddingBottom: 2,
  },
  pillBtn: {
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 7,
    marginRight: 8,
    backgroundColor: '#ffffff',
  },
  pillBtnOn: {
    borderColor: '#111111',
  },
  pillBtnText: {
    fontSize: 11,
    fontWeight: '500',
    color: '#111111',
  },
  pillBtnTextOn: {
    fontWeight: '600',
  },

  // Products
  productsHeader: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  productsMeta: {
    fontSize: 13,
    color: '#6b7280',
    fontWeight: '500',
  },
  productsEmpty: {
    fontSize: 13,
    color: '#6b7280',
  },
  productsList: {
    marginTop: 4,
  },
  productRow: {
    paddingVertical: 12,
    flexDirection: 'row',
    alignItems: 'center',
  },
  productName: {
    fontSize: 14,
    fontWeight: '500',
    color: '#111111',
  },
  productMeta: {
    marginTop: 4,
    fontSize: 12,
    color: '#6b7280',
  },
  rowIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  hairline: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: '#eef2f7',
  },

  // Bottom input (modal)
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
  categoryInline: {
    flexDirection: 'row',
    alignItems: 'center',
    height: 34,
    paddingHorizontal: 6,
    marginRight: 6,
  },
  categoryInlineText: {
    fontSize: 12,
    fontWeight: '500',
    color: '#111111',
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

  // Category picker sheet
  sheetBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.25)',
    justifyContent: 'flex-end',
    paddingHorizontal: 16,
    paddingBottom: 16,
  },
  sheetContainer: {
    backgroundColor: '#ffffff',
    borderRadius: 18,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    paddingHorizontal: 14,
    paddingTop: 14,
    paddingBottom: 10,
  },
  sheetTitle: {
    fontSize: 13,
    fontWeight: '600',
    color: '#111111',
    marginBottom: 10,
  },
  sheetList: {
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 14,
    overflow: 'hidden',
    backgroundColor: '#ffffff',
  },
  sheetScroll: {
    maxHeight: SHEET_MAX_HEIGHT,
  },
  sheetRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 12,
  },
  sheetRowText: {
    fontSize: 14,
    fontWeight: '500',
    color: '#111111',
  },
  sheetDivider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: '#eef2f7',
  },
  sheetCancel: {
    marginTop: 10,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 14,
    paddingVertical: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#ffffff',
  },
  sheetCancelText: {
    fontSize: 13,
    fontWeight: '500',
    color: '#111111',
  },
});

export default List;