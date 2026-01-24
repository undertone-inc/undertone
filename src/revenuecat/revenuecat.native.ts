import { Platform } from 'react-native';
import Purchases, { LOG_LEVEL, PURCHASES_ERROR_CODE } from 'react-native-purchases';
import RevenueCatUI, { PAYWALL_RESULT } from 'react-native-purchases-ui';

// IMPORTANT:
// - ENTITLEMENT_ID must match the *entitlement identifier* configured in RevenueCat.
// - This is NOT the product ID. Products are monthly/yearly, entitlement is undertone_pro.
export const ENTITLEMENT_ID = 'undertone_pro';

function getApiKey(): string {
  const ios = process.env.EXPO_PUBLIC_RC_IOS_KEY;
  const android = process.env.EXPO_PUBLIC_RC_ANDROID_KEY;

  if (Platform.OS === 'ios' && ios) return ios;
  if (Platform.OS === 'android' && android) return android;

  // Fallback for local testing. Prefer platform-specific keys when available.
  return ios || android || 'test_mOZPRCLAoyTEMVWEtCTbCMrWPGh';
}

export function hasProEntitlement(customerInfo: any): boolean {
  return !!customerInfo?.entitlements?.active?.[ENTITLEMENT_ID];
}

export function isPurchaseCancelledError(err: any): boolean {
  return !!err?.userCancelled || err?.code === PURCHASES_ERROR_CODE.PURCHASE_CANCELLED_ERROR;
}

export function getReadablePurchaseError(err: any): string {
  if (!err) return 'Unknown error.';
  if (isPurchaseCancelledError(err)) return 'Purchase cancelled.';
  return String(err?.message || err?.localizedMessage || err);
}

export async function configureRevenueCat(): Promise<void> {
  const apiKey = getApiKey();

  // When debugging, set the log level BEFORE configure.
  if (__DEV__) {
    try {
      await Purchases.setLogLevel(LOG_LEVEL.DEBUG);
    } catch {
      // ignore
    }
  }

  Purchases.configure({ apiKey });
}

export async function identifyUser(appUserID: string): Promise<any | null> {
  const { customerInfo } = await Purchases.logIn(String(appUserID));
  return customerInfo ?? null;
}

export async function logoutUser(): Promise<void> {
  await Purchases.logOut();
}

export async function getCustomerInfoSafe(): Promise<any | null> {
  try {
    return await Purchases.getCustomerInfo();
  } catch {
    return null;
  }
}

export async function getOfferingsSafe(): Promise<any | null> {
  try {
    return await Purchases.getOfferings();
  } catch {
    return null;
  }
}

function pickPackageFromOffering(offering: any, cycle: 'monthly' | 'yearly'): any | null {
  if (!offering) return null;

  // Prefer convenience accessors when available.
  if (cycle === 'monthly' && offering?.monthly) return offering.monthly;
  if (cycle === 'yearly' && (offering?.annual || offering?.yearly)) return offering.annual || offering.yearly;

  const pkgs: any[] = Array.isArray(offering?.availablePackages) ? offering.availablePackages : [];

  const byProductId = (id: string) =>
    pkgs.find((p) => String(p?.product?.identifier || '').trim() === id) || null;

  // Your configured product identifiers.
  if (cycle === 'monthly') {
    return (
      byProductId('monthly') ||
      pkgs.find((p) => String(p?.identifier || '').toLowerCase() === '$rc_monthly') ||
      pkgs.find((p) => String(p?.packageType || '').toLowerCase().includes('month')) ||
      null
    );
  }

  return (
    byProductId('yearly') ||
    pkgs.find((p) => String(p?.identifier || '').toLowerCase() === '$rc_annual') ||
    pkgs.find((p) => String(p?.packageType || '').toLowerCase().includes('annual')) ||
    pkgs.find((p) => String(p?.packageType || '').toLowerCase().includes('year')) ||
    null
  );
}

export async function purchaseCycle(cycle: 'monthly' | 'yearly'): Promise<{
  ok: boolean;
  cancelled?: boolean;
  customerInfo?: any;
  message?: string;
}> {
  try {
    const offerings = await Purchases.getOfferings();
    const offering = offerings?.current;

    if (!offering) {
      return { ok: false, message: 'No current offering found. Check RevenueCat offering configuration.' };
    }

    const pkg = pickPackageFromOffering(offering, cycle);
    if (!pkg) return { ok: false, message: `No ${cycle} package found in current offering.` };

    const { customerInfo } = await Purchases.purchasePackage(pkg);
    return { ok: true, customerInfo };
  } catch (err: any) {
    if (isPurchaseCancelledError(err)) return { ok: false, cancelled: true, message: 'Purchase cancelled.' };
    return { ok: false, message: getReadablePurchaseError(err) };
  }
}

export async function restorePurchases(): Promise<{ ok: boolean; customerInfo?: any; message?: string }> {
  try {
    const customerInfo = await Purchases.restorePurchases();
    return { ok: true, customerInfo };
  } catch (err: any) {
    return { ok: false, message: getReadablePurchaseError(err) };
  }
}

export async function presentPaywall(offering?: any): Promise<boolean> {
  const result: PAYWALL_RESULT = offering
    ? await RevenueCatUI.presentPaywall({ offering })
    : await RevenueCatUI.presentPaywall();

  return result === PAYWALL_RESULT.PURCHASED || result === PAYWALL_RESULT.RESTORED;
}

export async function presentPaywallIfNeeded(offering?: any): Promise<PAYWALL_RESULT> {
  const params: any = { requiredEntitlementIdentifier: ENTITLEMENT_ID };
  if (offering) params.offering = offering;
  return await RevenueCatUI.presentPaywallIfNeeded(params);
}

export async function presentCustomerCenter(): Promise<void> {
  await RevenueCatUI.presentCustomerCenter();
}
