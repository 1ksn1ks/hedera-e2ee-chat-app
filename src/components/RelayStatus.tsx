// Visual control only. The switch writes the local preference; the chip
// shows the path actually in use. Transport decisions live in transport.ts
// and useE2eeChat.ts. Ciphertext is unchanged either way.
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { ActiveTransport } from '../services/transport';
import { baseStyles, colors, glassCard } from '../theme';

interface Props {
  useRelay: boolean;
  transport: ActiveTransport;
  onToggle: (on: boolean) => void;
  // Chat header: full-width strip. Connect screen: rounded glass card.
  bleed?: boolean;
}

export function RelayStatus({ useRelay, transport, onToggle, bleed }: Props) {
  const direct = transport !== 'relay';
  return (
    <View style={[glassCard, styles.row, bleed ? styles.bleed : null]}>
      <Pressable
        onPress={() => onToggle(!useRelay)}
        accessibilityRole="switch"
        accessibilityState={{ checked: useRelay }}
        accessibilityLabel="Use relay server (faster, live)"
        style={styles.toggle}
      >
        <View style={[styles.track, useRelay ? styles.trackOn : styles.trackOff]}>
          <View style={[styles.thumb, useRelay ? styles.thumbOn : styles.thumbOff]} />
        </View>
        <Text style={styles.label}>Use relay server (faster, live)</Text>
      </Pressable>
      <View style={[baseStyles.chip, styles.chip]}>
        <Text style={baseStyles.chipText}>{direct ? 'Direct Hedera' : 'Relay'}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  bleed: {
    borderRadius: 0,
    borderLeftWidth: 0,
    borderRightWidth: 0,
  },
  toggle: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  track: {
    width: 36,
    height: 20,
    borderRadius: 999,
    borderWidth: 1,
    padding: 2,
    flexDirection: 'row',
    alignItems: 'center',
  },
  trackOn: {
    justifyContent: 'flex-end',
    backgroundColor: colors.cyanFaint,
    borderColor: colors.cyan,
  },
  trackOff: {
    justifyContent: 'flex-start',
    backgroundColor: colors.glass,
    borderColor: colors.hairline,
  },
  thumb: {
    width: 14,
    height: 14,
    borderRadius: 999,
  },
  thumbOn: {
    backgroundColor: colors.cyan,
  },
  thumbOff: {
    backgroundColor: colors.muted,
  },
  label: {
    flex: 1,
    color: colors.text,
    fontSize: 12,
    fontWeight: '600',
  },
  chip: {
    flexShrink: 0,
  },
});
