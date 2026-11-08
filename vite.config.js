import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Browser preview of the React Native app — same pattern as the sibling
// apps: Vite dev server on 0.0.0.0, /api proxied to the topic-message
// backend so the web build stays same-origin (the backend sends no CORS
// headers). Native-only modules get stubs; the keychain stub is
// in-memory on purpose (a browser reload must force a re-unlock).
export default defineConfig({
  plugins: [react()],
  define: {
    // __DEV__ is an RN/Metro build-time global (referenced by the app and by
    // react-native-web); give it a real value in the browser.
    __DEV__: JSON.stringify(process.env.NODE_ENV !== 'production'),
  },
  optimizeDeps: {
    // Ships platform-specific .web.js browser variants. The pre-bundler would
    // resolve them to the native files, but the dev transform honors
    // resolve.extensions and picks the .web.js ones — so serve it through the
    // transform. (react-native-svg is NOT excluded: its lib/module is a
    // hybrid ESM/CJS build that needs pre-bundling for CJS interop.)
    exclude: ['react-native-safe-area-context'],
  },
  resolve: {
    // Prefer the packages' .web.js variants (e.g. react-native-safe-area-context
    // ships browser implementations as NativeSafeAreaProvider.web.js /
    // SafeAreaView.web.js); fall through to the normal extensions otherwise.
    // The app's own .web.tsx / .web.ts files (e.g. src/components/Icon.web.tsx)
    // win the same way; Metro ignores them on phones.
    extensions: ['.web.tsx', '.web.ts', '.web.js', '.mjs', '.js', '.mts', '.ts', '.jsx', '.tsx', '.json'],
    alias: [
      // react-native-svg's fabric components call this at module load; the real
      // RN file is Flow + native-bridge and cannot load in a browser.
      {
        find: 'react-native/Libraries/Utilities/codegenNativeComponent',
        replacement: path.resolve(__dirname, 'web-shims/codegenNativeComponent.js'),
      },
      // Keychain has no native bridge in the browser — the stub keeps the key
      // in module memory only (never localStorage): a reload re-unlocks.
      {
        find: /^react-native-keychain$/,
        replacement: path.resolve(__dirname, 'web-stubs/keychain.ts'),
      },
      // Exact match only, so 'react-native/...' subpaths are not swallowed.
      { find: /^react-native$/, replacement: path.resolve(__dirname, 'web-shims/react-native.js') },
    ],
  },
  server: {
    host: '0.0.0.0',
    port: 5175,
    // If 5175 is taken, move to the next free port and print it — never
    // stop whatever else is holding the port.
    strictPort: false,
    fs: {
      // Setting fs.deny replaces Vite's defaults, so re-include them
      // (Vite 8: .env, .env.*, *.{crt,pem,key,p12,pfx,cer,der}, .npmrc,
      // .yarnrc.yml, **/.git/**). Slash-less patterns get **/ prepended
      // automatically; patterns with a slash are used as-is — hence the
      // **/ prefixes.
      deny: [
        '.env',
        '.env.*',
        '*.{crt,pem,key,p12,pfx,cer,der}',
        '.npmrc',
        '.yarnrc.yml',
        '**/.git/**',
        '**/android/**',
        '**/ios/**',
        '**/*.keystore',
        '**/*.jks',
        '**/keystore.properties',
        '**/google-services.json',
        '**/GoogleService-Info.plist',
        '**/.env*',
      ],
    },
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true,
      },
    },
  },
});
