// One chat row. Grouped like Signal/Telegram: the avatar column is only
// filled on the first message of a payer run (the list decides via
// showAvatar), own bubbles sit right with the cyan tint, the stamp is
// dd/mm/yy HH:MM, and a live edit rewrites text in place with an "edited"
// mark. Long-press on an OWN confirmed bubble offers Edit.
import React, { useEffect, useRef, useState } from 'react';
import {
  Image,
  Linking,
  Pressable,
  StyleSheet,
  Text,
  View,
  type GestureResponderEvent,
} from 'react-native';
import { colors, glassCard, radius } from '../theme';
import { Bubble } from '../hooks/useE2eeChat';
import { isVideoUrl, onMediaReleased, openSealedPart, releasePreview } from '../services/mediaCrypto';
import type { SealedPoster } from '../services/sealedMedia';

const AVATAR = 'https://kiloscribe.com/api/inscription-cdn/0.0.4819119';

interface Props {
  bubble: Bubble;
  showAvatar: boolean;
  showHeader: boolean;
  stamp: string;
  canEdit: boolean;
  onEdit: (bubble: Bubble) => void;
}

type OpenPart = { url?: string; b64?: string; fileKey: string; header: string; mime?: string; size?: number };

function partKey(part: OpenPart | null): string {
  if (!part || !part.fileKey || !part.header) return '';
  if (!part.url && !part.b64) return '';
  return `${part.fileKey}|${part.header}|${part.url || ''}|${part.b64 ? 'b' : ''}|${part.mime || ''}`;
}

// Decrypt into a memory URL. Logout and chat close revoke it.
function useMemoryUrl(part: OpenPart | null): { uri: string; failed: boolean } {
  const [uri, setUri] = useState('');
  const [failed, setFailed] = useState(false);
  const partRef = useRef(part);
  partRef.current = part;
  const key = partKey(part);
  useEffect(() => onMediaReleased(() => setUri('')), []);
  useEffect(() => {
    const current = partRef.current;
    if (!key || !current) {
      setUri('');
      setFailed(false);
      return;
    }
    let dead = false;
    let opened = '';
    setFailed(false);
    openSealedPart(current).then(
      (next) => {
        if (dead) {
          releasePreview(next);
          return;
        }
        opened = next;
        setUri(next);
      },
      () => {
        if (!dead) setFailed(true);
      }
    );
    return () => {
      dead = true;
      if (opened) releasePreview(opened);
    };
  }, [key]);
  return { uri, failed };
}

function posterPart(poster: SealedPoster | undefined): OpenPart | null {
  if (!poster || !poster.fileKey || !poster.header) return null;
  if (!poster.b64 && !poster.url) return null;
  return poster;
}

