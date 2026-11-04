// Chat payload packing + the 18 KB HCS byte gate — ports of step_by_step's
// chatimage.js (pack/unpack) and hcschunks.js (sizes), plus the fixed-length
// seal math the Globe map uses for its live byte counter: crypto_box_seal
// output is always payload + 48 bytes, and the base64 on the wire is
// UNPADDED, so the outgoing JSON size is predictable before encrypting.
const CHAT_IMAGE_PREFIX = '\u001echat1\n';

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

function safeHttpUrl(value: string): string {
  if (typeof value !== 'string' || !value) return '';
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return '';
    return url.href;
  } catch {
    return '';
  }
}

// LOGIC CHANGE. Sealed chat media matches Globe's packer, not a separate
// file cipher. step_by_step/videoposter.js:147-174 writes
// "\u001echat1\n" + { t, i, p? }. chatimage.js:91-96 and :121-130 are the
// chat wrappers. `i` is an http(s) media URL. `p` is a data:image still
// and is omitted unless it starts with "data:image/" (videoposter.js:152).
// There is no {url, fileKey, header, mime, size, w, h, poster} object and
// no secretstream encryptor in step_by_step. The topic seal (crypto_box_seal)
// is what hides `t`, `i`, and `p`. A message that is only { t, i } is the
// older plain image link: it still unpacks, and the bubble marks it
// "unencrypted (old)".
export interface ChatParts {
  text: string;
  image: string;
  poster: string;
  legacyPlain: boolean;
}

const EMPTY_PARTS: ChatParts = { text: '', image: '', poster: '', legacyPlain: false };

export function packChatPayload(text: string, imageUrl: string, poster = ''): string {
  const body = normalizeMessageNewlines(text);
  const image = safeHttpUrl(imageUrl);
  if (!image) return body;
  const data: { t: string; i: string; p?: string } = { t: body, i: image };
  if (typeof poster === 'string' && poster.startsWith('data:image/')) data.p = poster;
  return CHAT_IMAGE_PREFIX + JSON.stringify(data);
}

export function unpackChatPayload(raw: string): ChatParts {
  const text = typeof raw === 'string' ? raw : '';
  if (!text.startsWith(CHAT_IMAGE_PREFIX)) return { ...EMPTY_PARTS, text };
  try {
    const data = JSON.parse(text.slice(CHAT_IMAGE_PREFIX.length)) as { t?: unknown; i?: unknown; p?: unknown };
    const poster = typeof data.p === 'string' && data.p.startsWith('data:image/') ? data.p : '';
    const image = safeHttpUrl(typeof data.i === 'string' ? data.i : '');
    return {
      text: typeof data.t === 'string' ? data.t : '',
      image,
      poster,
      legacyPlain: image.length > 0 && poster.length === 0,
    };
  } catch {
    return { ...EMPTY_PARTS, text };
  }
}

// Unpadded base64 length: 3 bytes → 4 chars, 1 remainder → 2, 2 → 3.
export function b64Len(bytes: number): number {
  const r = bytes % 3;
  return Math.floor(bytes / 3) * 4 + (r === 1 ? 2 : r === 2 ? 3 : 0);
}

// Exact size of the outgoing HCS JSON for a send, before encrypting.
export function sendOutgoingBytes(text: string, imageUrl: string, poster = ''): number {
  const sealed = E2EE_SEAL_BYTES + utf8ByteLength(packChatPayload(text, imageUrl, poster));
  const placeholder = 'x'.repeat(b64Len(sealed));
  return utf8ByteLength(JSON.stringify({ encryptedMessage: { ciphertext: placeholder } }));
}

// Exact size of the outgoing HCS JSON for an edit (ciphertext grows the
// same way; created/timestamp/image ride alongside it).
export function editOutgoingBytes(
  data: { created: string; timestamp: string; image?: string },
  text: string,
  imageUrl: string,
  poster = ''
): number {
  const sealed = E2EE_SEAL_BYTES + utf8ByteLength(packChatPayload(text, imageUrl, poster));
  const placeholder = 'x'.repeat(b64Len(sealed));
  const body: Record<string, unknown> = {
    created: data.created,
    timestamp: data.timestamp,
    encryptedMessage: { ciphertext: placeholder },
  };
  if (data.image) body.image = data.image;
  return utf8ByteLength(JSON.stringify({ editEncryptedMessage: body }));
}
