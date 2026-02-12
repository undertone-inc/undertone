import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Alert,
  Linking,
} from 'react-native';
import Constants from 'expo-constants';
import { saveAuthProfile, saveToken } from '../auth';
import { openInAppBrowser } from '../in-app-browser';
import { captureInviteCodeFromUrl, clearInviteCode, getInviteCode } from '../invites';

type LoginProps = {
  navigation: any;
  onAuthSuccess?: (token: string, email: string, id?: string | number) => void;
};

type Mode = 'login' | 'signup' | 'reset';

// Read API base (env overrides app.json extra)
// IMPORTANT: Strip trailing slashes so we never generate URLs like "//login".
const RAW_API_BASE =
  process.env.EXPO_PUBLIC_API_BASE ??
  (Constants as any).expoConfig?.extra?.EXPO_PUBLIC_API_BASE ??
  'http://localhost:3000';
const API_BASE = String(RAW_API_BASE || '').replace(/\/+$/, '');

const TERMS_URL = 'https://undertoneapp.io/undertone-legal/terms/index.html';
const PRIVACY_URL = 'https://undertoneapp.io/undertone-legal/privacy/index.html';

// Keep placeholders consistent across fields.
const PLACEHOLDER_COLOR = '#999999';

const Login: React.FC<LoginProps> = ({ navigation, onAuthSuccess }) => {
  const [mode, setMode] = useState<Mode>('login');

  const [inviteCode, setInviteCode] = useState<string | null>(null);
  const [username, setUsername] = useState('');
  const [phoneNumber, setPhoneNumber] = useState('');

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const [newPassword, setNewPassword] = useState('');

  const [resetSent, setResetSent] = useState(false);
  const [resetCode, setResetCode] = useState('');

  const [loading, setLoading] = useState(false);

  // Load any stored invite code and keep it updated when a deep link arrives.
  useEffect(() => {
    let alive = true;

    (async () => {
      const code = await getInviteCode();
      if (!alive) return;
      setInviteCode(code);
    })().catch(() => {});

    const sub = Linking.addEventListener('url', (event) => {
      const url = event?.url;
      captureInviteCodeFromUrl(url)
        .then((code) => {
          if (!alive) return;
          if (code) setInviteCode(code);
        })
        .catch(() => {});
    });

    return () => {
      alive = false;
      try {
        (sub as any)?.remove?.();
      } catch {
        // ignore
      }
    };
  }, []);

  const trimmedEmail = email.trim();

  const completeAuth = async (
    token: string,
    authEmail: string,
    id?: string | number,
    accountName?: string | null,
    planTier?: string | null,
  ) => {
    try {
      await saveToken(token);
      await saveAuthProfile({
        email: authEmail,
        userId: id == null ? null : String(id),
        accountName: accountName ? String(accountName).trim() : null,
        planTier: planTier ? String(planTier).trim().toLowerCase() : null,
      });
    } catch {
      // If token can't be persisted, still allow session for this run.
    }
    if (onAuthSuccess) onAuthSuccess(token, authEmail, id);
  };

  const switchToLogin = () => {
    setMode('login');
    setPassword('');
    setNewPassword('');
    setResetSent(false);
    setResetCode('');
    setUsername('');
    setPhoneNumber('');
  };

  const switchToSignup = () => {
    setMode('signup');
    setPassword('');
    setNewPassword('');
    setResetSent(false);
    setResetCode('');
    setUsername('');
    setPhoneNumber('');
  };

  const switchToReset = () => {
    setMode('reset');
    setPassword('');
    setNewPassword('');
    setResetSent(false);
    setResetCode('');
    setUsername('');
    setPhoneNumber('');
  };

  const handleLogin = async () => {
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

      const token = String(data?.token || '').trim();
      const emailFromServer = String(data?.user?.email || trimmedEmail).trim();
      const idFromServer = data?.user?.id;
      const accountNameFromServer = String(data?.user?.accountName || '').trim();
      const planTierFromServer =
        data?.user?.planTier ??
        data?.user?.plan ??
        data?.user?.tier ??
        data?.user?.subscriptionPlan ??
        data?.user?.subscription?.plan;
      if (!token) {
        Alert.alert('Login failed', 'Server did not return an auth token.');
        return;
      }

      await completeAuth(
        token,
        emailFromServer,
        idFromServer,
        accountNameFromServer || null,
        planTierFromServer ? String(planTierFromServer) : null,
      );
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

    const inviteActive = Boolean(inviteCode);
    if (inviteActive) {
      const u = username.trim();
      const p = phoneNumber.trim();
      if (!u) {
        Alert.alert('Missing info', 'Please enter a username.');
        return;
      }
      if (!p) {
        Alert.alert('Missing info', 'Please enter your phone number.');
        return;
      }
    }

    try {
      setLoading(true);

      const response = await fetch(`${API_BASE}/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: trimmedEmail,
          password,
          inviteCode: inviteCode || undefined,
          phoneNumber: inviteCode ? phoneNumber.trim() : undefined,
          accountName: inviteCode ? username.trim() : undefined,
        }),
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

      // Invite-only fields are only required for the first sign-up. Clear the code after success.
      if (inviteCode) {
        clearInviteCode().catch(() => {});
        setInviteCode(null);
      }

      const token = String(data?.token || '').trim();
      const emailFromServer = String(data?.user?.email || trimmedEmail).trim();
      const idFromServer = data?.user?.id;
      const accountNameFromServer = String(data?.user?.accountName || '').trim();
      const planTierFromServer =
        data?.user?.planTier ??
        data?.user?.plan ??
        data?.user?.tier ??
        data?.user?.subscriptionPlan ??
        data?.user?.subscription?.plan;
      if (!token) {
        Alert.alert('Sign up failed', 'Server did not return an auth token.');
        return;
      }

      await completeAuth(
        token,
        emailFromServer,
        idFromServer,
        accountNameFromServer || null,
        planTierFromServer ? String(planTierFromServer) : null,
      );
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

  const handleRequestReset = async () => {
    if (!trimmedEmail) {
      Alert.alert('Missing info', 'Please enter your email.');
      return;
    }

    try {
      setLoading(true);

      const response = await fetch(`${API_BASE}/request-password-reset`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: trimmedEmail }),
      });

      const data = await response.json().catch(() => ({}));

      if (!response.ok || data?.ok === false) {
        Alert.alert('Reset failed', data?.error || 'Something went wrong.');
        return;
      }

      setResetSent(true);

      const devToken = String(data?.resetToken || '').trim();
      if (devToken) {
        setResetCode(devToken);
        Alert.alert('Reset code (dev)', devToken);
      } else {
        Alert.alert('Check your email', 'If an account exists, we will send you a reset code.');
      }
    } catch (error) {
      console.error('Request reset error:', error);
      Alert.alert('Network error', 'Could not reach the server. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const handleResetPassword = async () => {
    if (!trimmedEmail || !resetCode.trim() || !newPassword) {
      Alert.alert('Missing info', 'Please enter your email, the reset code, and a new password.');
      return;
    }

    try {
      setLoading(true);

      const response = await fetch(`${API_BASE}/reset-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: trimmedEmail, token: resetCode.trim(), newPassword }),
      });

      const data = await response.json().catch(() => ({}));

      if (!response.ok || data?.ok === false) {
        Alert.alert('Reset failed', data?.error || 'Could not update your password.');
        return;
      }

      Alert.alert('Password updated', 'You can now log in with your new password.');
      setResetSent(false);
      setResetCode('');
      setNewPassword('');
      setMode('login');
    } catch (error) {
      console.error('Reset password error:', error);
      Alert.alert('Network error', 'Could not reach the server. Please try again.');
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
            placeholderTextColor={PLACEHOLDER_COLOR}
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
                placeholderTextColor={PLACEHOLDER_COLOR}
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
            {inviteCode ? (
              <>
                <View style={[styles.fieldGroup, { marginBottom: 12 }]}> 
                  <TextInput
                    style={styles.input}
                    value={username}
                    onChangeText={setUsername}
                    placeholder="Username"
                    placeholderTextColor={PLACEHOLDER_COLOR}
                    autoCapitalize="none"
                    autoCorrect={false}
                    returnKeyType="next"
                  />
                </View>

                <View style={[styles.fieldGroup, { marginBottom: 12 }]}> 
                  <TextInput
                    style={styles.input}
                    value={phoneNumber}
                    onChangeText={setPhoneNumber}
                    placeholder="Phone number"
                    placeholderTextColor={PLACEHOLDER_COLOR}
                    keyboardType="phone-pad"
                    textContentType="telephoneNumber"
                    autoCapitalize="none"
                    autoCorrect={false}
                    returnKeyType="next"
                  />
                </View>
              </>
            ) : null}

            <View style={[styles.fieldGroup, { marginBottom: 16 }]}>
              <TextInput
                style={styles.input}
                value={password}
                onChangeText={setPassword}
                placeholder="Create a password"
                placeholderTextColor={PLACEHOLDER_COLOR}
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
            {!resetSent ? (
              <>
                <TouchableOpacity
                  style={[styles.button, loading && { opacity: 0.7 }]}
                  onPress={handleRequestReset}
                  disabled={loading}
                >
                  <Text style={styles.buttonText}>
                    {loading ? 'Sending…' : 'Send reset code'}
                  </Text>
                </TouchableOpacity>

                <View style={styles.resetLinksRow}>
                  <TouchableOpacity
                    onPress={() => setResetSent(true)}
                    disabled={loading}
                  >
                    <Text style={styles.resetLink}>I already have a code</Text>
                  </TouchableOpacity>
                  <Text style={styles.resetLinksSeparator}>•</Text>
                  <TouchableOpacity onPress={switchToLogin} disabled={loading}>
                    <Text style={styles.resetLink}>Back to log in</Text>
                  </TouchableOpacity>
                </View>
              </>
            ) : (
              <>
                <View style={[styles.fieldGroup, { marginBottom: 12 }]}>
                  <TextInput
                    style={styles.input}
                    value={resetCode}
                    onChangeText={(value) =>
                      setResetCode(value.replace(/[^0-9]/g, '').slice(0, 6))
                    }
                    placeholder="6-digit code"
                    placeholderTextColor={PLACEHOLDER_COLOR}
                    keyboardType="number-pad"
                    textContentType="oneTimeCode"
                    maxLength={6}
                    autoCapitalize="none"
                    autoCorrect={false}
                    returnKeyType="next"
                  />
                </View>

                <View style={[styles.fieldGroup, { marginBottom: 16 }]}>
                  <TextInput
                    style={styles.input}
                    value={newPassword}
                    onChangeText={setNewPassword}
                    placeholder="New password"
                    placeholderTextColor={PLACEHOLDER_COLOR}
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

                <View style={styles.resetLinksRow}>
                  <TouchableOpacity
                    onPress={() => setResetSent(false)}
                    disabled={loading}
                  >
                    <Text style={styles.resetLink}>Back</Text>
                  </TouchableOpacity>
                  <Text style={styles.resetLinksSeparator}>•</Text>
                  <TouchableOpacity onPress={switchToLogin} disabled={loading}>
                    <Text style={styles.resetLink}>Back to log in</Text>
                  </TouchableOpacity>
                </View>
              </>
            )}
          </>
        )}
      </View>
{isSignup && (
  <View style={styles.legalFooter} pointerEvents="box-none">
    <Text style={styles.legalText}>
      By signing up you agree to our{' '}
      <Text
        style={styles.legalLink}
        onPress={() => openInAppBrowser(TERMS_URL)}
        accessibilityRole="link"
      >
        Terms
      </Text>{' '}
      and{' '}
      <Text
        style={styles.legalLink}
        onPress={() => openInAppBrowser(PRIVACY_URL)}
        accessibilityRole="link"
      >
        Privacy Policy
      </Text>
    </Text>
  </View>
)}
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
  resetLinksRow: {
    flexDirection: 'row',
    marginTop: 12,
    justifyContent: 'center',
    alignItems: 'center',
    flexWrap: 'wrap',
  },
  resetLinksSeparator: {
    marginHorizontal: 10,
    fontSize: 14,
    color: '#bdbdbd',
  },
  resetLink: {
    fontSize: 14,
    color: '#555555',
    fontWeight: '500',
  },
  legalFooter: {
    position: 'absolute',
    left: 24,
    right: 24,
    bottom: 40,
    alignItems: 'center',
  },
  legalText: {
    fontSize: 12,
    color: '#555555',
    textAlign: 'center',
  },
  legalLink: {
    textDecorationLine: 'underline',
  },
});

export default Login;
