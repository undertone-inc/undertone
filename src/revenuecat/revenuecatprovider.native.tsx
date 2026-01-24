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
  presentPaywallIfNeeded,
  purchaseCycle,
  restorePurchases,
} from './revenuecat';

export type RevenueCatPurchaseResult = { ok: boolean; cancelled?: boolean; message?: string };

export type RevenueCatContextValue = {
  ready: boolean;
  isPro: boolean;
  customerInfo: any | null;
  offerings: any | null;
  refresh: () => Promise<void>;
  buyMonthly: () => Promise<RevenueCatPurchaseResult>;
  buyYearly: () => Promise<RevenueCatPurchaseResult>;
  restore: () => Promise<RevenueCatPurchaseResult>;
  showPaywall: () => Promise<boolean>;
  showPaywallIfNeeded: () => Promise<any>;
  openCustomerCenter: () => Promise<void>;
};

const Ctx = createContext<RevenueCatContextValue | null>(null);

export function useRevenueCat(): RevenueCatContextValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useRevenueCat must be used inside RevenueCatProvider');
  return v;
}

export function RevenueCatProvider({ appUserID, children }: { appUserID: string | null; children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
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

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        await configureRevenueCat();
      } catch (e) {
        console.warn('[revenuecat] configure failed', e);
      } finally {
        if (!alive) return;
        setReady(true);
        refresh().catch(() => {});
      }
    })();
    return () => { alive = false; };
  }, [refresh]);

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

  useEffect(() => {
    if (!ready) return;

    const listener = (ci: any) => {
      setCustomerInfo(ci);
      setIsPro(hasProEntitlement(ci));
    };

    const P: any = Purchases as any;
    try { P.addCustomerInfoUpdateListener?.(listener); } catch {}
    return () => { try { P.removeCustomerInfoUpdateListener?.(listener); } catch {} };
  }, [ready]);

  const value = useMemo<RevenueCatContextValue>(
    () => ({
      ready,
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
      showPaywallIfNeeded: async () => {
        const offering = offerings?.current ?? undefined;
        return await presentPaywallIfNeeded(offering);
      },
      openCustomerCenter: async () => {
        await presentCustomerCenter();
      },
    }),
    [ready, isPro, customerInfo, offerings, refresh]
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
