// Entry screen: topic id → connect (history metadata fetch) → unlock
// (keystore auto, password for admin-pinned keys, or key import) + wallet
// pairing for sending. No map, no feed — a messenger front door.
import React, { useState } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { baseStyles, colors, glassCard, radius } from '../theme';
import type { E2eeChat } from '../hooks/useE2eeChat';

interface Props {
  chat: E2eeChat;
}

export function ConnectScreen({ chat }: Props) {
  const [topic, setTopic] = useState('');
  const [password, setPassword] = useState('');
  const [keyHex, setKeyHex] = useState('');
  const [busy, setBusy] = useState<'' | 'connect' | 'password' | 'key' | 'wallet'>('');
  const [error, setError] = useState('');

  const status = chat.unlock.status;

  const doConnect = async () => {
    setBusy('connect');
    setError('');
    const res = await chat.connect(topic);
    if (!res.ok) setError(res.error || 'Connect failed');
    setBusy('');
  };

  const doPassword = async () => {
    setBusy('password');
    setError('');
    const res = await chat.unlockWithPassword(password);
    if (!res.ok) setError(res.error || 'Unlock failed');
    setBusy('');
  };

  const doKey = async () => {
    setBusy('key');
    setError('');
    const res = await chat.unlockWithKey(keyHex);
    if (!res.ok) setError(res.error || 'Unlock failed');
    setBusy('');
  };

  const doWallet = async () => {
    setBusy('wallet');
    setError('');
    const res = await chat.walletConnect();
    if (!res.ok) setError(res.error || 'Wallet connect failed');
    setBusy('');
  };

  const connecting = status === 'connecting';

  return (
    <ScrollView
      style={baseStyles.screen}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
    >
      <Text style={styles.brand}>Hedera E2EE Chat</Text>
      <Text style={baseStyles.subtitle}>
        Encrypted topic chat. Messages are sealed to the topic key — only
        holders of the topic private key can read them.
      </Text>

      <View style={[glassCard, styles.card]}>
        <Text style={styles.cardTitle}>Topic</Text>
        <TextInput
          value={topic}
          onChangeText={setTopic}
          placeholder="0.0.12345"
          placeholderTextColor={colors.muted}
          autoCapitalize="none"
          autoCorrect={false}
          editable={!connecting}
          style={styles.input}
        />
        <Pressable
          onPress={doConnect}
          disabled={connecting || !topic.trim()}
          style={[baseStyles.cyanButton, (connecting || !topic.trim()) && styles.off]}
        >
          <Text style={baseStyles.cyanButtonText}>
            {connecting ? 'Connecting…' : 'Connect topic'}
          </Text>
        </Pressable>
      </View>

      {chat.meta && (
        <View style={[glassCard, styles.card]}>
          <Text style={styles.cardTitle}>Unlock</Text>
          {status === 'need-password' && (
            <>
              <Text style={baseStyles.subtitle}>
                This topic has a pinned key protected by a password. Enter it
                to unwrap the topic key into your {`Keystore/Keychain`}.
              </Text>
              <TextInput
                value={password}
                onChangeText={setPassword}
                placeholder="Password"
                placeholderTextColor={colors.muted}
                secureTextEntry
                editable={busy !== 'password'}
                style={[styles.input, { marginTop: 8 }]}
              />
              <Pressable
                onPress={doPassword}
                disabled={busy === 'password' || !password}
                style={[baseStyles.cyanButton, (busy === 'password' || !password) && styles.off]}
              >
                <Text style={baseStyles.cyanButtonText}>
                  {busy === 'password' ? 'Unwrapping…' : 'Unlock with password'}
                </Text>
              </Pressable>
            </>
          )}
          {status === 'need-key' && (
            <Text style={baseStyles.subtitle}>
              No pinned password on this topic — import the topic private key
              (DER hex, the same one the wallet uses to seal messages).
            </Text>
          )}
          {status === 'need-password' && (
            <Text style={[baseStyles.subtitle, { marginTop: 10 }]}>
              or import the key directly:
            </Text>
          )}
          <TextInput
            value={keyHex}
            onChangeText={setKeyHex}
            placeholder="Topic private key (DER hex)"
            placeholderTextColor={colors.muted}
            autoCapitalize="none"
            autoCorrect={false}
            editable={
              busy !== 'key' && (status === 'need-key' || status === 'need-password')
            }
            style={[styles.input, styles.keyInput, { marginTop: 8 }]}
            multiline
            numberOfLines={3}
          />
          <Pressable
            onPress={doKey}
            disabled={busy === 'key' || !keyHex.trim()}
            style={[baseStyles.cyanButton, (busy === 'key' || !keyHex.trim()) && styles.off]}
          >
            <Text style={baseStyles.cyanButtonText}>
              {busy === 'key' ? 'Unlocking…' : 'Import key'}
            </Text>
          </Pressable>
          {status === 'unlocked' && (
            <View style={[styles.chip, { alignSelf: 'flex-start', marginTop: 10 }]}>
              <Text style={baseStyles.chipText}>Unlocked — opening chat…</Text>
            </View>
          )}
        </View>
      )}

      {chat.meta && (
        <View style={[glassCard, styles.card]}>
          <Text style={styles.cardTitle}>Wallet</Text>
          <Text style={baseStyles.subtitle}>
            Sending pays the HBAR network fee through your own wallet — the
            app never holds your signing key.
          </Text>
          {chat.account ? (
            <View style={[styles.chip, { alignSelf: 'flex-start', marginTop: 10 }]}>
              <Text style={baseStyles.chipText}>{chat.account}</Text>
            </View>
          ) : (
            <Pressable
              onPress={doWallet}
              disabled={busy === 'wallet'}
              style={[baseStyles.ghostButton, { marginTop: 10 }, busy === 'wallet' && styles.off]}
            >
              <Text style={baseStyles.ghostButtonText}>
                {busy === 'wallet' ? 'Waiting for wallet…' : 'Connect wallet '}
              </Text>
            </Pressable>
          )}
          {chat.pairingUri && (
            <Text style={[styles.pairing, { marginTop: 10 }]} selectable>
              {chat.pairingUri}
            </Text>
          )}
        </View>
      )}

      {status === 'error' && chat.unlock.message ? (
        <Text style={[baseStyles.error, { textAlign: 'center' }]}>{chat.unlock.message}</Text>
      ) : null}
      {error ? <Text style={[baseStyles.error, { textAlign: 'center' }]}>{error}</Text> : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: 16,
    gap: 14,
    alignItems: 'stretch',
  },
  brand: {
    color: colors.cyan,
    fontSize: 22,
    fontWeight: '800',
    textAlign: 'center',
    marginTop: 24,
  },
  card: {
    padding: 14,
    gap: 10,
  },
  cardTitle: {
    color: colors.text,
    fontSize: 15,
    fontWeight: '700',
  },
  input: {
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.hairline,
    borderRadius: radius.chip,
    color: colors.text,
    fontSize: 15,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  keyInput: {
    minHeight: 70,
    textAlignVertical: 'top',
  },
  off: {
    opacity: 0.35,
  },
  chip: {
    backgroundColor: colors.cyanFaint,
    borderColor: colors.cyanSoft,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  pairing: {
    color: colors.muted,
    fontSize: 10,
    lineHeight: 14,
  },
});
