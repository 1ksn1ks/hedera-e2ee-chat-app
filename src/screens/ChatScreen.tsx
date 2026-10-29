// The messenger shell: header (back, topic, wallet) + grouped bubble list +
// bottom composer. Long-press on an OWN confirmed bubble opens edit mode in
// the composer (prefilled with the shown decrypted text); Save posts the
// editEncryptedMessage directive and the engine rewrites the bubble in
// place with the "edited" mark.
import React, { useCallback, useMemo, useRef, useState } from 'react';
import {
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { baseStyles, colors, glassCard } from '../theme';
import { Bubble, formatStamp, type E2eeChat } from '../hooks/useE2eeChat';
import { MessageBubble } from '../components/MessageBubble';
import { Composer } from '../components/Composer';
import { editOutgoingBytes, sendOutgoingBytes } from '../services/chatPayload';

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
  const listRef = useRef<FlatList<Row>>(null);

  const topic = chat.meta?.topicId || '';

  const flash = useCallback((text: string) => {
    setNotice(text);
    setTimeout(() => setNotice(''), 4000);
  }, []);

  const onSend = useCallback(
    async (text: string) => {
      const res = await chat.send(text, '');
      if (!res.ok) flash(res.error || 'Send failed');
    },
    [chat, flash]
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
      flash('Saved');
    },
    [chat, editing, flash]
  );

  const predictSend = useCallback((text: string) => sendOutgoingBytes(text, ''), []);
  const predictEdit = useCallback(
    (text: string) =>
      editing
        ? editOutgoingBytes(
            {
              created: editing.created,
              timestamp: formatStamp(editing.created),
              image: editing.image || undefined,
            },
            text,
            editing.image
          )
        : 0,
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

      {notice ? <View style={styles.noticeBar}><Text style={styles.noticeText}>{notice}</Text></View> : null}

      <FlatList<Row>
        ref={listRef}
        data={rows}
        keyExtractor={(r) => r.bubble.sig}
        inverted={false}
        contentContainerStyle={styles.list}
        onContentSizeChange={() => listRef.current?.scrollToOffset({ offset: 0, animated: false })}
        renderItem={({ item }) => (
          <MessageBubble
            bubble={item.bubble}
            showAvatar={item.showAvatar}
            showHeader={item.showHeader}
            stamp={formatStamp(item.bubble.created)}
            canEdit={item.bubble.mine}
            onEdit={(b) => setEditing(b)}
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
        busy={false}
        predict={editing ? predictEdit : predictSend}
        onSend={onSend}
        editing={editing ? { label: formatStamp(editing.created), initialText: editing.text } : null}
        onSaveEdit={onSaveEdit}
        onCancelEdit={() => setEditing(null)}
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
