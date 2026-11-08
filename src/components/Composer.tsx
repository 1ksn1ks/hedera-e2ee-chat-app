// Bottom composer: text + live 18 KB byte counter + send. In edit mode it
// is prefilled with the bubble's shown (decrypted, possibly already-edited)
// text and offers Cancel / Save instead of the topic send. The counter is
// the exact predicted outgoing HCS JSON size (fixed 48-byte seal, unpadded
// base64) — the same math the Globe map uses, so the gate can never
// surprise the wallet.
import React, { useEffect, useMemo, useState } from 'react';
import {
  Image,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, noWebOutline, radius } from '../theme';
import { formatHcsUsage, HCS_SHOW_COUNTER_AFTER } from '../services/chatPayload';
import { Icon } from './Icon';

const INPUT_MIN = 42;
const INPUT_MAX = 140;

interface Props {
  placeholder: string;
  disabled: boolean;
  busy: boolean;
  busyLabel?: string;
  // predicted outgoing HCS JSON bytes for the current draft
  predict: (text: string) => number;
  onSend: (text: string) => void;
  editing?: { label: string; initialText: string } | null;
  onSaveEdit?: (text: string) => void;
  onCancelEdit?: () => void;
  attachment?: { kind: 'image' | 'video'; preview: string } | null;
  onAttach?: () => void;
  onClearAttachment?: () => void;
  mediaNote?: string;
}

