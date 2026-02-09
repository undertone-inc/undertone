import React, { useEffect, useState } from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { StatusBar, View, StyleSheet } from 'react-native';
import Constants from 'expo-constants';
import Ionicons from '@expo/vector-icons/Ionicons';
import Svg, { Line, Rect, Path } from 'react-native-svg';

import { SafeAreaProvider, initialWindowMetrics } from 'react-native-safe-area-context';

import { clearToken, getAuthProfile, saveAuthProfile, getToken } from './src/auth';
import { migrateLegacySecureStoreIfNeeded } from './src/localstore';
import { PlanTier, normalizePlanTier } from './src/api';
import Login from './src/screens/login';
import Upload from './src/screens/upload';
import Account from './src/screens/account';
import List from './src/screens/list';
import Inventory from './src/screens/inventory';
import CameraScreen from './src/screens/camera';
import { RevenueCatProvider, useRevenueCat } from './src/revenuecat/revenuecatprovider';

export type AuthStackParamList = {
  Login: undefined;
};

export type AppTabParamList = {
  Upload: undefined;
  Clients: undefined;
  YourKit: undefined;
  Account: undefined;
};

export type AppStackParamList = {
  Tabs: undefined;
  Camera: undefined;
};

const AuthStack = createNativeStackNavigator<AuthStackParamList>();
const Tabs = createBottomTabNavigator<AppTabParamList>();
const AppStack = createNativeStackNavigator<AppStackParamList>();

// Cast Navigator to any so we can safely use the render-prop pattern
const AuthStackNavigator = AuthStack.Navigator as React.ComponentType<any>;
const TabNavigator = Tabs.Navigator as React.ComponentType<any>;
const AppStackNavigator = AppStack.Navigator as React.ComponentType<any>;

function TabBarBackground() {
  return (
    <View style={styles.tabBarBackground} pointerEvents="none">
      <View style={styles.tabBarDivider} />
    </View>
  );
}

function IdCardOutlineIcon({
  size = 24,
  color = '#111111',
}: {
  size?: number;
  color?: string;
}) {

  const strokeWidth = 1.5;
  const markerStrokeWidth = 1.5;


  const markerX1 = 6.1;
  const markerX2 = 7.6;
  const lineX1 = 11.4;
  const lineX2 = 18.2;
  const lineY1 = 9.8;
  const lineY2 = 14.2;

  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Rect
        x={0.7}
        y={3.8}
        width={22.6}
        height={16.4}
        rx={3.0}
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinejoin="round"
      />

      {/* Minimal ID lines (equal length) with short left-side markers */}
      <Line
        x1={markerX1}
        y1={lineY1}
        x2={markerX2}
        y2={lineY1}
        stroke={color}
        strokeWidth={markerStrokeWidth}
        strokeLinecap="round"
      />
      <Line
        x1={lineX1}
        y1={lineY1}
        x2={lineX2}
        y2={lineY1}
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
      />

      <Line
        x1={markerX1}
        y1={lineY2}
        x2={markerX2}
        y2={lineY2}
        stroke={color}
        strokeWidth={markerStrokeWidth}
        strokeLinecap="round"
      />
      <Line
        x1={lineX1}
        y1={lineY2}
        x2={lineX2}
        y2={lineY2}
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
      />
    </Svg>
  );
}

function FolderCleanOutlineIcon({
  size = 24,
  color = '#111111',
}: {
  size?: number;
  color?: string;
}) {
  // Cleaner folder outline (no interior seam line).
  // Keep stroke width close to Ionicons' outline feel.
  const strokeWidth = 1.6;

  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M3.6 7.8h6.0l1.7-2.1h9.3c1.1 0 2.0.9 2.0 2.0v10.8c0 1.1-.9 2.0-2.0 2.0H3.6c-1.1 0-2.0-.9-2.0-2.0V9.8c0-1.1.9-2.0 2.0-2.0Z"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </Svg>
  );
}

// Read API base from app.json -> expo.extra.EXPO_PUBLIC_API_BASE
// IMPORTANT: Strip trailing slashes so we never generate URLs like "//me".
const RAW_API_BASE =
  (Constants as any).expoConfig?.extra?.EXPO_PUBLIC_API_BASE ??
  process.env.EXPO_PUBLIC_API_BASE ??
  'http://localhost:3000';
