// One chat row. Grouped like Signal/Telegram: the avatar column is only
// filled on the first message of a payer run (the list decides via
// showAvatar), own bubbles sit right with the cyan tint, the stamp is
// dd/mm/yy HH:MM, and a live edit rewrites text in place with an "edited"
// mark. Long-press on an OWN confirmed bubble offers Edit.
import React, { useEffect, useRef, useState, type RefObject } from 'react';
import {
  AccessibilityInfo,
  Image,
  Linking,
  Pressable,
  StyleSheet,
  Text,
  View,
  requireNativeComponent,
  type GestureResponderEvent,
  type ViewStyle,
} from 'react-native';
import { colors, radius } from '../theme';
import { Bubble } from '../hooks/useE2eeChat';
import { decryptGate } from '../services/decryptSlots';
import { isVideoUrl, onMediaReleased, openSealedPart, releasePreview } from '../services/mediaCrypto';
import type { SealedPoster } from '../services/sealedMedia';
import {
  avatarFor,
  DEFAULT_AVATAR,
  displayName,
  explorerUrl,
  safeHttpUrl,
  type Profile,
} from '../services/identity';

interface Props {
  bubble: Bubble;
  /** The sender's profile card, if they have one. */
  profile?: Profile;
  showAvatar: boolean;
  showHeader: boolean;
  stamp: string;
  canEdit: boolean;
  onEdit: (bubble: Bubble) => void;
  /** Native list signal. Web uses IntersectionObserver and ignores this. */
  near: boolean;
}

// Profile picture, or the default one when there is none or it fails to load.
function Avatar({ profile }: { profile?: Profile }) {
  const uri = avatarFor(profile);
  const [failed, setFailed] = useState('');
  return (
    <Image
      source={{ uri: failed === uri ? DEFAULT_AVATAR : uri }}
      style={styles.avatar}
      onError={() => {
        if (uri !== DEFAULT_AVATAR) setFailed(uri);
      }}
      accessibilityLabel="Profile photo"
    />
  );
}

// First message of a run: account id (opens the explorer) then the
// username, which opens the sender's own link when it is http(s) —
// the Globe map's chat header (encryptedtopicchat.js, payerlink.js).
function RunHeader({ payer, profile, mine }: { payer: string; profile?: Profile; mine: boolean }) {
  const name = displayName(profile);
  const link = safeHttpUrl(profile && profile.click2url);
  return (
    <View style={[styles.runHeader, mine && styles.runHeaderMine]}>
      <Text
        style={styles.accid}
        numberOfLines={1}
        accessibilityRole="link"
        onPress={() => {
          void Linking.openURL(explorerUrl(payer));
        }}
      >
        {payer}
      </Text>
      {name ? (
        <Text
          style={styles.username}
          numberOfLines={1}
          accessibilityRole={link ? 'link' : undefined}
          onPress={
            link
              ? () => {
                  void Linking.openURL(link);
                }
              : undefined
          }
        >
          {name}
        </Text>
      ) : null}
    </View>
  );
}

type OpenPart = { url?: string; b64?: string; fileKey: string; header: string; mime?: string; size?: number };

type SealedVideoProps = { src: string; style?: ViewStyle; loop?: boolean; muted?: boolean };

let SealedVideo: React.ComponentType<SealedVideoProps> | null = null;

function NativeClip({ src, style, loop, muted }: SealedVideoProps) {
  if (!SealedVideo) SealedVideo = requireNativeComponent<SealedVideoProps>('SealedVideo');
  const Clip = SealedVideo;
  return <Clip src={src} style={style} loop={loop} muted={muted} />;
}

function gifClipOf(media: { mime?: string; gif?: unknown } | null | undefined): boolean {
  if (!media || typeof media.mime !== 'string' || !media.mime.startsWith('video/')) return false;
  return media.gif === 1 || media.gif === true;
}

// e2eechatview.js motionReduced. A throw means motion is allowed.
function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    let dead = false;
    const apply = (on: boolean) => {
      if (!dead) setReduced(on);
    };
    try {
      if (typeof matchMedia === 'function') {
        const query = matchMedia('(prefers-reduced-motion: reduce)');
        apply(!!query.matches);
        const onChange = () => apply(!!query.matches);
        if (typeof query.addEventListener === 'function') query.addEventListener('change', onChange);
        else (query as MediaQueryList & { addListener?: (fn: () => void) => void }).addListener?.(onChange);
        return () => {
          dead = true;
          if (typeof query.removeEventListener === 'function') query.removeEventListener('change', onChange);
          else (query as MediaQueryList & { removeListener?: (fn: () => void) => void }).removeListener?.(onChange);
        };
      }
    } catch {
      apply(false);
    }
    let sub: { remove: () => void } | undefined;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((on) => apply(!!on))
      .catch(() => apply(false));
    sub = AccessibilityInfo.addEventListener('reduceMotionChanged', (on) => apply(!!on));
    return () => {
      dead = true;
      sub?.remove();
    };
  }, []);
  return reduced;
}

