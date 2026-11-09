// Entry screen: topic id, domain, or payer id → connect (history metadata
// fetch) → unlock (keystore auto, password for admin-pinned keys, or key
// import) + wallet pairing for sending. With a wallet connected, the
// accounts it follows are listed under the input like the Globe map's
// E2EE field (followsuggest.js). No map, no feed — a messenger front door.
import React, { useMemo, useState, type ReactNode } from 'react';
import {
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type TextInputProps,
} from 'react-native';
import { baseStyles, colors, glassCard, MAX_FORM, noWebOutline, radius } from '../theme';
import type { E2eeChat } from '../hooks/useE2eeChat';
import { RelayStatus } from '../components/RelayStatus';
import { Icon, type IconName } from '../components/Icon';
import {
  avatarFor,
  displayName,
  followingEmptyText,
  followItems,
  peopleItems,
  type FollowItem,
} from '../services/identity';
import { copyText } from '../services/clipboard';

interface Props {
  chat: E2eeChat;
}

// followsuggest.js QUICK: the first rows, then "See all".
const QUICK = 5;

// A text field whose border turns cyan while it has focus.
function Field({ style, onFocus, onBlur, ...rest }: TextInputProps) {
  const [focused, setFocused] = useState(false);
  return (
    <TextInput
      placeholderTextColor={colors.muted}
      {...rest}
      onFocus={(e) => {
        setFocused(true);
        onFocus?.(e);
      }}
      onBlur={(e) => {
        setFocused(false);
        onBlur?.(e);
      }}
      style={[baseStyles.input, noWebOutline, focused && baseStyles.inputFocus, style]}
    />
  );
}

function Card({ icon, title, children }: { icon: IconName; title: string; children: ReactNode }) {
  return (
    <View style={[glassCard, styles.card]}>
      <View style={styles.cardHead}>
        <View style={styles.cardIcon}>
          <Icon name={icon} size={16} color={colors.cyan} />
        </View>
        <Text style={styles.cardTitle}>{title}</Text>
      </View>
      {children}
    </View>
  );
}

function PrimaryButton({
  label,
  onPress,
  disabled,
  ghost,
  icon,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  ghost?: boolean;
  icon?: IconName;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      style={({ pressed }) => [
        ghost ? baseStyles.ghostButton : baseStyles.cyanButton,
        pressed && !ghost && { backgroundColor: colors.cyanPressed },
        pressed && ghost && { backgroundColor: colors.card },
        disabled && baseStyles.buttonOff,
      ]}
    >
      {icon ? <Icon name={icon} size={18} color={ghost ? colors.text : colors.cyanText} /> : null}
      <Text style={ghost ? baseStyles.ghostButtonText : baseStyles.cyanButtonText}>{label}</Text>
    </Pressable>
  );
}

function FollowRow({ item, onPick, last }: { item: FollowItem; onPick: (item: FollowItem) => void; last: boolean }) {
  return (
    <Pressable
      onPress={() => onPick(item)}
      style={({ pressed }) => [styles.followRow, !last && styles.followRule, pressed && styles.followPressed]}
      accessibilityRole="button"
      accessibilityLabel={`Open ${item.username || item.id}`}
    >
      <Image source={{ uri: item.avatar }} style={[styles.followAvatar, item.dim && styles.followDim]} />
      <View style={[styles.followText, item.dim && styles.followDim]}>
        <Text style={styles.followName} numberOfLines={1}>
          {item.username || item.id}
        </Text>
        <Text style={styles.followId} numberOfLines={1}>
          {item.id}
          {item.dim ? ' · no chat topic' : ''}
        </Text>
      </View>
      <Icon name="chevron" size={16} color={colors.muted} />
    </Pressable>
  );
}

