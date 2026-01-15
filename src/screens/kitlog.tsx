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
  ScrollView,
  Modal,
  Alert,
  StatusBar,
  useWindowDimensions,
} from 'react-native';
import Constants from 'expo-constants';
import { SafeAreaView, useSafeAreaInsets, initialWindowMetrics } from 'react-native-safe-area-context';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useBottomTabBarHeight } from '@react-navigation/bottom-tabs';
import { DOC_KEYS, getString, makeScopedKey, setString } from '../localstore';

type KitLogScreenProps = {
  navigation: any;
  route: any;
  email?: string | null;
  userId?: string | number | null;
};

type ItemStatus = 'inKit' | 'low' | 'empty';

type KitItem = {
  id: string;
  name: string;
  brand?: string;
  shade?: string;
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

type KitLogData = {
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


const STORAGE_KEY = DOC_KEYS.kitlog;

// Category bar fills up as you add items (cap).
const CATEGORY_BAR_TARGET = 12;


// How the bar sits when keyboard is CLOSED
// (Adds a little more breathing room above the bottom nav divider)
const CLOSED_BOTTOM_PADDING = 28;

// Extra space ABOVE the keyboard when it’s OPEN
// (Raised to make the lift clearly noticeable)
const KEYBOARD_GAP = 33;

function uid(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function defaultCategories(): KitCategory[] {
  const now = Date.now();
  const names = [
    // Put Prep & Skin first (user request).
    'Prep & Skin',
    // Core defaults
    'Base',
    'Lips',
    'Cheeks',
    'Eyes',
    'Brows',
    'Lashes',
    'Tools',
    'Hygiene & Disposables',
    'Body / FX / Extras',
  ];

  return names.map((name) => ({
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
function normalizeData(input: any): KitLogData {
  const base: KitLogData = { version: 1, categories: defaultCategories() };

  try {
    const cats = Array.isArray(input?.categories) ? input.categories : null;
    if (!cats) return base;

    const normalizedCats: KitCategory[] = cats
      .map((c: any) => {
        if (!c) return null;
        const id = typeof c.id === 'string' ? c.id : uid('cat');
        const name = typeof c.name === 'string' && c.name.trim() ? c.name.trim() : 'Untitled';
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

            return {
              id: itemId,
              name: itemName,
              brand: typeof it.brand === 'string' ? it.brand : '',
              shade: typeof it.shade === 'string' ? it.shade : '',
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
    return { version: 1, categories: normalizedCats };
  } catch {
    return base;
  }
}

const KitLog: React.FC<KitLogScreenProps> = ({ navigation, email, userId }) => {
  // Scope local data per user (stable id preferred; fall back to email).
  const scope = userId ?? (email ? String(email).trim().toLowerCase() : null);
  const storageKey = useMemo(() => makeScopedKey(STORAGE_KEY, scope), [scope]);

  const [data, setData] = useState<KitLogData>({ version: 1, categories: defaultCategories() });
  const [hydrated, setHydrated] = useState(false);
  const persistTimer = useRef<any>(null);
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

  const [search, setSearch] = useState('');
  const [view, setView] = useState<ViewMode>('all');
  const [homeAttention, setHomeAttention] = useState<HomeAttentionMode>('low');

  const [newCategoryText, setNewCategoryText] = useState('');
  const [quickAddText, setQuickAddText] = useState('');
  const [toneMenuOpen, setToneMenuOpen] = useState(false);

  // Close the inline tone dropdown when navigating between screens/items.
  useEffect(() => {
    setToneMenuOpen(false);
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
  }, []);

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
  const bottomPadding = keyboardHeight > 0 ? keyboardInset + KEYBOARD_GAP : CLOSED_BOTTOM_PADDING;

  const activeCategory = useMemo(() => {
    if (!activeCategoryId) return null;
    return data.categories.find((c) => c.id === activeCategoryId) ?? null;
  }, [data.categories, activeCategoryId]);

  const activeItem = useMemo(() => {
    if (!activeCategory || !activeItemId) return null;
    return activeCategory.items.find((it) => it.id === activeItemId) ?? null;
  }, [activeCategory, activeItemId]);

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

    // Keep Prep & Skin first, then the core face areas.
    const priority = ['prep & skin', 'base', 'lips', 'cheeks', 'eyes'] as const;
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
  }

  function closeCategory() {
    setMode('home');
    setActiveCategoryId(null);
    setActiveItemId(null);
    setView('all');
    setQuickAddText('');
    setSearch('');
  }

  function openItemDirect(categoryId: string, itemId: string) {
    setActiveCategoryId(categoryId);
    setActiveItemId(itemId);
    setMode('item');
    setView('all');
    setQuickAddText('');
    setSearch('');
  }

  function openItem(itemId: string) {
    setActiveItemId(itemId);
    setMode('item');
  }

  function closeItem() {
    setMode('category');
    setActiveItemId(null);
  }

  function addCategoryFromBar() {
    const name = newCategoryText.trim();
    if (!name) {
      Keyboard.dismiss();
      return;
    }

    const now = Date.now();
    const cat: KitCategory = { id: uid('cat'), name, createdAt: now, items: [] };
    setData((prev) => ({ ...prev, categories: [cat, ...prev.categories] }));
    setNewCategoryText('');
    Keyboard.dismiss();
  }

  function confirmDeleteCategory(categoryId: string) {
    const cat = data.categories.find((c) => c.id === categoryId);
    if (!cat) return;

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
    if (!text) {
      Keyboard.dismiss();
      return;
    }

    const now = Date.now();
    const newId = uid('item');

    const item: KitItem = {
      id: newId,
      name: text,
      brand: '',
      shade: '',
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
        <View style={[styles.container, { paddingBottom: bottomPadding }]}>
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

            <TouchableOpacity style={styles.accountChip} onPress={() => navigation.navigate('Upload')}>
              <Text style={styles.accountChipText}>Upload</Text>
            </TouchableOpacity>
          </View>

          {/* HOME */}
          {mode === 'home' && (
            <View style={{ flex: 1 }}>
              <ScrollView
                style={{ flex: 1 }}
                contentContainerStyle={{ paddingBottom: 26, paddingTop: 18, paddingLeft: 6, paddingRight: 0 }}
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

                              <View style={styles.categoryRackBar}>
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

              {/* Bottom bar (home) – create category */}
              <View style={styles.inputBar}>
                <View style={styles.inputContainer}>
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
                contentContainerStyle={{ paddingBottom: 18, paddingTop: 12 }}
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
                      const subBits = [it.brand, it.shade, it.location].filter(Boolean).join(' • ');
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

              {/* Bottom bar (category) – add item */}
              <View style={styles.inputBar}>
                <View style={styles.inputContainer}>
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
          )}

          {/* ITEM EDITOR */}
          <Modal
            visible={mode === 'item'}
            animationType="slide"
            presentationStyle={Platform.OS === 'ios' ? 'pageSheet' : 'fullScreen'}
            onRequestClose={closeItem}
          >
            <SafeAreaView style={[styles.modalSafe, { paddingTop: stableTopInset }]} edges={['left', 'right']}>
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
                    <FormRow
                      label="Brand"
                      value={activeItem?.brand ?? ''}
                      placeholder="NARS"
                      onChangeText={(v) => updateItemField('brand', v)}
                    />
                    <View style={styles.rowDivider} />
                    <FormRow
                      label="Shade"
                      value={activeItem?.shade ?? ''}
                      placeholder="Custard"
                      onChangeText={(v) => updateItemField('shade', v)}
                    />
                    <View style={styles.rowDivider} />
                    <View style={styles.formRow}>
                      <Text style={styles.formLabel}>Tone</Text>

                      <TouchableOpacity
                        style={styles.toneDropdownButton}
                        activeOpacity={0.9}
                        onPress={() => setToneMenuOpen((v) => !v)}
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
                    <View style={styles.rowDivider} />
                    <FormRow
                      label="Form"
                      value={activeItem?.form ?? ''}
                      placeholder="Cream"
                      onChangeText={(v) => updateItemField('form', v)}
                    />
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

export default KitLog;
