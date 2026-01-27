import * as WebBrowser from 'expo-web-browser';
import { Linking } from 'react-native';

/**
 * Open a URL inside the app (SFSafariViewController on iOS / Chrome Custom Tabs on Android)
 * with a safe fallback to Linking.openURL.
 */
export async function openInAppBrowser(url: string): Promise<void> {
  const safeUrl = String(url || '').trim();
  if (!safeUrl) return;

  try {
    await WebBrowser.openBrowserAsync(safeUrl);
    return;
  } catch {
    // Fallback to system browser
    try {
      const can = await Linking.canOpenURL(safeUrl);
      if (can) await Linking.openURL(safeUrl);
    } catch {
      // ignore
    }
  }
}
