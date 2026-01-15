import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Keyboard,
  TextInput,
  Platform,
  StatusBar,
  useWindowDimensions,
  ScrollView,
  Modal,
  Pressable,
  KeyboardAvoidingView,
  ActivityIndicator,
  Alert,
  Linking,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { DOC_KEYS, getString, makeScopedKey } from '../localstore';
import Constants from 'expo-constants';

import { SafeAreaView, initialWindowMetrics, useSafeAreaInsets } from 'react-native-safe-area-context';

const KITLOG_STORAGE_KEY = DOC_KEYS.kitlog;

type PlanTier = 'free' | 'pro';

const PLAN_CONFIG: Record<
  PlanTier,
  { label: string; priceLabel: string; features: string[] }
> = {
  free: {
    label: 'Free',
    priceLabel: '$0',
    features: ['5 uploads / mo', '5 clients / mo', '5 categories', '10 items'],
  },
  pro: {
    label: 'Pro',
    priceLabel: '$100 / mo',
    features: [
      '100 uploads / mo',
      '100 clients / mo',
      'Unlimited categories',
      'Unlimited items',
    ],
  },
};

const PLAN_LIMITS: Record<
  PlanTier,
  { uploads: number; clients: number; categories: number; items: number }
> = {
  free: { uploads: 5, clients: 5, categories: 5, items: 10 },
  pro: { uploads: 100, clients: 100, categories: Infinity, items: Infinity },
};

const PLAN_RANK: Record<PlanTier, number> = { free: 0, pro: 1 };

function formatPercent(used: number, limit: number): string {
  const safeUsed = Number.isFinite(used) && used > 0 ? used : 0;

  // Unlimited limits (Infinity) don't have a meaningful percent.
  if (limit === Infinity) return 'Unlimited';

  const safeLimit = Number.isFinite(limit) && limit > 0 ? limit : 0;
  if (safeLimit <= 0) return '0%';

  const pct = Math.round((safeUsed / safeLimit) * 100);
  return `${Math.max(0, pct)}%`;
}

function normalizePlanTier(value: any): PlanTier {
  const v = String(value ?? '').trim().toLowerCase();
  if (v === 'pro') return 'pro';
  if (v === 'free') return 'free';
  if (v.includes('pro')) return 'pro';
  // "Plus" is no longer offered; treat it as "Pro" so legacy values don't break UI.
  if (v === 'plus' || v.includes('plus')) return 'pro';
  return 'free';
}

// Read API base from app.json -> expo.extra.EXPO_PUBLIC_API_BASE
const API_BASE =
  (Constants as any).expoConfig?.extra?.EXPO_PUBLIC_API_BASE ??
  process.env.EXPO_PUBLIC_API_BASE ??
  'http://localhost:3000';

function countKitUsageFromRaw(raw: string | null): { categories: number; items: number } {
  if (!raw) return { categories: 0, items: 0 };
  try {
    const parsed = JSON.parse(raw);
    const cats = Array.isArray(parsed?.categories) ? parsed.categories : [];

    let items = 0;
    cats.forEach((c: any) => {
      const its = Array.isArray(c?.items) ? c.items : [];
      items += its.length;
    });

    return { categories: cats.length, items };
  } catch {
    return { categories: 0, items: 0 };
  }
}

type AccountScreenProps = {
  navigation: any;
  route: any;
  email?: string | null;
  userId?: string | number | null;
  token?: string | null;
  onEmailUpdated?: (nextEmail: string) => void;
  onLogout?: () => void;
};

// How the bar sits when keyboard is CLOSED
// (Adds a little more breathing room above the bottom nav divider)
const CLOSED_BOTTOM_PADDING = 28;

// Extra space ABOVE the keyboard when it is OPEN
const KEYBOARD_GAP = 0;

type ModalKind = null | 'name' | 'email' | 'password' | 'plan' | 'delete';

