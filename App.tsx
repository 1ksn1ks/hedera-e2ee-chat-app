// Hedera E2EE Chat — a standalone messenger for encrypted Hedera consensus
// topics. One screen at a time (no router): connect/unlock → chat. The
// whole E2EE engine (crypto, ingest, live stream, edits, wallet) lives in
// useE2eeChat and survives the screen switch.
import React from 'react';
import { StatusBar, View } from 'react-native';
import { initialWindowMetrics, SafeAreaProvider } from 'react-native-safe-area-context';
import { useE2eeChat } from './src/hooks/useE2eeChat';
import { ConnectScreen } from './src/screens/ConnectScreen';
import { ChatScreen } from './src/screens/ChatScreen';

function Chat() {
  const chat = useE2eeChat();
  const inChat =
    chat.phase === 'ready' &&
    chat.unlock.status === 'unlocked' &&
    chat.meta !== null;

  // Dev-only test seam (headless verification); stripped in release builds.
  if (typeof __DEV__ !== 'undefined' && __DEV__) {
    (globalThis as Record<string, unknown>).__e2eeChat = chat;
  }

  return (
    <View style={{ flex: 1, backgroundColor: '#0a0a0a' }}>
      <StatusBar barStyle="light-content" backgroundColor="#0a0a0a" />
      <View style={{ flex: 1 }}>
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
