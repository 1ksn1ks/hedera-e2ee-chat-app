// Bottom composer: text + live 18 KB byte counter + send. In edit mode it
// is prefilled with the bubble's shown (decrypted, possibly already-edited)
// text and offers Cancel / Save instead of the topic send. The counter is
// the exact predicted outgoing HCS JSON size (fixed 48-byte seal, unpadded
// base64) — the same math the Globe map uses, so the gate can never
// surprise the wallet.
import React, { useEffect, useMemo, useState } from 'react';
import {
  Image,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { colors, glassCard, radius } from '../theme';
import { formatHcsUsage, HCS_SHOW_COUNTER_AFTER } from '../services/chatPayload';

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

  return (
    <View style={[styles.wrap, glassCard, { borderRadius: radius.sheet }]}>
      {editing && (
        <View style={styles.editBar}>
          <Text style={styles.editLabel} numberOfLines={1}>
            Edit — {editing.label}
          </Text>
          <Pressable hitSlop={8} onPress={onCancelEdit}>
            <Text style={styles.cancelText}>Cancel</Text>
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
          <Pressable hitSlop={8} onPress={onClearAttachment} accessibilityRole="button">
            <Text style={styles.cancelText}>Remove</Text>
          </Pressable>
        </View>
      ) : null}
      <View style={styles.row}>
        {!editing && onAttach ? (
          <Pressable
            onPress={onAttach}
            disabled={disabled || busy}
            hitSlop={8}
            style={[styles.attach, (disabled || busy || !!mediaNote) && styles.attachOff]}
            accessibilityRole="button"
            accessibilityLabel="Attach photo or video"
          >
            <Text style={styles.attachText}>+</Text>
          </Pressable>
        ) : null}
        <TextInput
          value={text}
          onChangeText={setText}
          placeholder={editing ? 'New message text' : placeholder}
          placeholderTextColor={colors.muted}
          style={[styles.input, disabled && { opacity: 0.45 }]}
          multiline
          editable={!disabled && !busy}
          keyboardType="default"
          blurOnSubmit={false}
          maxLength={16000}
        />
        <Pressable
          onPress={submit}
          disabled={!canSubmit}
          style={[
            styles.send,
            !canSubmit && styles.sendOff,
          ]}
          accessibilityRole="button"
        >
          <Text style={styles.sendText}>{editing ? 'Save' : 'Send'}</Text>
        </Pressable>
      </View>
      <View style={styles.counterRow}>
        {showCounter && usage && (
          <Text
            style={[styles.counter, usage.warn && styles.counterWarn, over && styles.counterOver]}
            numberOfLines={1}
          >
            {usage.text}
          </Text>
        )}
        {busy && <Text style={styles.busy}>{busyLabel || '…'}</Text>}
        {!busy && over && (
          <Text style={styles.counterOver} numberOfLines={1}>
            keep it under 18 KB
          </Text>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    margin: 10,
    padding: 10,
    backgroundColor: colors.card,
  },
  editBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: colors.cyanFaint,
    borderRadius: radius.chip,
    paddingHorizontal: 10,
    paddingVertical: 6,
    marginBottom: 8,
  },
  editLabel: {
    flex: 1,
    color: colors.cyan,
    fontSize: 12,
    fontWeight: '700',
  },
  cancelText: {
    color: colors.muted,
    fontSize: 12,
    fontWeight: '600',
  },
  mediaNote: {
    color: colors.muted,
    fontSize: 11,
    lineHeight: 15,
    marginBottom: 8,
  },
  draft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 8,
  },
  thumb: {
    width: 36,
    height: 36,
    borderRadius: 8,
    backgroundColor: colors.cardRaised,
  },
  draftLabel: {
    flex: 1,
    color: colors.text,
    fontSize: 12,
    fontWeight: '600',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
  },
  attach: {
    width: 44,
    height: 44,
    borderRadius: radius.chip,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.glass,
    borderWidth: 1,
    borderColor: colors.cyanSoft,
  },
  attachOff: {
    opacity: 0.4,
  },
  attachText: {
    color: colors.cyan,
    fontSize: 22,
    lineHeight: 24,
    fontWeight: '600',
  },
  input: {
    flex: 1,
    color: colors.text,
    fontSize: 15,
    lineHeight: 21,
    maxHeight: 120,
    paddingVertical: 6,
    paddingHorizontal: 4,
  },
  send: {
    backgroundColor: colors.cyan,
    borderRadius: radius.chip,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  sendOff: {
    opacity: 0.35,
  },
  sendText: {
    color: colors.cyanText,
    fontSize: 14,
    fontWeight: '700',
  },
  counterRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    minHeight: 16,
    paddingHorizontal: 4,
    marginTop: 4,
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
    fontWeight: '600',
  },
  busy: {
    color: colors.cyan,
    fontSize: 11,
    fontWeight: '600',
  },
});