export function ConnectScreen({ chat }: Props) {
  const [topic, setTopic] = useState('');
  const [password, setPassword] = useState('');
  const [keyHex, setKeyHex] = useState('');
  const [newPw, setNewPw] = useState('');
  const [newPw2, setNewPw2] = useState('');
  const [busy, setBusy] = useState<'' | 'connect' | 'password' | 'key' | 'wallet' | 'setpw'>('');
  const [error, setError] = useState('');
  const [showAll, setShowAll] = useState(false);
  // Typing filters only the people you follow. Everyone else shows only
  // after "Search everyone" is tapped; clearing the field hides them again.
  const [searchEveryone, setSearchEveryone] = useState(false);
  // "Copied" shows for 2 s after the pairing link is copied.
  const [copied, setCopied] = useState(false);
  const doCopyPairing = async (uri: string) => {
    if (!uri) return;
    const ok = await copyText(uri);
    if (!ok) {
      setError("Couldn't copy. Long-press the link to select it instead.");
      return;
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  const [myNote, setMyNote] = useState('');

  const status = chat.unlock.status;

  // The field opens a topic id or a domain; a tapped person opens the topic
  // connected to their profile.
  const doConnect = async (value: string = topic, person = false) => {
    setBusy('connect');
    setError('');
    const res = await chat.connect(value, { person });
    if (!res.ok) setError(res.error || 'Connect failed');
    setBusy('');
  };

  const pickFollow = (item: FollowItem) => {
    setShowAll(false);
    void doConnect(item.id, true);
  };

  const followRows = useMemo(
    () => followItems(chat.following, chat.profiles, topic.trim()),
    [chat.following, chat.profiles, topic]
  );
  const followShown = showAll ? followRows : followRows.slice(0, QUICK);
  // Search by user: anyone with a profile, minus who is already under Following.
  const people = useMemo(
    () => peopleItems(chat.profiles, topic, new Set(chat.following.map((f) => f.id))),
    [chat.profiles, chat.following, topic]
  );
  const peopleShown = searchEveryone ? people.slice(0, QUICK) : [];
  const followEmpty = followingEmptyText(chat.followingStatus, chat.following.length, followRows.length);
  const me = chat.account ? chat.profiles[chat.account] : undefined;
  const myName = displayName(me);

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

  const canSetPw =
    busy === '' && !!keyHex.trim() && newPw.length >= 5 && newPw === newPw2;

  const doSetPassword = async () => {
    if (!canSetPw) return;
    setBusy('setpw');
    setError('');
    const res = await chat.setTopicPassword(keyHex, newPw);
    setBusy('');
    if (!res.ok) {
      setError(res.error || 'The password was not saved');
      return;
    }
    setNewPw('');
    setNewPw2('');
    setKeyHex('');
  };

  const doWallet = async () => {
    setBusy('wallet');
    setError('');
    setMyNote('');
    const res = await chat.walletConnect();
    if (!res.ok) setError(res.error || 'Wallet connect failed');
    setBusy('');
  };

  // Ends the saved session here and in the wallet.
  const doDisconnect = async () => {
    setBusy('wallet');
    setError('');
    setMyNote('');
    await chat.walletDisconnect();
    setBusy('');
  };

  // The "Open my E2EE chat" button: the topic connected to your profile.
  // No topic on your profile yet is a note, not an error.
  const doMyChat = async () => {
    setError('');
    setMyNote('');
    const res = await chat.openMyChat();
    if (!res.ok) setMyNote(res.error || '');
  };

  const connecting = status === 'connecting';
  const needsUnlock = status === 'need-key' || status === 'need-password';
  const shownError = error || (status === 'error' ? chat.unlock.message : '');

  return (
    <ScrollView
      style={baseStyles.screen}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
    >
      <View style={styles.column}>
        <View style={styles.hero}>
          <View style={styles.mark}>
            <Icon name="lock" size={26} color={colors.cyan} />
          </View>
          <Text style={styles.brand}>Hedera E2EE Chat</Text>
          <Text style={styles.tagline}>
            Messages are sealed to the topic key. Only holders of the topic
            private key can read them.
          </Text>
        </View>

        <RelayStatus useRelay={chat.useRelay} transport={chat.transport} onToggle={chat.setUseRelay} />

        <Card icon="hash" title="Open a chat">
          <Field
            value={topic}
            onChangeText={(text) => {
              setTopic(text);
              setShowAll(false);
              if (!text.trim()) setSearchEveryone(false);
            }}
            onSubmitEditing={() => {
              if (!connecting && topic.trim()) void doConnect();
            }}
            placeholder="Topic ID or domain"
            autoCapitalize="none"
            autoCorrect={false}
            editable={!connecting}
            returnKeyType="go"
          />
          {!chat.meta && (
            <View accessibilityLabel="Following">
              <View style={styles.followHead}>
                <Icon name="users" size={14} color={colors.muted} />
                <Text style={baseStyles.label}>
                  Following{chat.followingStatus === 'ready' ? ` · ${chat.following.length}` : ''}
                </Text>
              </View>
              {followShown.length > 0 && (
                <View style={styles.followList}>
                  {followShown.map((item, i) => (
                    <FollowRow
                      key={item.id}
                      item={item}
                      onPick={pickFollow}
                      last={i === followShown.length - 1}
                    />
                  ))}
                </View>
              )}
              {followRows.length > QUICK && (
                <Pressable onPress={() => setShowAll((v) => !v)} accessibilityRole="button" hitSlop={6}>
                  <Text style={styles.followMore}>
                    {showAll ? 'Show less' : `See all (${followRows.length})`}
                  </Text>
                </Pressable>
              )}
              {followEmpty ? (
                <Pressable
                  disabled={chat.followingStatus !== 'offline'}
                  onPress={() => {
                    void chat.refreshFollowing(true);
                  }}
                >
                  <Text style={styles.followEmpty}>{followEmpty}</Text>
                </Pressable>
              ) : null}
              {!searchEveryone && topic.trim() && people.length > 0 ? (
                <Pressable
                  onPress={() => setSearchEveryone(true)}
                  accessibilityRole="button"
                  hitSlop={6}
                  style={({ pressed }) => [styles.searchAll, pressed && styles.followPressed]}
                >
                  <Icon name="users" size={14} color={colors.cyan} />
                  <Text style={styles.searchAllText} numberOfLines={1}>
                    {`Search everyone for “${topic.trim()}” (${people.length})`}
                  </Text>
                </Pressable>
              ) : null}
              {peopleShown.length > 0 && (
                <View accessibilityLabel="People">
                  <View style={[styles.followHead, styles.peopleHead]}>
                    <Icon name="users" size={14} color={colors.muted} />
                    <Text style={baseStyles.label}>People</Text>
                  </View>
                  <View style={styles.followList}>
                    {peopleShown.map((item, i) => (
                      <FollowRow
                        key={item.id}
                        item={item}
                        onPick={pickFollow}
                        last={i === peopleShown.length - 1}
                      />
                    ))}
                  </View>
                  {people.length > QUICK && (
                    <Text style={styles.followEmpty}>
                      {`${people.length - QUICK} more. Keep typing to narrow it down.`}
                    </Text>
                  )}
                </View>
              )}
            </View>
          )}
          <PrimaryButton
            label={connecting ? 'Connecting…' : 'Connect'}
            onPress={() => {
              void doConnect();
            }}
            disabled={connecting || !topic.trim()}
          />
        </Card>

        {chat.meta && (
          <Card icon="key" title="Unlock">
            <View style={styles.topicLine}>
              <Icon name="hash" size={14} color={colors.muted} />
              <Text style={styles.topicText} numberOfLines={1}>
                {chat.meta.topicId}
                {chat.meta.via ? (
                  <Text style={styles.topicVia}>
                    {chat.meta.via === chat.account
                      ? '  your chat'
                      : `  via ${displayName(chat.profiles[chat.meta.via]) || chat.meta.via}`}
                  </Text>
                ) : null}
              </Text>
            </View>
            {status === 'need-password' && (
              <>
                <Text style={baseStyles.subtitle}>
                  This topic has a pinned key protected by a password. Enter it
                  to unwrap the topic key into your Keystore/Keychain.
                </Text>
                <Field
                  value={password}
                  onChangeText={setPassword}
                  onSubmitEditing={() => {
                    if (busy !== 'password' && password) void doPassword();
                  }}
                  placeholder="Password"
                  secureTextEntry
                  editable={busy !== 'password'}
                />
                <PrimaryButton
                  label={busy === 'password' ? 'Unwrapping…' : 'Unlock with password'}
                  onPress={doPassword}
                  disabled={busy === 'password' || !password}
                />
                <View style={styles.or}>
                  <View style={styles.orRule} />
                  <Text style={styles.orText}>or import the key</Text>
                  <View style={styles.orRule} />
                </View>
              </>
            )}
            {status === 'need-key' && (
              <Text style={baseStyles.subtitle}>
                This topic has no password yet. Paste the topic private key
                (DER hex) to open it, or save a password for it below so the
                password opens it from now on.
              </Text>
            )}
            {needsUnlock && (
              <>
                <Field
                  value={keyHex}
                  onChangeText={setKeyHex}
                  placeholder="Topic private key (DER hex)"
                  autoCapitalize="none"
                  autoCorrect={false}
                  editable={busy !== 'key'}
                  style={styles.keyInput}
                  multiline
                  numberOfLines={3}
                />
                <PrimaryButton
                  label={busy === 'key' ? 'Unlocking…' : 'Import key'}
                  onPress={doKey}
                  disabled={busy === 'key' || busy === 'setpw' || !keyHex.trim()}
                  ghost={status === 'need-password'}
                />
              </>
            )}
            {status === 'need-key' && (
              <>
                <View style={styles.or}>
                  <View style={styles.orRule} />
                  <Text style={styles.orText}>or save a password for it</Text>
                  <View style={styles.orRule} />
                </View>
                <Text style={baseStyles.subtitle}>
                  The key above is encrypted with your password and pinned on
                  this topic, the same as Set password in the Globe map. Your
                  wallet pays the HBAR fee. The password never leaves this
                  device.
                </Text>
                <Field
                  value={newPw}
                  onChangeText={setNewPw}
                  placeholder="New password (5+ characters)"
                  secureTextEntry
                  editable={busy !== 'setpw'}
                />
                <Field
                  value={newPw2}
                  onChangeText={setNewPw2}
                  onSubmitEditing={() => {
                    if (canSetPw) void doSetPassword();
                  }}
                  placeholder="Repeat password"
                  secureTextEntry
                  editable={busy !== 'setpw'}
                />
                {newPw2 && newPw !== newPw2 ? (
                  <Text style={styles.myNote}>The passwords don't match.</Text>
                ) : null}
                <PrimaryButton
                  label={busy === 'setpw' ? 'Confirm in your wallet…' : 'Save password and unlock'}
                  onPress={doSetPassword}
                  disabled={!canSetPw}
                  ghost
                  icon="key"
                />
              </>
            )}
            {status === 'unlocked' && (
              <View style={[baseStyles.chip, styles.chipRow]}>
                <Icon name="check" size={14} color={colors.cyan} />
                <Text style={baseStyles.chipText}>Unlocked, opening chat…</Text>
              </View>
            )}
          </Card>
        )}

        <Card icon="wallet" title="Wallet">
          {chat.account ? (
            <View style={styles.me}>
              <Image source={{ uri: avatarFor(me) }} style={styles.meAvatar} />
              <View style={styles.followText}>
                <Text style={styles.followName} numberOfLines={1}>
                  {myName || chat.account}
                </Text>
                {myName ? (
                  <Text style={styles.followId} numberOfLines={1}>
                    {chat.account}
                  </Text>
                ) : null}
              </View>
              <View style={[baseStyles.chip, styles.chipRow]}>
                <Icon name="check" size={12} color={colors.cyan} />
                <Text style={baseStyles.chipText}>Connected</Text>
              </View>
            </View>
          ) : null}
          {chat.account && !chat.meta ? (
            <Pressable
              onPress={() => {
                void doMyChat();
              }}
              disabled={connecting}
              accessibilityRole="button"
              accessibilityLabel="Open my E2EE chat"
              style={({ pressed }) => [styles.myChat, pressed && styles.followPressed, connecting && baseStyles.buttonOff]}
            >
              <View style={styles.cardIcon}>
                <Icon name="lock" size={16} color={colors.cyan} />
              </View>
              <View style={styles.followText}>
                <Text style={styles.followName}>Open my E2EE chat</Text>
                <Text style={styles.followId} numberOfLines={1}>
                  {me && me.topic ? me.topic : 'The topic connected to your profile'}
                </Text>
              </View>
              <Icon name="chevron" size={16} color={colors.muted} />
            </Pressable>
          ) : null}
          {chat.account && myNote ? <Text style={styles.myNote}>{myNote}</Text> : null}
          {chat.account ? (
            <Pressable
              onPress={() => {
                void doDisconnect();
              }}
              disabled={busy === 'wallet'}
              accessibilityRole="button"
              hitSlop={6}
              style={({ pressed }) => [styles.disconnect, pressed && styles.followPressed]}
            >
              <Text style={styles.disconnectText}>
                {busy === 'wallet' ? 'Disconnecting…' : 'Disconnect wallet'}
              </Text>
            </Pressable>
          ) : (
            <>
              <Text style={baseStyles.subtitle}>
                Sending pays the HBAR network fee through your own wallet. The
                app never holds your signing key. You stay connected after
                closing the app, until you disconnect.
              </Text>
              <PrimaryButton
                label={
                  chat.walletRestoring
                    ? 'Checking your wallet…'
                    : busy === 'wallet'
                      ? 'Waiting for wallet…'
                      : 'Connect wallet'
                }
                onPress={doWallet}
                disabled={busy === 'wallet' || chat.walletRestoring}
                ghost
                icon="wallet"
              />
            </>
          )}
          {chat.pairingUri && !chat.account && (
            <View style={styles.pairingBox}>
              <View style={styles.pairingHead}>
                <Text style={baseStyles.label}>Pairing link</Text>
                <Pressable
                  onPress={() => {
                    void doCopyPairing(chat.pairingUri || '');
                  }}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel="Copy pairing link"
                  style={({ pressed }) => [styles.copyBtn, copied && styles.copyBtnDone, pressed && styles.followPressed]}
                >
                  <Icon name={copied ? 'check' : 'copy'} size={14} color={colors.cyan} />
                  <Text style={styles.copyText}>{copied ? 'Copied' : 'Copy'}</Text>
                </Pressable>
              </View>
              <Text style={styles.pairing} selectable>
                {chat.pairingUri}
              </Text>
              <Text style={styles.pairingHint}>
                Paste it into your wallet's "connect with link" (WalletConnect).
              </Text>
            </View>
          )}
        </Card>

        {shownError ? (
          <View style={baseStyles.errorBox}>
            <Text style={baseStyles.error}>{shownError}</Text>
          </View>
        ) : null}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: {
    flexGrow: 1,
    paddingHorizontal: 16,
    paddingTop: 28,
    paddingBottom: 40,
  },
  column: {
    width: '100%',
    maxWidth: MAX_FORM,
    alignSelf: 'center',
    gap: 14,
  },
  hero: {
    alignItems: 'center',
    gap: 8,
    paddingBottom: 6,
  },
  mark: {
    width: 56,
    height: 56,
    borderRadius: radius.xl,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.cyanFaint,
    borderWidth: 1,
    borderColor: colors.cyanSoft,
    marginBottom: 4,
  },
  brand: {
    color: colors.text,
    fontSize: 24,
    fontWeight: '800',
    letterSpacing: -0.3,
    textAlign: 'center',
  },
  tagline: {
    color: colors.muted,
    fontSize: 14,
    lineHeight: 20,
    textAlign: 'center',
    maxWidth: 360,
  },
  card: {
    padding: 16,
    gap: 12,
  },
  cardHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  cardIcon: {
    width: 28,
    height: 28,
    borderRadius: radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.cyanFaint,
  },
  cardTitle: {
    color: colors.text,
    fontSize: 16,
    fontWeight: '700',
  },
  keyInput: {
    minHeight: 84,
    textAlignVertical: 'top',
    fontSize: 13,
  },
  followHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 2,
    marginBottom: 6,
  },
  peopleHead: {
    marginTop: 12,
  },
  searchAll: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 8,
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.hairline,
    backgroundColor: colors.sunken,
  },
  searchAllText: {
    color: colors.cyan,
    fontSize: 13,
    fontWeight: '600',
    flexShrink: 1,
  },
  followList: {
    backgroundColor: colors.sunken,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.hairline,
    overflow: 'hidden',
  },
  followRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 10,
    paddingHorizontal: 12,
  },
  followRule: {
    borderBottomWidth: 1,
    borderBottomColor: colors.hairline,
  },
  followPressed: {
    backgroundColor: colors.cyanFaint,
  },
  followDim: {
    opacity: 0.45,
  },
  followAvatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.cardRaised,
  },
  followText: {
    flex: 1,
    minWidth: 0,
  },
  followName: {
    color: colors.text,
    fontSize: 15,
    fontWeight: '600',
  },
  followId: {
    color: colors.muted,
    fontSize: 12,
    marginTop: 2,
  },
  followMore: {
    color: colors.cyan,
    fontSize: 13,
    fontWeight: '600',
    paddingTop: 10,
    paddingHorizontal: 2,
  },
  followEmpty: {
    color: colors.muted,
    fontSize: 13,
    paddingVertical: 4,
    paddingHorizontal: 2,
  },
  topicLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    alignSelf: 'flex-start',
    backgroundColor: colors.sunken,
    borderRadius: radius.sm,
    paddingHorizontal: 10,
    paddingVertical: 6,
    maxWidth: '100%',
  },
  topicText: {
    color: colors.text,
    fontSize: 13,
    fontWeight: '600',
    flexShrink: 1,
  },
  topicVia: {
    color: colors.muted,
    fontWeight: '400',
  },
  or: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginVertical: 2,
  },
  orRule: {
    flex: 1,
    height: 1,
    backgroundColor: colors.hairline,
  },
  orText: {
    color: colors.muted,
    fontSize: 12,
  },
  chipRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    alignSelf: 'flex-start',
  },
  me: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  meAvatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.cardRaised,
  },
  myChat: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: colors.sunken,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.hairline,
    paddingVertical: 10,
    paddingHorizontal: 12,
  },
  myNote: {
    color: colors.muted,
    fontSize: 13,
    lineHeight: 18,
  },
  disconnect: {
    alignSelf: 'flex-start',
    paddingVertical: 6,
    paddingHorizontal: 4,
    borderRadius: radius.sm,
  },
  disconnectText: {
    color: colors.danger,
    fontSize: 13,
    fontWeight: '600',
  },
  pairingHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  copyBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    height: 30,
    paddingHorizontal: 12,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.cyanSoft,
    backgroundColor: colors.cyanFaint,
  },
  copyBtnDone: {
    borderColor: colors.cyan,
  },
  copyText: {
    color: colors.cyan,
    fontSize: 13,
    fontWeight: '700',
  },
  pairingHint: {
    color: colors.muted,
    fontSize: 12,
    lineHeight: 16,
  },
  pairingBox: {
    gap: 6,
    backgroundColor: colors.sunken,
    borderRadius: radius.md,
    padding: 12,
  },
  pairing: {
    color: colors.textSoft,
    fontSize: 11,
    lineHeight: 16,
  },
});