// A sealed file decrypts in memory. An old {t,i} link stays a clear URL
// and is labelled "unencrypted (old)". A failure says "Can't decrypt".
function MediaFrame({ bubble }: { bubble: Bubble }) {
  const sealed = bubble.media;
  const usable = !!(sealed && sealed.fileKey && sealed.header && sealed.url);
  const video = sealed ? sealed.mime.startsWith('video/') : isVideoUrl(bubble.image);
  const [playing, setPlaying] = useState(false);
  const [broken, setBroken] = useState(false);
  const poster = useMemoryUrl(usable && sealed?.poster ? posterPart(sealed.poster) : null);
  const still = useMemoryUrl(usable && sealed && !video ? sealed : null);
  const inlineVideo = typeof document !== 'undefined';
  const clip = useMemoryUrl(usable && sealed && video && playing && inlineVideo ? sealed : null);
  const legacy = bubble.legacyPlain ? <Text style={styles.legacy}>unencrypted (old)</Text> : null;
  if (!sealed && !bubble.image && !bubble.poster) return null;
  const failed =
    broken ||
    (!!sealed && !usable) ||
    still.failed ||
    (playing && clip.failed);
  if (failed) {
    return (
      <View style={styles.failBox}>
        <Text style={styles.fail}>Can't decrypt</Text>
        {legacy}
      </View>
    );
  }
  if (video && playing && (sealed ? clip.uri : bubble.image)) {
    return (
      <View style={styles.mediaWrap}>
        <Playable
          uri={sealed ? clip.uri : bubble.image}
          poster={sealed ? poster.uri : bubble.poster}
          memory={!!sealed}
          onError={() => setBroken(true)}
        />
        {legacy}
      </View>
    );
  }
  if (video) {
    const stillUri = sealed ? poster.uri : bubble.poster;
    return (
      <View>
        <View style={styles.mediaWrap}>
          {stillUri ? (
            <Image source={{ uri: stillUri }} style={styles.image} resizeMode="cover" />
          ) : (
            <View style={[styles.image, styles.posterEmpty]} />
          )}
          <View style={styles.playOverlay} pointerEvents="box-none">
            <Pressable
              onPress={() => {
                if (sealed && !inlineVideo) return;
                setPlaying(true);
              }}
              style={styles.play}
              accessibilityRole="button"
              accessibilityLabel="Play video"
              hitSlop={8}
            >
              <View style={styles.playTriangle} />
            </Pressable>
          </View>
        </View>
        {legacy}
      </View>
    );
  }
  const stillUri = sealed ? still.uri : bubble.image || bubble.poster;
  if (sealed && !stillUri) return <View style={[styles.image, styles.posterEmpty]} />;
  return (
    <View>
      <Image
        source={{ uri: stillUri }}
        style={styles.image}
        resizeMode="cover"
        onError={() => setBroken(true)}
      />
      {legacy}
    </View>
  );
}

function Playable({
  uri,
  poster,
  onError,
  memory,
}: {
  uri: string;
  poster: string;
  onError: () => void;
  memory?: boolean;
}) {
  if (typeof document === 'undefined') {
    if (memory) {
      return (
        <View style={styles.failBox}>
          <Text style={styles.fail}>Play</Text>
        </View>
      );
    }
    return (
      <Pressable onPress={() => Linking.openURL(uri)} style={styles.failBox} accessibilityRole="button">
        <Text style={styles.fail}>Play</Text>
      </Pressable>
    );
  }
  return React.createElement('video' as unknown as 'div', {
    src: uri,
    poster: poster || undefined,
    controls: true,
    playsInline: true,
    autoPlay: true,
    onError,
    style: {
      width: 240,
      height: 160,
      borderRadius: 8,
      marginTop: 6,
      backgroundColor: colors.bg,
      objectFit: 'cover',
    },
  });
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
          <MediaFrame bubble={bubble} />
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
  mediaWrap: {
    marginTop: 6,
    alignSelf: 'flex-start',
    position: 'relative',
  },
  image: {
    width: 240,
    height: 160,
    borderRadius: 8,
    backgroundColor: colors.bg,
  },
  posterEmpty: {
    backgroundColor: colors.cardRaised,
  },
  playOverlay: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  play: {
    width: 44,
    height: 44,
    borderRadius: 22,
    borderWidth: 2,
    borderColor: colors.cyan,
    backgroundColor: 'rgba(10,10,10,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  playTriangle: {
    width: 0,
    height: 0,
    marginLeft: 3,
    borderTopWidth: 7,
    borderBottomWidth: 7,
    borderLeftWidth: 12,
    borderTopColor: 'transparent',
    borderBottomColor: 'transparent',
    borderLeftColor: colors.cyan,
  },
  legacy: {
    color: colors.muted,
    fontSize: 10,
    marginTop: 4,
  },
  failBox: {
    width: 240,
    minHeight: 72,
    borderRadius: 8,
    marginTop: 6,
    backgroundColor: colors.cardRaised,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 10,
  },
  fail: {
    color: colors.muted,
    fontSize: 12,
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
