import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import Purchases from 'react-native-purchases';

import {
  configureRevenueCat,
  getCustomerInfoSafe,
  getOfferingsSafe,
  hasProEntitlement,
  identifyUser,
  logoutUser,
  presentCustomerCenter,
  presentPaywall,
  purchaseCycle,
  restorePurchases,
} from './revenuecat';

export type RevenueCatPurchaseResult = { ok: boolean; cancelled?: boolean; message?: string };

export type RevenueCatContextValue = {
  /** True when RevenueCat is configured and safe to use. */
  ready: boolean;
  /** Set when RevenueCat failed to initialize (missing key, wrong key, etc.). */
  initError: string | null;

  isPro: boolean;
  customerInfo: any | null;
  offerings: any | null;

  refresh: () => Promise<void>;
  buyMonthly: () => Promise<RevenueCatPurchaseResult>;
  buyYearly: () => Promise<RevenueCatPurchaseResult>;
  restore: () => Promise<RevenueCatPurchaseResult>;
  showPaywall: () => Promise<boolean>;
  openCustomerCenter: () => Promise<void>;
};

const Ctx = createContext<RevenueCatContextValue | null>(null);

export function useRevenueCat(): RevenueCatContextValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useRevenueCat must be used inside RevenueCatProvider');
  return v;
}

export function RevenueCatProvider({
  appUserID,
  children,
}: {
  appUserID: string | null;
  children: React.ReactNode;
}) {
  const [ready, setReady] = useState(false);
  const [initError, setInitError] = useState<string | null>(null);

  const [customerInfo, setCustomerInfo] = useState<any | null>(null);
  const [offerings, setOfferings] = useState<any | null>(null);
  const [isPro, setIsPro] = useState(false);

  const refresh = useCallback(async () => {
    const [ci, off] = await Promise.all([getCustomerInfoSafe(), getOfferingsSafe()]);
    if (ci) {
      setCustomerInfo(ci);
      setIsPro(hasProEntitlement(ci));
    }
    if (off) setOfferings(off);
  }, []);

  // Configure once
  useEffect(() => {
    let alive = true;

    (async () => {
      try {
        await configureRevenueCat();
        if (!alive) return;
        setInitError(null);
        setReady(true);
        refresh().catch(() => {});
      } catch (e: any) {
        console.warn('[revenuecat] configure failed', e);
        if (!alive) return;
        setReady(false);
        setInitError(String(e?.message || e || 'RevenueCat failed to initialize.'));
      }
    })();

    return () => {
      alive = false;
    };
  }, [refresh]);

  // Identify/log out when auth changes
  useEffect(() => {
    if (!ready) return;

    (async () => {
      try {
        if (appUserID) {
          const ci = await identifyUser(String(appUserID));
          if (ci) {
            setCustomerInfo(ci);
            setIsPro(hasProEntitlement(ci));
          }
        } else {
          await logoutUser();
          const ci = await getCustomerInfoSafe();
          setCustomerInfo(ci);
          setIsPro(hasProEntitlement(ci));
        }
      } catch (e) {
        console.warn('[revenuecat] identify/logout failed', e);
      }
    })();
  }, [appUserID, ready]);

  // Listen for entitlement/customerInfo updates (renewals, refunds, restores, etc.)
  useEffect(() => {
    if (!ready) return;

    const listener = (ci: any) => {
      setCustomerInfo(ci);
      setIsPro(hasProEntitlement(ci));
    };

    const P: any = Purchases as any;
    try {
      P.addCustomerInfoUpdateListener?.(listener);
    } catch {
      // ignore
    }

    return () => {
      try {
        P.removeCustomerInfoUpdateListener?.(listener);
      } catch {
        // ignore
      }
    };
  }, [ready]);

  const value = useMemo<RevenueCatContextValue>(
    () => ({
      ready,
      initError,
      isPro,
      customerInfo,
      offerings,
      refresh,
      buyMonthly: async () => {
        const r = await purchaseCycle('monthly');
        if (r.ok && r.customerInfo) {
          setCustomerInfo(r.customerInfo);
          setIsPro(hasProEntitlement(r.customerInfo));
        }
        return { ok: r.ok, cancelled: r.cancelled, message: r.message };
      },
      buyYearly: async () => {
        const r = await purchaseCycle('yearly');
        if (r.ok && r.customerInfo) {
          setCustomerInfo(r.customerInfo);
          setIsPro(hasProEntitlement(r.customerInfo));
        }
        return { ok: r.ok, cancelled: r.cancelled, message: r.message };
      },
      restore: async () => {
        const r = await restorePurchases();
        if (r.ok && r.customerInfo) {
          setCustomerInfo(r.customerInfo);
          setIsPro(hasProEntitlement(r.customerInfo));
        }
        return { ok: r.ok, message: r.message };
      },
      showPaywall: async () => {
        const offering = offerings?.current ?? undefined;
        return await presentPaywall(offering);
      },
      openCustomerCenter: async () => {
        await presentCustomerCenter();
      },
    }),
    [ready, initError, isPro, customerInfo, offerings, refresh]
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