const API_BASE = String(RAW_API_BASE || '').replace(/\/+$/, '');


class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

async function fetchMe(token: string, timeoutMs = 12000) {
  // On mobile, fetch has no default timeout and can hang indefinitely if the API host
  // is unreachable. Use an abort timeout so the app never gets stuck on startup.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, timeoutMs));

  try {
    const res = await fetch(`${API_BASE}/me`, {
      method: 'GET',
      headers: { authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data?.ok === false) {
      const msg = data?.error || data?.message || `HTTP ${res.status}`;
      throw new HttpError(res.status, String(msg));
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}


type AppTabsProps = {
  userEmail: string | null;
  userId: string | null;
  token: string;
  planTier: PlanTier;
  onEmailUpdated: (nextEmail: string) => void;
  onPlanTierChanged: (nextTier: PlanTier) => void;
  onLogout: () => void;
};

function AppTabsShell({
  userEmail,
  userId,
  token,
  planTier,
  onEmailUpdated,
  onPlanTierChanged,
  onLogout,
}: AppTabsProps) {
  return (
    <TabNavigator
      lazy={false}
      screenOptions={{
        headerShown: false,
        tabBarShowLabel: true,
        // Keep the nav bar fixed; let the keyboard cover it instead of hiding/moving it.
        tabBarHideOnKeyboard: false,
        tabBarActiveTintColor: '#111111',
        tabBarInactiveTintColor: '#9ca3af',
        tabBarBackground: () => <TabBarBackground />,
        tabBarItemStyle: {
          paddingTop: 6,
          paddingBottom: 6,
        },
        tabBarLabelStyle: {
          fontSize: 11,
          fontWeight: '400',
          textTransform: 'lowercase',
          lineHeight: 14,
        },
        tabBarStyle: {
          backgroundColor: '#ffffff',
          borderTopWidth: 0,
          elevation: 0,
          shadowColor: 'transparent',
          shadowOpacity: 0,
          shadowRadius: 0,
          shadowOffset: { width: 0, height: 0 },
          overflow: 'visible',
        },
      }}
    >
      <Tabs.Screen
        name="Upload"
        options={{
          tabBarLabel: 'home',
          tabBarIcon: ({ color, size }) => {
            const iconSize = Math.max(18, (size ?? 24) - 2);
            return <Ionicons name="scan-outline" size={iconSize} color={color} />;
          },
        }}
      >
        {(props: any) => (
          <Upload
            {...props}
            email={userEmail}
            userId={userId}
            token={token}
            onLogout={onLogout}
          />
        )}
      </Tabs.Screen>

      <Tabs.Screen
        name="Clients"
        options={{
          tabBarLabel: 'your list',
          tabBarIcon: ({ color, size }) => {
            const iconSize = Math.max(18, (size ?? 24) - 1);
            return <FolderCleanOutlineIcon size={iconSize} color={color} />;
          },
        }}
      >
        {(props: any) => <List {...props} email={userEmail} userId={userId} planTier={planTier} />}
      </Tabs.Screen>

      <Tabs.Screen
        name="YourKit"
        options={{
          tabBarLabel: 'your kit',
          tabBarIcon: ({ color, size }) => {
            const iconSize = Math.max(18, (size ?? 24) - 1);
            return <Ionicons name="briefcase-outline" size={iconSize} color={color} />;
          },
        }}
      >
        {(props: any) => <Inventory {...props} email={userEmail} userId={userId} planTier={planTier} />}
      </Tabs.Screen>

      <Tabs.Screen
        name="Account"
        options={{
          tabBarLabel: 'account',
          tabBarIcon: ({ color, size }) => (
            <IdCardOutlineIcon size={size ?? 24} color={color} />
          ),
        }}
      >
        {(props: any) => (
          <Account
            {...props}
            email={userEmail}
            userId={userId}
            token={token}
            initialPlanTier={planTier}
            onEmailUpdated={onEmailUpdated}
            onPlanTierChanged={onPlanTierChanged}
            onLogout={onLogout}
          />
        )}
      </Tabs.Screen>
    </TabNavigator>
  );
}

function RevenueCatPlanBridge({
  serverPlanTier,
  children,
}: {
  serverPlanTier: PlanTier;
  children: (effectivePlanTier: PlanTier) => React.ReactNode;
}) {
  const { isPro } = useRevenueCat();
  const effectivePlanTier: PlanTier = isPro || serverPlanTier === 'pro' ? 'pro' : 'free';
  return <>{children(effectivePlanTier)}</>;
}

export default function App() {
  const [booting, setBooting] = useState(true);
  const [authToken, setAuthToken] = useState<string | null>(null);
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [planTier, setPlanTier] = useState<PlanTier>('free');

  useEffect(() => {
    let alive = true;

    const boot = async () => {
      // Never block the UI on network calls during boot.
      // 1) Restore token (fast) -> show app/login immediately.
      // 2) Fetch /me in the background with a hard timeout.
      let token: string | null = null;
      try {
        token = await getToken();
      } catch {
        token = null;
      }

      // Restore cached profile (so Account screen never shows "Loading…" when the API is unreachable).
      let cachedProfile: any = null;
      try {
        cachedProfile = await getAuthProfile();
      } catch {
        cachedProfile = null;
      }

      if (!alive) return;

      if (token) {
        // Optimistically render the authed app immediately.
        setAuthToken(token);

        // Apply cached profile immediately (best-effort).
        try {
          const cachedEmail = String(cachedProfile?.email || '').trim();
          const cachedId = String(cachedProfile?.userId || '').trim();
          const cachedTier = normalizePlanTier(cachedProfile?.planTier);
          if (cachedEmail) setUserEmail(cachedEmail);
          if (cachedId) setUserId(cachedId);
          if (cachedTier) setPlanTier(cachedTier);
          if (cachedId) migrateLegacySecureStoreIfNeeded(cachedId).catch(() => {});
        } catch {
          // ignore
        }

        // Fetch canonical user + plan tier (background; do not block startup).
        (async () => {
          try {
            const data = await fetchMe(token as string, 12000);
            if (!alive) return;

            const email = String(data?.user?.email || '').trim();
            const id = String(data?.user?.id || '').trim();
            const accountName = String(data?.user?.accountName || '').trim();
            const tier = normalizePlanTier(
              data?.user?.planTier ??
                data?.user?.plan ??
                data?.user?.tier ??
                data?.user?.subscriptionPlan ??
                data?.user?.subscription?.plan
            );

            if (email) setUserEmail(email);
            if (id) setUserId(id);
            setPlanTier(tier);

            // Keep cached profile in sync for offline / unreachable API scenarios.
            saveAuthProfile({
              email: email || null,
              userId: id || null,
              accountName: accountName || null,
              planTier: tier || null,
            }).catch(() => {});

            // One-time migration: move large blobs out of SecureStore.
            // Best-effort; do not block rendering.
            if (id) migrateLegacySecureStoreIfNeeded(id).catch(() => {});
          } catch (err: any) {
            if (!alive) return;

            // If the token is invalid/expired, log out.
            const status = typeof err?.status === 'number' ? err.status : 0;
            const msg = String(err?.message || '');
            const looksUnauthorized = status === 401 || status === 403 || /unauthor/i.test(msg);

            if (looksUnauthorized) {
              try {
                await clearToken();
              } catch {}
              setAuthToken(null);
              setUserEmail(null);
              setUserId(null);
              setPlanTier('free');
            } else {
              // Network/API unreachable: keep the token so the app can still open.
              // (Fetches elsewhere can show their own error states.)
              console.warn('Boot: /me unavailable', err);
            }
          }
        })();
      } else {
        // No token means no authenticated session; ensure cached profile is cleared.
        clearToken().catch(() => {});
        setAuthToken(null);
        setUserEmail(null);
        setUserId(null);
        setPlanTier('free');
      }

      if (alive) setBooting(false);
    };

    boot();
    return () => {
      alive = false;
    };
  }, []);

  const handleAuthSuccess = (token: string, email: string, id?: string | number) => {
    setAuthToken(token);
    setUserEmail(email);
    const idStr = String(id ?? '').trim();
    setUserId(idStr || null);
    setPlanTier('free');

    if (idStr) migrateLegacySecureStoreIfNeeded(idStr).catch(() => {});

    // Fetch canonical user + plan tier (login/signup may not include all fields).
    (async () => {
      try {
        const data = await fetchMe(token);
        const nextEmail = String(data?.user?.email || '').trim();
        const nextId = String(data?.user?.id || '').trim();
        const accountName = String(data?.user?.accountName || '').trim();
        const tier = normalizePlanTier(
          data?.user?.planTier ??
            data?.user?.plan ??
            data?.user?.tier ??
            data?.user?.subscriptionPlan ??
            data?.user?.subscription?.plan
        );

        if (nextEmail) setUserEmail(nextEmail);
        if (nextId) setUserId(nextId);
        setPlanTier(tier);

        // Keep cached profile in sync.
        saveAuthProfile({
          email: nextEmail || email || null,
          userId: nextId || idStr || null,
          accountName: accountName || null,
          planTier: tier || null,
        }).catch(() => {});

        if (nextId) migrateLegacySecureStoreIfNeeded(nextId).catch(() => {});
      } catch {
        // ignore
      }
    })();
  };

  const handleLogout = () => {
    setAuthToken(null);
    setUserEmail(null);
    setUserId(null);
    setPlanTier('free');
    clearToken().catch(() => {
      // ignore
    });
  };

  const handleEmailUpdated = (nextEmail: string) => {
    setUserEmail(nextEmail);
    saveAuthProfile({ email: nextEmail || null }).catch(() => {});
  };

  return (
    <SafeAreaProvider initialMetrics={initialWindowMetrics} style={{ flex: 1 }}>
      <StatusBar barStyle="dark-content" />

      <View style={{ flex: 1, backgroundColor: '#ffffff' }}>
        {booting ? (
          // Keep this blank so users never see a "Loading..." screen.
          // Startup should feel instant (native splash handles the initial load).
          <View style={{ flex: 1, backgroundColor: '#ffffff' }} />
        ) : (
          <NavigationContainer key={authToken ? 'app' : 'auth'}>
            <View style={{ flex: 1, backgroundColor: '#ffffff' }}>
              {authToken ? (
                <RevenueCatProvider appUserID={userId ? String(userId) : null}>
                  <RevenueCatPlanBridge serverPlanTier={planTier}>
                    {(effectivePlanTier) => (
                      <AppStackNavigator screenOptions={{ headerShown: false }}>
                        <AppStack.Screen name="Tabs">
                          {() => (
                            <AppTabsShell
                              userEmail={userEmail}
                              userId={userId}
                              token={authToken as string}
                              planTier={effectivePlanTier}
                              onEmailUpdated={handleEmailUpdated}
                              onPlanTierChanged={(nextTier) => setPlanTier(nextTier)}
                              onLogout={handleLogout}
                            />
                          )}
                        </AppStack.Screen>

                        <AppStack.Screen
                          name="Camera"
                          component={CameraScreen}
                          options={{
                            headerShown: false,
                            presentation: 'fullScreenModal',
                            animation: 'slide_from_bottom',
                          }}
                        />
                      </AppStackNavigator>
                    )}
                  </RevenueCatPlanBridge>
                </RevenueCatProvider>
              ) : (
                <AuthStackNavigator
                  screenOptions={{
                    headerShown: false,
                    animation: 'none',
                    contentStyle: { backgroundColor: '#ffffff' },
                  }}
                >
                  <AuthStack.Screen name="Login">
                    {(props: any) => <Login {...props} onAuthSuccess={handleAuthSuccess} />}
                  </AuthStack.Screen>
                </AuthStackNavigator>
              )}
            </View>
          </NavigationContainer>
        )}
      </View>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  tabBarBackground: {
    flex: 1,
    backgroundColor: '#ffffff',
  },
  tabBarDivider: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: 1,
    backgroundColor: '#eef2f7',
    // Nudge divider slightly upward above the tab bar.
    top: -2,
  },
});
