// Hedera E2EE Chat — a standalone messenger for encrypted Hedera consensus
// topics. One screen at a time (no router): connect/unlock → chat. The
// whole E2EE engine (crypto, ingest, live stream, edits, wallet) lives in
// useE2eeChat and survives the screen switch.
import React from 'react';
import { StatusBar, useWindowDimensions, View } from 'react-native';
import { initialWindowMetrics, SafeAreaProvider } from 'react-native-safe-area-context';
import { useE2eeChat } from './src/hooks/useE2eeChat';
import { ConnectScreen } from './src/screens/ConnectScreen';
import { ChatScreen } from './src/screens/ChatScreen';
import { colors, MAX_COLUMN } from './src/theme';

function Chat() {
  const chat = useE2eeChat();
  // A wide browser window gets one centered column with side rules.
  const wide = useWindowDimensions().width > MAX_COLUMN;
  const inChat =
    chat.phase === 'ready' &&
    chat.unlock.status === 'unlocked' &&
    chat.meta !== null;

  // Dev-only test seam (headless verification); stripped in release builds.
  if (typeof __DEV__ !== 'undefined' && __DEV__) {
    (globalThis as Record<string, unknown>).__e2eeChat = chat;
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <StatusBar barStyle="light-content" backgroundColor={colors.card} />
      <View
        style={[
          { flex: 1, width: '100%', maxWidth: MAX_COLUMN, alignSelf: 'center' },
          wide && { borderLeftWidth: 1, borderRightWidth: 1, borderColor: colors.hairline },
        ]}
      >
        {inChat ? <ChatScreen chat={chat} /> : <ConnectScreen chat={chat} />}
      </View>
    </View>
  );
}

export default function App() {
  return (
    <SafeAreaProvider initialMetrics={initialWindowMetrics}>
      <Chat />
    </SafeAreaProvider>
  );
}
