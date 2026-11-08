const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');

// libsodium lists its ESM build first in package "exports", so Metro picks
// it. That build is Emscripten output that reads import.meta.url, which
// Hermes cannot compile (release bundles fail in hermesc). Its CommonJS build
// is the same library and falls back to its pure-JS module when there is no
// WebAssembly, as on Hermes. Resolve just these two packages the CommonJS way.
const COMMONJS_ONLY = new Set(['libsodium-wrappers-sumo', 'libsodium-sumo']);

// That CommonJS build also has Node-only branches (require("node:fs") and
// require("crypto"), reached only when process.versions.node is set or there
// is no crypto.getRandomValues). Metro resolves every require statically, so
// give libsodium empty modules for them. On the phone, randomness comes from
// react-native-get-random-values (index.js).
const NODE_ONLY = new Set(['node:fs', 'crypto']);

/**
 * Metro configuration
 * https://reactnative.dev/docs/metro
 *
 * @type {import('@react-native/metro-config').MetroConfig}
 */
const config = {
  resolver: {
    resolveRequest(context, moduleName, platform) {
      if (COMMONJS_ONLY.has(moduleName)) {
        return {
          type: 'sourceFile',
          filePath: require.resolve(moduleName, { paths: [__dirname] }),
        };
      }
      if (NODE_ONLY.has(moduleName) && /[\\/]libsodium-sumo[\\/]/.test(context.originModulePath)) {
        return { type: 'empty' };
      }
      return context.resolveRequest(context, moduleName, platform);
    },
  },
};

module.exports = mergeConfig(getDefaultConfig(__dirname), config);
