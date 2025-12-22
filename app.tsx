import React, { useState } from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { StatusBar, SafeAreaView } from 'react-native';
import Login from './src/screens/login';
import Upload from './src/screens/upload';
import Account from './src/screens/account';
import Catalog from './src/screens/catalog';
import KitLog from './src/screens/kitlog';

export type RootStackParamList = {
  Login: undefined;
  Upload: undefined;
  Account: undefined;
  Catalog: undefined;
  KitLog: undefined;
};

const Stack = createNativeStackNavigator<RootStackParamList>();

// Cast Navigator to any so we can safely use the render-prop pattern
const StackNavigator = Stack.Navigator as React.ComponentType<any>;

export default function App() {
  const [userEmail, setUserEmail] = useState<string | null>(null);

  const handleAuthSuccess = (email: string) => {
    setUserEmail(email);
  };

  const handleLogout = () => {
    setUserEmail(null);
  };

  const handleEmailUpdated = (nextEmail: string) => {
    setUserEmail(nextEmail);
  };

  return (
    <NavigationContainer>
      <StatusBar barStyle="dark-content" />
      <SafeAreaView style={{ flex: 1, backgroundColor: '#ffffff' }}>
        <StackNavigator
          screenOptions={{
            headerShown: false,
            animation: 'none',
            contentStyle: { backgroundColor: '#ffffff' },
          }}
        >
          <Stack.Screen name="Login">
            {(props: any) => (
              <Login
                {...props}
                onAuthSuccess={handleAuthSuccess}
              />
            )}
          </Stack.Screen>

          <Stack.Screen name="Upload">
            {(props: any) => (
              <Upload
                {...props}
                email={userEmail}
              />
            )}
          </Stack.Screen>

          <Stack.Screen name="Account">
            {(props: any) => (
              <Account
                {...props}
                email={userEmail}
                onEmailUpdated={handleEmailUpdated}
                onLogout={handleLogout}
              />
            )}
          </Stack.Screen>

          <Stack.Screen name="Catalog">
            {(props: any) => (
              <Catalog
                {...props}
                email={userEmail}
              />
            )}
          </Stack.Screen>

          <Stack.Screen name="KitLog">
            {(props: any) => (
              <KitLog
                {...props}
                email={userEmail}
              />
            )}
          </Stack.Screen>
        </StackNavigator>
      </SafeAreaView>
    </NavigationContainer>
  );
}
