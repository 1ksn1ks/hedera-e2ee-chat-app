// The messenger shell: header (back, topic, wallet) + grouped bubble list +
// bottom composer. Long-press on an OWN confirmed bubble opens edit mode in
// the composer (prefilled with the shown decrypted text); Save posts the
// editEncryptedMessage directive and the engine rewrites the bubble in
// place with the "edited" mark.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  FlatList,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import type { ViewToken } from '@react-native/virtualized-lists';
import { baseStyles, colors, radius } from '../theme';
import { Icon } from '../components/Icon';
import { Bubble, formatStamp, type E2eeChat } from '../hooks/useE2eeChat';
import { MessageBubble } from '../components/MessageBubble';
import { Composer } from '../components/Composer';
import { RelayStatus } from '../components/RelayStatus';
import { editOutgoingBytes, sendOutgoingBytes } from '../services/chatPayload';
import { nearKeysForView } from '../services/decryptSlots';
import { packFitting, type SealedMedia } from '../services/sealedMedia';
import { chatSenders, displayName, type ChatSender } from '../services/identity';
import {
  holdPreview,
  MEDIA_BLOCKED,
  pickLocalMedia,
  releaseHeldMedia,
  releasePreview,
  uploadChatMedia,
} from '../services/mediaCrypto';

interface DraftMedia {
  media: SealedMedia;
  preview: string;
  kind: 'image' | 'video';
}

