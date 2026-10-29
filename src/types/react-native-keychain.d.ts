// react-native-keychain ships no TypeScript declarations; this covers the
// API surface this app uses (generic password, per-service).
declare module '@react-native-keychain' {
  export const ACCESSIBLE: {
    WHEN_UNLOCKED: string;
    AFTER_FIRST_UNLOCK: string;
    WHEN_PASSCODE_SET_THIS_DEVICE_ONLY: string;
    APPLICATION_SPECIFIC: string;
  };

  export interface GenericPasswordOptions {
    service?: string;
    accessible?: string;
    storage?: string;
  }

  export interface Credentials {
    service: string;
    username: string;
    password: string;
  }

  export function setGenericPassword(
    user: string,
    password: string,
    options?: GenericPasswordOptions
  ): Promise<void>;

  export function getGenericPassword(
    options?: GenericPasswordOptions
  ): Promise<Credentials | false>;

  export function resetGenericPassword(
    options?: GenericPasswordOptions
  ): Promise<boolean>;

  const Keychain: {
    ACCESSIBLE: typeof ACCESSIBLE;
    setGenericPassword: typeof setGenericPassword;
    getGenericPassword: typeof getGenericPassword;
    resetGenericPassword: typeof resetGenericPassword;
  };

  export default Keychain;
}