function partKey(part: OpenPart | null): string {
  if (!part || !part.fileKey || !part.header) return '';
  if (!part.url && !part.b64) return '';
  return `${part.fileKey}|${part.header}|${part.url || ''}|${part.b64 ? 'b' : ''}|${part.mime || ''}`;
}

// Decrypt into a memory URL only while the bubble is near the screen.
// Logout, chat close, and scrolling far away revoke it. At most two
// decrypts run at once (decryptGate). A queued one is dropped if the
// bubble leaves before its turn.
function useMemoryUrl(part: OpenPart | null, near: boolean): { uri: string; failed: boolean } {
  const [uri, setUri] = useState('');
  const [failed, setFailed] = useState(false);
  const partRef = useRef(part);
  partRef.current = part;
  const key = partKey(part);
  useEffect(() => onMediaReleased(() => setUri('')), []);
  useEffect(() => {
    const current = partRef.current;
    if (!near || !key || !current) {
      setUri('');
      setFailed(false);
      return;
    }
    let dead = false;
    let opened = '';
    setFailed(false);
    const job = decryptGate.run(() => openSealedPart(current));
    job.promise.then(
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
      job.cancel();
      if (opened) releasePreview(opened);
    };
  }, [key, near]);
  return { uri, failed };
}

// Web: one viewport above and below (rootMargin percentages are of the root).
// Native has no IntersectionObserver, so the FlatList `near` flag is used.
function useBubbleNear(hostRef: RefObject<View | null>, listNear: boolean): boolean {
  const [mode, setMode] = useState<'pending' | 'web' | 'list'>(
    typeof IntersectionObserver === 'function' ? 'pending' : 'list'
  );
  const [hit, setHit] = useState(false);
  useEffect(() => {
    if (typeof IntersectionObserver !== 'function') {
      setMode('list');
      return;
    }
    const node = hostRef.current as unknown as Element | null;
    if (!node || typeof node.getBoundingClientRect !== 'function') {
      setMode('list');
      return;
    }
    let observer: IntersectionObserver | null = null;
    let dead = false;
    try {
      observer = new IntersectionObserver(
        (entries) => {
          if (dead) return;
          const entry = entries[entries.length - 1];
          setHit(!!entry && entry.isIntersecting);
          setMode('web');
        },
        { root: null, rootMargin: '100% 0px', threshold: 0 }
      );
      observer.observe(node);
    } catch {
      observer?.disconnect();
      setMode('list');
      return;
    }
    return () => {
      dead = true;
      observer?.disconnect();
    };
  }, [hostRef]);
  if (mode === 'web') return hit;
  if (mode === 'list') return listNear;
  return false;
}

function posterPart(poster: SealedPoster | undefined): OpenPart | null {
  if (!poster || !poster.fileKey || !poster.header) return null;
  if (!poster.b64 && !poster.url) return null;
  return poster;
}

