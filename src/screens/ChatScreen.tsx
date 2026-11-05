// The messenger shell: header (back, topic, wallet) + grouped bubble list +
// bottom composer. Long-press on an OWN confirmed bubble opens edit mode in
// the composer (prefilled with the shown decrypted text); Save posts the
// editEncryptedMessage directive and the engine rewrites the bubble in
// place with the "edited" mark.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import type { ViewToken } from '@react-native/virtualized-lists';
import { baseStyles, colors, glassCard } from '../theme';
import { Bubble, formatStamp, type E2eeChat } from '../hooks/useE2eeChat';
import { MessageBubble } from '../components/MessageBubble';
import { Composer } from '../components/Composer';
import { RelayStatus } from '../components/RelayStatus';
import { editOutgoingBytes, sendOutgoingBytes } from '../services/chatPayload';
import { nearKeysForView } from '../services/decryptSlots';
import { packFitting, type SealedMedia } from '../services/sealedMedia';
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
}

interface Props {
  chat: E2eeChat;
}

export function ChatScreen({ chat }: Props) {
  const [editing, setEditing] = useState<Bubble | null>(null);
  const [notice, setNotice] = useState('');
  const [draft, setDraft] = useState<DraftMedia | null>(null);
  const [attachBusy, setAttachBusy] = useState(false);
  const listRef = useRef<FlatList<Row>>(null);
  const [nearKeys, setNearKeys] = useState<Set<string>>(() => new Set());
  const nearKeysRef = useRef(nearKeys);
  nearKeysRef.current = nearKeys;

  const topic = chat.meta?.topicId || '';

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
  const rows = useMemo(
    () =>
      chat.bubbles.map((b, i) => {
        const prev = i > 0 ? chat.bubbles[i - 1] : null;
        const newGroup = !prev || prev.payer !== b.payer;
        return { bubble: b, showAvatar: newGroup, showHeader: newGroup };
      }),
    [chat.bubbles]
  );
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

  const composerDisabled = !chat.account || chat.unlock.status !== 'unlocked';

  return (
    <View style={baseStyles.screen}>
      <View style={[styles.header, glassCard, { borderRadius: 0, borderLeftWidth: 0, borderRightWidth: 0, borderTopWidth: 0 }]}>
        <Pressable onPress={chat.leave} hitSlop={8} accessibilityRole="button">
          <Text style={styles.back}>‹</Text>
        </Pressable>
        <View style={styles.headerMid}>
          <Text style={styles.topic} numberOfLines={1}>
            {topic}
          </Text>
          <Text style={styles.lockline}>
            🔒 end-to-end encrypted{chat.account ? `  ·  ${chat.account}` : '  ·  read-only (no wallet)'}
          </Text>
        </View>
      </View>

      <RelayStatus bleed useRelay={chat.useRelay} transport={chat.transport} onToggle={chat.setUseRelay} />

      {notice ? <View style={styles.noticeBar}><Text style={styles.noticeText}>{notice}</Text></View> : null}

      <FlatList<Row>
        ref={listRef}
        data={rows}
        extraData={nearKeys}
        keyExtractor={(r) => r.bubble.sig}
        inverted={false}
        contentContainerStyle={styles.list}
        viewabilityConfig={viewabilityConfig}
        onViewableItemsChanged={onViewableItemsChanged}
        onContentSizeChange={() => listRef.current?.scrollToOffset({ offset: 0, animated: false })}
        renderItem={({ item }) => (
          <MessageBubble
            bubble={item.bubble}
            showAvatar={item.showAvatar}
            showHeader={item.showHeader}
            stamp={formatStamp(item.bubble.created)}
            canEdit={item.bubble.mine}
            onEdit={(b) => setEditing(b)}
            near={nearKeys.has(item.bubble.sig)}
          />
        )}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyText}>
              {chat.unlock.status === 'unlocked'
                ? 'No messages yet — say hello (wallet needed to send).'
                : 'Unlock the topic to read its messages.'}
            </Text>
          </View>
        }
      />

      <Composer
        placeholder="Encrypted message…"
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
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: colors.card,
    borderBottomWidth: 1,
    borderBottomColor: colors.hairline,
  },
  back: {
    color: colors.cyan,
    fontSize: 30,
    lineHeight: 30,
    fontWeight: '600',
    paddingHorizontal: 2,
  },
  headerMid: {
    flex: 1,
  },
  topic: {
    color: colors.text,
    fontSize: 15,
    fontWeight: '700',
  },
  lockline: {
    color: colors.muted,
    fontSize: 11,
    marginTop: 1,
  },
  noticeBar: {
    backgroundColor: colors.cyanFaint,
    borderBottomWidth: 1,
    borderBottomColor: colors.cyanSoft,
    paddingVertical: 6,
    paddingHorizontal: 14,
  },
  noticeText: {
    color: colors.cyan,
    fontSize: 12,
    fontWeight: '600',
  },
  list: {
    flexGrow: 1,
    paddingBottom: 10,
  },
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  emptyText: {
    color: colors.muted,
    fontSize: 13,
    textAlign: 'center',
    lineHeight: 19,
  },
});
