import React, { useState, useEffect } from 'react';
import {
  View,
  TextInput,
  StyleSheet,
  TouchableOpacity,
  TouchableWithoutFeedback,
  Keyboard,
  Text,
  Platform,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import * as SecureStore from 'expo-secure-store';

import { SafeAreaView } from 'react-native-safe-area-context';

const KITLOG_STORAGE_KEY = 'io_kitlog_v1';
const CATALOG_STORAGE_KEY = 'io_catalog_v1';
const EXPIRING_WINDOW_DAYS = 60;

const UPCOMING_WINDOW_DAYS = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

function safeParseDate(value?: string): number | null {
  if (!value) return null;
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : null;
}

function isExpiring(expiryDate?: string, windowDays = EXPIRING_WINDOW_DAYS): boolean {
  const ts = safeParseDate(expiryDate);
  if (!ts) return false;
  return ts - Date.now() <= windowDays * 24 * 60 * 60 * 1000;
}

function countNeedsAttentionFromRaw(raw: string | null): number {
  if (!raw) return 0;
  try {
    const parsed = JSON.parse(raw);
    const cats = Array.isArray(parsed?.categories) ? parsed.categories : [];

    let low = 0;
    let empty = 0;
    let expiring = 0;

    cats.forEach((c: any) => {
      const items = Array.isArray(c?.items) ? c.items : [];
      items.forEach((it: any) => {
        if (it?.status === 'low') low += 1;
        if (it?.status === 'empty') empty += 1;
        if (isExpiring(it?.expiryDate)) expiring += 1;
      });
    });

    // Match KitLog's "Needs attention" count (sum of the three buckets).
    return low + empty + expiring;
  } catch {
    return 0;
  }
}

function safeParseCalendarDate(value?: string): number | null {
  if (!value) return null;

  const s = value.trim();
  if (!s) return null;

  // When we store YYYY-MM-DD, parse it as a LOCAL date (not UTC) to avoid
  // timezone shifts that can move the day earlier/later.
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(s);
  const t = new Date(dateOnly ? `${s}T00:00:00` : s).getTime();
  return Number.isFinite(t) ? t : null;
}

function startOfTodayLocalMs(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function isWithinNextDaysCalendar(dateStr?: string, windowDays = UPCOMING_WINDOW_DAYS): boolean {
  const ts = safeParseCalendarDate(dateStr);
  if (!ts) return false;

  const today = startOfTodayLocalMs();
  const diff = ts - today;
  return diff >= 0 && diff <= windowDays * DAY_MS;
}

function countUpcomingClientsFromRaw(raw: string | null): number {
  if (!raw) return 0;
  try {
    const parsed = JSON.parse(raw);
    const clients = Array.isArray(parsed?.clients) ? parsed.clients : [];

    let upcoming = 0;
    clients.forEach((c: any) => {
      if (isWithinNextDaysCalendar(c?.trialDate) || isWithinNextDaysCalendar(c?.finalDate)) {
        upcoming += 1;
      }
    });

    return upcoming;
  } catch {
    return 0;
  }
}

type UploadScreenProps = {
  navigation: any;
  route: any;
  email?: string | null;
};

// How the bar sits when keyboard is CLOSED
const CLOSED_BOTTOM_PADDING = 12;

// Extra space ABOVE the keyboard when it’s OPEN
// ↓ make this smaller/bigger to tune the gap
const KEYBOARD_GAP = 0;

const Upload: React.FC<UploadScreenProps> = ({ navigation }) => {
  const [message, setMessage] = useState('');
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const [needsAttentionCount, setNeedsAttentionCount] = useState(0);
  const [upcomingClientCount, setUpcomingClientCount] = useState(0);

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

  // Keep the counts in sync (updates when returning to this screen).
  useEffect(() => {
    let alive = true;

    const refresh = async () => {
      try {
        const raw = await SecureStore.getItemAsync(KITLOG_STORAGE_KEY);
        const count = countNeedsAttentionFromRaw(raw);
        if (alive) setNeedsAttentionCount(count);
      } catch {
        if (alive) setNeedsAttentionCount(0);
      }

      try {
        const raw = await SecureStore.getItemAsync(CATALOG_STORAGE_KEY);
        const count = countUpcomingClientsFromRaw(raw);
        if (alive) setUpcomingClientCount(count);
      } catch {
        if (alive) setUpcomingClientCount(0);
      }
    };

    refresh();
    const unsubscribe = navigation.addListener('focus', refresh);

    return () => {
      alive = false;
      if (typeof unsubscribe === 'function') unsubscribe();
    };
  }, [navigation]);

  const handleSubmit = () => {
    const trimmed = message.trim();

    if (!trimmed) {
      Keyboard.dismiss();
      return;
    }

    // TODO: send message to backend
    console.log('Message:', trimmed);
  };

  // Use different bottom padding depending on keyboard state
  const bottomPadding =
    keyboardHeight > 0
      ? keyboardHeight + KEYBOARD_GAP
      : CLOSED_BOTTOM_PADDING;

  return (
    <TouchableWithoutFeedback onPress={Keyboard.dismiss}>
      <SafeAreaView style={styles.safeArea} edges={["top", "left", "right"]}>
        <View
          style={[
            styles.container,
            { paddingBottom: bottomPadding },
          ]}
        >
          {/* Top info row */}
          <View style={styles.topBar}>
            <View style={styles.infoPill}>
              <TouchableOpacity
                style={styles.catalogRow}
                activeOpacity={0.8}
                onPress={() => navigation.navigate('Catalog')}
                accessibilityRole="button"
              >
                <Text style={styles.catalogLabel}>Catalog:</Text>
                <Text style={styles.catalogCount}>{upcomingClientCount}</Text>
              </TouchableOpacity>

              <View style={styles.verticalDivider} />

              {/* Plan row */}
              <TouchableOpacity
                style={styles.planRow}
                activeOpacity={0.8}
                onPress={() => navigation.navigate('KitLog')}
                accessibilityRole="button"
              >
                <Text style={styles.planLabel}>Your kit:</Text>
                <Text style={styles.planValue}>{needsAttentionCount}</Text>
              </TouchableOpacity>
            </View>

            <TouchableOpacity
              style={styles.accountChip}
              onPress={() => navigation.navigate('Account')}
            >
              <Text style={styles.accountChipText}>Account</Text>
            </TouchableOpacity>
          </View>

          {/* Middle area (chat / uploads) */}
          <View style={styles.chatArea} />

          {/* Bottom input bar */}
          <View style={styles.inputBar}>
            <View style={styles.inputContainer}>
              <TextInput
                style={styles.textInput}
                value={message}
                onChangeText={setMessage}
                placeholder="Message"
                placeholderTextColor="#999999"
                returnKeyType="send"
                onSubmitEditing={handleSubmit}
                blurOnSubmit={false}
              />

              {/* Single camera icon button */}
              <TouchableOpacity
                style={styles.iconButton}
                onPress={() => {
                  Keyboard.dismiss();
                  console.log('Open camera');
                }}
              >
                <Ionicons name="camera-outline" size={18} color="#ffffff" />
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </SafeAreaView>
    </TouchableWithoutFeedback>
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
    paddingBottom: 0, // dynamic padding is applied via bottomPadding
  },

  // Top bar
  topBar: {
    marginTop: 8,
    marginBottom: 10,
    flexDirection: 'row',
    alignItems: 'center',
  },
  infoPill: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 18,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    backgroundColor: '#ffffff',
    paddingLeft: 25,
    paddingRight: 10,
    minHeight: 38,
  },
  catalogRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  catalogLabel: {
    color: '#111827',
    fontSize: 13,
    fontWeight: '400',
  },
  catalogCount: {
    color: '#111827',
    fontSize: 13,
    fontWeight: '400',
    marginLeft: 20,
    transform: [{ translateX: 1 }]
  },
  verticalDivider: {
    width: 1,
    height: 16,
    backgroundColor: '#e5e7eb',
    marginHorizontal: 22,
    transform: [{ translateX: 2 }]
  },
  planRow: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingLeft: 0,
  },
  planLabel: {
    color: '#111827',
    fontSize: 13,
    fontWeight: '400',
    transform: [{ translateX: 3 }]
  },
  planValue: {
    color: '#111827',
    fontSize: 13,
    fontWeight: '400',
    marginRight: 16,
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

  chatArea: {
    flex: 1,
  },

  // Bottom input
  inputBar: {
    paddingTop: 8,
  },
  inputContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#e0e0e0',
    borderRadius: 22,
    paddingLeft: 18,
    paddingRight: 6,
    backgroundColor: '#ffffff',
    minHeight: 44,
  },
  textInput: {
    flex: 1,
    fontSize: 14,
    paddingVertical: 8,
    paddingRight: 8,
  },
  iconButton: {
    marginLeft: 4,
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: '#111111',
    alignItems: 'center',
    justifyContent: 'center',
  },
});

export default Upload;