// A sealed file decrypts in memory. An old {t,i} link stays a clear URL
// and is labelled "unencrypted (old)". A failure says "Can't decrypt".
function MediaFrame({ bubble, near }: { bubble: Bubble; near: boolean }) {
  const sealed = bubble.media;
  const usable = !!(sealed && sealed.fileKey && sealed.header && sealed.url);
  const video = sealed ? sealed.mime.startsWith('video/') : isVideoUrl(bubble.image);
  const gifClip = gifClipOf(sealed);
  const reduced = useReducedMotion();
  const gifPlay = gifClip && !reduced;
  const [playing, setPlaying] = useState(false);
  const [broken, setBroken] = useState(false);
  const poster = useMemoryUrl(usable && sealed?.poster ? posterPart(sealed.poster) : null, near);
  const still = useMemoryUrl(usable && sealed && !video ? sealed : null, near);
  const clip = useMemoryUrl(usable && sealed && video && (playing || gifPlay) ? sealed : null, near);
  const legacy = bubble.legacyPlain ? <Text style={styles.legacy}>unencrypted (old)</Text> : null;
  if (!sealed && !bubble.image && !bubble.poster) return null;
  const failed =
    broken ||
    (!!sealed && !usable) ||
    still.failed ||
    ((playing || gifPlay) && clip.failed);
  if (failed) {
    return (
      <View style={styles.failBox}>
        <Text style={styles.fail}>Can't decrypt</Text>
        {legacy}
      </View>
    );
  }
  if (video && (playing || gifPlay) && (sealed ? clip.uri : bubble.image)) {
    return (
      <View style={styles.mediaWrap}>
        <Playable
          uri={sealed ? clip.uri : bubble.image}
          poster={sealed ? poster.uri : bubble.poster}
          memory={!!sealed}
          gifClip={gifClip}
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
          {gifClip ? null : (
            <View style={styles.playOverlay} pointerEvents="box-none">
              <Pressable
                onPress={() => {
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
          )}
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
  gifClip,
}: {
  uri: string;
  poster: string;
  onError: () => void;
  memory?: boolean;
  gifClip?: boolean;
}) {
  if (typeof document === 'undefined') {
    if (memory) return <NativeClip src={uri} style={styles.image} loop={!!gifClip} muted={!!gifClip} />;
    return (
      <Pressable onPress={() => Linking.openURL(uri)} style={styles.failBox} accessibilityRole="button">
        <Text style={styles.fail}>Play</Text>
      </Pressable>
    );
  }
  return React.createElement('video' as unknown as 'div', {
    src: uri,
    poster: poster || undefined,
    controls: !gifClip,
    muted: !!gifClip,
    loop: !!gifClip,
    playsInline: true,
    autoPlay: true,
    onError,
    style: {
      width: 240,
      height: 160,
      borderRadius: radius.md,
      marginTop: 6,
      backgroundColor: colors.bg,
      objectFit: 'cover',
    },
  });
}

export function MessageBubble({ bubble, profile, showAvatar, showHeader, stamp, canEdit, onEdit, near }: Props) {
  const [expanded, setExpanded] = useState(false);
  const hostRef = useRef<View>(null);
  const onScreen = useBubbleNear(hostRef, near);
  const mine = bubble.mine;
  const long = bubble.text.length > 400;

  const handleLongPress = (e: GestureResponderEvent) => {
    if (canEdit && !bubble.pending) onEdit(bubble);
  };

  return (
    <View
      ref={hostRef}
      style={[styles.row, mine && styles.rowMine, showAvatar ? styles.rowFirst : styles.rowNext]}
    >
      <View style={styles.avatarCol}>{showAvatar && <Avatar profile={profile} />}</View>
      <View style={[styles.bubbleCol, mine && styles.bubbleColMine]}>
        {showHeader && <RunHeader payer={bubble.payer} profile={profile} mine={mine} />}
        <Pressable
          onLongPress={handleLongPress}
          style={({ pressed }) => [
            styles.bubble,
            mine ? styles.bubbleMine : styles.bubbleTheirs,
            showHeader && (mine ? styles.firstMine : styles.firstTheirs),
            bubble.pending && styles.bubblePending,
            pressed && canEdit && !bubble.pending && styles.bubblePressed,
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
          <MediaFrame bubble={bubble} near={onScreen} />
          {long && (
            <Pressable onPress={() => setExpanded((v) => !v)} hitSlop={6}>
              <Text style={styles.more}>{expanded ? 'Show less' : 'Show more'}</Text>
            </Pressable>
          )}
          <View style={styles.metaRow}>
            {bubble.edited && <Text style={[styles.edited, mine && styles.metaMine]}>edited</Text>}
            <Text style={[styles.stamp, mine && styles.metaMine]}>
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
    alignItems: 'flex-start',
    paddingHorizontal: 10,
  },
  rowFirst: {
    paddingTop: 14,
  },
  rowNext: {
    paddingTop: 3,
  },
  rowMine: {
    flexDirection: 'row-reverse',
  },
  avatarCol: {
    width: 44,
    alignItems: 'center',
  },
  avatar: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: colors.cardRaised,
  },
  bubbleCol: {
    flex: 1,
    alignItems: 'flex-start',
  },
  bubbleColMine: {
    alignItems: 'flex-end',
  },
  runHeader: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 6,
    maxWidth: '80%',
    marginBottom: 4,
    paddingHorizontal: 4,
  },
  runHeaderMine: {
    flexDirection: 'row-reverse',
  },
  accid: {
    color: colors.muted,
    fontSize: 11,
    flexShrink: 0,
  },
  username: {
    color: colors.cyan,
    fontSize: 13,
    fontWeight: '700',
    flexShrink: 1,
  },
  bubble: {
    maxWidth: '80%',
    paddingTop: 8,
    paddingBottom: 6,
    paddingHorizontal: 12,
    borderRadius: radius.bubble,
  },
  bubbleTheirs: {
    backgroundColor: colors.bubbleTheirs,
  },
  bubbleMine: {
    backgroundColor: colors.bubbleMine,
  },
  // The first bubble of a run points at its avatar.
  firstTheirs: {
    borderTopLeftRadius: 6,
  },
  firstMine: {
    borderTopRightRadius: 6,
  },
  bubblePending: {
    opacity: 0.7,
  },
  bubblePressed: {
    opacity: 0.85,
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
    borderRadius: radius.md,
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
    borderRadius: radius.md,
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
    marginTop: 3,
  },
  edited: {
    color: colors.muted,
    fontSize: 11,
    fontStyle: 'italic',
  },
  stamp: {
    color: colors.muted,
    fontSize: 11,
  },
  metaMine: {
    color: colors.mineMeta,
  },
});