async function readJsonSafe(res: Response): Promise<any> {
  const text = await res.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

async function postJson(path: string, body: any, token?: string): Promise<any> {
  const headers: any = { 'Content-Type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body ?? {}),
  });

  const data = await readJsonSafe(res);
  if (!res.ok || data?.ok === false) {
    const msg = data?.error || data?.message || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return data;
}

async function getJson(path: string, token?: string): Promise<any> {
  const headers: any = {};
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${API_BASE}${path}`, { method: 'GET', headers });
  const data = await readJsonSafe(res);
  if (!res.ok || data?.ok === false) {
    const msg = data?.error || data?.message || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return data;
}

const Account: React.FC<AccountScreenProps> = ({ navigation, email, userId, token, onEmailUpdated, onLogout }) => {
  // Scope local data per user (stable id preferred; fall back to email).
  const scope = userId ?? (email ? String(email).trim().toLowerCase() : null);
  const kitlogKey = makeScopedKey(KITLOG_STORAGE_KEY, scope);
  const emailTrimmed = (email || '').trim();
  const tokenTrimmed = (token || '').trim();

  const [keyboardHeight, setKeyboardHeight] = useState(0);

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
  const [emailUpdatesEnabled, setEmailUpdatesEnabled] = useState(true);
  const [uploadsUsedThisMonth, setUploadsUsedThisMonth] = useState(0);
  const [clientsUsedThisMonth, setClientsUsedThisMonth] = useState(0);
  const [kitCategoryCount, setKitCategoryCount] = useState(0);
  const [kitItemCount, setKitItemCount] = useState(0);
  const [settingsQuery, setSettingsQuery] = useState('');

  const [accountName, setAccountName] = useState('');

  const [planTier, setPlanTier] = useState<PlanTier>('free');
  const [pendingPlanTier, setPendingPlanTier] = useState<PlanTier | null>(null);

  const [activeModal, setActiveModal] = useState<ModalKind>(null);
  const [saving, setSaving] = useState(false);

  // modal fields
  const [draftName, setDraftName] = useState('');

  const [draftEmail, setDraftEmail] = useState('');
  const [emailPassword, setEmailPassword] = useState('');

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmNewPassword, setConfirmNewPassword] = useState('');

  useEffect(() => {
    const showEvent = Platform.OS === 'android' ? 'keyboardDidShow' : 'keyboardWillShow';
    const hideEvent = Platform.OS === 'android' ? 'keyboardDidHide' : 'keyboardWillHide';

    const showListener = Keyboard.addListener(showEvent, (event) => {
      const height = event?.endCoordinates?.height ?? 0;
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

  const refreshAccount = async () => {
    if (!tokenTrimmed) return;

    try {
      const data = await getJson(`/me`, tokenTrimmed);
      const nextEmail = String(data?.user?.email || '').trim();
      if (nextEmail && onEmailUpdated) onEmailUpdated(nextEmail);
      const nextName = String(data?.user?.accountName || '').trim();
      setAccountName(nextName);
      const nextTier = normalizePlanTier(
        data?.user?.planTier ??
          data?.user?.plan ??
          data?.user?.tier ??
          data?.user?.subscriptionPlan ??
          data?.user?.subscription?.plan
      );
      setPlanTier(nextTier);

      // Optional usage fields from the server (fallbacks to local/defaults when absent).
      const usage = data?.usage ?? data?.limitsUsage ?? data?.counters ?? data?.stats ?? {};

      const nextUploads = Number(
        usage?.uploadsThisMonth ??
          usage?.uploads_this_month ??
          usage?.uploadsMonth ??
          usage?.uploads_used ??
          usage?.uploadsUsed ??
          usage?.uploads ??
          0
      );
      if (Number.isFinite(nextUploads)) setUploadsUsedThisMonth(nextUploads);

      const nextClients = Number(
        usage?.clientsThisMonth ??
          usage?.clients_this_month ??
          usage?.clientsMonth ??
          usage?.clients_month ??
          usage?.clients_used ??
          usage?.clientsUsed ??
          usage?.clients ??
          usage?.clientCount ??
          usage?.clientsCount ??
          usage?.client_count ??
          0
      );
      if (Number.isFinite(nextClients)) setClientsUsedThisMonth(nextClients);

      const nextCats = Number(
        usage?.categories ??
          usage?.categoriesCount ??
          usage?.categoryCount ??
          usage?.catalogCategories ??
          usage?.catalog_categories ??
          NaN
      );
      if (Number.isFinite(nextCats)) setKitCategoryCount(nextCats);

      const nextItems = Number(
        usage?.items ??
          usage?.itemsCount ??
          usage?.itemCount ??
          usage?.catalogItems ??
          usage?.catalog_items ??
          NaN
      );
      if (Number.isFinite(nextItems)) setKitItemCount(nextItems);

    } catch {
      // If the server isn't reachable (or user not found), keep UI usable.
      // (Account name can still be set; save will surface errors.)
    }
  };

  // Keep the kit count + account profile in sync when returning to this screen.
  useEffect(() => {
    let alive = true;

    const refresh = async () => {
      try {
        const raw = await getString(kitlogKey);
        const usage = countKitUsageFromRaw(raw);
        if (alive) {
          setKitCategoryCount(usage.categories);
          setKitItemCount(usage.items);
        }
      } catch {
        if (alive) {
          setKitCategoryCount(0);
          setKitItemCount(0);
        }
      }

      if (alive) {
        await refreshAccount();
      }
    };

    refresh();
    const unsubscribe = navigation.addListener('focus', refresh);

    return () => {
      alive = false;
      if (typeof unsubscribe === 'function') unsubscribe();
    };
  }, [navigation, tokenTrimmed, kitlogKey]);

  const handleLogoutPress = async () => {
    Keyboard.dismiss();

    // Best-effort revoke token server-side.
    try {
      if (tokenTrimmed) await postJson('/logout', {}, tokenTrimmed);
    } catch {
      // ignore
    }

    if (onLogout) {
      onLogout();
    }
  };

  const deleteAccount = async () => {
    if (!requireAuthOrAlert()) return;

    try {
      setSaving(true);

      await postJson('/delete-account', {}, tokenTrimmed);

      closeModal();
      Alert.alert('Account deleted', 'Your account has been deleted.');

      if (onLogout) {
        onLogout();
      }
    } catch (e: any) {
      Alert.alert('Could not delete account', String(e?.message || e));
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteAccountPress = () => {
    Keyboard.dismiss();
    if (!requireAuthOrAlert()) return;
    setActiveModal('delete');
  };

  const bottomPadding = keyboardHeight > 0 ? keyboardHeight + KEYBOARD_GAP : CLOSED_BOTTOM_PADDING;


  const query = settingsQuery.trim().toLowerCase();
  const isFiltering = query.length > 0;

  const matchesQuery = (...parts: string[]) => {
    if (!isFiltering) return true;
    return parts.some((p) => p.toLowerCase().includes(query));
  };

  const showAccountName = matchesQuery('Account name', 'Name');
  const showEmailRow = matchesQuery('Email', 'Update email');
  const showPassword = matchesQuery('Password', 'Update password');

  const showPlan = matchesQuery('Plan', 'Free', 'Pro', 'Upgrade', 'Manage');
  const showBilling = matchesQuery('Billing', 'Update billing');

  const showUploadUsage = matchesQuery('Usage', 'Upload usage', 'Upload', 'Uploads');

  const showCatalog = matchesQuery('Catalog', 'clients', 'items', 'categories');
  const showYourKit = matchesQuery('Your kit', 'kit', 'items');

  const showEmailUpdates = matchesQuery('Email updates');
  const showUserAgreement = matchesQuery('User agreement');
  const showSupport = matchesQuery('Support');

  const showDeleteAccount = matchesQuery('Delete account');
  const showLogout = matchesQuery('Log out', 'Logout');

  const profileRowsVisible = showAccountName || showEmailRow || showPassword;
  const planRowsVisible = showPlan || showBilling;
  const catalogRowsVisible = showUploadUsage || showCatalog || showYourKit;
  const commRowsVisible = showEmailUpdates || showUserAgreement || showSupport;
  const actionRowsVisible = showDeleteAccount || showLogout;

  const anyRowsVisible =
    profileRowsVisible || planRowsVisible || catalogRowsVisible || commRowsVisible || actionRowsVisible;

  const requireAuthOrAlert = () => {
    if (tokenTrimmed) return true;
    Alert.alert('Not logged in', 'Please log in to manage your account settings.');
    return false;
  };

  const closeModal = () => {
    setActiveModal(null);
    setPendingPlanTier(null);
    setDraftName('');
    setDraftEmail('');
    setEmailPassword('');
    setCurrentPassword('');
    setNewPassword('');
    setConfirmNewPassword('');
  };

  const openNameModal = () => {
    if (!requireAuthOrAlert()) return;
    Keyboard.dismiss();
    setDraftName(accountName || '');
    setActiveModal('name');
  };

  const openEmailModal = () => {
    if (!requireAuthOrAlert()) return;
    Keyboard.dismiss();
    setDraftEmail(emailTrimmed);
    setEmailPassword('');
    setActiveModal('email');
  };

  const openPasswordModal = () => {
    if (!requireAuthOrAlert()) return;
    Keyboard.dismiss();
    setCurrentPassword('');
    setNewPassword('');
    setConfirmNewPassword('');
    setActiveModal('password');
  };

  const openPlanModal = () => {
    if (!requireAuthOrAlert()) return;
    Keyboard.dismiss();
    setActiveModal('plan');
  };

  const saveAccountName = async () => {
    const name = draftName.trim();
    if (!name) {
      Alert.alert('Account name', 'Please enter a name.');
      return;
    }

    try {
      setSaving(true);
      await postJson('/update-account-name', { accountName: name }, tokenTrimmed);
      setAccountName(name);
      closeModal();
      Alert.alert('Saved', 'Your account name has been updated.');
    } catch (e: any) {
      Alert.alert('Could not update name', String(e?.message || e));
    } finally {
      setSaving(false);
    }
  };

  const saveEmail = async () => {
    const nextEmail = draftEmail.trim();
    if (!nextEmail) {
      Alert.alert('Update email', 'Please enter a new email.');
      return;
    }
    if (!emailPassword) {
      Alert.alert('Update email', 'Please enter your password to confirm.');
      return;
    }

    try {
      setSaving(true);
      const data = await postJson('/update-email', { password: emailPassword, newEmail: nextEmail }, tokenTrimmed);

      const updated = String(data?.user?.email || nextEmail).trim();
      if (onEmailUpdated) onEmailUpdated(updated);

      closeModal();
      Alert.alert('Email updated', 'Your email has been updated.');
    } catch (e: any) {
      Alert.alert('Could not update email', String(e?.message || e));
    } finally {
      setSaving(false);
    }
  };

  const savePassword = async () => {
    if (!currentPassword || !newPassword) {
      Alert.alert('Update password', 'Please enter your current password and a new password.');
      return;
    }

    if (newPassword !== confirmNewPassword) {
      Alert.alert('Update password', 'New passwords do not match.');
      return;
    }

    try {
      setSaving(true);
      await postJson('/update-password', { currentPassword, newPassword }, tokenTrimmed);

      closeModal();
      Alert.alert('Password updated', 'Your password has been updated.');
    } catch (e: any) {
      Alert.alert('Could not update password', String(e?.message || e));
    } finally {
      setSaving(false);
    }
  };

  const startSubscription = async (targetTier: PlanTier) => {
    if (!requireAuthOrAlert()) return;

    try {
      setSaving(true);
      setPendingPlanTier(targetTier);

      // Server should create a checkout session (Stripe / IAP bridge) and return a URL.
      // Example response: { ok: true, url: "https://..." }
      const data = await postJson('/start-subscription', { plan: targetTier }, tokenTrimmed);

      const url = String(data?.url || data?.checkoutUrl || data?.checkout_url || '').trim();

      if (!url) {
        Alert.alert('Upgrade', 'Subscription flow is not configured yet.');
        return;
      }

      const canOpen = await Linking.canOpenURL(url);
      if (!canOpen) {
        Alert.alert('Upgrade', 'Could not open the checkout link on this device.');
        return;
      }

      await Linking.openURL(url);
      closeModal();
    } catch (e: any) {
      Alert.alert('Could not start subscription', String(e?.message || e));
    } finally {
      setSaving(false);
      setPendingPlanTier(null);
    }
  };

  const renderModal = () => {
    if (!activeModal) return null;

    if (activeModal === 'plan') {
      const tiers: PlanTier[] = ['pro'];

      return (
        <Modal
          visible
          transparent
          animationType="fade"
          onRequestClose={() => {
            if (!saving) closeModal();
          }}
        >
          <Pressable
            style={styles.modalBackdrop}
            onPress={() => {
              if (!saving) closeModal();
            }}
          >
            <KeyboardAvoidingView
              behavior={Platform.OS === 'ios' ? 'padding' : undefined}
              style={styles.modalCenter}
            >
              <Pressable style={styles.modalCard} onPress={() => {}}>
                <View style={styles.modalHeader}>
                  <Text style={styles.modalTitle}>Plans</Text>
                  <TouchableOpacity
                    onPress={closeModal}
                    activeOpacity={0.85}
                    style={styles.modalClose}
                    accessibilityRole="button"
                    accessibilityLabel="Close"
                    disabled={saving}
                  >
                    <Ionicons name="close" size={20} color="#6b7280" />
                  </TouchableOpacity>
                </View>

                <Text style={styles.planIntro}>
                  Pick the plan that matches your usage. Billed monthly. Cancel anytime.
                </Text>

                <ScrollView
                  style={styles.planScroll}
                  contentContainerStyle={styles.planScrollContent}
                  showsVerticalScrollIndicator={false}
                >
                  {tiers.map((tier) => {
                    const cfg = PLAN_CONFIG[tier];
                    const isCurrent = planTier === tier;
                    const isUpgrade = PLAN_RANK[tier] > PLAN_RANK[planTier];
                    const isPending = saving && pendingPlanTier === tier;

                    return (
                      <View
                        key={tier}
                        style={[styles.planCard, isCurrent && styles.planCardCurrent]}
                      >
                        <View style={styles.planTopRow}>
                          <View style={styles.planNameRow}>
                            <Text style={styles.planName}>{cfg.label}</Text>
                            {isCurrent && (
                              <View style={styles.planCurrentTag}>
                                <Text style={styles.planCurrentTagText}>Current</Text>
                              </View>
                            )}
                          </View>

                          <Text style={styles.planPrice}>{cfg.priceLabel}</Text>
                        </View>

                        <View style={styles.planFeatures}>
                          {cfg.features.map((f) => (
                            <View key={f} style={styles.planFeatureRow}>
                              <Ionicons name="checkmark" size={16} color="#111827" />
                              <Text style={styles.planFeatureText}>{f}</Text>
                            </View>
                          ))}
                        </View>

                        <View style={styles.planActionRow}>
                          {isCurrent ? (
                            <View style={styles.planPillMuted}>
                              <Text style={styles.planPillMutedText}>Current plan</Text>
                            </View>
                          ) : isUpgrade ? (
                            <TouchableOpacity
                              style={[
                                styles.planButton,
                                styles.planButtonPrimary,
                                saving && { opacity: 0.75 },
                              ]}
                              onPress={() => startSubscription(tier)}
                              activeOpacity={0.85}
                              disabled={saving}
                            >
                              {isPending ? (
                                <ActivityIndicator size="small" color="#ffffff" />
                              ) : (
                                <Text style={styles.planButtonPrimaryText}>Get Pro</Text>
                              )}
                            </TouchableOpacity>
                          ) : (
                            <View style={styles.planPillMuted}>
                              <Text style={styles.planPillMutedText}>Lower tier</Text>
                            </View>
                          )}
                        </View>
                      </View>
                    );
                  })}
                </ScrollView>

                <Text style={styles.planFinePrint}>
                  After checkout, come back here and tap Refresh to update your plan.
                </Text>

                <View style={styles.planFooter}>
                  <TouchableOpacity
                    style={[styles.planButton, styles.planButtonSecondary, { marginLeft: 0 }]}
                    onPress={closeModal}
                    activeOpacity={0.85}
                    disabled={saving}
                  >
                    <Text style={styles.planButtonSecondaryText}>Close</Text>
                  </TouchableOpacity>

                  <TouchableOpacity
                    style={[
                      styles.planButton,
                      styles.planButtonSecondary,
                      saving && { opacity: 0.55 },
                    ]}
                    onPress={refreshAccount}
                    activeOpacity={0.85}
                    disabled={saving}
                  >
                    <Text style={styles.planButtonSecondaryText}>Refresh</Text>
                  </TouchableOpacity>
                </View>
              </Pressable>
            </KeyboardAvoidingView>
          </Pressable>
        </Modal>
      );
    }

    if (activeModal === 'delete') {
      return (
        <Modal
          visible
          transparent
          animationType="fade"
          onRequestClose={() => {
            if (!saving) closeModal();
          }}
        >
          <Pressable
            style={styles.modalBackdrop}
            onPress={() => {
              if (!saving) closeModal();
            }}
          >
            <KeyboardAvoidingView
              behavior={Platform.OS === 'ios' ? 'padding' : undefined}
              style={styles.modalCenter}
            >
              <Pressable style={styles.modalCard} onPress={() => {}}>
                <View style={styles.modalHeader}>
                  <Text style={styles.modalTitle}>Delete account</Text>
                  <TouchableOpacity
                    onPress={closeModal}
                    activeOpacity={0.85}
                    style={styles.modalClose}
                    accessibilityRole="button"
                    accessibilityLabel="Close"
                    disabled={saving}
                  >
                    <Ionicons name="close" size={20} color="#6b7280" />
                  </TouchableOpacity>
                </View>

                <Text style={styles.modalWarningText}>
                  This will permanently delete your account and remove your server data. This can’t be undone.
                </Text>

                <View style={styles.modalButtons}>
                  <TouchableOpacity
                    style={[styles.modalButton, styles.modalButtonSecondary]}
                    onPress={closeModal}
                    activeOpacity={0.85}
                    disabled={saving}
                  >
                    <Text style={styles.modalButtonSecondaryText}>Cancel</Text>
                  </TouchableOpacity>

                  <TouchableOpacity
                    style={[
                      styles.modalButton,
                      styles.modalButtonDanger,
                      saving && { opacity: 0.55 },
                    ]}
                    onPress={deleteAccount}
                    activeOpacity={0.85}
                    disabled={saving}
                  >
                    {saving ? (
                      <ActivityIndicator size="small" color="#ffffff" />
                    ) : (
                      <Text style={styles.modalButtonDangerText}>Delete</Text>
                    )}
                  </TouchableOpacity>
                </View>
              </Pressable>
            </KeyboardAvoidingView>
          </Pressable>
        </Modal>
      );
    }

    const isName = activeModal === 'name';
    const isEmail = activeModal === 'email';
    const isPassword = activeModal === 'password';

    const title = isName ? 'Account name' : isEmail ? 'Update email' : 'Update password';
    const primaryLabel = isName ? 'Save' : isEmail ? 'Update' : 'Update';

    const disablePrimary =
      saving ||
      (isName && !draftName.trim()) ||
      (isEmail && (!draftEmail.trim() || !emailPassword)) ||
      (isPassword && (!currentPassword || !newPassword || newPassword !== confirmNewPassword));

    const onSave = isName ? saveAccountName : isEmail ? saveEmail : savePassword;

    return (
      <Modal
        visible
        transparent
        animationType="fade"
        onRequestClose={() => {
          if (!saving) closeModal();
        }}
      >
        <Pressable
          style={styles.modalBackdrop}
          onPress={() => {
            if (!saving) closeModal();
          }}
        >
          <KeyboardAvoidingView
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
            style={styles.modalCenter}
          >
            <Pressable style={styles.modalCard} onPress={() => {}}>
              <View style={styles.modalHeader}>
                <Text style={styles.modalTitle}>{title}</Text>
                <TouchableOpacity
                  onPress={closeModal}
                  activeOpacity={0.85}
                  style={styles.modalClose}
                  accessibilityRole="button"
                  accessibilityLabel="Close"
                  disabled={saving}
                >
                  <Ionicons name="close" size={20} color="#6b7280" />
                </TouchableOpacity>
              </View>

              {isName && (
                <View style={styles.modalBody}>
                  <Text style={styles.modalLabel}>Name</Text>
                  <TextInput
                    value={draftName}
                    onChangeText={setDraftName}
                    placeholder="e.g. Taylor"
                    placeholderTextColor="#9ca3af"
                    style={styles.modalInput}
                    autoCapitalize="words"
                    autoCorrect={false}
                    returnKeyType="done"
                    onSubmitEditing={saveAccountName}
                  />
                </View>
              )}

              {isEmail && (
                <View style={styles.modalBody}>
                  <Text style={styles.modalLabel}>New email</Text>
                  <TextInput
                    value={draftEmail}
                    onChangeText={setDraftEmail}
                    placeholder="you@example.com"
                    placeholderTextColor="#9ca3af"
                    style={styles.modalInput}
                    keyboardType="email-address"
                    autoCapitalize="none"
                    autoCorrect={false}
                    returnKeyType="next"
                  />

                  <Text style={[styles.modalLabel, { marginTop: 14 }]}>Password</Text>
                  <TextInput
                    value={emailPassword}
                    onChangeText={setEmailPassword}
                    placeholder="Password"
                    placeholderTextColor="#9ca3af"
                    style={styles.modalInput}
                    secureTextEntry
                    returnKeyType="done"
                    onSubmitEditing={saveEmail}
                  />

                  <Text style={styles.modalHelp}>We'll ask for your password to confirm this change.</Text>
                </View>
              )}

              {isPassword && (
                <View style={styles.modalBody}>
                  <Text style={styles.modalLabel}>Current password</Text>
                  <TextInput
                    value={currentPassword}
                    onChangeText={setCurrentPassword}
                    placeholder="Current password"
                    placeholderTextColor="#9ca3af"
                    style={styles.modalInput}
                    secureTextEntry
                    returnKeyType="next"
                  />

                  <Text style={[styles.modalLabel, { marginTop: 14 }]}>New password</Text>
                  <TextInput
                    value={newPassword}
                    onChangeText={setNewPassword}
                    placeholder="New password"
                    placeholderTextColor="#9ca3af"
                    style={styles.modalInput}
                    secureTextEntry
                    returnKeyType="next"
                  />

                  <Text style={[styles.modalLabel, { marginTop: 14 }]}>Confirm new password</Text>
                  <TextInput
                    value={confirmNewPassword}
                    onChangeText={setConfirmNewPassword}
                    placeholder="Confirm new password"
                    placeholderTextColor="#9ca3af"
                    style={styles.modalInput}
                    secureTextEntry
                    returnKeyType="done"
                    onSubmitEditing={savePassword}
                  />
                </View>
              )}

              <View style={styles.modalButtons}>
                <TouchableOpacity
                  style={[styles.modalButton, styles.modalButtonSecondary]}
                  onPress={closeModal}
                  activeOpacity={0.85}
                  disabled={saving}
                >
                  <Text style={styles.modalButtonSecondaryText}>Cancel</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={[
                    styles.modalButton,
                    styles.modalButtonPrimary,
                    disablePrimary && { opacity: 0.55 },
                  ]}
                  onPress={onSave}
                  activeOpacity={0.85}
                  disabled={disablePrimary}
                >
                  {saving ? (
                    <ActivityIndicator size="small" color="#ffffff" />
                  ) : (
                    <Text style={styles.modalButtonPrimaryText}>{primaryLabel}</Text>
                  )}
                </TouchableOpacity>
              </View>
            </Pressable>
          </KeyboardAvoidingView>
        </Pressable>
      </Modal>
    );
  };

  const nameValue = accountName.trim().length > 0 ? accountName.trim() : 'Not set';
  const emailValue = tokenTrimmed ? (emailTrimmed || 'Loading…') : 'Not set';
  const planValue = tokenTrimmed ? PLAN_CONFIG[planTier].label : 'Not set';
  const planActionLabel = planTier === 'pro' ? 'Manage' : 'Upgrade';

  const limits = PLAN_LIMITS[planTier];

  const usagePercentValue = formatPercent(uploadsUsedThisMonth, limits.uploads);

  const catalogPercentValue = formatPercent(clientsUsedThisMonth, limits.clients);

  const kitPercentValue = formatPercent(kitItemCount, limits.items);


  return (
    <SafeAreaView
      style={[styles.safeArea, { paddingTop: stableTopInset }]}
      edges={['left', 'right']}
    >
      <View style={[styles.container, { paddingBottom: bottomPadding }]}>
        {/* Top bar */}
        <View style={styles.topBar}>
          <View style={styles.searchBar}>
            <Ionicons name="search-outline" size={16} color="#9ca3af" style={styles.searchIcon} />
            <TextInput
              value={settingsQuery}
              onChangeText={setSettingsQuery}
              placeholder="Search settings..."
              placeholderTextColor="#9ca3af"
              style={styles.searchInput}
              returnKeyType="search"
              autoCapitalize="none"
              autoCorrect={false}
              clearButtonMode="while-editing"
              accessibilityLabel="Search settings"
            />
            {settingsQuery.trim().length > 0 && (
              <TouchableOpacity
                onPress={() => setSettingsQuery('')}
                style={styles.clearButton}
                accessibilityRole="button"
                accessibilityLabel="Clear search"
                activeOpacity={0.8}
              >
                <Ionicons name="close-circle" size={18} color="#9ca3af" />
              </TouchableOpacity>
            )}
          </View>

          <TouchableOpacity
            style={styles.accountChip}
            onPress={() => {
              Keyboard.dismiss();
              navigation.navigate('Upload');
            }}
            activeOpacity={0.85}
            accessibilityRole="button"
            accessibilityLabel="Upload"
          >
            <Text style={styles.accountChipText}>Upload</Text>
          </TouchableOpacity>
        </View>

        {/* Middle area */}
        <View style={styles.content}>
          <ScrollView
            style={styles.scroll}
            contentContainerStyle={styles.scrollContent}
            keyboardShouldPersistTaps="always"
            showsVerticalScrollIndicator={false}
          >
            <View style={styles.listContent}>
              {!anyRowsVisible && isFiltering ? (
                <View style={styles.noResults}>
                  <Text style={styles.noResultsText}>No settings match your search.</Text>
                </View>
              ) : (
                <>
                  {/* Profile */}
                  {profileRowsVisible && (
                    <View style={styles.group}>
                      {showAccountName && (
                        <TouchableOpacity
                          style={styles.row}
                          activeOpacity={0.85}
                          onPress={openNameModal}
                          accessibilityRole="button"
                          accessibilityLabel="Update account name"
                        >
                          <Text style={styles.rowLabel}>Account name</Text>
                          <View style={styles.rowRightWrap}>
                            <Text
                              style={[
                                styles.rowRightValue,
                                nameValue === 'Not set' && styles.rowRightValueMuted,
                              ]}
                              numberOfLines={1}
                            >
                              {nameValue}
                            </Text>
                            <Ionicons name="chevron-forward" size={16} color="#9ca3af" />
                          </View>
                        </TouchableOpacity>
                      )}

                      {showEmailRow && (
                        <TouchableOpacity
                          style={styles.row}
                          activeOpacity={0.85}
                          onPress={openEmailModal}
                          accessibilityRole="button"
                          accessibilityLabel="Update email"
                        >
                          <Text style={styles.rowLabel}>Email</Text>
                          <View style={styles.rowRightWrap}>
                            <Text
                              style={[
                                styles.rowRightValue,
                                emailValue === 'Not set' && styles.rowRightValueMuted,
                              ]}
                              numberOfLines={1}
                            >
                              {emailValue}
                            </Text>
                            <Ionicons name="chevron-forward" size={16} color="#9ca3af" />
                          </View>
                        </TouchableOpacity>
                      )}

                      {showPassword && (
                        <TouchableOpacity
                          style={styles.row}
                          activeOpacity={0.85}
                          onPress={openPasswordModal}
                          accessibilityRole="button"
                          accessibilityLabel="Update password"
                        >
                          <Text style={styles.rowLabel}>Password</Text>
                          <View style={styles.rowRightWrap}>
                            <Text style={styles.rowRightValueMuted}>Change</Text>
                            <Ionicons name="chevron-forward" size={16} color="#9ca3af" />
                          </View>
                        </TouchableOpacity>
                      )}
                    </View>
                  )}

                  {/* Divider between profile section and plan/billing */}
                  {profileRowsVisible && planRowsVisible ? <View style={styles.sectionDivider} /> : null}

                  {/* Plan & billing */}
                  {planRowsVisible && (
                    <View style={styles.group}>
                      {showPlan && (
                        <View style={styles.row}>
                          <Text style={styles.rowLabel}>Plan</Text>
                          <View style={styles.rowRight}>
                            <Text style={styles.rowValue}>{planValue}</Text>
                            {tokenTrimmed ? (
                              <TouchableOpacity
                                style={styles.chip}
                                onPress={openPlanModal}
                                activeOpacity={0.85}
                              >
                                <Text style={styles.chipText}>{planActionLabel}</Text>
                              </TouchableOpacity>
                            ) : null}
                          </View>
                        </View>
                      )}

                      {showBilling && (
                        <View style={styles.row}>
                          <Text style={styles.rowLabel}>Billing</Text>
                          <TouchableOpacity
                            activeOpacity={0.8}
                            onPress={() => console.log('Update billing')}
                          >
                            <Text style={styles.rowRightAction}>Update</Text>
                          </TouchableOpacity>
                        </View>
                      )}
                    </View>
                  )}

                  {/* Divider between plan/billing and catalog/kit */}
                  {planRowsVisible && catalogRowsVisible ? <View style={styles.sectionDivider} /> : null}

                  {/* Catalog & kit */}
                  {catalogRowsVisible && (
                    <View style={styles.group}>
                      {showUploadUsage && (
                        <View style={styles.row}>
                          <Text style={styles.rowLabel}>Uploads</Text>
                          <Text style={styles.rowValue}>{usagePercentValue}</Text>
                        </View>
                      )}

                      {showCatalog && (
                        <TouchableOpacity
                          style={styles.row}
                          activeOpacity={0.8}
                          onPress={() => navigation.navigate('Catalog')}
                          accessibilityRole="button"
                        >
                          <Text style={styles.rowLabel}>Catalog</Text>
                          <Text style={styles.rowValue}>{catalogPercentValue}</Text>
                        </TouchableOpacity>
                      )}

                      {showYourKit && (
                        <TouchableOpacity
                          style={styles.row}
                          activeOpacity={0.8}
                          onPress={() => navigation.navigate('KitLog')}
                          accessibilityRole="button"
                        >
                          <Text style={styles.rowLabel}>Your kit</Text>
                          <Text style={styles.rowValue}>{kitPercentValue}</Text>
                        </TouchableOpacity>
                      )}
                    </View>
                  )}

                  {/* Divider between catalog/kit and communication/support */}
                  {catalogRowsVisible && commRowsVisible ? <View style={styles.sectionDivider} /> : null}

                  {/* Communication: email updates + support */}
                  {commRowsVisible && (
                    <View style={styles.group}>
                      {showEmailUpdates && (
                        <View style={styles.row}>
                          <View style={styles.rowTextBlock}>
                            <Text style={styles.rowLabel}>Email updates</Text>
                          </View>

                          <TouchableOpacity
                            style={[styles.toggleOuter, emailUpdatesEnabled && styles.toggleOuterOn]}
                            onPress={() => setEmailUpdatesEnabled((prev) => !prev)}
                            activeOpacity={0.8}
                          >
                            <View style={[styles.toggleThumb, emailUpdatesEnabled && styles.toggleThumbOn]} />
                          </TouchableOpacity>
                        </View>
                      )}

                      {showUserAgreement && (
                        <TouchableOpacity
                          style={styles.row}
                          activeOpacity={0.8}
                          onPress={() => console.log('User agreement pressed')}
                        >
                          <Text style={styles.rowLabel}>User agreement</Text>
                          <Ionicons name="chevron-forward" size={16} color="#9ca3af" />
                        </TouchableOpacity>
                      )}

                      {showSupport && (
                        <TouchableOpacity
                          style={styles.row}
                          activeOpacity={0.8}
                          onPress={() => console.log('Support pressed')}
                        >
                          <Text style={styles.rowLabel}>Support</Text>
                          <Ionicons name="chevron-forward" size={16} color="#9ca3af" />
                        </TouchableOpacity>
                      )}
                    </View>
                  )}

                  {/* Divider under email/support */}
                  {commRowsVisible && actionRowsVisible ? <View style={styles.sectionDivider} /> : null}

                  {/* Account actions */}
                  {actionRowsVisible && (
                    <View style={styles.group}>
                      {showDeleteAccount && (
                        <TouchableOpacity
                          style={styles.row}
                          onPress={handleDeleteAccountPress}
                          activeOpacity={0.85}
                        >
                          <View style={styles.logoutRowLeft}>
                            <Ionicons name="trash-outline" size={18} color="#b91c1c" />
                            <Text style={styles.deleteRowText}>Delete account</Text>
                          </View>
                        </TouchableOpacity>
                      )}

                      {showLogout && (
                        <TouchableOpacity style={styles.row} onPress={handleLogoutPress} activeOpacity={0.85}>
                          <View style={styles.logoutRowLeft}>
                            <Ionicons name="log-out-outline" size={18} color="#4b5563" />
                            <Text style={styles.logoutRowText}>Log out</Text>
                          </View>
                        </TouchableOpacity>
                      )}
                    </View>
                  )}
                </>
              )}
            </View>
          </ScrollView>
        </View>

        {renderModal()}
      </View>
    </SafeAreaView>
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
    paddingBottom: 0,
  },

  // Top bar
  topBar: {
    marginTop: 8,
    marginBottom: 10,
    flexDirection: 'row',
    alignItems: 'center',
  },
  searchBar: {
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
  searchIcon: {
    marginRight: 10,
  },
  searchInput: {
    flex: 1,
    fontSize: 13,
    color: '#111827',
    paddingVertical: 8,
  },
  clearButton: {
    paddingLeft: 8,
    paddingVertical: 6,
  },

  accountChip: {
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
  accountChipText: {
    color: '#111827',
    fontSize: 13,
    fontWeight: '600',
  },

  // Middle account content
  content: {
    flex: 1,
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    paddingBottom: 20,
  },

  listContent: {
    paddingHorizontal: 8,
    paddingTop: 22, // replaces the removed header block spacing
  },

  group: {
    marginBottom: 0,
  },

  noResults: {
    paddingVertical: 18,
    alignItems: 'center',
  },
  noResultsText: {
    fontSize: 13,
    color: '#6b7280',
  },

  // section dividers between major areas (22px gaps)
  sectionDivider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: '#e5e7eb',
    marginTop: 22,
    marginBottom: 22,
  },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 14,
  },
  rowTextBlock: {
    flex: 1,
    paddingRight: 12,
  },
  rowLabel: {
    fontSize: 13,
    color: '#111827',
  },
  rowValue: {
    fontSize: 13,
    color: '#111827',
  },
  rowSecondaryRight: {
    fontSize: 12,
    color: '#6b7280',
    marginTop: 2,
  },
  rowRight: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  rowRightAction: {
    fontSize: 12,
    color: '#111827',
    fontWeight: '500',
  },

  rowRightWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    maxWidth: '65%',
  },
  rowRightValue: {
    fontSize: 13,
    color: '#111827',
    marginRight: 6,
    maxWidth: '92%',
  },
  rowRightValueMuted: {
    fontSize: 13,
    color: '#6b7280',
    marginRight: 6,
  },

  chip: {
    marginLeft: 10,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#111827',
  },
  chipText: {
    fontSize: 11,
    color: '#111827',
    fontWeight: '500',
  },

  toggleOuter: {
    width: 38,
    height: 22,
    borderRadius: 11,
    borderWidth: 1,
    borderColor: '#d1d5db',
    backgroundColor: '#f9fafb',
    padding: 2,
    justifyContent: 'center',
  },
  toggleOuterOn: {
    borderColor: '#111827',
    backgroundColor: '#111827',
  },
  toggleThumb: {
    width: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: '#ffffff',
    alignSelf: 'flex-start',
  },
  toggleThumbOn: {
    alignSelf: 'flex-end',
  },
  logoutRowLeft: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  logoutRowText: {
    marginLeft: 8,
    fontSize: 13,
    color: '#4b5563',
    fontWeight: '500',
  },

  deleteRowText: {
    marginLeft: 8,
    fontSize: 13,
    color: '#b91c1c',
    fontWeight: '500',
  },

  // Modal
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  modalCenter: {
    flex: 1,
    padding: 20,
    justifyContent: 'center',
  },
  modalCard: {
    backgroundColor: '#ffffff',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    padding: 16,
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  modalTitle: {
    fontSize: 15,
    fontWeight: '600',
    color: '#111827',
  },
  modalClose: {
    padding: 6,
    borderRadius: 999,
  },
  modalBody: {
    paddingBottom: 6,
  },
  modalLabel: {
    fontSize: 12,
    color: '#6b7280',
    marginBottom: 8,
  },
  modalInput: {
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 13,
    color: '#111827',
    backgroundColor: '#ffffff',
  },
  modalHelp: {
    marginTop: 10,
    fontSize: 12,
    color: '#6b7280',
  },
  modalWarningText: {
    fontSize: 12,
    color: '#6b7280',
    lineHeight: 16,
  },
  modalButtons: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    marginTop: 16,
  },
  modalButton: {
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
    minWidth: 94,
    alignItems: 'center',
  },
  modalButtonSecondary: {
    borderWidth: 1,
    borderColor: '#e5e7eb',
    backgroundColor: '#ffffff',
    marginRight: 10,
  },
  modalButtonSecondaryText: {
    fontSize: 13,
    color: '#111827',
    fontWeight: '600',
  },
  modalButtonPrimary: {
    backgroundColor: '#111827',
  },
  modalButtonPrimaryText: {
    fontSize: 13,
    color: '#ffffff',
    fontWeight: '600',
  },
  modalButtonDanger: {
    backgroundColor: '#b91c1c',
  },
  modalButtonDangerText: {
    fontSize: 13,
    color: '#ffffff',
    fontWeight: '600',
  },


  // Plan modal
  planIntro: {
    fontSize: 12,
    color: '#6b7280',
    marginBottom: 12,
    lineHeight: 16,
  },
  planScroll: {
    maxHeight: 420,
  },
  planScrollContent: {
    paddingBottom: 6,
  },
  planCard: {
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 16,
    padding: 14,
    marginBottom: 12,
    backgroundColor: '#ffffff',
  },
  planCardCurrent: {
    borderColor: '#111827',
    backgroundColor: '#f9fafb',
  },
  planTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 10,
  },
  planNameRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  planName: {
    fontSize: 14,
    fontWeight: '600',
    color: '#111827',
  },
  planCurrentTag: {
    marginLeft: 8,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
    backgroundColor: '#111827',
  },
  planCurrentTagText: {
    fontSize: 11,
    color: '#ffffff',
    fontWeight: '600',
  },
  planPrice: {
    fontSize: 13,
    color: '#111827',
    fontWeight: '600',
  },
  planFeatures: {
    marginBottom: 12,
  },
  planFeatureRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 8,
  },
  planFeatureText: {
    marginLeft: 8,
    fontSize: 12,
    color: '#4b5563',
    flex: 1,
  },
  planActionRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
  },
  planPillMuted: {
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    backgroundColor: '#ffffff',
  },
  planPillMutedText: {
    fontSize: 12,
    color: '#6b7280',
    fontWeight: '600',
  },
  planFinePrint: {
    marginTop: 2,
    fontSize: 12,
    color: '#6b7280',
    lineHeight: 16,
  },
  planFooter: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    marginTop: 14,
  },
  planButton: {
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
    minWidth: 104,
    alignItems: 'center',
  },
  planButtonPrimary: {
    backgroundColor: '#111827',
  },
  planButtonPrimaryText: {
    fontSize: 13,
    color: '#ffffff',
    fontWeight: '600',
  },
  planButtonSecondary: {
    borderWidth: 1,
    borderColor: '#e5e7eb',
    backgroundColor: '#ffffff',
    marginLeft: 10,
  },
  planButtonSecondaryText: {
    fontSize: 13,
    color: '#111827',
    fontWeight: '600',
  },
});

export default Account;