interface Row {
  bubble: Bubble;
  showAvatar: boolean;
  showHeader: boolean;
  // Set on the first message of a new day: the divider label above it.
  day: string;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function dayKey(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

// Today / Yesterday / 6 Nov 2026, in the phone's own time zone.
function dayLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const key = dayKey(iso);
  if (key === dayKey(now.toISOString())) return 'Today';
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (key === dayKey(yesterday.toISOString())) return 'Yesterday';
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

interface Props {
  chat: E2eeChat;
}

// One choice in the "by sender" strip: everyone, or one person.
function SenderChip({
  label,
  count,
  avatar,
  active,
  onPress,
  onX,
}: {
  label: string;
  count: number;
  avatar?: string;
  active: boolean;
  onPress: () => void;
  onX?: (x: number) => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      onLayout={onX ? (e) => onX(e.nativeEvent.layout.x) : undefined}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      accessibilityLabel={`${label}, ${count} ${count === 1 ? 'message' : 'messages'}`}
      style={({ pressed }) => [styles.chip, active && styles.chipActive, pressed && styles.chipPressed]}
    >
      {avatar ? <Image source={{ uri: avatar }} style={styles.chipAvatar} /> : null}
      <Text style={[styles.chipText, active && styles.chipTextActive]} numberOfLines={1}>
        {label}
      </Text>
      <Text style={[styles.chipCount, active && styles.chipTextActive]}>{count}</Text>
    </Pressable>
  );
}

export function ChatScreen({ chat }: Props) {
  const [editing, setEditing] = useState<Bubble | null>(null);
  const [notice, setNotice] = useState('');
  const [draft, setDraft] = useState<DraftMedia | null>(null);
  const [attachBusy, setAttachBusy] = useState(false);
  const listRef = useRef<FlatList<Row>>(null);
  // Open at the newest message; follow new ones only while the reader is
  // already near the bottom, so scrolling back through history isn't yanked.
  const atBottomRef = useRef(true);
  const [nearKeys, setNearKeys] = useState<Set<string>>(() => new Set());
  const nearKeysRef = useRef(nearKeys);
  nearKeysRef.current = nearKeys;

  const topic = chat.meta?.topicId || '';
  const via = chat.meta?.via || '';
  const myName = chat.account ? displayName(chat.profiles[chat.account]) : '';

  // "By sender": the strip lists everyone who wrote here, A–Z. Picking one
  // shows only their messages; "All" is the normal time-ordered chat.
  const [peopleOpen, setPeopleOpen] = useState(false);
  const [onlyPayer, setOnlyPayer] = useState<string | null>(null);
  const senders = useMemo(() => chatSenders(chat.bubbles, chat.profiles), [chat.bubbles, chat.profiles]);
  const picked: ChatSender | null = onlyPayer ? senders.find((s) => s.payer === onlyPayer) || null : null;
  const showSender = useCallback((payer: string | null) => {
    // Land on the newest message of the new selection.
    atBottomRef.current = true;
    setOnlyPayer(payer);
    if (payer) setPeopleOpen(true);
  }, []);

  // Another chat starts unfiltered.
  useEffect(() => {
    setOnlyPayer(null);
    setPeopleOpen(false);
  }, [topic]);

  // Keep the chosen person's chip in view (it can sit off the right edge).
  const stripRef = useRef<ScrollView>(null);
  const chipX = useRef<Record<string, number>>({});
  const onlyPayerRef = useRef(onlyPayer);
  onlyPayerRef.current = onlyPayer;
  const revealChip = useCallback((payer: string | null) => {
    if (!payer) {
      stripRef.current?.scrollTo({ x: 0, animated: true });
      return;
    }
    const x = chipX.current[payer];
    if (x !== undefined) stripRef.current?.scrollTo({ x: Math.max(0, x - 56), animated: true });
  }, []);
  useEffect(() => {
    revealChip(onlyPayer);
  }, [onlyPayer, revealChip]);

  const flash = useCallback((text: string) => {
    setNotice(text);
    setTimeout(() => setNotice(''), 4000);
  }, []);

  useEffect(() => () => releaseHeldMedia(), []);

  useEffect(() => {
    if (!chat.account) setDraft(null);
  }, [chat.account]);

  const onAttach = useCallback(async () => {
    if (!chat.useRelay) {
      flash(MEDIA_BLOCKED);
      return;
    }
    const picked = await pickLocalMedia();
    if (!picked) return;
    setAttachBusy(true);
    const preview = holdPreview(picked.bytes, picked.mime);
    try {
      const uploaded = await uploadChatMedia({
        bytes: picked.bytes,
        mime: picked.mime,
        mode: 'relay',
        account: chat.account || '',
      });
      const kind = picked.mime.startsWith('video/') ? 'video' : 'image';
      const chip = uploaded.chipBytes ? holdPreview(uploaded.chipBytes, 'image/jpeg') : preview;
      if (chip !== preview) releasePreview(preview);
      setDraft((prev) => {
        if (prev && prev.preview && prev.preview !== chip) releasePreview(prev.preview);
        return { media: uploaded.media, preview: chip, kind };
      });
    } catch (e: unknown) {
      releasePreview(preview);
      flash(e instanceof Error ? e.message : 'Upload failed');
    } finally {
      setAttachBusy(false);
    }
  }, [chat.account, chat.useRelay, flash]);

  const onSend = useCallback(
    async (text: string) => {
      if (draft && !chat.useRelay) {
        flash(MEDIA_BLOCKED);
        return;
      }
      const res = await chat.send(text, draft?.media ?? null);
      if (!res.ok) {
        flash(res.error || 'Send failed');
        return;
      }
      if (res.droppedPoster) flash('Thumbnail too big for this message, sent without it');
      releaseHeldMedia();
      setDraft(null);
    },
    [chat, draft, flash]
  );

  const onSaveEdit = useCallback(
    async (text: string) => {
      if (!editing) return;
      const res = await chat.edit(editing, text);
      if (!res.ok) {
        flash(res.error || 'Edit was not saved');
        return;
      }
      setEditing(null);
      flash(res.droppedPoster ? 'Thumbnail too big for this message, sent without it' : 'Saved');
    },
    [chat, editing, flash]
  );

  const predictSend = useCallback(
    (text: string) => sendOutgoingBytes(packFitting(text, draft?.media ?? null).packed),
    [draft]
  );
  const predictEdit = useCallback(
    (text: string) => {
      if (!editing) return 0;
      const fit = packFitting(
        text,
        editing.media,
        editing.media ? '' : editing.image,
        editing.media ? '' : editing.poster
      );
      return editOutgoingBytes(
        {
          created: editing.created,
          timestamp: formatStamp(editing.created),
          image: editing.media ? undefined : editing.image || undefined,
        },
        fit.packed
      );
    },
    [editing]
  );

  // Grouping: the avatar + name show on the first message of a payer run.
  // A new day starts a new run under its own divider.
  const rows = useMemo(() => {
    const shown = onlyPayer ? chat.bubbles.filter((b) => b.payer === onlyPayer) : chat.bubbles;
    return shown.map((b, i) => {
      const prev = i > 0 ? shown[i - 1] : null;
      const newDay = !prev || dayKey(prev.created) !== dayKey(b.created);
      const newGroup = !prev || prev.payer !== b.payer || newDay;
      return {
        bubble: b,
        showAvatar: newGroup,
        showHeader: newGroup,
        day: newDay ? dayLabel(b.created) : '',
      };
    });
  }, [chat.bubbles, onlyPayer]);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  // Stable pair: FlatList ignores a changed onViewableItemsChanged.
  // The visible span plus one span above and below is about one screen
  // outside the viewport. Web bubbles ignore this and use IntersectionObserver.
  const viewabilityConfig = useRef({
    itemVisiblePercentThreshold: 0,
    minimumViewTime: 0,
  }).current;
  const onViewableItemsChanged = useRef(
    ({ viewableItems }: { viewableItems: Array<ViewToken<Row>> }) => {
      const nextKeys = nearKeysForView(
        rowsRef.current.map((row) => ({ key: row.bubble.sig })),
        viewableItems
      );
      const prev = nearKeysRef.current;
      if (prev.size === nextKeys.length && nextKeys.every((key) => prev.has(key))) return;
      const next = new Set(nextKeys);
      nearKeysRef.current = next;
      setNearKeys(next);
    }
  ).current;

  // Rows repaint when a profile card or the near set changes.
  const listExtra = useMemo(() => ({ nearKeys, profiles: chat.profiles }), [nearKeys, chat.profiles]);

  const composerDisabled = !chat.account || chat.unlock.status !== 'unlocked';
  const placeholder = !chat.account ? 'Connect a wallet to send' : 'Encrypted message';
  // A domain or payer opened the chat: show that name, with the id below.
  // A person's chat (opened by tapping them, or your own on login) shows
  // their username when they have one.
  const viaName = via && chat.profiles[via] ? displayName(chat.profiles[via]) || via : via;
  const title = viaName || topic;
  const who = chat.account ? myName || chat.account : 'read-only';

  return (
    <View style={baseStyles.screen}>
      <View style={styles.header}>
        <Pressable
          onPress={chat.leave}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Back"
          style={({ pressed }) => [styles.back, pressed && styles.backPressed]}
        >
          <Icon name="back" size={24} color={colors.text} />
        </Pressable>
        <View style={styles.topicMark}>
          <Icon name="lock" size={18} color={colors.cyan} />
        </View>
        <View style={styles.headerMid}>
          <Text style={styles.topic} numberOfLines={1}>
            {title}
          </Text>
          <Text style={styles.lockline} numberOfLines={1}>
            {via ? `${topic} · ` : ''}End-to-end encrypted · {who}
          </Text>
        </View>
        <Pressable
          onPress={() => {
            if (peopleOpen && !onlyPayer) setPeopleOpen(false);
            else setPeopleOpen(true);
          }}
          hitSlop={6}
          accessibilityRole="button"
          accessibilityLabel="Show messages by sender"
          accessibilityState={{ expanded: peopleOpen || !!onlyPayer }}
          style={({ pressed }) => [
            styles.peopleBtn,
            (peopleOpen || onlyPayer) && styles.peopleBtnActive,
            pressed && styles.backPressed,
          ]}
        >
          <Icon name="users" size={18} color={peopleOpen || onlyPayer ? colors.cyan : colors.textSoft} />
        </Pressable>
        <RelayStatus compact useRelay={chat.useRelay} transport={chat.transport} onToggle={chat.setUseRelay} />
      </View>

      {(peopleOpen || onlyPayer) && senders.length > 0 ? (
        <View style={styles.strip}>
          <ScrollView
            ref={stripRef}
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.stripRow}
          >
            <SenderChip
              label="All"
              count={chat.bubbles.length}
              active={!onlyPayer}
              onPress={() => showSender(null)}
            />
            {senders.map((s) => (
              <SenderChip
                key={s.payer}
                label={s.mine ? `${s.name} (you)` : s.name}
                count={s.count}
                avatar={s.avatar}
                active={onlyPayer === s.payer}
                onPress={() => showSender(onlyPayer === s.payer ? null : s.payer)}
                onX={(x) => {
                  chipX.current[s.payer] = x;
                  // The strip opened by an avatar tap lays out after the pick.
                  if (onlyPayerRef.current === s.payer) revealChip(s.payer);
                }}
              />
            ))}
          </ScrollView>
        </View>
      ) : null}

      <View style={styles.body}>
        {notice ? (
          <View style={styles.notice} pointerEvents="none">
            <Text style={styles.noticeText}>{notice}</Text>
          </View>
        ) : null}

        <FlatList<Row>
          ref={listRef}
          data={rows}
          extraData={listExtra}
          keyExtractor={(r) => r.bubble.sig}
          inverted={false}
          contentContainerStyle={styles.list}
          viewabilityConfig={viewabilityConfig}
          onViewableItemsChanged={onViewableItemsChanged}
          onScroll={(e) => {
            const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
            atBottomRef.current = contentSize.height - (contentOffset.y + layoutMeasurement.height) < 160;
          }}
          scrollEventThrottle={64}
          onContentSizeChange={() => {
            if (atBottomRef.current) listRef.current?.scrollToEnd({ animated: false });
          }}
          renderItem={({ item }) => (
            <>
              {item.day ? (
                <View style={styles.day}>
                  <Text style={styles.dayText}>{item.day}</Text>
                </View>
              ) : null}
              <MessageBubble
                bubble={item.bubble}
                profile={chat.profiles[item.bubble.payer]}
                showAvatar={item.showAvatar}
                showHeader={item.showHeader}
                stamp={formatStamp(item.bubble.created)}
                canEdit={item.bubble.mine}
                onEdit={(b) => setEditing(b)}
                near={nearKeys.has(item.bubble.sig)}
                onPickSender={showSender}
              />
            </>
          )}
          ListEmptyComponent={
            <View style={styles.empty}>
              <View style={styles.emptyMark}>
                <Icon name="lock" size={26} color={colors.cyan} />
              </View>
              <Text style={styles.emptyTitle}>
                {onlyPayer
                  ? `No messages from ${picked ? picked.name : onlyPayer}`
                  : chat.unlock.status === 'unlocked'
                    ? 'No messages yet'
                    : 'Locked'}
              </Text>
              <Text style={styles.emptyText}>
                {chat.unlock.status === 'unlocked'
                  ? chat.account
                    ? 'Say hello. Only holders of the topic key can read it.'
                    : 'Connect a wallet to send the first message.'
                  : 'Unlock the topic to read its messages.'}
              </Text>
            </View>
          }
        />
      </View>

      <Composer
        placeholder={placeholder}
        disabled={composerDisabled}
        busy={attachBusy}
        busyLabel={attachBusy ? 'Uploading…' : undefined}
        predict={editing ? predictEdit : predictSend}
        onSend={onSend}
        editing={editing ? { label: formatStamp(editing.created), initialText: editing.text } : null}
        onSaveEdit={onSaveEdit}
        onCancelEdit={() => setEditing(null)}
        attachment={draft ? { kind: draft.kind, preview: draft.preview } : null}
        onAttach={onAttach}
        onClearAttachment={() => {
          releaseHeldMedia();
          setDraft(null);
        }}
        mediaNote={chat.useRelay ? '' : MEDIA_BLOCKED}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingLeft: 6,
    paddingRight: 12,
    paddingVertical: 8,
    minHeight: 60,
    backgroundColor: colors.card,
    borderBottomWidth: 1,
    borderBottomColor: colors.hairline,
  },
  back: {
    width: 40,
    height: 40,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  backPressed: {
    backgroundColor: colors.cardRaised,
  },
  peopleBtn: {
    width: 36,
    height: 36,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.stroke,
    backgroundColor: colors.cardRaised,
  },
  peopleBtnActive: {
    borderColor: colors.cyanSoft,
    backgroundColor: colors.cyanFaint,
  },
  strip: {
    backgroundColor: colors.card,
    borderBottomWidth: 1,
    borderBottomColor: colors.hairline,
  },
  stripRow: {
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    height: 32,
    paddingLeft: 6,
    paddingRight: 10,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.stroke,
    backgroundColor: colors.cardRaised,
    maxWidth: 220,
  },
  chipActive: {
    borderColor: colors.cyan,
    backgroundColor: colors.cyanFaint,
  },
  chipPressed: {
    opacity: 0.8,
  },
  chipAvatar: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: colors.bg,
  },
  chipText: {
    color: colors.textSoft,
    fontSize: 13,
    fontWeight: '600',
    flexShrink: 1,
    paddingLeft: 4,
  },
  chipTextActive: {
    color: colors.cyan,
  },
  chipCount: {
    color: colors.muted,
    fontSize: 12,
    fontWeight: '600',
  },
  topicMark: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.cyanFaint,
    borderWidth: 1,
    borderColor: colors.cyanSoft,
  },
  headerMid: {
    flex: 1,
    minWidth: 0,
  },
  topic: {
    color: colors.text,
    fontSize: 16,
    fontWeight: '700',
  },
  lockline: {
    color: colors.muted,
    fontSize: 12,
    marginTop: 2,
  },
  body: {
    flex: 1,
  },
  notice: {
    position: 'absolute',
    top: 10,
    left: 16,
    right: 16,
    zIndex: 2,
    alignItems: 'center',
  },
  noticeText: {
    color: colors.text,
    fontSize: 13,
    fontWeight: '600',
    backgroundColor: colors.cardRaised,
    borderWidth: 1,
    borderColor: colors.cyanSoft,
    borderRadius: radius.pill,
    overflow: 'hidden',
    paddingVertical: 8,
    paddingHorizontal: 14,
  },
  list: {
    flexGrow: 1,
    paddingTop: 4,
    paddingBottom: 12,
  },
  day: {
    alignItems: 'center',
    paddingTop: 16,
    paddingBottom: 2,
  },
  dayText: {
    color: colors.textSoft,
    fontSize: 12,
    fontWeight: '600',
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.hairline,
    borderRadius: radius.pill,
    overflow: 'hidden',
    paddingVertical: 4,
    paddingHorizontal: 12,
  },
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
    gap: 8,
  },
  emptyMark: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.cyanFaint,
    marginBottom: 4,
  },
  emptyTitle: {
    color: colors.text,
    fontSize: 16,
    fontWeight: '700',
  },
  emptyText: {
    color: colors.muted,
    fontSize: 14,
    textAlign: 'center',
    lineHeight: 20,
    maxWidth: 280,
  },
});
