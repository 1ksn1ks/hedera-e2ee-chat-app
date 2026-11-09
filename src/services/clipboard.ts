// Copy text for the user (e.g. the WalletConnect pairing link, to paste into
// a wallet). React Native core still ships Clipboard (deprecated in favour of
// @react-native-clipboard/clipboard, which would add a native module), and
// react-native-web maps it to the browser. The browser's own async clipboard
// is preferred where it exists.
import { Clipboard, Platform } from 'react-native';

export async function copyText(text: string): Promise<boolean> {
  try {
    const nav = typeof navigator !== 'undefined' ? navigator : undefined;
    if (Platform.OS === 'web' && nav && nav.clipboard && typeof nav.clipboard.writeText === 'function') {
      await nav.clipboard.writeText(text);
      return true;
    }
    Clipboard.setString(text);
    return true;
  } catch {
    return false;
  }
}
