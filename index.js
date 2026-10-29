import 'react-native-get-random-values';
import 'react-native-url-polyfill/auto';
import { polyfill as polyfillEncoding } from 'text-encoding';
import '@walletconnect/react-native-compat';

import { AppRegistry } from 'react-native';
import App from './App';
import { name as appName } from './app.json';

polyfillEncoding();

AppRegistry.registerComponent(appName, () => App);
