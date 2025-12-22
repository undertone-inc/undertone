import React, { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Alert,
} from 'react-native';
import Constants from 'expo-constants';

type LoginProps = {
  navigation: any;
  onAuthSuccess?: (email: string) => void;
};

type Mode = 'login' | 'signup' | 'reset';

// Read API base from app.json -> expo.extra.EXPO_PUBLIC_API_BASE
const API_BASE =
  (Constants as any).expoConfig?.extra?.EXPO_PUBLIC_API_BASE ??
  process.env.EXPO_PUBLIC_API_BASE ??
  'http://localhost:3000';

const Login: React.FC<LoginProps> = ({ navigation, onAuthSuccess }) => {
  const [mode, setMode] = useState<Mode>('login');

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const [newPassword, setNewPassword] = useState('');

  const [loading, setLoading] = useState(false);

  const trimmedEmail = email.trim();

  const goToUpload = (authEmail: string) => {
    if (onAuthSuccess) {
      onAuthSuccess(authEmail);
    }

    navigation.reset({
      index: 0,
      routes: [{ name: 'Upload' }],
    });
  };

  const switchToLogin = () => {
    setMode('login');
    setPassword('');
    setNewPassword('');
  };

  const switchToSignup = () => {
    setMode('signup');
    setPassword('');
    setNewPassword('');
  };

  const switchToReset = () => {
    setMode('reset');
    setPassword('');
    setNewPassword('');
  };

  const handleLogin = async () => {
    if (__DEV__ && !trimmedEmail && !password) {
      const fakeEmail = 'test@example.com';
      goToUpload(fakeEmail);
      return;
    }

    if (!trimmedEmail || !password) {
      Alert.alert('Missing info', 'Please enter your email and password.');
      return;
    }

    try {
      setLoading(true);

      const response = await fetch(`${API_BASE}/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: trimmedEmail, password }),
      });

      const data = await response.json().catch(() => ({}));

      if (!response.ok || data?.ok === false) {
        const message =
          data?.error ||
          (response.status === 404
            ? 'User not found.'
            : response.status === 401
            ? 'Incorrect password.'
            : 'Something went wrong while logging in.');
        Alert.alert('Login failed', message);
        return;
      }

      goToUpload(trimmedEmail);
    } catch (error) {
      console.error('Login error:', error);
      Alert.alert(
        'Network error',
        'Could not reach the server. Please check your connection and try again.',
      );
    } finally {
      setLoading(false);
    }
  };

  const handleSignup = async () => {
    if (!trimmedEmail || !password) {
      Alert.alert('Missing info', 'Please enter an email and password.');
      return;
    }

    try {
      setLoading(true);

      const response = await fetch(`${API_BASE}/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: trimmedEmail, password }),
      });

      const data = await response.json().catch(() => ({}));

      if (!response.ok || data?.ok === false) {
        const message =
          data?.error ||
          (response.status === 409
            ? 'That email is already registered.'
            : 'Something went wrong while creating your account.');
        Alert.alert('Sign up failed', message);
        return;
      }

      goToUpload(trimmedEmail);
    } catch (error) {
      console.error('Signup error:', error);
      Alert.alert(
        'Network error',
        'Could not reach the server. Please check your connection and try again.',
      );
    } finally {
      setLoading(false);
    }
  };

  const handleResetPassword = async () => {
    if (!trimmedEmail || !newPassword) {
      Alert.alert('Missing info', 'Please enter your email and new password.');
      return;
    }

    try {
      setLoading(true);

      const response = await fetch(`${API_BASE}/reset-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: trimmedEmail, newPassword }),
      });

      const data = await response.json().catch(() => ({}));

      if (!response.ok || data?.ok === false) {
        const message =
          data?.error ||
          (response.status === 404
            ? 'No user found with that email.'
            : 'Something went wrong while updating your password.');
        Alert.alert('Reset failed', message);
        return;
      }

      Alert.alert('Password updated', 'You can now log in with your new password.');

      // Keep email, clear new password, go back to login mode
      setNewPassword('');
      setMode('login');
    } catch (error) {
      console.error('Reset password error:', error);
      Alert.alert(
        'Network error',
        'Could not reach the server. Please check your connection and try again.',
      );
    } finally {
      setLoading(false);
    }
  };

  const isLogin = mode === 'login';
  const isSignup = mode === 'signup';
  const isReset = mode === 'reset';

  return (
    <View style={styles.container}>
      <View style={styles.inner}>
        <Text style={styles.title}>
          {isLogin ? 'Log in' : isSignup ? 'Sign up' : 'Reset password'}
        </Text>

        {/* Shared email field */}
        <View style={[styles.fieldGroup, { marginBottom: 24 }]}>
          <TextInput
            style={styles.input}
            value={email}
            onChangeText={setEmail}
            placeholder="you@example.com"
            keyboardType="email-address"
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="next"
          />
        </View>

        {isLogin ? (
          <>
            {/* LOGIN MODE */}
            <View style={[styles.fieldGroup, { marginBottom: 16 }]}>
              <TextInput
                style={styles.input}
                value={password}
                onChangeText={setPassword}
                placeholder="Password"
                secureTextEntry
                returnKeyType="done"
                onSubmitEditing={handleLogin}
              />

              <TouchableOpacity
                style={styles.forgotInline}
                onPress={switchToReset}
              >
                <Text style={styles.forgotText}>Forgot your password?</Text>
              </TouchableOpacity>
            </View>

            <TouchableOpacity
              style={[styles.button, loading && { opacity: 0.7 }]}
              onPress={handleLogin}
              disabled={loading}
            >
              <Text style={styles.buttonText}>
                {loading ? 'Logging in…' : 'Continue'}
              </Text>
            </TouchableOpacity>

            <View style={styles.switchRow}>
              <Text style={styles.switchText}>Don't have an account?</Text>
              <TouchableOpacity onPress={switchToSignup}>
                <Text style={styles.switchLink}>Sign up</Text>
              </TouchableOpacity>
            </View>
          </>
        ) : isSignup ? (
          <>
            {/* SIGNUP MODE */}
            <View style={[styles.fieldGroup, { marginBottom: 16 }]}>
              <TextInput
                style={styles.input}
                value={password}
                onChangeText={setPassword}
                placeholder="Create a password"
                secureTextEntry
                returnKeyType="done"
                onSubmitEditing={handleSignup}
              />
            </View>

            <TouchableOpacity
              style={[styles.button, loading && { opacity: 0.7 }]}
              onPress={handleSignup}
              disabled={loading}
            >
              <Text style={styles.buttonText}>
                {loading ? 'Creating account…' : 'Create account'}
              </Text>
            </TouchableOpacity>

            <View style={styles.switchRow}>
              <Text style={styles.switchText}>Already have an account?</Text>
              <TouchableOpacity onPress={switchToLogin}>
                <Text style={styles.switchLink}>Log in</Text>
              </TouchableOpacity>
            </View>
          </>
        ) : (
          <>
            {/* RESET MODE */}
            <View style={[styles.fieldGroup, { marginBottom: 16 }]}>
              <TextInput
                style={styles.input}
                value={newPassword}
                onChangeText={setNewPassword}
                placeholder="New password"
                secureTextEntry
                returnKeyType="done"
                onSubmitEditing={handleResetPassword}
              />
            </View>

            <TouchableOpacity
              style={[styles.button, loading && { opacity: 0.7 }]}
              onPress={handleResetPassword}
              disabled={loading}
            >
              <Text style={styles.buttonText}>
                {loading ? 'Updating…' : 'Update password'}
              </Text>
            </TouchableOpacity>

            <View style={styles.switchRow}>
              <Text style={styles.switchText}>Remembered your password?</Text>
              <TouchableOpacity onPress={switchToLogin}>
                <Text style={styles.switchLink}>Back to log in</Text>
              </TouchableOpacity>
            </View>
          </>
        )}
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#ffffff',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  inner: {
    width: '100%',
    maxWidth: 420,
    alignSelf: 'center',
  },
  title: {
    fontSize: 28,
    fontWeight: '600',
    marginBottom: 24,
  },
  fieldGroup: {
    marginBottom: 16,
  },
  input: {
    borderWidth: 1,
    borderColor: '#e0e0e0',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
    backgroundColor: '#ffffff',
  },
  forgotInline: {
    marginTop: 8,
    alignSelf: 'flex-end',
  },
  forgotText: {
    fontSize: 14,
    color: '#555555',
  },
  button: {
    backgroundColor: '#111111',
    borderRadius: 999,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 12,
  },
  buttonText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '500',
  },
  switchRow: {
    flexDirection: 'row',
    marginTop: 16,
    justifyContent: 'center',
  },
  switchText: {
    fontSize: 14,
    color: '#555555',
    marginRight: 4,
  },
  switchLink: {
    fontSize: 14,
    color: '#111111',
    fontWeight: '500',
  },
});

export default Login;
