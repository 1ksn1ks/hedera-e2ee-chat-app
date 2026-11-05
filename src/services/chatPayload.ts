// The 18 KB HCS byte gate. Packing lives in sealedMedia.ts. crypto_box_seal
// output is always payload + 48 bytes, and the base64 on the wire is
// UNPADDED, so the outgoing JSON size is predictable before encrypting.

// Headroom under the 20-chunk / 20480-byte HCS ceiling.
export const HCS_MESSAGE_MAX_BYTES = 18 * 1024;
export const HCS_SHOW_COUNTER_AFTER = 1024;
export const HCS_TOO_LONG = 'Message is too long. Keep it under 18 KB.';

// crypto_box_seal overhead: 24-byte nonce + 32-byte ephemeral public key.
export const E2EE_SEAL_BYTES = 48;

export function utf8ByteLength(text: string): number {
  const value = text == null ? '' : String(text);
  return new TextEncoder().encode(value).length;
}

// Live size of one 18 KB topic message, same presentation as the Globe map.
export function formatHcsUsage(bytes: number): { text: string; warn: boolean; over: boolean } {
  const n = Math.max(0, Number(bytes) || 0);
  const over = n > HCS_MESSAGE_MAX_BYTES;
  const warn = !over && n > HCS_MESSAGE_MAX_BYTES * 0.9;
  const used = n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`;
  let text = `${used} / 18 KB`;
  if (n > 1024) text += `  ${Math.ceil(n / 1024)} approvals`;
  return { text, warn, over };
}

// Stored text keeps real newline characters. Carriage returns become one
// newline, runs of three or more collapse to a blank line, newlines at the
// ends are dropped.
export function normalizeMessageNewlines(text: string): string {
  const value = String(text == null ? '' : text)
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
  return value.replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '').replace(/\n+$/, '');
}

// Unpadded base64 length: 3 bytes → 4 chars, 1 remainder → 2, 2 → 3.
export function b64Len(bytes: number): number {
  const r = bytes % 3;
  return Math.floor(bytes / 3) * 4 + (r === 1 ? 2 : r === 2 ? 3 : 0);
}

// Exact size of the outgoing HCS JSON for an already packed payload.
// Sealed files are packed in sealedMedia.ts before this runs, so the
// counter includes {t,m} and an embedded poster.
export function sendOutgoingBytes(packed: string): number {
  const sealed = E2EE_SEAL_BYTES + utf8ByteLength(packed);
  const placeholder = 'x'.repeat(b64Len(sealed));
  return utf8ByteLength(JSON.stringify({ encryptedMessage: { ciphertext: placeholder } }));
}

// Exact size of the outgoing HCS JSON for an edit. `image` is only the
// older clear URL. A sealed file keeps its address inside `packed`.
export function editOutgoingBytes(
  data: { created: string; timestamp: string; image?: string },
  packed: string
): number {
  const sealed = E2EE_SEAL_BYTES + utf8ByteLength(packed);
  const placeholder = 'x'.repeat(b64Len(sealed));
  const body: Record<string, unknown> = {
    created: data.created,
    timestamp: data.timestamp,
    encryptedMessage: { ciphertext: placeholder },
  };
  if (data.image) body.image = data.image;
  return utf8ByteLength(JSON.stringify({ editEncryptedMessage: body }));
}
