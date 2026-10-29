// Topic-key storage. On device the unwrapped topic private key (DER hex)
// lives in the platform keystore — iOS Keychain / Android Keystore via
// react-native-keychain, gated by the device passcode — never in
// AsyncStorage or long-lived JS state. In the browser preview the package
// resolves to an in-memory stub (a reload drops the key and forces a
// re-unlock), which is the intended behaviour there.
import Keychain from '@react-native-keychain';

const SERVICE_PREFIX = 'com.hedera.e2eetchat.topic';

function serviceFor(topicId: string): string {
  return `${SERVICE_PREFIX}.${topicId}`;
}

export async function storeTopicKey(topicId: string, derHex: string): Promise<void> {
  await Keychain.setGenericPassword(topicId, derHex, {
    service: serviceFor(topicId),
    accessible: Keychain.ACCESSIBLE.WHEN_PASSCODE_SET_THIS_DEVICE_ONLY,
  });
}

export async function loadTopicKey(topicId: string): Promise<string | null> {
  const creds = await Keychain.getGenericPassword({ service: serviceFor(topicId) });
  return creds ? creds.password : null;
}

export async function clearTopicKey(topicId: string): Promise<void> {
  await Keychain.resetGenericPassword({ service: serviceFor(topicId) });
}
