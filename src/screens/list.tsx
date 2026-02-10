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

// Filter sheet should be taller so the date field stays visible when the keyboard is open.
const FILTER_SHEET_MAX_HEIGHT = Math.round(Dimensions.get('window').height * 0.9);
const FILTER_SHEET_MIN_HEIGHT = Math.round(Dimensions.get('window').height * 0.62);

// Time wheel picker sizing.
const WHEEL_ROW_HEIGHT = 40;
const WHEEL_VISIBLE_ROWS = 5;
const WHEEL_SPACER_HEIGHT = ((WHEEL_VISIBLE_ROWS - 1) / 2) * WHEEL_ROW_HEIGHT;
const AMPM_COL_WIDTH = 56;

// Default KitLog categories (used only if KitLog hasn't been opened yet)
const DEFAULT_KITLOG_CATEGORIES = [
  // Match KitLog category ordering
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

const FALLBACK_CATEGORY_NAME = 'Base';

// Kit picker uses this sentinel category to show all items.
const KIT_PICKER_ALL = '__all__';

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

const DOW_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function normalizeKitlogCategoryName(raw: any): string {
  const n = typeof raw === 'string' ? raw.trim() : '';
  if (!n) return '';
  const key = n.toLowerCase();

  // Legacy name migrations.
  if (key === 'foundation') return 'Base';
  if (key === 'prep & skin' || key === 'prep and skin' || key === 'prep/skin') return 'Prep & Finish';
  if (key === 'prep & finish' || key === 'prep and finish') return 'Prep & Finish';
  if (key === 'lashes') return 'Eyes';
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

  return n;
}


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
  'Engagement',
  'Graduation',
  'Party',
  'Trial',
  'Production',
  'Fashion & editorial',
  'Corporate',
  'Photoshoot',
  'Other',
] as const;

type EventType = string;

// Category is driven by KitLog (dynamic), so store it as a string (category name).
type PlanCategory = string;

type ClientProduct = {
  id: string;
  category: PlanCategory;
  name: string;
  shade?: string;
  notes?: string;
  // If added from KitLog, keep a reference to the KitLog item id.
  kitItemId?: string;
  createdAt: number;
  updatedAt: number;
};

type KitPickItem = {
  id: string;
  category: PlanCategory;
  name: string;
  brand?: string;
  shade?: string;
  subcategory?: string;
  type?: string;
};

