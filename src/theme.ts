// Dark glass + cyan messenger chrome — the same palette as
// hedera-notifications-frontend (bg #0a0a0a, card #12141a, cyan #22d3ee),
// arranged as a Signal/Telegram shell: header + list + bottom composer.
import { StyleSheet } from 'react-native';

export const colors = {
  bg: '#0a0a0a',
  card: '#12141a',
  cardRaised: '#171a23',
  cyan: '#22d3ee',
  cyanSoft: 'rgba(34,211,238,0.28)',
  cyanFaint: 'rgba(34,211,238,0.1)',
  cyanText: '#0a2a30',
  text: '#e6e6f0',
  muted: '#8d93a5',
  danger: '#f07178',
  warn: '#e5c07b',
  hairline: 'rgba(255,255,255,0.06)',
  glass: 'rgba(255,255,255,0.04)',
  dim: 'rgba(0,0,0,0.62)',
};

export const radius = {
  sheet: 16,
  bubble: 12,
  chip: 12,
};

export const glassCard = {
  backgroundColor: colors.card,
  borderWidth: 1,
  borderColor: colors.hairline,
  borderRadius: radius.sheet,
};

export const pressableBase = {
  ...glassCard,
  paddingHorizontal: 14,
  paddingVertical: 12,
};

export const baseStyles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  title: {
    color: colors.text,
    fontSize: 17,
    fontWeight: '700',
  },
  subtitle: {
    color: colors.muted,
    fontSize: 13,
    lineHeight: 19,
  },
  error: {
    color: colors.danger,
    fontSize: 13,
  },
  cyanButton: {
    backgroundColor: colors.cyan,
    borderRadius: radius.chip,
    paddingVertical: 12,
    alignItems: 'center',
    paddingHorizontal: 16,
  },
  cyanButtonText: {
    color: colors.cyanText,
    fontSize: 15,
    fontWeight: '700',
  },
  ghostButton: {
    ...glassCard,
    borderRadius: radius.chip,
    paddingVertical: 12,
    alignItems: 'center',
    paddingHorizontal: 16,
  },
  ghostButtonText: {
    color: colors.text,
    fontSize: 15,
    fontWeight: '600',
  },
  chip: {
    backgroundColor: colors.cyanFaint,
    borderColor: colors.cyanSoft,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  chipText: {
    color: colors.cyan,
    fontSize: 12,
    fontWeight: '600',
  },
});
