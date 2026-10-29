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

async function setGenericPassword(user: string, password: string) {
  memory.set(user, password);
}

async function getGenericPassword(): Promise<{ service: string; password: string } | false> {
  for (const [service, password] of memory) {
    return { service, password };
  }
  return false;
}

async function resetGenericPassword() {
  memory.clear();
}

export default { ACCESSIBLE, setGenericPassword, getGenericPassword, resetGenericPassword };
export { ACCESSIBLE };
