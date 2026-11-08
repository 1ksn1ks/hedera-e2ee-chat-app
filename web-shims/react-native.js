// Web shim for 'react-native' imports: everything from react-native-web,
// plus native-only named exports the app imports but the browser has no
// bridge for (granted/no-op in the web preview).
// (no `default` re-export: the CJS-interop'd build doesn't expose one,
// and the RN ecosystem uses named imports)
export * from 'react-native-web';

// react-native-svg 15.16 imports this from 'react-native' itself (older
// versions used the deep path the vite alias still maps). Same web stand-in.
export { default as codegenNativeComponent } from './codegenNativeComponent.js';

export const PermissionsAndroid = {
  PERMISSIONS: {},
  REQUEST_PERMISSIONS: {},
  PERMISSION_NAMES: {},
  check: async () => true,
  request: async () => 'granted',
  requestMultiple: async () => ({}),
};

// react-native-web has no TurboModuleRegistry. Native modules don't exist in
// the browser, so lookups return null (safe-area-context tolerates a null
// native module; react-native-svg's are never consumed on web).
export const TurboModuleRegistry = {
  get: () => null,
  getEnforcing: () => null,
};

// react-native-web has no requireNativeComponent. Without this export the
// named import in MessageBubble fails at module link time and the whole
// preview stays blank. The native SealedVideo only mounts when there is no
// DOM, so in the browser the returned component is never rendered.
export function requireNativeComponent() {
  return function NativeComponentStub() {
    return null;
  };
}
