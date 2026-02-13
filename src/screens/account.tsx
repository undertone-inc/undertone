import React, { useState, useEffect, useRef } from 'react';
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
import { openInAppBrowser } from '../in-app-browser';
import { getAuthProfile, saveAuthProfile } from '../auth';
import { DOC_KEYS, getString, makeScopedKey } from '../localstore';
import { copyToClipboard } from '../invites';
import Constants from 'expo-constants';
import { PlanTier, PLAN_CONFIG, PLAN_LIMITS, PLAN_RANK, normalizePlanTier } from '../api';
import { useRevenueCat } from '../revenuecat/revenuecatprovider';

import { SafeAreaView, initialWindowMetrics, useSafeAreaInsets } from 'react-native-safe-area-context';

const INVENTORY_STORAGE_KEY = DOC_KEYS.inventory;


function formatPercent(used: number, limit: number): string {
  const safeUsed = Number.isFinite(used) && used > 0 ? used : 0;

  // Unlimited limits (Infinity) don't have a meaningful percent.
  if (limit === Infinity) return 'Unlimited';

  const safeLimit = Number.isFinite(limit) && limit > 0 ? limit : 0;
  if (safeLimit <= 0) return '0%';

  const pct = Math.round((safeUsed / safeLimit) * 100);
  return `${Math.max(0, pct)}%`;
}

// normalizePlanTier is imported from ../api

// Read API base from app.json -> expo.extra.EXPO_PUBLIC_API_BASE
// IMPORTANT: Strip trailing slashes so we never generate URLs like "//billing/sync".
const RAW_API_BASE =
  (Constants as any).expoConfig?.extra?.EXPO_PUBLIC_API_BASE ??
  process.env.EXPO_PUBLIC_API_BASE ??
  'http://localhost:3000';
const API_BASE = String(RAW_API_BASE || '').replace(/\/+$/, '');

const TERMS_URL = 'https://undertoneapp.io/undertone-legal/terms/index.html';
const PRIVACY_URL = 'https://undertoneapp.io/undertone-legal/privacy/index.html';

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
  initialPlanTier?: PlanTier;
  onEmailUpdated?: (nextEmail: string) => void;
  onPlanTierChanged?: (nextTier: PlanTier) => void;
  onLogout?: () => void;
};

// How the bar sits when keyboard is CLOSED
// (Adds a little more breathing room above the bottom nav divider)
const CLOSED_BOTTOM_PADDING = 28;

// Extra space ABOVE the keyboard when it is OPEN
const KEYBOARD_GAP = 0;

type ModalKind =
  | null
  | 'name'
  | 'email'
  | 'password'
  | 'plan'
  | 'delete'
  | 'updates'
  | 'support'
  | 'refer';

type BillingCycle = 'monthly' | 'yearly';

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

