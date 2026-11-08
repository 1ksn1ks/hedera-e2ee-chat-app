// Topic-key storage. On device the unwrapped topic private key (DER hex)
// lives in the platform keystore — iOS Keychain / Android Keystore via
// react-native-keychain, one entry per topic — never in AsyncStorage or
// long-lived JS state. Opening that topic again unlocks from it, so the
// password (which is never stored) is typed once per topic per phone.
// In the browser preview the package resolves to an in-memory stub (a
// reload drops the key and forces a re-unlock), which is the intended
// behaviour there.
import {
  ACCESSIBLE,
  getGenericPassword,
  resetGenericPassword,
  setGenericPassword,
} from 'react-native-keychain';

const SERVICE_PREFIX = 'com.hedera.e2eetchat.topic';

function serviceFor(topicId: string): string {
  return `${SERVICE_PREFIX}.${topicId}`;
}

// iOS: readable only while the phone is unlocked, never synced to iCloud or
// restored to another device, and only if the phone has a passcode (without
// one the save fails and the key stays in memory for this session).
// Android: Keystore-backed encryption on this device.
export async function storeTopicKey(topicId: string, derHex: string): Promise<void> {
  const saved = await setGenericPassword(topicId, derHex, {
    service: serviceFor(topicId),
    accessible: ACCESSIBLE.WHEN_PASSCODE_SET_THIS_DEVICE_ONLY,
  });
  if (saved === false) throw new Error('The phone did not save the topic key');
}

export async function loadTopicKey(topicId: string): Promise<string | null> {
  try {
    const creds = await getGenericPassword({ service: serviceFor(topicId) });
    return creds ? creds.password : null;
  } catch {
    // Keystore unreadable (e.g. lock screen removed): ask for the password.
    return null;
  }
}

export async function clearTopicKey(topicId: string): Promise<void> {
  await resetGenericPassword({ service: serviceFor(topicId) });
}
