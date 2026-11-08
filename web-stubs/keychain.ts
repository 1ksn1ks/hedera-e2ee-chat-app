// Browser stand-in for react-native-keychain. The topic key lives in module
// memory ONLY — never in localStorage/IndexedDB — so a page reload drops it
// and the app asks for the password / key again. This is the intended web
// behaviour, not a fallback bug.
const memory = new Map<string, string>();

const ACCESSIBLE = {
  WHEN_UNLOCKED: 'whenUnlocked',
  AFTER_FIRST_UNLOCK: 'afterFirstUnlock',
  WHEN_PASSCODE_SET_THIS_DEVICE_ONLY: 'whenPasscodeSetThisDeviceOnly',
  APPLICATION_SPECIFIC: 'applicationSpecific',
};

// One entry per `service`, like the real Keychain/Keystore (secretStore.ts
// uses one service per topic). Ignoring it handed topic A's key to topic B,
// which then "unlocked" with the wrong key and showed no messages.
type Options = { service?: string };
const DEFAULT_SERVICE = 'default';

async function setGenericPassword(user: string, password: string, options?: Options) {
  memory.set(options?.service || DEFAULT_SERVICE, password);
  return { service: options?.service || DEFAULT_SERVICE, storage: 'memory', user };
}

async function getGenericPassword(
  options?: Options
): Promise<{ service: string; password: string } | false> {
  const service = options?.service || DEFAULT_SERVICE;
  const password = memory.get(service);
  return password === undefined ? false : { service, password };
}

async function resetGenericPassword(options?: Options) {
  return memory.delete(options?.service || DEFAULT_SERVICE);
}

// Same names as the real package (secretStore.ts uses the named exports).
export { ACCESSIBLE, getGenericPassword, resetGenericPassword, setGenericPassword };
export default { ACCESSIBLE, setGenericPassword, getGenericPassword, resetGenericPassword };