export function Composer({
  placeholder,
  disabled,
  busy,
  busyLabel,
  predict,
  onSend,
  editing,
  onSaveEdit,
  onCancelEdit,
  attachment,
  onAttach,
  onClearAttachment,
  mediaNote,
}: Props) {
  const [text, setText] = useState('');
  const [focused, setFocused] = useState(false);
  // Browser textareas don't grow by themselves: start at one row and follow
  // the content height up to the cap. Phones grow natively.
  const [webHeight, setWebHeight] = useState(INPUT_MIN);
  const insets = useSafeAreaInsets();

  useEffect(() => {
    if (!text) setWebHeight(INPUT_MIN);
  }, [text]);

  // Edit mode prefills the draft with the bubble's shown text; leaving edit
  // mode clears it.
  useEffect(() => {
    if (editing) {
      setText(editing.initialText);
    } else {
      setText('');
    }
  }, [editing]);

  const usage = useMemo(() => {
    if (!text.trim() && !editing && !attachment) return null;
    return formatHcsUsage(predict(text));
  }, [text, editing, predict, attachment]);

  const over = !!usage?.over;
  const hasMedia = !!attachment && !editing;
  const showCounter = !!usage && (editing || hasMedia || over || predict(text) >= HCS_SHOW_COUNTER_AFTER);
  const canSubmit = !disabled && !busy && !over && (!!text.trim() || hasMedia);

  const submit = () => {
    const value = text.trim();
    if (!canSubmit) return;
    if (editing && onSaveEdit) {
      if (!value) return;
      onSaveEdit(value);
      setText('');
    } else if (!editing) {
      onSend(value);
      setText('');
    }
  };

  const attachOff = disabled || busy || !!mediaNote;
  const showStatus = (showCounter && !!usage) || busy || over;

  return (
    <View style={[styles.wrap, { paddingBottom: 10 + insets.bottom }]}>
      <View style={styles.column}>
        {editing && (
          <View style={styles.editBar}>
            <Icon name="pencil" size={16} color={colors.cyan} />
            <View style={styles.editCopy}>
              <Text style={styles.editTitle}>Editing message</Text>
              <Text style={styles.editLabel} numberOfLines={1}>
                {editing.label}
              </Text>
            </View>
            <Pressable
              hitSlop={8}
              onPress={onCancelEdit}
              style={styles.iconSmall}
              accessibilityRole="button"
              accessibilityLabel="Cancel edit"
            >
              <Icon name="x" size={16} color={colors.muted} />
            </Pressable>
          </View>
        )}
        {mediaNote ? <Text style={styles.mediaNote}>{mediaNote}</Text> : null}
        {hasMedia && attachment ? (
          <View style={styles.draft}>
            {attachment.preview ? (
              <Image source={{ uri: attachment.preview }} style={styles.thumb} />
            ) : (
              <View style={styles.thumb} />
            )}
            <Text style={styles.draftLabel}>{attachment.kind === 'video' ? 'Video' : 'Photo'}</Text>
            <Pressable
              hitSlop={8}
              onPress={onClearAttachment}
              style={styles.iconSmall}
              accessibilityRole="button"
              accessibilityLabel="Remove attachment"
            >
              <Icon name="x" size={16} color={colors.muted} />
            </Pressable>
          </View>
        ) : null}
        <View style={styles.row}>
          {!editing && onAttach ? (
            <Pressable
              onPress={onAttach}
              disabled={disabled || busy}
              hitSlop={6}
              style={({ pressed }) => [styles.round, styles.attach, pressed && styles.attachPressed, attachOff && styles.off]}
              accessibilityRole="button"
              accessibilityLabel="Attach photo or video"
            >
              <Icon name="plus" size={22} color={colors.cyan} />
            </Pressable>
          ) : null}
          <TextInput
            value={text}
            onChangeText={setText}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            placeholder={editing ? 'New message text' : placeholder}
            placeholderTextColor={colors.muted}
            style={[
              styles.input,
              noWebOutline,
              Platform.OS === 'web' && { height: webHeight },
              focused && styles.inputFocus,
              disabled && styles.inputOff,
            ]}
            onContentSizeChange={(e) => {
              if (Platform.OS !== 'web') return;
              const h = Math.ceil(e.nativeEvent.contentSize.height) + 2;
              setWebHeight(Math.max(INPUT_MIN, Math.min(INPUT_MAX, h)));
            }}
            numberOfLines={1}
            multiline
            editable={!disabled && !busy}
            keyboardType="default"
            blurOnSubmit={false}
            maxLength={16000}
          />
          <Pressable
            onPress={submit}
            disabled={!canSubmit}
            style={({ pressed }) => [
              styles.round,
              canSubmit ? styles.sendOn : styles.sendIdle,
              pressed && canSubmit && styles.sendPressed,
            ]}
            accessibilityRole="button"
            accessibilityLabel={editing ? 'Save edit' : 'Send'}
          >
            <Icon
              name={editing ? 'check' : 'send'}
              size={20}
              strokeWidth={2.4}
              color={canSubmit ? colors.cyanText : colors.muted}
            />
          </Pressable>
        </View>
        {showStatus && (
          <View style={styles.counterRow}>
            {showCounter && usage ? (
              <Text
                style={[styles.counter, usage.warn && styles.counterWarn, over && styles.counterOver]}
                numberOfLines={1}
              >
                {usage.text}
              </Text>
            ) : (
              <View />
            )}
            {busy && <Text style={styles.busy}>{busyLabel || '…'}</Text>}
            {!busy && over && (
              <Text style={styles.counterOver} numberOfLines={1}>
                keep it under 18 KB
              </Text>
            )}
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    backgroundColor: colors.card,
    borderTopWidth: 1,
    borderTopColor: colors.hairline,
    paddingTop: 10,
    paddingHorizontal: 10,
  },
  column: {
    gap: 8,
  },
  editBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: colors.cyanFaint,
    borderLeftWidth: 3,
    borderLeftColor: colors.cyan,
    borderRadius: radius.sm,
    paddingLeft: 10,
    paddingRight: 4,
    paddingVertical: 6,
  },
  editCopy: {
    flex: 1,
    minWidth: 0,
  },
  editTitle: {
    color: colors.cyan,
    fontSize: 12,
    fontWeight: '700',
  },
  editLabel: {
    color: colors.textSoft,
    fontSize: 12,
    marginTop: 1,
  },
  iconSmall: {
    width: 30,
    height: 30,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  mediaNote: {
    color: colors.muted,
    fontSize: 12,
    lineHeight: 16,
    paddingHorizontal: 4,
  },
  draft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: colors.sunken,
    borderRadius: radius.md,
    padding: 6,
  },
  thumb: {
    width: 40,
    height: 40,
    borderRadius: radius.sm,
    backgroundColor: colors.cardRaised,
  },
  draftLabel: {
    flex: 1,
    color: colors.text,
    fontSize: 13,
    fontWeight: '600',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
  },
  round: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: 'center',
    justifyContent: 'center',
  },
  attach: {
    backgroundColor: colors.cardRaised,
    borderWidth: 1,
    borderColor: colors.stroke,
  },
  attachPressed: {
    backgroundColor: colors.cyanFaint,
  },
  off: {
    opacity: 0.4,
  },
  input: {
    flex: 1,
    minHeight: INPUT_MIN,
    maxHeight: INPUT_MAX,
    color: colors.text,
    fontSize: 15,
    lineHeight: 20,
    backgroundColor: colors.sunken,
    borderWidth: 1,
    borderColor: colors.stroke,
    borderRadius: 21,
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 10,
  },
  inputFocus: {
    borderColor: colors.cyanSoft,
  },
  inputOff: {
    opacity: 0.6,
  },
  sendOn: {
    backgroundColor: colors.cyan,
  },
  sendPressed: {
    backgroundColor: colors.cyanPressed,
  },
  sendIdle: {
    backgroundColor: colors.cardRaised,
  },
  counterRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 6,
  },
  counter: {
    color: colors.muted,
    fontSize: 11,
  },
  counterWarn: {
    color: colors.warn,
  },
  counterOver: {
    color: colors.danger,
    fontSize: 11,
    fontWeight: '600',
  },
  busy: {
    color: colors.cyan,
    fontSize: 11,
    fontWeight: '600',
  },
});
