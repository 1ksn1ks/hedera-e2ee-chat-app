// Local preference for the relay switch. Default on. The topic key never
// goes through this store — only "1" or "0".
import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = 'e2ee-chat.useRelay';

export async function loadUseRelay(): Promise<boolean> {
  try {
    const value = await AsyncStorage.getItem(KEY);
    if (value === '0') return false;
    if (value === '1') return true;
  } catch {
    // Storage missing. Stay on the relay default.
  }
  return true;
}

export async function saveUseRelay(on: boolean): Promise<void> {
  try {
    await AsyncStorage.setItem(KEY, on ? '1' : '0');
  } catch {
    // The in-memory switch still applies for this session.
  }
}
