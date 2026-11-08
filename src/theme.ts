// Dark messenger chrome with one cyan accent (the palette family of
// hedera-notifications-frontend), arranged as a Signal/Telegram shell:
// header + list + docked composer. Surfaces step up from bg → sunken
// (inputs) → card → cardRaised; text steps down text → textSoft → muted.
import { Platform, StyleSheet, type TextStyle } from 'react-native';

export const colors = {
  bg: '#07090c',
  sunken: '#0b0e13',
  card: '#10141b',
  cardRaised: '#171c25',
  bubbleTheirs: '#161b24',
  bubbleMine: '#0e3a45',
  cyan: '#22d3ee',
  cyanPressed: '#0fb8d3',
  cyanSoft: 'rgba(34,211,238,0.32)',
  cyanFaint: 'rgba(34,211,238,0.10)',
  cyanText: '#03252c',
  text: '#eef1f7',
  textSoft: '#b4bac8',
  muted: '#7d8497',
  mineMeta: 'rgba(238,241,247,0.58)',
  danger: '#f2777f',
  dangerFaint: 'rgba(242,119,127,0.10)',
  warn: '#e8c27d',
  hairline: 'rgba(255,255,255,0.07)',
  stroke: 'rgba(255,255,255,0.11)',
  glass: 'rgba(255,255,255,0.04)',
  dim: 'rgba(0,0,0,0.62)',
};

export const radius = {
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  pill: 999,
  sheet: 16,
  bubble: 18,
  chip: 12,
};

export const space = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
};

// Widest column on a desktop browser; phones use their full width.
export const MAX_COLUMN = 760;
export const MAX_FORM = 520;

export const glassCard = {
  backgroundColor: colors.card,
  borderWidth: 1,
  borderColor: colors.hairline,
  borderRadius: radius.lg,
};

export const pressableBase = {
  ...glassCard,
  paddingHorizontal: 14,
  paddingVertical: 12,
};

// The browser's focus outline is replaced by our own border colour.
export const noWebOutline = (Platform.OS === 'web' ? { outlineStyle: 'none' } : {}) as unknown as TextStyle;

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
  // Small caps label above a field or a list.
  label: {
    color: colors.muted,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  input: {
    backgroundColor: colors.sunken,
    borderWidth: 1,
    borderColor: colors.stroke,
    borderRadius: radius.md,
    color: colors.text,
    fontSize: 15,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  inputFocus: {
    borderColor: colors.cyan,
  },
  error: {
    color: colors.danger,
    fontSize: 13,
  },
  errorBox: {
    backgroundColor: colors.dangerFaint,
    borderRadius: radius.md,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  cyanButton: {
    backgroundColor: colors.cyan,
    borderRadius: radius.md,
    minHeight: 48,
    paddingVertical: 12,
    paddingHorizontal: 16,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 8,
  },
  cyanButtonText: {
    color: colors.cyanText,
    fontSize: 15,
    fontWeight: '700',
  },
  ghostButton: {
    backgroundColor: colors.cardRaised,
    borderWidth: 1,
    borderColor: colors.stroke,
    borderRadius: radius.md,
    minHeight: 48,
    paddingVertical: 12,
    paddingHorizontal: 16,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 8,
  },
  ghostButtonText: {
    color: colors.text,
    fontSize: 15,
    fontWeight: '600',
  },
  buttonOff: {
    opacity: 0.4,
  },
  chip: {
    backgroundColor: colors.cyanFaint,
    borderColor: colors.cyanSoft,
    borderWidth: 1,
    borderRadius: radius.pill,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  chipText: {
    color: colors.cyan,
    fontSize: 12,
    fontWeight: '600',
  },
});
