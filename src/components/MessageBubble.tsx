// One chat row. Grouped like Signal/Telegram: the avatar column is only
// filled on the first message of a payer run (the list decides via
// showAvatar), own bubbles sit right with the cyan tint, the stamp is
// dd/mm/yy HH:MM, and a live edit rewrites text in place with an "edited"
// mark. Long-press on an OWN confirmed bubble offers Edit.
import React, { useState } from 'react';
import {
  Image,
  Pressable,
  StyleSheet,
  Text,
  View,
  type GestureResponderEvent,
} from 'react-native';
import { colors, glassCard, radius } from '../theme';
import { Bubble } from '../hooks/useE2eeChat';

const AVATAR = 'https://kiloscribe.com/api/inscription-cdn/0.0.4819119';

interface Props {
  bubble: Bubble;
  showAvatar: boolean;
  showHeader: boolean;
  stamp: string;
  canEdit: boolean;
  onEdit: (bubble: Bubble) => void;
}

export function MessageBubble({ bubble, showAvatar, showHeader, stamp, canEdit, onEdit }: Props) {
  const [expanded, setExpanded] = useState(false);
  const mine = bubble.mine;
  const long = bubble.text.length > 400;

  const handleLongPress = (e: GestureResponderEvent) => {
    if (canEdit && !bubble.pending) onEdit(bubble);
  };

  return (
    <View
      style={[
        styles.row,
        mine && styles.rowMine,
        !showAvatar && { paddingTop: 2 },
        showAvatar && { paddingTop: 10 },
      ]}
    >
      <View style={styles.avatarCol}>
        {showAvatar && (
          <View style={styles.avatarWrap}>
            <Image
              source={{ uri: AVATAR }}
              style={styles.avatar}
              onError={() => {}}
            />
            {showHeader && (
              <Text style={[styles.payerName, mine && styles.payerNameMine]} numberOfLines={1}>
                {mine ? 'you' : bubble.payer}
              </Text>
            )}
          </View>
        )}
      </View>
      <View style={[styles.bubbleCol, mine && styles.bubbleColMine]}>
        <Pressable
          onLongPress={handleLongPress}
          style={[
            styles.bubble,
            glassCard,
            mine ? styles.bubbleMine : styles.bubbleTheirs,
            long && !expanded && styles.bubbleClamped,
          ]}
          accessibilityRole="button"
          accessibilityLabel={`${bubble.payer} message`}
        >
          {bubble.text ? (
            <Text style={[styles.body, mine && styles.bodyMine]} selectable={false}>
              {expanded ? bubble.text : long ? bubble.text.slice(0, 400) : bubble.text}
            </Text>
          ) : null}
          {bubble.image ? (
            <Image source={{ uri: bubble.image }} style={styles.image} resizeMode="contain" />
          ) : null}
          {long && (
            <Pressable onPress={() => setExpanded((v) => !v)}>
              <Text style={styles.more}>{expanded ? 'Show less' : 'Show more'}</Text>
            </Pressable>
          )}
          <View style={styles.metaRow}>
            {bubble.edited && <Text style={styles.edited}>edited</Text>}
            <Text style={[styles.stamp, mine && styles.stampMine]}>
              {bubble.pending ? 'sending…' : stamp}
            </Text>
          </View>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingHorizontal: 12,
  },
  rowMine: {
    flexDirection: 'row-reverse',
  },
  avatarCol: {
    width: 64,
    alignItems: 'center',
    justifyContent: 'flex-end',
    paddingBottom: 4,
  },
  avatarWrap: {
    alignItems: 'center',
  },
  avatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.cardRaised,
  },
  payerName: {
    color: colors.cyan,
    fontSize: 11,
    fontWeight: '600',
    marginTop: 3,
  },
  payerNameMine: {
    color: colors.muted,
  },
  bubbleCol: {
    flex: 1,
    flexDirection: 'row',
  },
  bubbleColMine: {
    justifyContent: 'flex-end',
  },
  bubble: {
    maxWidth: '82%',
    paddingVertical: 8,
    paddingHorizontal: 12,
    marginBottom: 6,
  },
  bubbleTheirs: {
    borderRadius: radius.bubble,
    borderTopLeftRadius: 4,
    backgroundColor: colors.card,
  },
  bubbleMine: {
    borderRadius: radius.bubble,
    borderTopRightRadius: 4,
    backgroundColor: colors.cyanFaint,
    borderColor: colors.cyanSoft,
  },
  bubbleClamped: {
    overflow: 'hidden',
  },
  body: {
    color: colors.text,
    fontSize: 15,
    lineHeight: 21,
  },
  bodyMine: {
    color: colors.text,
  },
  image: {
    maxHeight: 220,
    maxWidth: 260,
    borderRadius: 8,
    marginTop: 2,
    backgroundColor: colors.bg,
  },
  more: {
    color: colors.cyan,
    fontSize: 12,
    fontWeight: '600',
    marginTop: 4,
  },
  metaRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
    gap: 5,
    marginTop: 4,
  },
  edited: {
    color: colors.muted,
    fontSize: 10,
    fontStyle: 'italic',
  },
  stamp: {
    color: colors.muted,
    fontSize: 10,
  },
  stampMine: {
    color: colors.muted,
  },
});
