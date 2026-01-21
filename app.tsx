import React, { useEffect, useState } from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { StatusBar, View, Text, StyleSheet } from 'react-native';
import Constants from 'expo-constants';
import Ionicons from '@expo/vector-icons/Ionicons';
import Svg, { Line, Rect, Path } from 'react-native-svg';

import { SafeAreaProvider, initialWindowMetrics } from 'react-native-safe-area-context';

import { clearToken, getToken } from './src/auth';
import { migrateLegacySecureStoreIfNeeded } from './src/localstore';
import { PlanTier, normalizePlanTier } from './src/api';
import Login from './src/screens/login';
import Upload from './src/screens/upload';
import Account from './src/screens/account';
import List from './src/screens/list';
import Inventory from './src/screens/inventory';
import CameraScreen from './src/screens/camera';

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


async function fetchMe(token: string) {
  const res = await fetch(`${API_BASE}/me`, {
    method: 'GET',
    headers: { authorization: `Bearer ${token}` },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data?.ok === false) {
    const msg = data?.error || data?.message || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return data;
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
          tabBarLabel: 'scan',
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="scan-outline" size={size ?? 24} color={color} />
          ),
        }}
      >
        {(props: any) => <Upload {...props} email={userEmail} userId={userId} token={token} />}
      </Tabs.Screen>

      <Tabs.Screen
        name="Clients"
        options={{
          tabBarLabel: 'your list',
          tabBarIcon: ({ color, size }) => (
            <FolderCleanOutlineIcon size={size ?? 24} color={color} />
          ),
        }}
      >
        {(props: any) => <List {...props} email={userEmail} userId={userId} planTier={planTier} />}
      </Tabs.Screen>

      <Tabs.Screen
        name="YourKit"
        options={{
          tabBarLabel: 'your kit',
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="briefcase-outline" size={size ?? 24} color={color} />
          ),
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
export default function App() {
  const [booting, setBooting] = useState(true);
  const [authToken, setAuthToken] = useState<string | null>(null);
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [planTier, setPlanTier] = useState<PlanTier>('free');

  useEffect(() => {
    let alive = true;

    const boot = async () => {
      try {
        const token = await getToken();
        if (!alive) return;

        if (token) {
          try {
            const data = await fetchMe(token);
            const email = String(data?.user?.email || '').trim();
            const id = String(data?.user?.id || '').trim();
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

            // One-time migration: move large blobs out of SecureStore.
            // Scope by stable user id so email changes don't split local data.
            if (id) {
              try {
                await migrateLegacySecureStoreIfNeeded(id);
              } catch {
                // ignore
              }
            }
            setAuthToken(token);
          } catch {
            // Token invalid/expired.
            try {
              await clearToken();
            } catch {}
            setAuthToken(null);
            setUserEmail(null);
            setUserId(null);
            setPlanTier('free');
          }
        }
      } finally {
        if (alive) setBooting(false);
      }
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
  };

  return (
    <SafeAreaProvider initialMetrics={initialWindowMetrics} style={{ flex: 1 }}>
      <StatusBar barStyle="dark-content" />

      <View style={{ flex: 1, backgroundColor: '#ffffff' }}>
        {booting ? (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
            <Text style={{ color: '#111111' }}>Loading…</Text>
          </View>
        ) : (
          <NavigationContainer key={authToken ? 'app' : 'auth'}>
            <View style={{ flex: 1, backgroundColor: '#ffffff' }}>
              {authToken ? (
                <AppStackNavigator screenOptions={{ headerShown: false }}>
                  <AppStack.Screen name="Tabs">
                    {() => (
                      <AppTabsShell
                        userEmail={userEmail}
                        userId={userId}
                        token={authToken as string}
                        planTier={planTier}
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