type ClientRecord = {
  id: string;
  displayName: string;
  undertone: Undertone;
  season: Season4 | null;
  trialDate?: string; // YYYY-MM-DD
  trialTime?: string; // HH:MM
  finalDate?: string; // YYYY-MM-DD
  finalTime?: string; // HH:MM
  eventType: string;
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

function formatDateInputDMY(raw: string): string {
  // Accept digits only and format as DD-MM-YYYY while typing.
  const digits = (raw || '').replace(/\D/g, '').slice(0, 8);
  if (digits.length <= 2) return digits;
  if (digits.length <= 4) return `${digits.slice(0, 2)}-${digits.slice(2)}`;
  return `${digits.slice(0, 2)}-${digits.slice(2, 4)}-${digits.slice(4)}`;
}

function ymdToDmy(ymd: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec((ymd || '').trim());
  if (!m) return '';
  return `${m[3]}-${m[2]}-${m[1]}`;
}

function dmyToYmd(dmy: string): string {
  const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec((dmy || '').trim());
  if (!m) return '';
  const dd = m[1];
  const mm = m[2];
  const yyyy = m[3];
  return `${yyyy}-${mm}-${dd}`;
}





function normalizeTimeString(raw: any): string {
  if (typeof raw === 'string') return raw.trim();
  return '';
}

function formatTimeInput(raw: string): string {
  // Accept digits only and format as HH:MM while typing.
  const digits = (raw || '').replace(/\D/g, '').slice(0, 4);
  if (digits.length <= 2) return digits;
  // Common shorthand: 930 => 09:30
  if (digits.length === 3) return `0${digits.slice(0, 1)}:${digits.slice(1)}`;
  return `${digits.slice(0, 2)}:${digits.slice(2)}`;
}


function formatTimeDisplay(hhmm: string): string {
  const m = /^(\d{1,2}):(\d{2})$/.exec((hhmm || '').trim());
  if (!m) return '';
  const h24 = Math.max(0, Math.min(23, Number(m[1])));
  const mm = Math.max(0, Math.min(59, Number(m[2])));
  const isPM = h24 >= 12;
  let h12 = h24 % 12;
  if (h12 === 0) h12 = 12;
  return `${h12}:${pad2(mm)} ${isPM ? 'PM' : 'AM'}`;
}

function pad2(n: number): string {
  const v = Math.floor(Math.abs(n));
  return v < 10 ? `0${v}` : `${v}`;
}

function ymdFromParts(year: number, month0: number, day: number): string {
  return `${year}-${pad2(month0 + 1)}-${pad2(day)}`;
}

function parseYmdParts(ymd: string): { year: number; month0: number; day: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec((ymd || '').trim());
  if (!m) return null;
  const year = Number(m[1]);
  const month0 = Number(m[2]) - 1;
  const day = Number(m[3]);
  if (!Number.isFinite(year) || !Number.isFinite(month0) || !Number.isFinite(day)) return null;
  if (month0 < 0 || month0 > 11) return null;
  if (day < 1 || day > 31) return null;
  return { year, month0, day };
}

function buildMonthMatrix(year: number, month0: number): (number | null)[][] {
  const firstDow = new Date(year, month0, 1).getDay();
  const daysInMonth = new Date(year, month0 + 1, 0).getDate();
  const cells: (number | null)[] = [];
  for (let i = 0; i < firstDow; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);
  while (cells.length % 7 !== 0) cells.push(null);
  const weeks: (number | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

function monthYearLabel(year: number, month0: number): string {
  const names = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const m = names[month0] || '';
  return m ? `${m} ${year}` : `${year}`;
}
const DAY_MS = 24 * 60 * 60 * 1000;
const UPCOMING_WINDOW_DAYS = 10;

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
  const dates = `${c.trialDate || ''} ${c.trialTime || ''} ${c.finalDate || ''} ${c.finalTime || ''}`.toLowerCase();
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
    trialTime: '',
    finalDate: '',
    finalTime: '',
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
  const datesEmpty =
    !(c.trialDate || '').trim() &&
    !(c.trialTime || '').trim() &&
    !(c.finalDate || '').trim() &&
    !(c.finalTime || '').trim();
  const eventTypeEmpty = !(String((c as any).eventType || '')).trim();
  return nameEmpty && notesEmpty && noProducts && noMatch && datesEmpty && eventTypeEmpty;
}

// Backwards compatibility:
// Earlier versions stored a small fixed set of category *codes*.
// We now store the category *name* from KitLog.
const LEGACY_CATEGORY_CODES: Record<string, string> = {
  prep: 'Prep & Finish',
  base: 'Base',
  conceal: 'Base',
  cheek: 'Cheeks',
  sculpt: 'Sculpt',
  brow: 'Brows',
  eye: 'Eyes',
  lashes: 'Eyes',
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

    // Migrations from legacy category *names* to current KitLog categories.
    const key = trimmed.toLowerCase();
    if (key === 'foundation') return 'Base';
    if (key === 'prep & skin' || key === 'prep and skin' || key === 'prep/skin') return 'Prep & Finish';
    if (key === 'prep & finish' || key === 'prep and finish') return 'Prep & Finish';
    if (key === 'lashes') return 'Eyes';
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
        let eventType = '';
        if (rawEventType) {
          const key = rawEventType.toLowerCase();

          const match = EVENT_TYPE_OPTIONS.find((opt) => opt.toLowerCase() === key);
          if (match) {
            eventType = match;
          } else if (
            key === 'special occasion' ||
            key === 'special_occasion' ||
            key === 'special-occasion'
          ) {
            eventType = 'Party';
          } else if (key === 'tv' || key === 'film' || key === 'television') {
            eventType = 'Production';
          } else if (key === 'fashion&editorial' || key === 'fashion and editorial' || key === 'editorial') {
            eventType = 'Fashion & editorial';
          } else {
            // Allow custom event types.
            eventType = rawEventType;
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
              kitItemId: typeof (p as any).kitItemId === 'string' ? String((p as any).kitItemId) : undefined,
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
          trialTime: normalizeTimeString((c as any)?.trialTime),
          finalDate: normalizeDateString((c as any)?.finalDate),
          finalTime: normalizeTimeString((c as any)?.finalTime),
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

  const [filterOpen, setFilterOpen] = useState(false);
  const [filterEventType, setFilterEventType] = useState<string>('');
  const [filterDate, setFilterDate] = useState<string>('');
  const [filterEventMenuOpen, setFilterEventMenuOpen] = useState(false);

  // Client editor modal state
  const [draft, setDraft] = useState<ClientRecord | null>(null);
  const [isDraftNew, setIsDraftNew] = useState(false);
  const [kitlogItems, setKitlogItems] = useState<KitPickItem[]>([]);
  const [kitPickerOpen, setKitPickerOpen] = useState(false);
  const [kitPickerSearch, setKitPickerSearch] = useState('');
  const [kitPickerCategory, setKitPickerCategory] = useState<string>(KIT_PICKER_ALL);
  const [kitlogCategories, setKitlogCategories] = useState<string[]>(DEFAULT_KITLOG_CATEGORIES);
  const [eventTypeMenuOpen, setEventTypeMenuOpen] = useState(false);
  const [customEventTypeOpen, setCustomEventTypeOpen] = useState(false);

  // Date/time pickers (calendar + wheel)
  const [datePickerOpen, setDatePickerOpen] = useState(false);
  const [timePickerOpen, setTimePickerOpen] = useState(false);
  const [activeDateField, setActiveDateField] = useState<'trialDate' | 'finalDate' | null>(null);
  const [activeTimeField, setActiveTimeField] = useState<'trialTime' | 'finalTime' | null>(null);
  const [calendarYear, setCalendarYear] = useState<number>(new Date().getFullYear());
  const [calendarMonth, setCalendarMonth] = useState<number>(new Date().getMonth()); // 0-based
  const [timeHour12, setTimeHour12] = useState<number>(9);
  const [timeAmPm, setTimeAmPm] = useState<'AM' | 'PM'>('AM');
  const [timeMinute, setTimeMinute] = useState<number>(0);
  const hourWheelRef = useRef<ScrollView | null>(null);
  const minuteWheelRef = useRef<ScrollView | null>(null);

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
        setKitlogItems([]);
        setKitPickerCategory(KIT_PICKER_ALL);
        return;
      }

      const catsRaw = Array.isArray(parsed?.categories) ? parsed.categories : [];

      const names = catsRaw
        .map((c: any) => normalizeKitlogCategoryName(c?.name))
        .filter(Boolean) as string[];

      // Deduplicate while preserving order.
      const uniq: string[] = [];
      for (const n of names) {
        if (!uniq.includes(n)) uniq.push(n);
      }

      const finalList: string[] = [...DEFAULT_KITLOG_CATEGORIES];

      // Append any custom categories from KitLog (preserve their order).
      for (const n of uniq) {
        if (!finalList.includes(n)) finalList.push(n);
      }

      const items: KitPickItem[] = [];
      for (const c of catsRaw) {
        const catName = normalizeKitlogCategoryName((c as any)?.name);
        if (!catName) continue;
        const itemsRaw = Array.isArray((c as any)?.items) ? (c as any).items : [];
        for (const it of itemsRaw) {
          const name = typeof (it as any)?.name === 'string' ? (it as any).name.trim() : '';
          if (!name) continue;
          const id = typeof (it as any)?.id === 'string' ? (it as any).id : uid('kit');
          const brand = typeof (it as any)?.brand === 'string' ? (it as any).brand.trim() : '';
          const shade = typeof (it as any)?.shade === 'string' ? (it as any).shade.trim() : '';
          const subcategory = typeof (it as any)?.subcategory === 'string' ? (it as any).subcategory.trim() : '';
          const type = typeof (it as any)?.type === 'string' ? (it as any).type.trim() : '';
          const subKey = (subcategory || '').trim().toLowerCase();
          const catLow = String(catName || '').trim().toLowerCase();

          let mappedCategory = catName;

          // Base misfiles: keep list usable even if KitLog hasn’t been opened to migrate yet.
          if (catLow === 'base') {
            if (subKey === 'blush' || subKey === 'bronzer') mappedCategory = 'Cheeks';
            else if (subKey === 'contour' || subKey === 'highlighter') mappedCategory = 'Sculpt';
          }

          // Cheeks/Sculpt swap
          if (catLow === 'cheeks' && subKey === 'highlighter') mappedCategory = 'Sculpt';
          if (catLow === 'sculpt' && subKey === 'bronzer') mappedCategory = 'Cheeks';


          items.push({
            id,
            category: mappedCategory,
            name,
            brand: brand || undefined,
            shade: shade || undefined,
            subcategory: subcategory || undefined,
            type: type || undefined,
          });
        }
      }

      setKitlogCategories(finalList);
      setKitlogItems(items);

      setKitPickerCategory((prev) => {
        if (prev === KIT_PICKER_ALL) return prev;
        if (finalList.includes(prev)) return prev;
        return KIT_PICKER_ALL;
      });
    } catch {
      setKitlogCategories(DEFAULT_KITLOG_CATEGORIES);
      setKitlogItems([]);
      setKitPickerCategory(KIT_PICKER_ALL);
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
  const filterActive = !!filterEventType.trim() || !!filterDate.trim();

  const filterEventTypeOptions = useMemo(() => {
    const base = [...EVENT_TYPE_OPTIONS];
    const seen = new Set(base.map((v) => v.toLowerCase()));
    const custom: string[] = [];
    for (const c of data.clients || []) {
      const v = (c.eventType || '').toString().trim();
      if (!v) continue;
      const k = v.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      custom.push(v);
    }
    return [...base, ...custom];
  }, [data.clients]);

  const addedKitIds = useMemo(() => {
    const s = new Set<string>();
    for (const p of (draft?.products || []) as any[]) {
      const id = typeof (p as any)?.kitItemId === 'string' ? (p as any).kitItemId : '';
      if (id) s.add(id);
    }
    return s;
  }, [draft]);

  const kitPickerVisibleItems = useMemo(() => {
    const needle = kitPickerSearch.trim().toLowerCase();
    const cat = kitPickerCategory;

    const filtered = kitlogItems.filter((it) => {
      if (cat !== KIT_PICKER_ALL && it.category !== cat) return false;
      if (!needle) return true;
      const hay = `${it.name} ${it.brand || ''} ${it.shade || ''}`.toLowerCase();
      return hay.includes(needle);
    });

    return [...filtered].sort((a, b) => {
      if (cat === KIT_PICKER_ALL) {
        const c = a.category.localeCompare(b.category);
        if (c) return c;
      }
      return a.name.localeCompare(b.name);
    });
  }, [kitlogItems, kitPickerSearch, kitPickerCategory]);


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

  const upcomingFiltered = useMemo(() => {
    if (!filterActive) return upcomingAll;
    const typeNeedle = filterEventType.trim().toLowerCase();
    const dateNeedle = filterDate.trim();
    return upcomingAll.filter((c) => {
      if (typeNeedle && (c.eventType || '').toString().trim().toLowerCase() !== typeNeedle) return false;
      if (dateNeedle) {
        const t = (c.trialDate || '').trim();
        const f = (c.finalDate || '').trim();
        if (t !== dateNeedle && f !== dateNeedle) return false;
      }
      return true;
    });
  }, [upcomingAll, filterActive, filterEventType, filterDate]);

  const nonUpcomingFiltered = useMemo(() => {
    if (!filterActive) return nonUpcomingAll;
    const typeNeedle = filterEventType.trim().toLowerCase();
    const dateNeedle = filterDate.trim();
    return nonUpcomingAll.filter((c) => {
      if (typeNeedle && (c.eventType || '').toString().trim().toLowerCase() !== typeNeedle) return false;
      if (dateNeedle) {
        const t = (c.trialDate || '').trim();
        const f = (c.finalDate || '').trim();
        if (t !== dateNeedle && f !== dateNeedle) return false;
      }
      return true;
    });
  }, [nonUpcomingAll, filterActive, filterEventType, filterDate]);

  const upcomingVisible = useMemo(() => {
    if (!searchActive) return upcomingFiltered;
    return upcomingFiltered.filter((c) => clientMatchesQuery(c, query));
  }, [upcomingFiltered, query, searchActive]);

  const nonUpcomingVisible = useMemo(() => {
    if (!searchActive) return nonUpcomingFiltered;
    return nonUpcomingFiltered.filter((c) => clientMatchesQuery(c, query));
  }, [nonUpcomingFiltered, query, searchActive]);

  const hasUpcoming = upcomingFiltered.length > 0;
  const upcomingTotal = upcomingAll.length;
  const upcomingShowing = upcomingVisible.length;
  const clientsTotal = nonUpcomingAll.length;
  const clientsShowing = nonUpcomingVisible.length;

  const upcomingMeta = (searchActive || filterActive) ? `${upcomingShowing} / ${upcomingTotal}` : `${upcomingTotal}`;
  const clientsMeta = (searchActive || filterActive) ? `${clientsShowing} / ${clientsTotal}` : `${clientsTotal}`;

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

  const filterBackdropPadBottom =
    keyboardHeight > 0 ? keyboardHeight + 12 : Math.max(insets.bottom, 16) + 12;

  const calendarWeeks = useMemo(() => buildMonthMatrix(calendarYear, calendarMonth), [calendarYear, calendarMonth]);
  const hours12 = useMemo(() => Array.from({ length: 12 }, (_, i) => i + 1), []);
  const minutes = useMemo(() => Array.from({ length: 60 }, (_, i) => i), []);

  useEffect(() => {
    if (!timePickerOpen) return;
    const t = setTimeout(() => {
      try {
        const hourIdx = Math.max(0, Math.min(11, (timeHour12 || 1) - 1));
        hourWheelRef.current?.scrollTo({ y: hourIdx * WHEEL_ROW_HEIGHT, animated: false });
        minuteWheelRef.current?.scrollTo({ y: timeMinute * WHEEL_ROW_HEIGHT, animated: false });
      } catch {
        // ignore
      }
    }, 30);
    return () => clearTimeout(t);
  }, [timePickerOpen, activeTimeField]);

  function addClientFromBar() {
    const name = newClientText.trim();
    Keyboard.dismiss();

    const limit = PLAN_LIMITS[planTier].clients;
    const used = Array.isArray(data.clients) ? data.clients.length : 0;
    if (limit !== Infinity && used >= limit) {
      const isPro = planTier === 'pro';
      const msg = isPro
        ? `You’ve reached the Pro plan limit of ${limit.toLocaleString()} list items.`
        : `Free plan allows up to ${limit.toLocaleString()} list items. Upgrade to Pro to add more.`;

      Alert.alert(
        'List limit reached',
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
    setCustomEventTypeOpen(false);
    setEventTypeMenuOpen(false);
    setKitPickerOpen(false);
    setDatePickerOpen(false);
    setTimePickerOpen(false);
    setKitPickerOpen(false);
    setActiveDateField(null);
    setActiveTimeField(null);
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
    setCustomEventTypeOpen(false);
    setEventTypeMenuOpen(false);
    setKitPickerOpen(false);
    setDatePickerOpen(false);
    setTimePickerOpen(false);
    setKitPickerOpen(false);
    setActiveDateField(null);
    setActiveTimeField(null);
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
    setCustomEventTypeOpen(false);
    setDatePickerOpen(false);
    setTimePickerOpen(false);
    setKitPickerOpen(false);
    setActiveDateField(null);
    setActiveTimeField(null);
    if (!draft) return;
    const cleaned: ClientRecord = {
      ...draft,
      displayName: (draft.displayName || '').trim(),
      trialDate: formatDateInput((draft.trialDate || '').trim()),
      trialTime: formatTimeInput((draft.trialTime || '').trim()),
      finalDate: formatDateInput((draft.finalDate || '').trim()),
      finalTime: formatTimeInput((draft.finalTime || '').trim()),
      eventType: (draft.eventType || '').toString().trim(),
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
    Alert.alert('Delete from list', 'This removes the item from your list.', [
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

  function closeDatePicker() {
    setDatePickerOpen(false);
    setActiveDateField(null);
  }

  function closeTimePicker() {
    setTimePickerOpen(false);
    setActiveTimeField(null);
  }

  function openDatePickerSheet(field: 'trialDate' | 'finalDate') {
    if (!draft) return;
    Keyboard.dismiss();
    setEventTypeMenuOpen(false);
    setCustomEventTypeOpen(false);
    setTimePickerOpen(false);
    setActiveTimeField(null);
    setKitPickerOpen(false);

    // Toggle closed if tapping the same field again.
    if (datePickerOpen && activeDateField === field) {
      setDatePickerOpen(false);
      setActiveDateField(null);
      return;
    }

    setActiveDateField(field);

    const cur = (field === 'trialDate' ? draft.trialDate : draft.finalDate) || '';
    const parts = parseYmdParts(cur);
    const base = parts ? new Date(parts.year, parts.month0, 1) : new Date();
    setCalendarYear(base.getFullYear());
    setCalendarMonth(base.getMonth());
    setDatePickerOpen(true);
  }

  function openTimePickerSheet(field: 'trialTime' | 'finalTime') {
    if (!draft) return;
    Keyboard.dismiss();
    setEventTypeMenuOpen(false);
    setCustomEventTypeOpen(false);
    setDatePickerOpen(false);
    setActiveDateField(null);
    setKitPickerOpen(false);

    // Toggle closed if tapping the same field again.
    if (timePickerOpen && activeTimeField === field) {
      setTimePickerOpen(false);
      setActiveTimeField(null);
      return;
    }

    setActiveTimeField(field);

    const cur = (field === 'trialTime' ? draft.trialTime : draft.finalTime) || '';
    const m = /^(\d{1,2}):(\d{2})$/.exec(cur.trim());
    const h24 = m ? Math.min(23, Math.max(0, Number(m[1]))) : 9;
    const min = m ? Math.min(59, Math.max(0, Number(m[2]))) : 0;
    const safeH24 = Number.isFinite(h24) ? h24 : 9;
    const isPM = safeH24 >= 12;
    let h12 = safeH24 % 12;
    if (h12 === 0) h12 = 12;

    setTimeHour12(h12);
    setTimeMinute(Number.isFinite(min) ? min : 0);
    setTimeAmPm(isPM ? 'PM' : 'AM');
    setTimePickerOpen(true);
  }

  function shiftCalendarMonth(delta: number) {
    const next = new Date(calendarYear, calendarMonth + delta, 1);
    setCalendarYear(next.getFullYear());
    setCalendarMonth(next.getMonth());
  }

  function pickCalendarDay(day: number) {
    if (!draft || !activeDateField) return;
    const ymd = ymdFromParts(calendarYear, calendarMonth, day);
    setDraft((prev) => {
      if (!prev) return prev;
      return { ...prev, [activeDateField]: ymd, updatedAt: Date.now() } as ClientRecord;
    });
    closeDatePicker();
  }

  function clearActiveDate() {
    if (!draft || !activeDateField) {
      closeDatePicker();
      return;
    }
    setDraft((prev) => {
      if (!prev) return prev;
      return { ...prev, [activeDateField]: '', updatedAt: Date.now() } as ClientRecord;
    });
    closeDatePicker();
  }

  function commitTime() {
    if (!draft || !activeTimeField) {
      closeTimePicker();
      return;
    }
    const base = Math.max(1, Math.min(12, timeHour12 || 12)) % 12;
    const hour24 = base + (timeAmPm === 'PM' ? 12 : 0);
    const hh = pad2(hour24);
    const mm = pad2(timeMinute);
    const value = `${hh}:${mm}`;
    setDraft((prev) => {
      if (!prev) return prev;
      return { ...prev, [activeTimeField]: value, updatedAt: Date.now() } as ClientRecord;
    });
    closeTimePicker();
  }

  function clearActiveTime() {
    if (!draft || !activeTimeField) {
      closeTimePicker();
      return;
    }
    setDraft((prev) => {
      if (!prev) return prev;
      return { ...prev, [activeTimeField]: '', updatedAt: Date.now() } as ClientRecord;
    });
    closeTimePicker();
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

  function closeFilter() {
    setFilterEventMenuOpen(false);
    setFilterOpen(false);
  }

  function clearFilters() {
    setFilterEventType('');
    setFilterDate('');
    setFilterEventMenuOpen(false);
  }

  async function openKitPicker() {
    if (!draft) return;
    Keyboard.dismiss();
    setEventTypeMenuOpen(false);
    setDatePickerOpen(false);
    setActiveDateField(null);
    setTimePickerOpen(false);
    setActiveTimeField(null);

    // Toggle closed if already open.
    if (kitPickerOpen) {
      setKitPickerOpen(false);
      return;
    }

    await refreshKitlogCategories();
    setKitPickerSearch('');
    setKitPickerCategory(KIT_PICKER_ALL);
    setKitPickerOpen(true);
  }

  function addKitItemToDraft(item: KitPickItem) {
    if (!draft) return;
    const now = Date.now();

    const already = (draft.products || []).some((p) => (p.kitItemId || '') === item.id);
    if (already) return;

    const brand = (item.brand || '').trim();
    const name = (item.name || '').trim();
    const displayName = brand && !name.toLowerCase().includes(brand.toLowerCase()) ? `${brand} ${name}` : name;

    const prod: ClientProduct = {
      id: uid('prod'),
      category: item.category,
      name: displayName,
      shade: item.shade || '',
      notes: '',
      kitItemId: item.id,
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
  }
  const topTitle = hasUpcoming ? 'Upcoming' : 'List';
  const topMeta = hasUpcoming ? upcomingMeta : clientsMeta;

  const draftEventTypeValue = (draft?.eventType || '').toString().trim();
  const draftEventTypeIsCustom =
    !!draftEventTypeValue && !EVENT_TYPE_OPTIONS.some((opt) => opt.toLowerCase() === draftEventTypeValue.toLowerCase());
  const draftEventTypeDisplay = draftEventTypeValue ? draftEventTypeValue : customEventTypeOpen ? 'Custom' : 'Select';

  const todayLocal = new Date();
  const todayYmd = ymdFromParts(todayLocal.getFullYear(), todayLocal.getMonth(), todayLocal.getDate());
  const activeDateValue =
    draft && activeDateField ? String((draft as any)[activeDateField] || '').trim() : '';

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
              <View style={styles.listHeaderRight}>
                <Text style={styles.listHeaderMeta}>{topMeta}</Text>
                <TouchableOpacity
                  style={[styles.filterBtn, filterActive ? styles.filterBtnOn : null]}
                  activeOpacity={0.9}
                  onPress={() => {
                    Keyboard.dismiss();
                    setFilterEventMenuOpen(false);
                    setFilterOpen(true);
                  }}
                  accessibilityRole="button"
                >
                  <Ionicons name="options-outline" size={16} color={filterActive ? '#111111' : '#6b7280'} />
                </TouchableOpacity>
              </View>
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
              (searchActive || filterActive) ? (
                <View style={styles.emptyPad}>
                  <Text style={styles.emptyPadText}>No items found.</Text>
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
                      <View style={styles.listHeaderRight}>
                        <Text style={styles.listHeaderMeta}>{item.meta}</Text>
                        <TouchableOpacity
                          style={[styles.filterBtn, filterActive ? styles.filterBtnOn : null]}
                          activeOpacity={0.9}
                          onPress={() => {
                            Keyboard.dismiss();
                            setFilterEventMenuOpen(false);
                            setFilterOpen(true);
                          }}
                          accessibilityRole="button"
                        >
                          <Ionicons name="options-outline" size={16} color={filterActive ? '#111111' : '#6b7280'} />
                        </TouchableOpacity>
                      </View>
                    </View>
                    <View style={[styles.hairline, styles.listHeaderDivider]} />
                  </View>
                );
              }

              const c = item.client;
              const title = c.displayName?.trim() ? c.displayName.trim() : 'Untitled';

              const chips: { key: string; text: string }[] = [];
              const eventType = (c.eventType || '').toString().trim();
              if (eventType) {
                chips.push({ key: `type_${eventType}`, text: eventType });
              }

              const trialDate = (c.trialDate || '').trim();
              const trialTime = (c.trialTime || '').trim();
              const trialDisplay = trialDate ? (ymdToDmy(trialDate) || trialDate) : '';
              const trialTimeDisplay = trialTime ? (formatTimeDisplay(trialTime) || trialTime) : '';
              if (trialDate) {
                chips.push({
                  key: `trial_${trialDate}_${trialTime}`,
                  text: `Trial ${trialDisplay}${trialTimeDisplay ? ' ' + trialTimeDisplay : ''}`,
                });
              }

              const finalDate = (c.finalDate || '').trim();
              const finalTime = (c.finalTime || '').trim();
              const finalDisplay = finalDate ? (ymdToDmy(finalDate) || finalDate) : '';
              const finalTimeDisplay = finalTime ? (formatTimeDisplay(finalTime) || finalTime) : '';
              if (finalDate) {
                chips.push({
                  key: `event_${finalDate}_${finalTime}`,
                  text: `Event ${finalDisplay}${finalTimeDisplay ? ' ' + finalTimeDisplay : ''}`,
                });
              }

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
                  </View>

                  {chips.length ? (
                    <View style={styles.chipRow}>
                      {chips.map((ch) => (
                        <View key={ch.key} style={styles.smallChip}>
                          <Text style={styles.smallChipText} numberOfLines={1}>
                            {ch.text}
                          </Text>
                        </View>
                      ))}
                    </View>
                  ) : null}
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

        {/* Filter (match the Add-to-list panel) */}
        <Modal
          visible={filterOpen}
          animationType="slide"
          presentationStyle={Platform.OS === 'ios' ? 'pageSheet' : 'fullScreen'}
          onRequestClose={closeFilter}
        >
          <TouchableWithoutFeedback onPress={Keyboard.dismiss}>
            <SafeAreaView style={styles.modalSafe} edges={['top', 'left', 'right']}>
              <View style={[styles.modalContainer, { paddingBottom: modalBottomPadding }]}> 
                <View style={styles.modalHeader}>
                  <TouchableOpacity style={styles.modalBack} onPress={closeFilter} accessibilityRole="button">
                    <Ionicons name="chevron-back" size={20} color="#111111" />
                    <Text style={styles.modalBackText}>List</Text>
                  </TouchableOpacity>

                  <TouchableOpacity style={styles.modalClear} onPress={clearFilters} accessibilityRole="button">
                    <Text style={styles.modalClearText}>Clear</Text>
                  </TouchableOpacity>
                </View>

                <ScrollView
                  style={{ flex: 1 }}
                  contentContainerStyle={{ paddingTop: 12, paddingBottom: 24 }}
                  keyboardShouldPersistTaps="handled"
                  showsVerticalScrollIndicator={false}
                >
                  <View style={styles.editorCard}>
                    <Text style={styles.sectionTitle}>Filter</Text>




                    <TouchableOpacity
                      style={styles.menuRow}
                      activeOpacity={0.9}
                      onPress={() => {
                        Keyboard.dismiss();
                        setFilterEventMenuOpen((v) => !v);
                      }}
                      accessibilityRole="button"
                    >
                      <Text style={styles.menuRowLabel}>Event type</Text>
                      <View style={styles.menuRowRight}>
                        <Text
                          style={[styles.menuRowValue, !filterEventType.trim() ? styles.menuRowValueMuted : null]}
                          numberOfLines={1}
                        >
                          {filterEventType.trim() ? filterEventType : 'Any'}
                        </Text>
                        <Ionicons name="chevron-down" size={14} color="#6b7280" style={{ marginLeft: 6 }} />
                      </View>
                    </TouchableOpacity>

                    {filterEventMenuOpen ? (
                      <View style={styles.eventMenu}>
                        {[('Any' as const), ...filterEventTypeOptions].map((name, idx) => {
                          const value = name === 'Any' ? '' : (name as any);
                          const on = (filterEventType || '') === value;
                          const isLast = idx === filterEventTypeOptions.length;
                          return (
                            <View key={String(name)}>
                              <TouchableOpacity
                                style={styles.eventMenuRow}
                                activeOpacity={0.9}
                                onPress={() => {
                                  setFilterEventType(value);
                                  setFilterEventMenuOpen(false);
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

                    <View style={{ marginTop: 12 }}>
                      <Text style={styles.dateLabel}>Date</Text>
                      <TextInput
                        value={filterDate}
                        onChangeText={(v) => setFilterDate(formatDateInput(v))}
                        placeholder="YYYY-MM-DD"
                        placeholderTextColor="#9ca3af"
                        style={styles.dateInput}
                        autoCorrect={false}
                        keyboardType={Platform.OS === 'ios' ? 'number-pad' : 'numeric'}
                        maxLength={10}
                        returnKeyType="done"
                      />
                      <Text style={styles.filterHint}>Matches trial or event date</Text>
                    </View>
                  </View>
                </ScrollView>
              </View>
            </SafeAreaView>
          </TouchableWithoutFeedback>
        </Modal>

        {/* Client editor */}
        <Modal
          visible={!!draft}
          animationType="slide"
          presentationStyle={Platform.OS === 'ios' ? 'pageSheet' : 'fullScreen'}
          onRequestClose={closeClient}
        >

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
                  scrollEnabled={!timePickerOpen}
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

                    {/* Trial + Event (date + time) in one row (tap to pick) */}
                    <View style={styles.dateRowCombined}>
                      <View style={[styles.dateTimeBoxWrap, { marginRight: 12 }]}>
                        <Text style={styles.dateLabel}>Trial</Text>
                        <View style={styles.dateTimeBox}>
                          <TouchableOpacity
                            style={styles.dateTimePart}
                            activeOpacity={0.9}
                            onPress={() => openDatePickerSheet('trialDate')}
                            accessibilityRole="button"
                          >
                            <Text
                              style={[styles.dateTimeValue, !(draft?.trialDate || '').trim() ? styles.dateTimeValueMuted : null]}
                              numberOfLines={1}
                            >
                              {(draft?.trialDate || '').trim()
                                ? (ymdToDmy((draft?.trialDate || '').trim()) || (draft?.trialDate || '').trim())
                                : 'DD-MM-YYYY'}
                            </Text>
                          </TouchableOpacity>
                          <View style={styles.dateTimeDivider} />
                          <TouchableOpacity
                            style={styles.dateTimePartTime}
                            activeOpacity={0.9}
                            onPress={() => openTimePickerSheet('trialTime')}
                            accessibilityRole="button"
                          >
                            <Text
                              style={[styles.dateTimeValue, !(draft?.trialTime || '').trim() ? styles.dateTimeValueMuted : null]}
                              numberOfLines={1}
                            >
                              {(draft?.trialTime || '').trim() ? (formatTimeDisplay((draft?.trialTime || '').trim()) || (draft?.trialTime || '').trim()) : 'HH:MM AM'}
                            </Text>
                          </TouchableOpacity>
                        </View>
                      </View>

                      <View style={styles.dateTimeBoxWrap}>
                        <Text style={styles.dateLabel}>Event</Text>
                        <View style={styles.dateTimeBox}>
                          <TouchableOpacity
                            style={styles.dateTimePart}
                            activeOpacity={0.9}
                            onPress={() => openDatePickerSheet('finalDate')}
                            accessibilityRole="button"
                          >
                            <Text
                              style={[styles.dateTimeValue, !(draft?.finalDate || '').trim() ? styles.dateTimeValueMuted : null]}
                              numberOfLines={1}
                            >
                              {(draft?.finalDate || '').trim()
                                ? (ymdToDmy((draft?.finalDate || '').trim()) || (draft?.finalDate || '').trim())
                                : 'DD-MM-YYYY'}
                            </Text>
                          </TouchableOpacity>
                          <View style={styles.dateTimeDivider} />
                          <TouchableOpacity
                            style={styles.dateTimePartTime}
                            activeOpacity={0.9}
                            onPress={() => openTimePickerSheet('finalTime')}
                            accessibilityRole="button"
                          >
                            <Text
                              style={[styles.dateTimeValue, !(draft?.finalTime || '').trim() ? styles.dateTimeValueMuted : null]}
                              numberOfLines={1}
                            >
                              {(draft?.finalTime || '').trim() ? (formatTimeDisplay((draft?.finalTime || '').trim()) || (draft?.finalTime || '').trim()) : 'HH:MM AM'}
                            </Text>
                          </TouchableOpacity>
                        </View>
                      </View>
                    </View>



                    {/* Inline date picker (calendar) */}
                    {datePickerOpen ? (
                      <View style={[styles.inlinePickerCard, { marginTop: 12 }]}>
                        <View style={styles.inlinePickerHeaderRow}>
                          <Text style={[styles.sectionTitle, { marginBottom: 0 }]}>
                            {activeDateField === 'finalDate' ? 'Event date' : 'Trial date'}
                          </Text>
                          <View style={styles.inlinePickerHeaderActions}>
                            <TouchableOpacity
                              style={styles.inlinePickerActionBtn}
                              activeOpacity={0.9}
                              onPress={clearActiveDate}
                              accessibilityRole="button"
                            >
                              <Text style={styles.inlinePickerActionText}>Clear</Text>
                            </TouchableOpacity>
                            <TouchableOpacity
                              style={styles.inlinePickerCloseBtn}
                              activeOpacity={0.9}
                              onPress={closeDatePicker}
                              accessibilityRole="button"
                            >
                              <Ionicons name="close" size={18} color="#111111" />
                            </TouchableOpacity>
                          </View>
                        </View>

                        <View style={styles.calendarHeaderRow}>
                          <TouchableOpacity
                            style={styles.calendarNavBtn}
                            onPress={() => shiftCalendarMonth(-1)}
                            accessibilityRole="button"
                          >
                            <Ionicons name="chevron-back" size={18} color="#111111" />
                          </TouchableOpacity>

                          <Text style={styles.calendarMonthText}>
                            {MONTH_NAMES[calendarMonth]} {calendarYear}
                          </Text>

                          <TouchableOpacity
                            style={styles.calendarNavBtn}
                            onPress={() => shiftCalendarMonth(1)}
                            accessibilityRole="button"
                          >
                            <Ionicons name="chevron-forward" size={18} color="#111111" />
                          </TouchableOpacity>
                        </View>

                        <View style={styles.calendarDowRow}>
                          {DOW_SHORT.map((d) => (
                            <Text key={d} style={styles.calendarDowText}>
                              {d}
                            </Text>
                          ))}
                        </View>

                        <View style={styles.calendarGrid}>
                          {calendarWeeks.map((week, wi) => (
                            <View key={`w_${wi}`} style={styles.calendarWeekRow}>
                              {week.map((day, di) => {
                                if (!day) return <View key={`c_${wi}_${di}`} style={styles.calendarDayCell} />;
                                const ymd = ymdFromParts(calendarYear, calendarMonth, day);
                                const selected = !!activeDateValue && ymd === activeDateValue;
                                const isToday = ymd === todayYmd;
                                return (
                                  <TouchableOpacity
                                    key={`d_${wi}_${di}`}
                                    style={[
                                      styles.calendarDayBtn,
                                      selected ? styles.calendarDayBtnOn : null,
                                      isToday && !selected ? styles.calendarDayBtnToday : null,
                                    ]}
                                    activeOpacity={0.9}
                                    onPress={() => pickCalendarDay(day)}
                                    accessibilityRole="button"
                                  >
                                    <Text style={[styles.calendarDayText, selected ? styles.calendarDayTextOn : null]}>
                                      {day}
                                    </Text>
                                  </TouchableOpacity>
                                );
                              })}
                            </View>
                          ))}
                        </View>

                        <Text style={styles.calendarHint}>Tap a day to set the date.</Text>
                      </View>
                    ) : null}

                    {/* Inline time picker (wheel) */}
                    {timePickerOpen ? (
                      <View style={[styles.inlinePickerCard, { marginTop: 12 }]}>
                        <View style={styles.inlinePickerHeaderRow}>
                          <View style={styles.inlinePickerHeaderLeft}>
                            <Text style={[styles.sectionTitle, { marginBottom: 0, fontSize: 13 }]}>
                              {activeTimeField === 'finalTime' ? 'Event time' : 'Trial time'}
                            </Text>

                            <View style={styles.ampmHeaderRow}>
                              {(['AM', 'PM'] as const).map((v) => {
                                const on = timeAmPm === v;
                                return (
                                  <TouchableOpacity
                                    key={v}
                                    style={[styles.ampmBtn, styles.ampmBtnHeader, on ? styles.ampmBtnOn : null]}
                                    activeOpacity={0.9}
                                    onPress={() => setTimeAmPm(v)}
                                    accessibilityRole="button"
                                  >
                                    <Text style={[styles.ampmText, on ? styles.ampmTextOn : null]}>{v}</Text>
                                  </TouchableOpacity>
                                );
                              })}
                            </View>
                          </View>

                          <View style={styles.inlinePickerHeaderActions}>
                            <TouchableOpacity
                              style={styles.inlinePickerActionBtn}
                              activeOpacity={0.9}
                              onPress={clearActiveTime}
                              accessibilityRole="button"
                            >
                              <Text style={styles.inlinePickerActionText}>Clear</Text>
                            </TouchableOpacity>
                            <TouchableOpacity
                              style={styles.inlinePickerActionBtn}
                              activeOpacity={0.9}
                              onPress={commitTime}
                              accessibilityRole="button"
                            >
                              <Text style={styles.inlinePickerActionText}>Set</Text>
                            </TouchableOpacity>
                          </View>
                        </View>

                        <View style={styles.timeWheelWrap}>
                          <ScrollView
                            ref={hourWheelRef as any}
                            showsVerticalScrollIndicator={false}
                            snapToInterval={WHEEL_ROW_HEIGHT}
                            decelerationRate="fast"
                            bounces={false}
                            nestedScrollEnabled
                            onStartShouldSetResponderCapture={() => true}
                            onMoveShouldSetResponderCapture={() => true}
                            contentContainerStyle={{ paddingVertical: WHEEL_SPACER_HEIGHT }}
                            onMomentumScrollEnd={(e) => {
                              const y = e.nativeEvent.contentOffset.y;
                              const idx = Math.max(0, Math.min(11, Math.round(y / WHEEL_ROW_HEIGHT)));
                              setTimeHour12(hours12[idx] ?? 1);
                            }}
                            onScrollEndDrag={(e) => {
                              const y = e.nativeEvent.contentOffset.y;
                              const idx = Math.max(0, Math.min(11, Math.round(y / WHEEL_ROW_HEIGHT)));
                              setTimeHour12(hours12[idx] ?? 1);
                            }}
                            style={styles.timeWheelCol}
                          >
                            {hours12.map((h) => {
                              const on = h === timeHour12;
                              return (
                                <View key={`h_${h}`} style={styles.wheelRow}>
                                  <Text style={[styles.wheelText, on ? styles.wheelTextOn : null]}>{pad2(h)}</Text>
                                </View>
                              );
                            })}
                          </ScrollView>

                          <Text style={styles.timeWheelColon}>:</Text>

                          <ScrollView
                            ref={minuteWheelRef as any}
                            showsVerticalScrollIndicator={false}
                            snapToInterval={WHEEL_ROW_HEIGHT}
                            decelerationRate="fast"
                            bounces={false}
                            nestedScrollEnabled
                            onStartShouldSetResponderCapture={() => true}
                            onMoveShouldSetResponderCapture={() => true}
                            contentContainerStyle={{ paddingVertical: WHEEL_SPACER_HEIGHT }}
                            onMomentumScrollEnd={(e) => {
                              const y = e.nativeEvent.contentOffset.y;
                              const idx = Math.max(0, Math.min(59, Math.round(y / WHEEL_ROW_HEIGHT)));
                              setTimeMinute(idx);
                            }}
                            onScrollEndDrag={(e) => {
                              const y = e.nativeEvent.contentOffset.y;
                              const idx = Math.max(0, Math.min(59, Math.round(y / WHEEL_ROW_HEIGHT)));
                              setTimeMinute(idx);
                            }}
                            style={styles.timeWheelCol}
                          >
                            {minutes.map((m) => {
                              const on = m === timeMinute;
                              return (
                                <View key={`m_${m}`} style={styles.wheelRow}>
                                  <Text style={[styles.wheelText, on ? styles.wheelTextOn : null]}>{pad2(m)}</Text>
                                </View>
                              );
                            })}
                          </ScrollView>

                          <View pointerEvents="none" style={styles.wheelOverlay} />
                        </View>

                        {/* Removed hint text to reduce visual noise */}
                      </View>
                    ) : null}

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
                            !draftEventTypeValue ? styles.menuRowValueMuted : null,
                          ]}
                          numberOfLines={1}
                        >
                          {draftEventTypeDisplay}
                        </Text>
                        <Ionicons name="chevron-down" size={14} color="#6b7280" style={{ marginLeft: 6 }} />
                      </View>
                    </TouchableOpacity>

                    {eventTypeMenuOpen ? (
                      <View style={styles.eventMenu}>
                        {(['None', ...EVENT_TYPE_OPTIONS, 'Custom'] as const).map((name, idx) => {
                          const isCustom = name === 'Custom';
                          const value = name === 'None' ? '' : isCustom ? '__custom__' : (name as any);

                          const on =
                            value === '__custom__'
                              ? customEventTypeOpen || draftEventTypeIsCustom
                              : !customEventTypeOpen && draftEventTypeValue === value;

                          const isLast = idx === EVENT_TYPE_OPTIONS.length + 1;

                          return (
                            <View key={String(name)}>
                              <TouchableOpacity
                                style={styles.eventMenuRow}
                                activeOpacity={0.9}
                                onPress={() => {
                                  if (value === '__custom__') {
                                    setCustomEventTypeOpen(true);
                                    setDraft((prev) => {
                                      if (!prev) return prev;
                                      const cur = (prev.eventType || '').toString().trim();
                                      const curIsCustom =
                                        !!cur && !EVENT_TYPE_OPTIONS.some((opt) => opt.toLowerCase() === cur.toLowerCase());
                                      return {
                                        ...prev,
                                        eventType: curIsCustom ? (prev.eventType as any) : '',
                                        updatedAt: Date.now(),
                                      };
                                    });
                                    setEventTypeMenuOpen(false);
                                    return;
                                  }

                                  setDraft((prev) => (prev ? { ...prev, eventType: value as any, updatedAt: Date.now() } : prev));
                                  setCustomEventTypeOpen(false);
                                  setEventTypeMenuOpen(false);
                                }}
                                accessibilityRole="button"
                              >
                                <Text style={styles.eventMenuText}>{name}</Text>
                                {on ? (
                                  <Ionicons name="checkmark" size={18} color="#111111" />
                                ) : (
                                  <View style={{ width: 18 }} />
                                )}
                              </TouchableOpacity>
                              {!isLast ? <View style={styles.eventMenuDivider} /> : null}
                            </View>
                          );
                        })}
                      </View>
                    ) : null}

                    {(customEventTypeOpen || draftEventTypeIsCustom) ? (
                      <View style={{ marginTop: 10 }}>
                        <Text style={styles.dateLabel}>Custom event type</Text>
                        <TextInput
                          value={draft?.eventType ?? ''}
                          onChangeText={(v) =>
                            setDraft((prev) => (prev ? { ...prev, eventType: v, updatedAt: Date.now() } : prev))
                          }
                          placeholder="Type…"
                          placeholderTextColor="#9ca3af"
                          style={styles.customEventInput}
                          autoCorrect={false}
                          returnKeyType="done"
                        />
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
                      <Text style={[styles.sectionTitle, { marginBottom: 0 }]}>Products</Text>
                      <TouchableOpacity
                        style={styles.productsAddBtn}
                        activeOpacity={0.9}
                        onPress={() => openKitPicker()}
                        accessibilityRole="button"
                        hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                      >
                        <Ionicons name="add" size={18} color="#111111" />
                      </TouchableOpacity>
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

                    {kitPickerOpen ? (
                      <View style={styles.inlinePickerCard}>
                        <View style={styles.kitHeaderRow}>
                          <Text style={[styles.sectionTitle, { marginBottom: 0 }]}>Add from kit</Text>
                        </View>

                        <View style={styles.kitSearchPill}>
                          <Ionicons name="search-outline" size={16} color="#6b7280" style={{ marginRight: 8 }} />
                          <TextInput
                            value={kitPickerSearch}
                            onChangeText={setKitPickerSearch}
                            placeholder="Search kit…"
                            placeholderTextColor="#9ca3af"
                            style={styles.kitSearchInput}
                            autoCorrect={false}
                            returnKeyType="search"
                          />
                          {kitPickerSearch.trim() ? (
                            <TouchableOpacity
                              style={styles.kitSearchClear}
                              onPress={() => setKitPickerSearch('')}
                              accessibilityRole="button"
                            >
                              <Ionicons name="close-circle" size={18} color="#9ca3af" />
                            </TouchableOpacity>
                          ) : null}
                        </View>

                        <ScrollView
                          horizontal
                          showsHorizontalScrollIndicator={false}
                          contentContainerStyle={styles.kitCategoryRow}
                          keyboardShouldPersistTaps="handled"
                        >
                          {[KIT_PICKER_ALL, ...kitlogCategories].map((cat) => {
                            const label = cat === KIT_PICKER_ALL ? 'All' : cat;
                            const on = kitPickerCategory === cat;
                            return (
                              <TouchableOpacity
                                key={cat}
                                style={[styles.pillBtn, on ? styles.pillBtnOn : null]}
                                onPress={() => setKitPickerCategory(cat)}
                                activeOpacity={0.9}
                                accessibilityRole="button"
                              >
                                <Text style={[styles.pillBtnText, on ? styles.pillBtnTextOn : null]}>{label}</Text>
                              </TouchableOpacity>
                            );
                          })}
                        </ScrollView>

                        <View style={[styles.sheetList, { marginTop: 12, borderWidth: 0 }]}>
                          <ScrollView
                            style={styles.kitListScroll}
                            showsVerticalScrollIndicator
                            bounces={false}
                            keyboardShouldPersistTaps="handled"
                            nestedScrollEnabled
                          >
                            {kitPickerVisibleItems.length === 0 ? (
                              <View style={styles.kitEmptyRow}>
                                <Text style={styles.kitEmptyText}>No items found.</Text>
                              </View>
                            ) : (
                              kitPickerVisibleItems.map((it, idx) => {
                                const isLast = idx === kitPickerVisibleItems.length - 1;
                                const brand = (it.brand || '').trim();
                                const nm = (it.name || '').trim();
                                const title =
                                  brand && nm && !nm.toLowerCase().includes(brand.toLowerCase()) ? `${brand} ${nm}` : nm;
                                const metaParts: string[] = [];
                                if (it.category) metaParts.push(it.category);
                                if (it.shade) metaParts.push(it.shade);
                                const meta = metaParts.join(' • ');
                                const added = addedKitIds.has(it.id);

                                return (
                                  <View key={it.id}>
                                    <TouchableOpacity
                                      style={styles.kitRow}
                                      activeOpacity={0.9}
                                      onPress={() => addKitItemToDraft(it)}
                                      accessibilityRole="button"
                                    >
                                      <View style={{ flex: 1, paddingRight: 10 }}>
                                        <Text style={styles.kitRowName} numberOfLines={2}>
                                          {title || it.name}
                                        </Text>
                                        {meta ? (
                                          <Text style={styles.kitRowMeta} numberOfLines={1}>
                                            {meta}
                                          </Text>
                                        ) : null}
                                      </View>
                                      {added ? (
                                        <Ionicons name="checkmark" size={18} color="#111111" />
                                      ) : (
                                        <Ionicons name="add" size={18} color="#111111" />
                                      )}
                                    </TouchableOpacity>
                                    {!isLast ? <View style={styles.sheetDivider} /> : null}
                                  </View>
                                );
                              })
                            )}
                          </ScrollView>
                        </View>
                      </View>
                    ) : null}

                  </View>
                </ScrollView>

              </View>
            </SafeAreaView>

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
    paddingRight: 4,
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
  listHeaderRight: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  filterBtn: {
    marginLeft: 10,
    width: 30,
    height: 30,
    alignItems: 'center',
    justifyContent: 'center',
  },
  filterBtnOn: {},
  listHeaderDivider: {
    marginTop: 13,
    marginBottom: 26,
    marginRight: 4,
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
    alignItems: 'flex-end',
  },
  dateRowCombined: {
    flexDirection: 'row',
    marginTop: 12,
    alignItems: 'flex-end',
  },
  dateTimeBoxWrap: {
    flex: 1,
    minWidth: 0,
  },
  dateTimeBox: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 14,
    backgroundColor: '#ffffff',
    overflow: 'hidden',
  },
  dateTimePart: {
    flex: 1,
    minWidth: 0,
    paddingVertical: 10,
    paddingHorizontal: 12,
  },
  dateTimePartTime: {
    width: 76,
    minWidth: 68,
    paddingVertical: 10,
    paddingHorizontal: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dateTimeDivider: {
    width: StyleSheet.hairlineWidth,
    height: '100%',
    backgroundColor: '#e5e7eb',
  },
  dateTimeValue: {
    fontSize: 13,
    color: '#111111',
    fontWeight: '400',
  },
  dateTimeValueMuted: {
    color: '#9ca3af',
  },
  dateTimeGroup: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'flex-end',
  },
  dateField: {
    flex: 1,
    minWidth: 0,
  },
  timeField: {
    width: 96,
    minWidth: 88,
    flexShrink: 0,
  },
  timeFieldCompact: {
    width: 72,
    minWidth: 64,
    flexShrink: 0,
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
  timeInput: {
    fontSize: 13,
    color: '#111111',
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 14,
    backgroundColor: '#ffffff',
    textAlign: 'center',
  },
  timeInputCompact: {
    fontSize: 13,
    color: '#111111',
    paddingVertical: 10,
    paddingHorizontal: 8,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 14,
    backgroundColor: '#ffffff',
    textAlign: 'center',
  },
  customEventInput: {
    fontSize: 13,
    color: '#111111',
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 14,
    backgroundColor: '#ffffff',
  },

  // Inline picker panels (inside the client editor)
  inlinePickerCard: {
    marginTop: 12,
    borderWidth: 0,
    borderRadius: 14,
    backgroundColor: '#ffffff',
    paddingHorizontal: 0,
    paddingVertical: 12,
  },
  inlinePickerHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 10,
  },
  inlinePickerHeaderLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    flexShrink: 1,
  },
  ampmHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginLeft: 10,
  },
  ampmBtnHeader: {
    marginVertical: 0,
    marginHorizontal: 4,
    width: 44,
    paddingVertical: 4,
    paddingHorizontal: 10,
    borderRadius: 12,
  },
  inlinePickerHeaderActions: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  inlinePickerActionBtn: {
    paddingHorizontal: 10,
    height: 34,
    alignItems: 'center',
    justifyContent: 'center',
  },
  inlinePickerActionText: {
    fontSize: 13,
    fontWeight: '500',
    color: '#111111',
  },
  inlinePickerCloseBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
  },

  // Calendar picker
  calendarHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 10,
  },
  calendarNavBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#e5e7eb',
    backgroundColor: '#ffffff',
  },
  calendarMonthText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#111111',
  },
  calendarDowRow: {
    flexDirection: 'row',
    marginBottom: 6,
  },
  calendarDowText: {
    flex: 1,
    fontSize: 11,
    fontWeight: '500',
    color: '#6b7280',
    textAlign: 'center',
  },
  calendarGrid: {
    borderWidth: 0,
    borderRadius: 16,
    overflow: 'hidden',
    backgroundColor: '#ffffff',
  },
  calendarWeekRow: {
    flexDirection: 'row',
  },
  calendarDayCell: {
    flex: 1,
    height: 44,
  },
  calendarDayBtn: {
    flex: 1,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  calendarDayBtnOn: {
    backgroundColor: '#111111',
  },
  calendarDayBtnToday: {
    borderWidth: 1,
    borderColor: '#111111',
  },
  calendarDayText: {
    fontSize: 13,
    fontWeight: '500',
    color: '#111111',
  },
  calendarDayTextOn: {
    color: '#ffffff',
  },
  calendarHint: {
    marginTop: 10,
    fontSize: 12,
    color: '#6b7280',
  },

  // Time wheel picker
  modalHeaderRightRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  timeWheelWrap: {
    position: 'relative',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 0,
    borderRadius: 18,
    overflow: 'hidden',
    backgroundColor: '#ffffff',
    height: WHEEL_ROW_HEIGHT * WHEEL_VISIBLE_ROWS,
  },
  timeWheelCol: {
    width: 96,
    height: WHEEL_ROW_HEIGHT * WHEEL_VISIBLE_ROWS,
  },
  timeWheelColon: {
    fontSize: 18,
    fontWeight: '600',
    color: '#111111',
    paddingHorizontal: 6,
  },
  wheelRow: {
    height: WHEEL_ROW_HEIGHT,
    alignItems: 'center',
    justifyContent: 'center',
  },
  wheelText: {
    fontSize: 18,
    color: '#6b7280',
    fontWeight: '500',
  },
  wheelTextOn: {
    color: '#111111',
    fontWeight: '600',
  },
  wheelOverlay: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: WHEEL_SPACER_HEIGHT,
    height: WHEEL_ROW_HEIGHT,
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: '#e5e7eb',
    backgroundColor: 'rgba(0,0,0,0.02)',
  },

  ampmCol: {
    width: AMPM_COL_WIDTH,
    height: WHEEL_ROW_HEIGHT * WHEEL_VISIBLE_ROWS,
    borderLeftWidth: 1,
    borderLeftColor: '#e5e7eb',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 6,
    backgroundColor: '#ffffff',
  },
  ampmBtn: {
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 10,
    paddingVertical: 6,
    paddingHorizontal: 10,
    marginVertical: 4,
    backgroundColor: '#ffffff',
    width: AMPM_COL_WIDTH - 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ampmBtnOn: {
    borderColor: '#111111',
    backgroundColor: 'rgba(0,0,0,0.03)',
  },
  ampmText: {
    fontSize: 10,
    fontWeight: '700',
    color: '#6b7280',
    letterSpacing: 0.4,
  },
  ampmTextOn: {
    color: '#111111',
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
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  productsAddBtn: {
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: -4,
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
  filterSheetContainer: {
    minHeight: FILTER_SHEET_MIN_HEIGHT,
    maxHeight: FILTER_SHEET_MAX_HEIGHT,
  },
  filterSheetScroll: {
    flex: 1,
  },
  filterSheetScrollContent: {
    paddingBottom: 16,
  },
  filterSheetFooter: {
    paddingTop: 8,
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


  // Filter
  filterHint: {
    marginTop: 6,
    fontSize: 12,
    color: '#6b7280',
  },

  // Filter modal header
  modalClear: {
    paddingHorizontal: 12,
    height: 40,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    backgroundColor: '#ffffff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalClearText: {
    fontSize: 13,
    fontWeight: '500',
    color: '#111111',
  },

  // Add product bar
  kitInline: {
    width: 34,
    height: 34,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 4,
  },

  // Kit picker
  kitSheetContainer: {
    paddingBottom: 10,
  },
  kitHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 10,
  },
  kitCloseBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
  },
  kitSearchPill: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 18,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    backgroundColor: '#ffffff',
    paddingLeft: 12,
    paddingRight: 8,
    minHeight: 38,
  },
  kitSearchInput: {
    flex: 1,
    fontSize: 14,
    color: '#111111',
    paddingVertical: 0,
    fontWeight: '400',
  },
  kitSearchClear: {
    marginLeft: 6,
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  kitCategoryRow: {
    flexDirection: 'row',
    paddingTop: 10,
    paddingBottom: 2,
  },
  kitListScroll: {
    maxHeight: SHEET_MAX_HEIGHT,
  },
  kitRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 12,
  },
  kitRowName: {
    fontSize: 14,
    fontWeight: '500',
    color: '#111111',
  },
  kitRowMeta: {
    marginTop: 4,
    fontSize: 12,
    color: '#6b7280',
  },
  kitEmptyRow: {
    paddingHorizontal: 12,
    paddingVertical: 18,
  },
  kitEmptyText: {
    fontSize: 13,
    color: '#6b7280',
    fontWeight: '500',
  },
});

export default List;