const Account: React.FC<AccountScreenProps> = ({
  navigation,
  route,
  email,
  userId,
  token,
  initialPlanTier,
  onEmailUpdated,
  onPlanTierChanged,
  onLogout,
}) => {
  // Scope local data per user (stable id preferred; fall back to email).
  const scope = userId ?? (email ? String(email).trim().toLowerCase() : null);
  const inventoryKey = makeScopedKey(INVENTORY_STORAGE_KEY, scope);
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
  const [listsUsedThisMonth, setListsUsedThisMonth] = useState(0);
  const [kitCategoryCount, setKitCategoryCount] = useState(0);
  const [kitItemCount, setKitItemCount] = useState(0);
  const [settingsQuery, setSettingsQuery] = useState('');

  const [accountName, setAccountName] = useState('');

  const [planTier, setPlanTier] = useState<PlanTier>(initialPlanTier ?? 'free');
  const [pendingPlanTier, setPendingPlanTier] = useState<PlanTier | null>(null);

  const [billingCycle, setBillingCycle] = useState<BillingCycle>('monthly');

  const {
    ready: rcReady,
    initError: rcInitError,
    isPro: rcIsPro,
    buyMonthly,
    buyYearly,
    restore,
    showPaywall,
    openCustomerCenter,
  } = useRevenueCat();

  const effectivePlanTier: PlanTier = rcIsPro || planTier === 'pro' ? 'pro' : 'free';

  // Keep local plan state in sync with app-level plan state.
  useEffect(() => {
    if (!initialPlanTier) return;
    if (initialPlanTier !== planTier) setPlanTier(initialPlanTier);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialPlanTier]);

  const [activeModal, setActiveModal] = useState<ModalKind>(null);
  const [saving, setSaving] = useState(false);

  // modal fields
  const [draftName, setDraftName] = useState('');

  const [draftEmail, setDraftEmail] = useState('');
  const [emailPassword, setEmailPassword] = useState('');

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmNewPassword, setConfirmNewPassword] = useState('');

  const [supportMessage, setSupportMessage] = useState('');
  const [inviteLink, setInviteLink] = useState('');
  const [inviteLinkStatus, setInviteLinkStatus] = useState<'copied' | 'failed' | null>(null);
  const inviteLinkStatusTimer = useRef<ReturnType<typeof setTimeout> | null>(null);


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

  // Prevent setState on unmounted component when showing short-lived invite feedback.
  useEffect(() => {
    return () => {
      if (inviteLinkStatusTimer.current) {
        clearTimeout(inviteLinkStatusTimer.current);
        inviteLinkStatusTimer.current = null;
      }
    };
  }, []);

  // Hydrate cached profile immediately so the screen looks "logged in" even when /me is unreachable.
  useEffect(() => {
    let alive = true;

    const hydrate = async () => {
      if (!tokenTrimmed) return;
      try {
        const cached = await getAuthProfile();
        if (!alive) return;

        // Name is managed locally in this screen, so pull a cached value if present.
        if (!accountName.trim() && cached?.accountName) {
          setAccountName(String(cached.accountName).trim());
        }

        // If the parent hasn't hydrated email yet, push cached email up.
        if (!emailTrimmed && cached?.email && onEmailUpdated) {
          onEmailUpdated(String(cached.email).trim());
        }
      } catch {
        // ignore
      }
    };

    hydrate();

    return () => {
      alive = false;
    };
    // Intentionally not depending on accountName/email to avoid repeated SecureStore reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tokenTrimmed]);

  const refreshAccount = async () => {
    if (!tokenTrimmed) return;

    try {
      const data = await getJson(`/me`, tokenTrimmed);
      const nextEmail = String(data?.user?.email || '').trim();
      if (nextEmail && onEmailUpdated) onEmailUpdated(nextEmail);
      const nextId = String(data?.user?.id || data?.user?.userId || '').trim();
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
      if (onPlanTierChanged) onPlanTierChanged(nextTier);

      // Cache the profile so the Account screen is usable even when the API is unreachable.
      saveAuthProfile({
        email: nextEmail || null,
        userId: nextId || null,
        accountName: nextName || null,
        planTier: nextTier || null,
      }).catch(() => {});

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

      const nextLists = Number(
        usage?.listsThisMonth ??
          usage?.lists_this_month ??
          usage?.listsMonth ??
          usage?.lists_month ??
          usage?.lists_used ??
          usage?.listsUsed ??
          usage?.lists ??
          usage?.listCount ??
          usage?.listsCount ??
          usage?.list_count ??
          0
      );
      if (Number.isFinite(nextLists)) setListsUsedThisMonth(nextLists);

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
        const raw = await getString(inventoryKey);
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
  }, [navigation, tokenTrimmed, inventoryKey]);

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
  const showRestorePurchases = matchesQuery('Restore', 'Restore purchases', 'Restore purchase', 'Purchases');

  const showUpdates = matchesQuery('Updates', 'Update', 'Location', 'Locations');
  const showReferUser = matchesQuery(
    'Refer user',
    'Refer a friend',
    'Refer friend',
    'Referral',
    'Invite',
    'Invites',
    'Refer',
    'Affiliate center',
    'Affiliate',
    'Affiliates',
    'Your list',
    'List'
  );

  const showEmailUpdates = matchesQuery('Email updates');
  const showPrivacyPolicy = matchesQuery('Privacy Policy', 'Privacy policy', 'User agreement');
  const showSupport = matchesQuery('Support');

  const showDeleteAccount = matchesQuery('Delete account');
  const showLogout = matchesQuery('Log out', 'Logout');

  const profileRowsVisible = showAccountName || showEmailRow || showPassword;
  const planRowsVisible = showPlan || showBilling || showRestorePurchases;
  const catalogRowsVisible = showUpdates || showReferUser || showSupport;
  const commRowsVisible = showEmailUpdates || showPrivacyPolicy;
  const actionRowsVisible = showDeleteAccount || showLogout;

  const anyRowsVisible =
    profileRowsVisible || planRowsVisible || catalogRowsVisible || commRowsVisible || actionRowsVisible;

  const requireAuthOrAlert = () => {
    if (tokenTrimmed) return true;
    Alert.alert('Not logged in', 'Please log in to manage your account settings.');
    return false;
  };

  const closeModal = () => {
    if (inviteLinkStatusTimer.current) {
      clearTimeout(inviteLinkStatusTimer.current);
      inviteLinkStatusTimer.current = null;
    }
    setInviteLinkStatus(null);
    setActiveModal(null);
    setPendingPlanTier(null);
    setBillingCycle('monthly');
    setDraftName('');
    setDraftEmail('');
    setEmailPassword('');
    setCurrentPassword('');
    setNewPassword('');
    setConfirmNewPassword('');
    setSupportMessage('');
    setInviteLink('');
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

  const openUpdatesModal = () => {
    Keyboard.dismiss();
    setActiveModal('updates');
  };

  const openReferModal = () => {
    if (!requireAuthOrAlert()) return;
    Keyboard.dismiss();
    if (inviteLinkStatusTimer.current) {
      clearTimeout(inviteLinkStatusTimer.current);
      inviteLinkStatusTimer.current = null;
    }
    setInviteLinkStatus(null);
    setInviteLink('');
    setActiveModal('refer');
  };

  const openSupportModal = () => {
    if (!requireAuthOrAlert()) return;
    Keyboard.dismiss();
    setSupportMessage('');
    setActiveModal('support');
  };


  const openPlanModal = () => {
    if (!requireAuthOrAlert()) return;
    Keyboard.dismiss();
    setActiveModal('plan');
  };

  // If another screen navigates here with { openUpgrade: true }, auto-open the upgrade modal.
  useEffect(() => {
    const open = Boolean(route?.params?.openUpgrade);
    if (!open) return;

    try {
      navigation.setParams({ openUpgrade: undefined });
    } catch {
      // ignore
    }

    openPlanModal();
  }, [route?.params?.openUpgrade]);

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
      saveAuthProfile({ accountName: name }).catch(() => {});
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
      saveAuthProfile({ email: updated }).catch(() => {});

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

  const submitSupport = async () => {
    if (!requireAuthOrAlert()) return;

    const message = supportMessage.trim();
    if (!message) {
      Alert.alert('Support', 'Please describe the issue.');
      return;
    }

    try {
      setSaving(true);

      await postJson(
        '/support',
        {
          message,
          meta: {
            email: emailTrimmed || null,
            userId: userId ?? null,
            accountName: accountName || null,
            platform: Platform.OS,
            appVersion:
              (Constants as any)?.expoConfig?.version ??
              (Constants as any)?.manifest?.version ??
              null,
          },
        },
        tokenTrimmed
      );

      closeModal();
      Alert.alert('Submitted', 'Thanks — your message has been sent.');
    } catch (e: any) {
      const msg = String(e?.message || e);
      if (/404|not found/i.test(msg)) {
        Alert.alert('Support', 'Support submission is not configured yet.');
      } else {
        Alert.alert('Could not submit', msg);
      }
    } finally {
      setSaving(false);
    }
  };

  const generateInviteLink = async () => {
    if (!requireAuthOrAlert()) return;

    try {
      setSaving(true);

      const data = await postJson(
        '/invites/link',
        {
          meta: {
            fromEmail: emailTrimmed || null,
            userId: userId ?? null,
            accountName: accountName || null,
          },
        },
        tokenTrimmed
      );

      const link = String(data?.inviteLink || data?.link || '').trim();
      if (!link) {
        throw new Error('Server did not return an invite link.');
      }

      setInviteLink(link);
      setInviteLinkStatus(null);
    } catch (e: any) {
      const msg = String(e?.message || e);
      if (/404|not found/i.test(msg)) {
        Alert.alert('Refer user', 'Invite links are not configured yet.');
      } else {
        Alert.alert('Could not generate link', msg);
      }
    } finally {
      setSaving(false);
    }
  };

  const copyInviteLink = async () => {
    const link = (inviteLink || '').trim();
    if (!link) return;

    // Copy first, then show inline feedback.
    const ok = await copyToClipboard(link);
    setInviteLinkStatus(ok ? 'copied' : 'failed');

    if (inviteLinkStatusTimer.current) {
      clearTimeout(inviteLinkStatusTimer.current);
      inviteLinkStatusTimer.current = null;
    }

    inviteLinkStatusTimer.current = setTimeout(() => {
      setInviteLinkStatus(null);
      setInviteLink('');
      inviteLinkStatusTimer.current = null;
    }, 1000);
  };

  const syncServerBilling = async () => {
    if (!tokenTrimmed) return;
    try {
      await postJson('/billing/sync', {}, tokenTrimmed);
    } catch {
      // Best-effort only. If this fails, the app can still unlock Pro via RevenueCat,
      // but the server might not enforce the correct scan limits until the next sync.
    }
  };




  const startSubscription = async (targetTier: PlanTier, cycle: BillingCycle) => {
    if (!requireAuthOrAlert()) return;

    if (!rcReady) {
      const msg = rcInitError
        ? `Purchases are unavailable right now.\n\n${rcInitError}`
        : 'Purchases are still initializing. Please try again.';
      Alert.alert('Purchases', msg);
      return;
    }

    try {
      setSaving(true);
      setPendingPlanTier(targetTier);

      // One-tap purchase attempt for the selected billing cycle.
      // On real iOS subscriptions this triggers the Apple purchase sheet.
      const result = cycle === 'yearly' ? await buyYearly() : await buyMonthly();

      // RevenueCat can return a successful transaction even if the entitlement mapping
      // is misconfigured (rare). Only unlock Pro when the entitlement is active.
      const hasPro = result?.ok ? (result?.hasPro ?? true) : false;

      if (result?.ok && hasPro) {
        setPlanTier('pro');
        onPlanTierChanged?.('pro');
        await syncServerBilling();
        closeModal();
        Alert.alert('Success', 'Undertone Pro unlocked.');
        return;
      }

      if (result?.ok && !hasPro) {
        // Transaction succeeded but entitlement didn't activate. Don't unlock Pro.
        closeModal();
        await syncServerBilling();
        Alert.alert(
          'Purchase pending',
          'Your purchase completed, but Undertone Pro is not active yet. Please tap Restore purchases, or try again in a moment.'
        );
        return;
      }

      // If purchase fails/cancels, fall back to the RevenueCat paywall.
      closeModal();
      try {
        const purchasedViaPaywall = await showPaywall();
        if (purchasedViaPaywall) {
          setPlanTier('pro');
          onPlanTierChanged?.('pro');
          await syncServerBilling();
          Alert.alert('Success', 'Undertone Pro unlocked.');
        }
      } catch (paywallErr: any) {
        const fallbackMsg = String(paywallErr?.message || paywallErr);
        const baseMsg = result?.message ? String(result.message) : 'Could not complete purchase.';
        Alert.alert('Upgrade', `${baseMsg}\n\n${fallbackMsg}`);
      }
    } catch (e: any) {
      closeModal();
      try {
        const purchasedViaPaywall = await showPaywall();
        if (purchasedViaPaywall) {
          setPlanTier('pro');
          onPlanTierChanged?.('pro');
          await syncServerBilling();
          Alert.alert('Success', 'Undertone Pro unlocked.');
        }
      } catch {
        Alert.alert('Could not start subscription', String(e?.message || e));
      }
    } finally {
      setSaving(false);
      setPendingPlanTier(null);
    }
  };

  const restorePurchases = async () => {
    if (!requireAuthOrAlert()) return;

    if (!rcReady) {
      const msg = rcInitError
        ? `Purchases are unavailable right now.\n\n${rcInitError}`
        : 'Purchases are still initializing. Please try again.';
      Alert.alert('Restore purchases', msg);
      return;
    }

    try {
      setSaving(true);
      const r = await restore();

      if (!r?.ok) {
        Alert.alert('Restore purchases', String(r?.message || 'Restore failed.'));
        return;
      }

      // Only unlock Pro if the user actually has an active entitlement.
      if (!r?.hasPro) {
        Alert.alert(
          'Restore purchases',
          'No active Undertone Pro subscription was found for this Apple ID.'
        );
        return;
      }

      setPlanTier('pro');
      onPlanTierChanged?.('pro');
      await syncServerBilling();
      Alert.alert('Restore purchases', 'Restore complete.');
    } catch (e: any) {
      Alert.alert('Restore purchases', String(e?.message || e));
    } finally {
      setSaving(false);
      setPendingPlanTier(null);
    }
  };

  const openAppleSubscriptions = async () => {
    // Apple’s subscription management page
    // Prefer itms-apps to open the App Store directly; fall back to https.
    const urls = [
      'itms-apps://apps.apple.com/account/subscriptions',
      'https://apps.apple.com/account/subscriptions',
    ];

    for (const url of urls) {
      try {
        await Linking.openURL(url);
        return;
      } catch {
        // try next
      }
    }

    Alert.alert('Manage subscription', 'Unable to open Apple subscription settings.');
  };

  const openGooglePlaySubscriptions = async () => {
    // Google Play subscription management page
    // (Works for any package; opens the user's subscriptions list.)
    const url = 'https://play.google.com/store/account/subscriptions';
    try {
      await Linking.openURL(url);
    } catch {
      Alert.alert('Manage subscription', 'Unable to open Google Play subscription settings.');
    }
  };

  const openStoreSubscriptions = async () => {
    if (Platform.OS === 'ios') return await openAppleSubscriptions();
    if (Platform.OS === 'android') return await openGooglePlaySubscriptions();
    Alert.alert('Manage subscription', 'Subscription management is not available on this platform.');
  };

  const openCustomerCenterSafe = async () => {
    if (!requireAuthOrAlert()) return;

    // If RevenueCat isn't ready, fall back to Apple subscription settings.
    if (!rcReady) {
      await openStoreSubscriptions();
      return;
    }

    Keyboard.dismiss();

    const startedAt = Date.now();

    try {
      setSaving(true);

      // Customer Center (RevenueCat UI).
      // If it doesn't present (returns immediately), fall back to Apple's page.
      await openCustomerCenter();

      const elapsed = Date.now() - startedAt;
      if (elapsed < 600) {
        await openStoreSubscriptions();
      }
    } catch {
      await openStoreSubscriptions();
    } finally {
      setSaving(false);
    }
  };

  const renderModal = () => {
    // Support/Updates/Refer are rendered as in-screen full-white panels (not overlay modals)
    // so they visually replace the settings list area.
    if (activeModal === 'support' || activeModal === 'updates' || activeModal === 'refer') {
      return null;
    }
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
              <Pressable style={[styles.modalCard, styles.modalCardPlan]} onPress={() => {}}>
<ScrollView
                  style={styles.planScroll}
                  contentContainerStyle={styles.planScrollContent}
                  showsVerticalScrollIndicator={false}
                >
                  {tiers.map((tier) => {
                    const cfg = PLAN_CONFIG[tier];
                    const isCurrent = effectivePlanTier === tier;
                    const isUpgrade = PLAN_RANK[tier] > PLAN_RANK[effectivePlanTier];
                    const isPending = saving && pendingPlanTier === tier;

                    const priceLabel = billingCycle === 'yearly' ? '$200 / yr' : cfg.priceLabel;

                    const features = (() => {
                      if (billingCycle !== 'yearly') return cfg.features;

                      let swappedScans = false;
                      let swappedDiscoveries = false;

                      return cfg.features.map((f) => {
                        const s = String(f);

                        if (!swappedScans && /scan/i.test(s)) {
                          swappedScans = true;
                          return 'Up to 250 scans per year';
                        }

                        if (!swappedDiscoveries && /product\s+discover/i.test(s)) {
                          swappedDiscoveries = true;
                          return 'Up to 120 product discoveries per year';
                        }

                        return f;
                      });
                    })();

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

                          <Text style={styles.planPrice}>{priceLabel}</Text>
                        </View>

                        <View style={styles.planDivider} />

                        <View style={styles.planFeatures}>
                          {features.map((f, idx) => (
                            <View key={`${tier}-${billingCycle}-${idx}`} style={styles.planFeatureRow}>
                              <Ionicons name="checkmark" size={16} color="#111827" />
                              <Text style={styles.planFeatureText}>{f}</Text>
                            </View>
                          ))}
                        </View>

                        <View style={[styles.planActionRow, isUpgrade && styles.planActionRowWithToggle]}>
                          {isCurrent ? (
                            <View style={styles.planPillMuted}>
                              <Text style={styles.planPillMutedText}>Current plan</Text>
                            </View>
                          ) : isUpgrade ? (
                            <>
                              <View style={styles.planBillingToggleGroup}>
                                <View style={styles.planBillingToggleOuter}>
                                  <TouchableOpacity
                                    style={[
                                      styles.planBillingToggleOption,
                                      billingCycle === 'monthly' && styles.planBillingToggleOptionActive,
                                    ]}
                                    onPress={() => setBillingCycle('monthly')}
                                    activeOpacity={0.9}
                                    disabled={saving}
                                    accessibilityRole="button"
                                    accessibilityLabel="Monthly"
                                  >
                                    <Text
                                      style={[
                                        styles.planBillingToggleText,
                                        billingCycle === 'monthly' && styles.planBillingToggleTextActive,
                                      ]}
                                    >
                                      Monthly
                                    </Text>
                                  </TouchableOpacity>

                                  <View style={styles.planBillingToggleYearlyWrap}>
                                    {billingCycle === 'yearly' && (
                                      <Text style={styles.planSavePct}>Save 20%</Text>
                                    )}
                                    <TouchableOpacity
                                      style={[
                                        styles.planBillingToggleOption,
                                        billingCycle === 'yearly' && styles.planBillingToggleOptionActive,
                                      ]}
                                      onPress={() => setBillingCycle('yearly')}
                                      activeOpacity={0.9}
                                      disabled={saving}
                                      accessibilityRole="button"
                                      accessibilityLabel="Yearly"
                                    >
                                      <Text
                                        style={[
                                          styles.planBillingToggleText,
                                          billingCycle === 'yearly' && styles.planBillingToggleTextActive,
                                        ]}
                                      >
                                        Yearly
                                      </Text>
                                    </TouchableOpacity>
                                  </View>
                                </View>
                              </View>

                              <TouchableOpacity
                                style={[
                                  styles.planButton,
                                  styles.planButtonPrimary,
                                  saving && { opacity: 0.75 },
                                ]}
                                onPress={() => startSubscription(tier, billingCycle)}
                                activeOpacity={0.85}
                                disabled={saving}
                              >
                                {isPending ? (
                                  <ActivityIndicator size="small" color="#111827" />
                                ) : (
                                  <Text style={styles.planButtonPrimaryText}>Get Pro</Text>
                                )}
                              </TouchableOpacity>
                            </>

                          ) : (
                            <View style={styles.planPillMuted}>
                              <Text style={styles.planPillMutedText}>Lower tier</Text>
                            </View>
                          )}
                        </View>

                        {isUpgrade && (
                          <>
                            <View style={styles.planActionDivider} />
                            <View style={styles.planFootRow}>
                              <View style={styles.planFootLeft}>
                                <Text style={styles.planCancelAnytime}>
                                  {billingCycle === 'yearly' ? 'Auto-renews yearly' : 'Auto-renews monthly'}
                                </Text>
                                <Text style={styles.planFootSep}> · </Text>
                                <Text style={styles.planCancelAnytime}>Cancel anytime</Text>
                              </View>

                              <View style={styles.planFootRight}>
    <TouchableOpacity
      onPress={() => openInAppBrowser(TERMS_URL)}
      activeOpacity={0.8}
      accessibilityRole="link"
      accessibilityLabel="Terms"
    >
      <Text style={[styles.planCancelAnytime, styles.planFootLink]}>Terms</Text>
    </TouchableOpacity>
    <Text style={styles.planFootSep}> · </Text>
    <TouchableOpacity
      onPress={() => openInAppBrowser(PRIVACY_URL)}
      activeOpacity={0.8}
      accessibilityRole="link"
      accessibilityLabel="Privacy"
    >
      <Text style={[styles.planCancelAnytime, styles.planFootLink]}>Privacy</Text>
    </TouchableOpacity>
  </View>
</View>
                          </>
                        )}
                      </View>
                    );
                  })}
                </ScrollView>
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
  const planValue = tokenTrimmed ? PLAN_CONFIG[effectivePlanTier].label : 'Not set';
  const planActionLabel = effectivePlanTier === 'pro' ? 'Manage' : 'Upgrade';

  const limits = PLAN_LIMITS[effectivePlanTier];

  const usagePercentValue = formatPercent(uploadsUsedThisMonth, limits.uploads);

  const catalogPercentValue = formatPercent(listsUsedThisMonth, limits.lists);

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
        </View>

        {/* Middle area */}
        <View style={styles.content}>
          {activeModal === 'support' ? (
            <KeyboardAvoidingView
              behavior={Platform.OS === 'ios' ? 'padding' : undefined}
              style={styles.supportScreen}
            >
              <View style={styles.supportPanel}>
                <View style={styles.supportPanelHeaderRow}>
                  <TouchableOpacity
                    onPress={() => {
                      if (!saving) closeModal();
                    }}
                    activeOpacity={0.85}
                    style={styles.supportBackButton}
                    accessibilityRole="button"
                    accessibilityLabel="Back"
                    disabled={saving}
                  >
                    <Ionicons name="chevron-back" size={20} color="#111827" />
                  </TouchableOpacity>

                  <Text style={styles.supportPanelTitle}>Support</Text>
                </View>

                <View style={styles.supportPanelBody}>
                  <TextInput
                    value={supportMessage}
                    onChangeText={setSupportMessage}
                    placeholder="Describe the issue"
                    placeholderTextColor="#9ca3af"
                    style={[styles.supportTextArea, styles.supportTextAreaPanel]}
                    multiline
                    textAlignVertical="top"
                    autoCorrect
                  />
                </View>

                <View style={styles.supportPanelFooter}>
                  <TouchableOpacity
                    style={[styles.supportSubmitButton, saving && { opacity: 0.7 }]}
                    onPress={submitSupport}
                    activeOpacity={0.85}
                    disabled={saving}
                  >
                    {saving ? (
                      <ActivityIndicator size="small" color="#111827" />
                    ) : (
                      <Text style={styles.supportSubmitText}>Submit</Text>
                    )}
                  </TouchableOpacity>
                </View>
              </View>
            </KeyboardAvoidingView>
          ) : activeModal === 'updates' ? (
            <View style={styles.supportScreen}>
              <View style={styles.supportPanel}>
                <View style={styles.supportPanelHeaderRow}>
                  <TouchableOpacity
                    onPress={() => {
                      if (!saving) closeModal();
                    }}
                    activeOpacity={0.85}
                    style={styles.supportBackButton}
                    accessibilityRole="button"
                    accessibilityLabel="Back"
                    disabled={saving}
                  >
                    <Ionicons name="chevron-back" size={20} color="#111827" />
                  </TouchableOpacity>

                  <Text style={styles.supportPanelTitle}>Updates</Text>
                </View>

                <Text style={[styles.modalInfoText, styles.updatesEmptyText]}>No updates yet</Text>
              </View>
            </View>
          ) : activeModal === 'refer' ? (
            <KeyboardAvoidingView
              behavior={Platform.OS === 'ios' ? 'padding' : undefined}
              style={styles.supportScreen}
            >
              <View style={styles.supportPanel}>
                <View style={styles.supportPanelHeaderRow}>
                  <TouchableOpacity
                    onPress={() => {
                      if (!saving) closeModal();
                    }}
                    activeOpacity={0.85}
                    style={styles.supportBackButton}
                    accessibilityRole="button"
                    accessibilityLabel="Back"
                    disabled={saving}
                  >
                    <Ionicons name="chevron-back" size={20} color="#111827" />
                  </TouchableOpacity>

                  <Text style={styles.supportPanelTitle}>Refer user</Text>
                </View>

                <View style={styles.referInviteRow}>
                  <Pressable
                    style={styles.referLinkBox}
                    onPress={copyInviteLink}
                    disabled={!inviteLink || saving || !!inviteLinkStatus}
                    accessibilityRole="button"
                    accessibilityLabel="Invite link"
                  >
                    <Text
                      style={[
                        styles.referLinkText,
                        !inviteLink && styles.referLinkPlaceholder,
                      ]}
                      numberOfLines={1}
                    >
                      {inviteLinkStatus === 'copied'
                        ? 'copied'
                        : inviteLinkStatus === 'failed'
                        ? 'copy failed'
                        : inviteLink
                        ? inviteLink
                        : ''}
                    </Text>
                  </Pressable>

                  <TouchableOpacity
                    style={[styles.referSendButton, saving && { opacity: 0.7 }]}
                    onPress={generateInviteLink}
                    activeOpacity={0.85}
                    disabled={saving}
                    accessibilityRole="button"
                    accessibilityLabel="Generate invite link"
                  >
                    {saving ? (
                      <ActivityIndicator size="small" color="#111827" />
                    ) : (
                      <Text style={styles.referSendText}>Link</Text>
                    )}
                  </TouchableOpacity>
                </View>

                <View style={{ height: 10 }} />
              </View>
            </KeyboardAvoidingView>
          ) : (
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
                                onPress={effectivePlanTier === 'pro' ? openCustomerCenterSafe : openPlanModal}
                                activeOpacity={0.85}
                              >
                                <Text style={styles.chipText}>{planActionLabel}</Text>
                              </TouchableOpacity>
                            ) : null}
                          </View>
                        </View>
                      )}

                      {showBilling && (
                        <TouchableOpacity
                          style={styles.row}
                          activeOpacity={0.85}
                          onPress={openCustomerCenterSafe}
                          disabled={saving}
                          accessibilityRole="button"
                          accessibilityLabel="Billing"
                        >
                          <Text style={styles.rowLabel}>Billing</Text>
                          <View style={styles.rowRightWrap}>
                            <Text style={[styles.rowRightAction, saving && { opacity: 0.6 }]}>Update</Text>
                          </View>
                        </TouchableOpacity>
                      )}

                      {showRestorePurchases && (
                        <TouchableOpacity
                          style={styles.row}
                          activeOpacity={0.8}
                          onPress={restorePurchases}
                          disabled={saving}
                          accessibilityRole="button"
                          accessibilityLabel="Restore purchases"
                        >
                          <Text style={styles.rowLabel}>Restore</Text>
                          <Ionicons
                            name="chevron-forward"
                            size={16}
                            color="#9ca3af"
                            style={saving ? { opacity: 0.6 } : undefined}
                          />
                        </TouchableOpacity>
                      )}
                    </View>
                  )}

                  {/* Divider between plan/billing and catalog/kit */}
                  {planRowsVisible && catalogRowsVisible ? <View style={styles.sectionDivider} /> : null}

                  {/* Catalog */}
                  {catalogRowsVisible && (
                    <View style={styles.group}>
                      {showUpdates && (
                        <TouchableOpacity
                          style={styles.row}
                          activeOpacity={0.85}
                          onPress={openUpdatesModal}
                          accessibilityRole="button"
                          accessibilityLabel="Updates"
                        >
                          <Text style={styles.rowLabel}>Updates</Text>
                          <Text style={styles.rowValue}>0</Text>
                        </TouchableOpacity>
                      )}

                      {showReferUser && (
                        <TouchableOpacity
                          style={styles.row}
                          activeOpacity={0.85}
                          onPress={openReferModal}
                          accessibilityRole="button"
                          accessibilityLabel="Refer user"
                        >
                          <Text style={styles.rowLabel}>Refer user</Text>
                          <Text style={styles.rowValue}>0</Text>
                        </TouchableOpacity>
                      )}

                      {showSupport && (
                        <TouchableOpacity
                          style={styles.row}
                          activeOpacity={0.8}
                          onPress={openSupportModal}
                          accessibilityRole="button"
                        >
                          <Text style={styles.rowLabel}>Support</Text>
                          <Ionicons name="chevron-forward" size={16} color="#9ca3af" />
                        </TouchableOpacity>
                      )}
                    </View>
                  )}

                  {/* Divider between catalog/kit and communication/support */}
                  {catalogRowsVisible && commRowsVisible ? <View style={styles.sectionDivider} /> : null}

                  {/* Communication: email updates */}
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

                      {showPrivacyPolicy && (
                        <TouchableOpacity
                          style={styles.row}
                          activeOpacity={0.8}
                          onPress={() => openInAppBrowser(PRIVACY_URL)}
                        >
                          <Text style={styles.rowLabel}>Privacy Policy</Text>
                          <Ionicons name="chevron-forward" size={16} color="#9ca3af" />
                        </TouchableOpacity>
                      )}
                    </View>
                  )}

                  {/* Divider under email settings */}
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
          )}
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
    marginRight: 14,
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
    fontWeight: '500',
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
    borderColor: '#d1d5db',
    backgroundColor: '#e5e7eb',
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
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 18,
  },
  // Slightly less padding for the plan (upgrade) modal so content doesn't feel too inset.
  modalCardPlan: {
    paddingHorizontal: 22,
    paddingTop: 20,
    paddingBottom: 28,
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  modalTitle: {
    fontSize: 15,
    fontWeight: '500',
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
  modalInfoText: {
    marginTop: 18,
    marginBottom: 6,
    fontSize: 13,
    color: '#6b7280',
    textAlign: 'center',
  },
  updatesEmptyText: {
    textAlign: 'left',
    alignSelf: 'stretch',
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
    fontWeight: '500',
  },
  modalButtonPrimary: {
    backgroundColor: '#111827',
  },
  modalButtonPrimaryText: {
    fontSize: 13,
    color: '#ffffff',
    fontWeight: '500',
  },
  modalButtonDanger: {
    backgroundColor: '#b91c1c',
  },
  modalButtonDangerText: {
    fontSize: 13,
    color: '#ffffff',
    fontWeight: '500',
  },

  // Support screen (covers the settings list area)
  supportScreen: {
    flex: 1,
    backgroundColor: '#ffffff',
  },
  supportPanel: {
    flex: 1,
    backgroundColor: '#ffffff',
    paddingHorizontal: 8,
    paddingTop: 22,
    paddingBottom: 14,
  },
  supportPanelHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 14,
  },
  supportBackButton: {
    paddingVertical: 6,
    paddingRight: 10,
  },
    supportPanelTitle: {
    fontSize: 15,
    fontWeight: '500',
    color: '#111827',
    textAlign: 'left',
    marginLeft: 2,
  },

  supportHeaderSpacer: {
    width: 30,
  },
  supportPanelBody: {
    // Keep the submit button visually close to the input.
    // (Avoid pushing the footer to the bottom of the panel.)
    marginBottom: 12,
  },
  supportLabel: {
    fontSize: 12,
    color: '#6b7280',
    marginBottom: 8,
  },
    supportTextArea: {
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 13,
    color: '#111827',
    backgroundColor: '#ffffff',
  },

    supportTextAreaPanel: {
    height: 140,
  },

    supportPanelFooter: {
    paddingTop: 14,
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
  },

    supportSubmitButton: {
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: '#ffffff',
    borderWidth: 1,
    borderColor: '#111827',
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'flex-end',
  },

  supportSubmitText: {
    fontSize: 13,
    color: '#111827',
    fontWeight: '500',
  },


  // Refer a friend
  referInfoButton: {
    paddingVertical: 6,
    paddingHorizontal: 6,
  },
  referInfoText: {
    fontSize: 12,
    color: '#9ca3af',
    fontWeight: '400',
  },


  referInviteRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 6,
    marginBottom: 22,
  },
  referLinkBox: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: '#ffffff',
    minHeight: 42,
    marginRight: 14,
    justifyContent: 'center',
  },
  referLinkText: {
    fontSize: 13,
    color: '#111827',
  },
  referLinkPlaceholder: {
    color: '#9ca3af',
  },
  referSendButton: {
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
    minWidth: 72,
    minHeight: 42,
    backgroundColor: '#ffffff',
    borderWidth: 1,
    borderColor: '#111827',
    alignItems: 'center',
    justifyContent: 'center',
  },
  referSendText: {
    fontSize: 13,
    color: '#111827',
    fontWeight: '500',
  },
  referRewardBlock: {
    marginTop: 14,
  },
  referRewardText: {
    fontSize: 12,
    color: '#6b7280',
    lineHeight: 16,
    marginBottom: 6,
  },


  // Plan modal
  planIntro: {
    fontSize: 12,
    color: '#6b7280',
    marginBottom: 12,
    lineHeight: 16,
  },
  planBillingToggleGroup: {
    marginRight: 29,
    alignItems: 'center',
    position: 'relative',
  },
  planSavePct: {
    position: 'absolute',
    top: -18,
    left: 0,
    right: 0,
    textAlign: 'center',
    fontSize: 11,
    color: '#6b7280',
    fontWeight: '500',
  },
  planBillingToggleOuter: {
    flexDirection: 'row',
    backgroundColor: '#f3f4f6',
    borderRadius: 999,
    overflow: 'visible',
    padding: 3,
  },
  planBillingToggleYearlyWrap: {
    position: 'relative',
  },
    planBillingToggleOption: {
    paddingVertical: 8,
    paddingHorizontal: 18,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
  },
    planBillingToggleOptionActive: {
    backgroundColor: '#ffffff',
  },
    planBillingToggleText: {
    fontSize: 13,
    fontWeight: '500',
    color: '#6b7280',
  },
    planBillingToggleTextActive: {
    color: '#111827',
  },
  planBillingHint: {
    marginTop: 10,
    textAlign: 'center',
    fontSize: 11,
    color: '#6b7280',
    fontWeight: '400',
  },
  planScroll: {
    maxHeight: 520,
  },
  planScrollContent: {
    paddingTop: 0,
    paddingBottom: 0,
    paddingHorizontal: 0,
  },
  planCard: {
    paddingHorizontal: 0,
    paddingVertical: 4,
    marginBottom: 0,
    backgroundColor: 'transparent',
  },
  planCardCurrent: {
    backgroundColor: 'transparent',
    shadowOpacity: 0,
    elevation: 0,
  },
  planTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 0,
  },
  planDivider: {
    height: 1,
    backgroundColor: '#f1f1f1',
    marginTop: 20,
    marginBottom: 28,
  },
  planActionDivider: {
    height: 1,
    backgroundColor: '#f1f1f1',
    marginTop: 32,
    marginBottom: 22,
  },
  planCancelAnytime: {
    fontSize: 11,
    color: '#c2c8d3',
    fontWeight: '400',
  },
  planFootRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    width: '100%',
  },
  planFootLeft: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  planFootRight: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  planFootSep: {
    fontSize: 11,
    color: '#c2c8d3',
    fontWeight: '400',
  },
  planFootLink: {
    textDecorationLine: 'none',
  },

  planNameRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  planName: {
    fontSize: 14,
    fontWeight: '500',
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
    fontWeight: '500',
  },
  planPrice: {
    fontSize: 13,
    color: '#111827',
    fontWeight: '500',
  },
  planFeatures: {
    marginTop: 0,
    marginBottom: 14,
  },
    planFeatureRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 10,
  },
  planFeatureText: {
    marginLeft: 8,
    fontSize: 12,
    color: '#4b5563',
    flex: 1,
  },
  planActionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    marginTop: 12,
  },
  planActionRowWithToggle: {
    alignItems: 'flex-start',
    marginTop: 14,
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
    fontWeight: '500',
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
    borderWidth: 1,
    borderColor: '#111827',
    backgroundColor: '#ffffff',
  },
  planButtonPrimaryText: {
    fontSize: 13,
    color: '#111827',
    fontWeight: '500',
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
    fontWeight: '500',
  },

});

export default Account;
