// Visual control only. The switch writes the local preference; the label
// shows the path actually in use. Transport decisions live in transport.ts
// and useE2eeChat.ts. Ciphertext is unchanged either way.
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { ActiveTransport } from '../services/transport';
import { colors, glassCard, radius } from '../theme';
import { Icon } from './Icon';

interface Props {
  useRelay: boolean;
  transport: ActiveTransport;
  onToggle: (on: boolean) => void;
  // Chat header: a small pill. Connect screen: a full settings row.
  compact?: boolean;
}

function Switch({ on }: { on: boolean }) {
  return (
    <View style={[styles.track, on ? styles.trackOn : styles.trackOff]}>
      <View style={[styles.thumb, on ? styles.thumbOn : styles.thumbOff]} />
    </View>
  );
}

export function RelayStatus({ useRelay, transport, onToggle, compact }: Props) {
  const direct = transport !== 'relay';
  const fellBack = useRelay && direct;
  const a11y = {
    accessibilityRole: 'switch' as const,
    accessibilityState: { checked: useRelay },
    accessibilityLabel: 'Use relay server (faster, live)',
  };

  if (compact) {
    return (
      <Pressable
        onPress={() => onToggle(!useRelay)}
        hitSlop={8}
        style={({ pressed }) => [styles.pill, pressed && styles.pressed]}
        {...a11y}
      >
        <View style={[styles.dot, direct ? styles.dotDirect : styles.dotRelay]} />
        <Text style={styles.pillText}>{direct ? 'Direct' : 'Relay'}</Text>
      </Pressable>
    );
  }

  const detail = fellBack
    ? 'Relay unreachable. Reading the public Hedera mirror until it returns.'
    : useRelay
      ? 'Faster, with live updates.'
      : 'Off. Reading the public Hedera mirror directly.';

  return (
    <Pressable
      onPress={() => onToggle(!useRelay)}
      hitSlop={4}
      style={({ pressed }) => [glassCard, styles.row, pressed && styles.pressed]}
      {...a11y}
    >
      <View style={[styles.badge, direct && styles.badgeDirect]}>
        <Icon name={direct ? 'globe' : 'server'} size={18} color={direct ? colors.warn : colors.cyan} />
      </View>
      <View style={styles.copy}>
        <Text style={styles.title}>Use relay server</Text>
        <Text style={styles.detail}>{detail}</Text>
      </View>
      <Switch on={useRelay} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  pressed: {
    opacity: 0.8,
  },
  badge: {
    width: 36,
    height: 36,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.cyanFaint,
  },
  badgeDirect: {
    backgroundColor: 'rgba(232,194,125,0.10)',
  },
  copy: {
    flex: 1,
    minWidth: 0,
  },
  title: {
    color: colors.text,
    fontSize: 14,
    fontWeight: '600',
  },
  detail: {
    color: colors.muted,
    fontSize: 12,
    lineHeight: 17,
    marginTop: 2,
  },
  track: {
    width: 44,
    height: 26,
    borderRadius: radius.pill,
    padding: 3,
    flexDirection: 'row',
    alignItems: 'center',
  },
  trackOn: {
    justifyContent: 'flex-end',
    backgroundColor: colors.cyan,
  },
  trackOff: {
    justifyContent: 'flex-start',
    backgroundColor: colors.cardRaised,
    borderWidth: 1,
    borderColor: colors.stroke,
  },
  thumb: {
    width: 20,
    height: 20,
    borderRadius: radius.pill,
  },
  thumbOn: {
    backgroundColor: colors.cyanText,
  },
  thumbOff: {
    width: 18,
    height: 18,
    backgroundColor: colors.muted,
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    height: 28,
    borderRadius: radius.pill,
    backgroundColor: colors.cardRaised,
    borderWidth: 1,
    borderColor: colors.stroke,
  },
  dot: {
    width: 7,
    height: 7,
    borderRadius: radius.pill,
  },
  dotRelay: {
    backgroundColor: colors.cyan,
  },
  dotDirect: {
    backgroundColor: colors.warn,
  },
  pillText: {
    color: colors.textSoft,
    fontSize: 12,
    fontWeight: '600',
  },
});
