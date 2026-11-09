import 'react-native-get-random-values';
import 'react-native-url-polyfill/auto';
import { TextDecoder, TextEncoder } from 'text-encoding';
import '@walletconnect/react-native-compat';

import { AppRegistry } from 'react-native';
import App from './App';
import { name as appName } from './app.json';

// text-encoding exports the two classes only (there is no polyfill()
// function: calling one crashed the app before it registered). Install them
// where the engine has none; WalletConnect's compat layer may already have.
if (typeof global.TextEncoder === 'undefined') global.TextEncoder = TextEncoder;
if (typeof global.TextDecoder === 'undefined') global.TextDecoder = TextDecoder;

AppRegistry.registerComponent(appName, () => App);
