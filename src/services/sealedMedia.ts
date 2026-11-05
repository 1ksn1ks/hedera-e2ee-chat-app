// LOGIC CHANGE. Chat files match step_by_step/e2eemedia.js. The server stores
// only a secretstream ciphertext (uploadmedia.js uploadSealedChatMedia).
// The file key and header stay inside the topic-key seal. Nothing here
// writes the gallery or logs a key, a header, or plaintext.
import _sodium from 'libsodium-wrappers-sumo';

type Sodium = typeof _sodium;

let sodium: Sodium = _sodium;
const sealedReadyPromise: Promise<void> = _sodium.ready.then(() => {
  sodium = _sodium;
});

export function sealedReady(): Promise<void> {
  return sealedReadyPromise;
}

export const STREAM_CHUNK = 64 * 1024;
export const POSTER_EMBED_MAX = 24 * 1024;
export const SEALED_CONTENT_TYPE = 'application/octet-stream';
export const SEALED_SLACK = 1024 * 1024;
export const SEALED_MAX = 100 * 1024 * 1024 + SEALED_SLACK;
export const CHAT_IMAGE_PREFIX = '\u001echat1\n';

// Same 18 KB gate as chatPayload.ts. e2eeWireBytes matches sendOutgoingBytes.
const HCS_MESSAGE_MAX_BYTES = 18 * 1024;
const E2EE_SEAL_BYTES = 48;

const VIDEO_MAX = 100 * 1024 * 1024;
const IMAGE_MAX = 20 * 1024 * 1024;
const ALLOWED = new Set(['image/png', 'image/jpeg', 'image/webp', 'video/mp4', 'video/webm']);

const MIRROR_HOSTS = new Set([
  'mainnet-public.mirrornode.hedera.com',
  'mainnet.mirrornode.hedera.com',
]);

export const MEDIA_BLOCKED = 'Media is off on Direct Hedera — no server to hold files.';

export interface SealedPoster {
  b64?: string;
  url?: string;
  fileKey: string;
  header: string;
  mime: string;
  size: number;
}

export interface SealedMedia {
  url: string;
  fileKey: string;
  header: string;
  mime: string;
  size: number;
  w: number;
  h: number;
  poster?: SealedPoster;
  /** Globe sets this when a GIF was converted to a muted looping clip. */
  gif?: 1;
}

export interface ChatParts {
  text: string;
  image: string;
  poster: string;
  legacyPlain: boolean;
  media: SealedMedia | null;
}

export interface SealPosterResult {
  mode: 'embed' | 'upload';
  poster: SealedPoster;
  uploads: { contentType: string; body: Uint8Array; headers: Record<string, string> }[];
}

export interface UploadResponse {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}

export type UploadFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: Blob }
) => Promise<UploadResponse>;

export interface UploadGrant {
  account: string;
  token: string;
  exp: number;
}

export interface GrantStorage {
  getItem(key: string): string | null | Promise<string | null>;
  setItem(key: string, value: string): void | Promise<void>;
  removeItem(key: string): void | Promise<void>;
}

interface StatusError extends Error {
  status?: number;
}

interface ByteReader {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  cancel?: () => Promise<void> | void;
}

interface DownloadBody {
  getReader?: () => ByteReader;
  cancel?: () => Promise<void> | void;
}

interface DownloadResponse {
  ok: boolean;
  body?: DownloadBody | null;
  headers?: { get(name: string): string | null } | null;
  arrayBuffer?: () => Promise<ArrayBuffer>;
}

export type SealedDownloadFetch = (
  url: string,
  init: { signal: AbortSignal; redirect: 'error'; credentials: 'omit' }
) => Promise<DownloadResponse>;

const EMPTY_MEDIA: SealedMedia = {
  url: '',
  fileKey: '',
  header: '',
  mime: '',
  size: 0,
  w: 0,
  h: 0,
};

const EMPTY_PARTS: ChatParts = {
  text: '',
  image: '',
  poster: '',
  legacyPlain: false,
  media: null,
};

const GRANT_SKEW_MS = 15000;
const UPLOAD_GRANT_TTL_MS = 24 * 60 * 60 * 1000;

function keyBytes(): number {
  return sodium.crypto_secretstream_xchacha20poly1305_KEYBYTES;
}

function headerBytes(): number {
  return sodium.crypto_secretstream_xchacha20poly1305_HEADERBYTES;
}

function copyBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  copy.set(bytes);
  return copy;
}

function blobOf(parts: Uint8Array[], type?: string): Blob {
  const chunks: ArrayBuffer[] = [];
  for (const part of parts) chunks.push(copyBytes(part).buffer);
  return type ? new Blob(chunks, { type }) : new Blob(chunks);
}

function concat(left: Uint8Array, right: Uint8Array): Uint8Array<ArrayBuffer> {
  if (!left.length) return copyBytes(right);
  const out = new Uint8Array(new ArrayBuffer(left.length + right.length));
  out.set(left, 0);
  out.set(right, left.length);
  return out;
}

// Walk a buffer in STREAM_CHUNK slices. React Native's Blob has no stream(),
// and new Blob([bytes]) throws, so this path never builds one.
function readerFromBytes(bytes: Uint8Array): ByteReader {
  let offset = 0;
  return {
    async read() {
      if (offset >= bytes.byteLength) return { done: true };
      const end = Math.min(bytes.byteLength, offset + STREAM_CHUNK);
      const value = bytes.subarray(offset, end);
      offset = end;
      return { done: false, value };
    },
    cancel() {
      offset = bytes.byteLength;
    },
  };
}

function readerOf(source: Blob | Uint8Array | ArrayBuffer | DownloadBody | null | undefined): ByteReader {
  if (source instanceof Uint8Array) return readerFromBytes(source);
  if (source instanceof ArrayBuffer) return readerFromBytes(new Uint8Array(source));
  const streamBody = source as { getReader?: () => ByteReader; body?: { getReader?: () => ByteReader } } | null;
  if (streamBody && typeof streamBody.getReader === 'function') return streamBody.getReader();
  if (streamBody && streamBody.body && typeof streamBody.body.getReader === 'function') {
    return streamBody.body.getReader();
  }
  const asBlob = source as Blob | null;
  if (asBlob && typeof asBlob.stream === 'function') return asBlob.stream().getReader() as ByteReader;
  if (asBlob && typeof asBlob.arrayBuffer === 'function') {
    let inner: ByteReader | null = null;
    return {
      async read() {
        if (!inner) inner = readerFromBytes(new Uint8Array(await asBlob.arrayBuffer()));
        return inner.read();
      },
      cancel() {
        return inner?.cancel?.();
      },
    };
  }
  return readerFromBytes(new Uint8Array(0));
}

function plainSizeOf(source: Blob | Uint8Array): number {
  if (typeof (source as Blob).size === 'number' && !(source instanceof Uint8Array)) {
    return (source as Blob).size;
  }
  if (source instanceof Uint8Array) return source.byteLength;
  return 0;
}

function relayBase(): string {
  const configured = (globalThis as { __E2EE_BACKEND_URL__?: string }).__E2EE_BACKEND_URL__;
  if (typeof configured === 'string') return configured.replace(/\/+$/, '');
  return 'https://onlyonhbar.com';
}

// Public origin of a sealed upload. The relay answers
// `${R2_PUBLIC_BASE}/${key}` (step_by_step server/index.js) and the page
// receives that string as globalThis.__R2_PUBLIC_BASE. https only:
// an http override is not rewritten to https and is not accepted.
const R2_PUBLIC_ORIGIN = 'https://pub-243bb90aeefc464884cd212612165e5b.r2.dev';

export function r2PublicBase(): string {
  const env = (globalThis as { process?: { env?: { R2_PUBLIC_BASE_URL?: string } } }).process?.env
    ?.R2_PUBLIC_BASE_URL;
  if (typeof env === 'string' && env) return env.replace(/\/+$/, '');
  const page = (globalThis as { __R2_PUBLIC_BASE?: unknown }).__R2_PUBLIC_BASE;
  if (typeof page === 'string' && page) return page.replace(/\/+$/, '');
  return R2_PUBLIC_ORIGIN;
}

// https only, same origin and path prefix as the upload's public base.
// A username, a password, "..", or a backslash makes the URL unusable.
function sealedMediaUrl(value: string): string {
  const baseRaw = r2PublicBase();
  if (!baseRaw || typeof value !== 'string' || !value) return '';
  let base: URL;
  let url: URL;
  try {
    base = new URL(baseRaw);
    url = new URL(value);
  } catch {
    return '';
  }
  if (base.protocol !== 'https:' || url.protocol !== 'https:') return '';
  if (url.username || url.password) return '';
  if (url.origin !== base.origin) return '';
  const prefix = base.pathname.replace(/\/+$/, '');
  let path = url.pathname;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    return '';
  }
  if (!path || path.includes('\\') || path.includes('\0')) return '';
  const segments = path.split('/');
  if (segments.includes('..') || segments.includes('.')) return '';
  if (prefix && path !== prefix && !path.startsWith(prefix + '/')) return '';
  const key = path.slice(prefix.length).replace(/^\/+/, '');
  if (!key || key.includes('..')) return '';
  return url.origin + url.pathname;
}

function safeHttp(value: string): string {
  if (typeof value !== 'string' || !value) return '';
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return '';
    return url.href;
  } catch {
    return '';
  }
}

function isMirrorUrl(value: string): boolean {
  try {
    return MIRROR_HOSTS.has(new URL(value).host);
  } catch {
    return false;
  }
}

function b64Field(value: unknown, bytes: number): string {
  if (typeof value !== 'string' || !value || value.length > 80) return '';
  try {
    const raw = sodium.from_base64(value);
    if (raw.length !== bytes) return '';
    return value;
  } catch {
    return '';
  }
}

function cleanMime(value: unknown): string {
  if (typeof value !== 'string') return '';
  const mime = value.trim().toLowerCase();
  if (!mime || mime.length > 80 || mime === SEALED_CONTENT_TYPE) return '';
  if (!/^(video|image)\/[a-z0-9.+-]+$/.test(mime)) return '';
  return mime;
}

function cleanSize(value: unknown): number {
  const size = Number(value);
  if (!Number.isFinite(size) || size < 0) return 0;
  return Math.min(Math.floor(size), SEALED_MAX);
}

function cleanEdge(value: unknown): number {
  const edge = Number(value);
  if (!Number.isFinite(edge) || edge <= 0) return 0;
  return Math.min(Math.floor(edge), 8192);
}

function normalizeNewlines(text: string): string {
  const value = String(text == null ? '' : text)
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
  return value.replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '').replace(/\n+$/, '');
}

function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text == null ? '' : String(text)).length;
}

function b64Len(bytes: number): number {
  const r = bytes % 3;
  return Math.floor(bytes / 3) * 4 + (r === 1 ? 2 : r === 2 ? 3 : 0);
}

function statusError(status: number, message: string): StatusError {
  const err = new Error(message) as StatusError;
  err.status = status;
  return err;
}

function normalizePoster(poster: SealedPoster | null | undefined): SealedPoster | null {
  if (!poster || typeof poster !== 'object') return null;
  const fileKey = b64Field(poster.fileKey, keyBytes());
  const header = b64Field(poster.header, headerBytes());
  if (!fileKey || !header) return null;
  const mime = cleanMime(poster.mime) || 'image/jpeg';
  const size = cleanSize(poster.size);
  if (typeof poster.b64 === 'string' && poster.b64) {
    try {
      const raw = sodium.from_base64(poster.b64);
      if (!raw.length || raw.length > POSTER_EMBED_MAX) return null;
    } catch {
      return null;
    }
    return { b64: poster.b64, fileKey, header, mime, size };
  }
  const url = sealedMediaUrl(poster.url || '');
  if (!url) return null;
  return { url, fileKey, header, mime, size };
}

export function normalizeMedia(media: SealedMedia | null | undefined): SealedMedia | null {
  if (!media || typeof media !== 'object') return null;
  const url = sealedMediaUrl(media.url);
  const fileKey = b64Field(media.fileKey, keyBytes());
  const header = b64Field(media.header, headerBytes());
  if (!url || !fileKey || !header) return null;
  const clean: SealedMedia = {
    url,
    fileKey,
    header,
    mime: cleanMime(media.mime),
    size: cleanSize(media.size),
    w: cleanEdge(media.w),
    h: cleanEdge(media.h),
  };
  const poster = normalizePoster(media.poster);
  if (poster) clean.poster = poster;
  const flag = (media as { gif?: unknown }).gif;
  if (flag === 1 || flag === true) clean.gif = 1;
  return clean;
}

// e2eemedia.js packSealedMedia. `m` is the only media object. No filename.
export function packSealedMedia(text: string, media: SealedMedia | null | undefined): string {
  const clean = normalizeMedia(media);
  if (!clean) return '';
  return (
    CHAT_IMAGE_PREFIX +
    JSON.stringify({
      t: typeof text === 'string' ? text : '',
      m: clean,
    })
  );
}

// e2eemedia.js readSealedMedia. No `m` means an older {t,i,p} message.
// A present but unusable `m` stays a message so the bubble can say it
// cannot be opened, without painting the ciphertext URL.
export function readSealedMedia(raw: string): { text: string; media: SealedMedia } | null {
  if (typeof raw !== 'string' || !raw.startsWith(CHAT_IMAGE_PREFIX)) return null;
  try {
    const data = JSON.parse(raw.slice(CHAT_IMAGE_PREFIX.length)) as { t?: unknown; m?: unknown };
    if (!data || data.m == null) return null;
    const media = normalizeMedia(data.m as SealedMedia);
    const text = typeof data.t === 'string' ? data.t : '';
    if (!media) return { text, media: { ...EMPTY_MEDIA } };
    return { text, media };
  } catch {
    return null;
  }
}

// chatimage.js packChatPayload. A sealed file wins. An older edit that
// still has a clear URL keeps the {t,i,p} thumb. New sends pass media.
export function packChatPayload(
  text: string,
  imageUrl = '',
  poster = '',
  media: SealedMedia | null = null
): string {
  const body = normalizeNewlines(text || '');
  if (media) {
    const packed = packSealedMedia(body, media);
    if (packed) return packed;
  }
  const image = safeHttp(imageUrl);
  if (!image) return body;
  const data: { t: string; i: string; p?: string } = { t: body, i: image };
  if (typeof poster === 'string' && poster.startsWith('data:image/')) data.p = poster;
  return CHAT_IMAGE_PREFIX + JSON.stringify(data);
}

export function unpackChatPayload(raw: string): ChatParts {
  const sealed = readSealedMedia(raw);
  if (sealed) {
    return { text: sealed.text, image: '', poster: '', legacyPlain: false, media: sealed.media };
  }
  const text = typeof raw === 'string' ? raw : '';
  if (!text.startsWith(CHAT_IMAGE_PREFIX)) return { ...EMPTY_PARTS, text };
  try {
    const data = JSON.parse(text.slice(CHAT_IMAGE_PREFIX.length)) as {
      t?: unknown;
      i?: unknown;
      p?: unknown;
    };
    const poster = typeof data.p === 'string' && data.p.startsWith('data:image/') ? data.p : '';
    const image = safeHttp(typeof data.i === 'string' ? data.i : '');
    return {
      text: typeof data.t === 'string' ? data.t : '',
      image,
      poster,
      legacyPlain: image.length > 0 && poster.length === 0,
      media: null,
    };
  } catch {
    return { ...EMPTY_PARTS, text };
  }
}

// videoposter.js e2eeWireBytes. crypto_box_seal is +48 and base64 is unpadded.
export function e2eeWireBytes(payload: string): number {
  const sealed = E2EE_SEAL_BYTES + utf8ByteLength(payload || '');
  const placeholder = 'x'.repeat(b64Len(sealed));
  return utf8ByteLength(JSON.stringify({ encryptedMessage: { ciphertext: placeholder } }));
}

// Drop an embedded poster when the sealed topic message would pass 18 KB.
// A poster that already lives at its own URL is only a short string.
export function packFitting(
  text: string,
  media: SealedMedia | null,
  legacyImage = '',
  legacyPoster = ''
): { packed: string; droppedPoster: boolean } {
  if (media && media.url) {
    let packed = packChatPayload(text, '', '', media);
    if (media.poster?.b64 && packed.startsWith(CHAT_IMAGE_PREFIX) && e2eeWireBytes(packed) > HCS_MESSAGE_MAX_BYTES) {
      const slim: SealedMedia = { ...media };
      delete slim.poster;
      packed = packChatPayload(text, '', '', slim);
      return { packed, droppedPoster: true };
    }
    return { packed, droppedPoster: false };
  }
  let packed = packChatPayload(text, legacyImage, legacyPoster);
  if (legacyPoster && e2eeWireBytes(packed) > HCS_MESSAGE_MAX_BYTES) {
    return { packed: packChatPayload(text, legacyImage, ''), droppedPoster: true };
  }
  return { packed, droppedPoster: false };
}

export function sealedUploadHeaders(extra?: {
  account?: string;
  uploadToken?: string;
  turnstile?: string;
}): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': SEALED_CONTENT_TYPE,
    'X-Sealed': '1',
  };
  const account = extra?.account?.trim() || '';
  if (/^\d+\.\d+\.\d+$/.test(account)) headers['X-Account'] = account;
  if (extra?.uploadToken) headers['X-Upload-Token'] = extra.uploadToken;
  if (extra?.turnstile) headers['CF-Turnstile-Response'] = extra.turnstile;
  return headers;
}

// e2eemedia.js encryptStream. One fresh key unless the caller passes one.
// Full chunks are TAG_MESSAGE. The last chunk, which may be empty, is TAG_FINAL.
export async function encryptStream(
  source: Blob | Uint8Array,
  keyBytesIn?: Uint8Array
): Promise<{ blob: Blob; fileKey: string; header: string; plainSize: number }> {
  await sealedReady();
  const key =
    keyBytesIn instanceof Uint8Array && keyBytesIn.length === keyBytes()
      ? keyBytesIn
      : sodium.crypto_secretstream_xchacha20poly1305_keygen();
  const opened = sodium.crypto_secretstream_xchacha20poly1305_init_push(key);
  const state = opened.state;
  const header = opened.header;
  const parts: Uint8Array[] = [];
  const tagMessage = sodium.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE;
  const tagFinal = sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL;
  const push = (chunk: Uint8Array, final: boolean) => {
    parts.push(
      sodium.crypto_secretstream_xchacha20poly1305_push(
        state,
        copyBytes(chunk),
        null,
        final ? tagFinal : tagMessage
      )
    );
  };
  const reader = readerOf(source);
  let carry = new Uint8Array(0);
  while (true) {
    const step = await reader.read();
    if (step.done) break;
    if (!step.value || !step.value.length) continue;
    carry = concat(carry, step.value);
    while (carry.length > STREAM_CHUNK) {
      push(carry.subarray(0, STREAM_CHUNK), false);
      carry = carry.subarray(STREAM_CHUNK);
    }
  }
  push(carry, true);
  return {
    blob: blobOf(parts, SEALED_CONTENT_TYPE),
    fileKey: sodium.to_base64(key),
    header: sodium.to_base64(header),
    plainSize: plainSizeOf(source),
  };
}

// Plaintext size plus one authenticator per secretstream frame. The header
// stays in the sealed message, so it is not part of the download. A missing
// or empty declared size stops at SEALED_MAX. A known size stops earlier.
export function sealedDownloadCap(size: number | undefined): number {
  const n = Number(size);
  if (!Number.isFinite(n) || n <= 0) return SEALED_MAX;
  const plain = Math.min(Math.floor(n), SEALED_MAX);
  const frames = Math.ceil(plain / STREAM_CHUNK);
  const overhead = frames * sodium.crypto_secretstream_xchacha20poly1305_ABYTES;
  return Math.min(SEALED_MAX, plain + overhead);
}

function headerLength(response: DownloadResponse): number {
  const headers = response && response.headers;
  if (!headers || typeof headers.get !== 'function') return 0;
  const raw = headers.get('content-length');
  if (raw == null || raw === '') return 0;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}

async function fetchSealed(
  url: string,
  cap: number,
  fetchImpl: SealedDownloadFetch
): Promise<{ source: DownloadBody | Uint8Array; stop: () => void }> {
  const controller = new AbortController();
  const stop = () => {
    try {
      controller.abort();
    } catch {
      // Already aborted.
    }
  };
  let response: DownloadResponse;
  try {
    response = await fetchImpl(url, {
      signal: controller.signal,
      redirect: 'error',
      credentials: 'omit',
    });
  } catch {
    stop();
    throw new Error('decrypt');
  }
  if (!response || !response.ok) {
    stop();
    throw new Error('decrypt');
  }
  const announced = headerLength(response);
  if (announced > cap) {
    stop();
    try {
      await response.body?.cancel?.();
    } catch {
      // Unread.
    }
    throw new Error('decrypt');
  }
  const stream = response.body;
  if (stream && typeof stream.getReader === 'function') return { source: stream, stop };
  if (typeof response.arrayBuffer !== 'function') {
    stop();
    throw new Error('decrypt');
  }
  let raw: ArrayBuffer;
  try {
    raw = await response.arrayBuffer();
  } catch {
    stop();
    throw new Error('decrypt');
  }
  if (raw.byteLength > cap) {
    stop();
    throw new Error('decrypt');
  }
  return { source: new Uint8Array(raw), stop };
}

function plaintextBytes(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  let size = 0;
  for (const part of parts) size += part.byteLength;
  const out = new Uint8Array(new ArrayBuffer(size));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

async function decryptFrames(
  source: Blob | Uint8Array | ArrayBuffer | DownloadBody,
  fileKeyB64: string,
  headerB64: string,
  cap: number
): Promise<Uint8Array<ArrayBuffer>> {
  await sealedReady();
  const key = sodium.from_base64(fileKeyB64);
  const header = sodium.from_base64(headerB64);
  if (key.length !== keyBytes() || header.length !== headerBytes()) throw new Error('decrypt');
  const state = sodium.crypto_secretstream_xchacha20poly1305_init_pull(header, key);
  const frameBytes = STREAM_CHUNK + sodium.crypto_secretstream_xchacha20poly1305_ABYTES;
  const tagFinal = sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL;
  const parts: Uint8Array[] = [];
  let sawFinal = false;
  const pull = (frame: Uint8Array) => {
    if (sawFinal) throw new Error('decrypt');
    const opened = sodium.crypto_secretstream_xchacha20poly1305_pull(state, frame, null);
    if (!opened || !opened.message) throw new Error('decrypt');
    parts.push(opened.message);
    if (opened.tag === tagFinal) sawFinal = true;
  };
  const reader = readerOf(source);
  const limit = Number(cap);
  let seen = 0;
  let carry = new Uint8Array(0);
  while (true) {
    const step = await reader.read();
    if (step.done) break;
    if (!step.value || !step.value.length) continue;
    const value = step.value instanceof Uint8Array ? step.value : new Uint8Array(step.value);
    seen += value.byteLength;
    if (Number.isFinite(limit) && seen > limit) {
      try {
        await reader.cancel?.();
      } catch {
        // Already closed.
      }
      throw new Error('decrypt');
    }
    carry = concat(carry, value);
    while (carry.length >= frameBytes) {
      const frame = carry.slice(0, frameBytes);
      carry = carry.subarray(frameBytes);
      pull(frame);
    }
  }
  if (!sawFinal) {
    if (!carry.length) throw new Error('decrypt');
    pull(carry.slice());
  } else if (carry.length) {
    throw new Error('decrypt');
  }
  if (!sawFinal) throw new Error('decrypt');
  return plaintextBytes(parts);
}

export async function decryptStream(
  source: Blob | Uint8Array | ArrayBuffer | DownloadBody,
  fileKeyB64: string,
  headerB64: string,
  cap: number = SEALED_MAX
): Promise<Blob> {
  return blobOf([await decryptFrames(source, fileKeyB64, headerB64, cap)]);
}

// Plaintext bytes. Native uses this directly: React Native cannot build a
// Blob from those bytes, and its fetch response has no body stream.
export async function decryptSealedBytes(
  part: {
    url?: string;
    b64?: string;
    fileKey: string;
    header: string;
    mime?: string;
    size?: number;
  },
  fetchImpl?: SealedDownloadFetch
): Promise<Uint8Array<ArrayBuffer>> {
  await sealedReady();
  if (!part.fileKey || !part.header) throw new Error('decrypt');
  const cap = sealedDownloadCap(part.size);
  let stop = (): void => {};
  try {
    let source: Blob | Uint8Array | DownloadBody;
    if (typeof part.b64 === 'string' && part.b64) {
      let raw: Uint8Array;
      try {
        raw = sodium.from_base64(part.b64);
      } catch {
        throw new Error('decrypt');
      }
      if (!raw.length || raw.byteLength > cap) throw new Error('decrypt');
      source = raw;
    } else {
      const href = sealedMediaUrl(part.url || '');
      if (!href) throw new Error('decrypt');
      const opened = await fetchSealed(
        href,
        cap,
        fetchImpl ?? ((url, init) => fetch(url, init) as Promise<DownloadResponse>)
      );
      stop = opened.stop;
      source = opened.source;
    }
    return await decryptFrames(source, part.fileKey, part.header, cap);
  } catch (err) {
    try {
      stop();
    } catch {
      // Already stopped.
    }
    if (err instanceof Error && err.message === 'decrypt') throw err;
    throw new Error('decrypt');
  }
}

export async function decryptSealedPart(
  part: {
    url?: string;
    b64?: string;
    fileKey: string;
    header: string;
    mime?: string;
    size?: number;
  },
  fetchImpl?: SealedDownloadFetch
): Promise<Blob> {
  const bytes = await decryptSealedBytes(part, fetchImpl);
  const type = typeof part.mime === 'string' && part.mime ? part.mime : SEALED_CONTENT_TYPE;
  return blobOf([bytes], type);
}

export async function sealPosterBytes(
  plain: Uint8Array,
  options?: {
    embedMax?: number;
    fits?: (poster: SealedPoster, body: Uint8Array) => boolean;
  }
): Promise<SealPosterResult> {
  await sealedReady();
  const bytes = plain instanceof Uint8Array ? plain : new Uint8Array(0);
  const enc = await encryptStream(bytes);
  const body = new Uint8Array(await enc.blob.arrayBuffer());
  const embedded: SealedPoster = {
    b64: sodium.to_base64(body),
    fileKey: enc.fileKey,
    header: enc.header,
    mime: 'image/jpeg',
    size: bytes.byteLength,
  };
  const cap = options && options.embedMax && options.embedMax > 0 ? options.embedMax : POSTER_EMBED_MAX;
  const fits = options && typeof options.fits === 'function' ? options.fits(embedded, body) : true;
  if (body.length <= cap && fits) {
    return { mode: 'embed', poster: embedded, uploads: [] };
  }
  return {
    mode: 'upload',
    poster: {
      fileKey: enc.fileKey,
      header: enc.header,
      mime: 'image/jpeg',
      size: bytes.byteLength,
    },
    uploads: [
      {
        contentType: SEALED_CONTENT_TYPE,
        body,
        headers: sealedUploadHeaders(),
      },
    ],
  };
}

export function grantKey(account: string): string {
  return `upload-grant:${account}`;
}

export async function readGrant(
  storage: GrantStorage | null | undefined,
  account: string,
  now = Date.now()
): Promise<UploadGrant | null> {
  if (!account || !storage) return null;
  let raw: string | null = null;
  try {
    raw = await storage.getItem(grantKey(account));
  } catch {
    return null;
  }
  if (!raw) return null;
  let grant: UploadGrant | null = null;
  try {
    grant = JSON.parse(raw) as UploadGrant;
  } catch {
    await clearGrant(storage, account);
    return null;
  }
  if (
    !grant ||
    grant.account !== account ||
    typeof grant.token !== 'string' ||
    grant.token.length === 0 ||
    typeof grant.exp !== 'number' ||
    !Number.isFinite(grant.exp) ||
    grant.exp <= now + GRANT_SKEW_MS
  ) {
    await clearGrant(storage, account);
    return null;
  }
  return { account: grant.account, token: grant.token, exp: grant.exp };
}

export async function writeGrant(storage: GrantStorage | null | undefined, grant: UploadGrant): Promise<void> {
  if (!storage || !grant || !grant.account || typeof grant.token !== 'string') return;
  try {
    await storage.setItem(
      grantKey(grant.account),
      JSON.stringify({ account: grant.account, token: grant.token, exp: grant.exp })
    );
  } catch {
    // The caller still holds the token for this send.
  }
}

export async function clearGrant(storage: GrantStorage | null | undefined, account: string): Promise<void> {
  if (!storage || !account) return;
  try {
    await storage.removeItem(grantKey(account));
  } catch {
    // Nothing left to drop.
  }
}

export function rememberGrant(
  account: string,
  auth: { token?: unknown; exp?: unknown; expiresIn?: unknown },
  now = Date.now()
): UploadGrant {
  let exp = Number(auth && auth.exp);
  if (!Number.isFinite(exp) || exp <= now) {
    const expiresIn = Number(auth && auth.expiresIn);
    exp = Number.isFinite(expiresIn) && expiresIn > 0 ? now + expiresIn * 1000 : now + UPLOAD_GRANT_TTL_MS;
  }
  return { account, token: String(auth.token), exp };
}

// 64 raw signature bytes. WalletConnect returns a SignatureMap protobuf.
// The upload server accepts only those 64 bytes (server/index.js decodeSignature).
export function signatureBytesFromWallet(result: unknown): Uint8Array | null {
  let text = '';
  if (typeof result === 'string') text = result;
  else if (result && typeof result === 'object' && 'signatureMap' in result) {
    const map = (result as { signatureMap?: unknown }).signatureMap;
    text = typeof map === 'string' ? map : '';
  }
  text = text.trim();
  if (!text) return null;
  if (/^[0-9a-fA-F]{128}$/.test(text)) {
    const hex = new Uint8Array(64);
    for (let i = 0; i < 64; i++) hex[i] = parseInt(text.substr(i * 2, 2), 16);
    return hex;
  }
  let raw: Uint8Array;
  try {
    const bin = atob(text);
    raw = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) raw[i] = bin.charCodeAt(i);
  } catch {
    return null;
  }
  if (raw.length === 64) return raw;
  return findSignature(raw, 0, raw.length);
}

function readVarint(buf: Uint8Array, index: number): { n: number; i: number } | null {
  let n = 0;
  let shift = 0;
  let i = index;
  while (i < buf.length && shift < 35) {
    const b = buf[i];
    i += 1;
    n += (b & 0x7f) * 2 ** shift;
    if ((b & 0x80) === 0) return { n, i };
    shift += 7;
  }
  return null;
}

function findSignature(buf: Uint8Array, start: number, end: number): Uint8Array | null {
  let i = start;
  while (i < end) {
    const tag = readVarint(buf, i);
    if (!tag) return null;
    const field = tag.n >>> 3;
    const wire = tag.n & 7;
    i = tag.i;
    if (wire === 2) {
      const len = readVarint(buf, i);
      if (!len) return null;
      const from = len.i;
      const to = from + len.n;
      if (to > end) return null;
      if ((field === 2 || field === 3) && len.n === 64) return buf.slice(from, to);
      const inner = findSignature(buf, from, to);
      if (inner) return inner;
      i = to;
    } else if (wire === 0) {
      const skipped = readVarint(buf, i);
      if (!skipped) return null;
      i = skipped.i;
    } else {
      return null;
    }
  }
  return null;
}

async function readUploadUrl(res: UploadResponse): Promise<string> {
  if (!res.ok) {
    throw statusError(res.status, res.status === 403 ? 'Turnstile check failed' : 'Upload failed');
  }
  let data: { ok?: unknown; url?: unknown } = {};
  try {
    const parsed = await res.json();
    if (parsed && typeof parsed === 'object') data = parsed as { ok?: unknown; url?: unknown };
  } catch {
    throw new Error('Upload failed');
  }
  const url = sealedMediaUrl(typeof data.url === 'string' ? data.url : '');
  if (data.ok !== true || !url || isMirrorUrl(url)) throw new Error('Upload failed');
  return url;
}

export async function postSealedBlob(options: {
  body: Blob;
  mode: 'relay' | 'hedera-only';
  account?: string;
  uploadToken?: string;
  turnstile?: string;
  fetchImpl?: UploadFetch;
  backendUrl?: string;
}): Promise<string> {
  if (options.mode !== 'relay') throw new Error(MEDIA_BLOCKED);
  const base = (options.backendUrl ?? relayBase()).replace(/\/+$/, '');
  const endpoint = `${base}/api/upload`;
  if (isMirrorUrl(endpoint)) throw new Error('Media is not stored on the mirror');
  const headers = sealedUploadHeaders({
    account: options.account,
    uploadToken: options.uploadToken,
    turnstile: options.turnstile,
  });
  const fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init) as Promise<UploadResponse>);
  const res = await fetchImpl(endpoint, { method: 'POST', headers, body: options.body });
  return readUploadUrl(res);
}

// Encrypt on this device, then POST only the ciphertext. A 401 means the
// server wants a signed upload token. The wallet is asked only then, once,
// and the same ciphertext is sent one more time. A server that does not
// require upload auth accepts X-Account and never opens the wallet.
export async function uploadSealedChatMedia(options: {
  bytes: Uint8Array;
  mime: string;
  mode: 'relay' | 'hedera-only';
  account?: string;
  width?: number;
  height?: number;
  fetchImpl?: UploadFetch;
  backendUrl?: string;
  turnstile?: string;
  sign?: () => Promise<UploadGrant>;
  storage?: GrantStorage;
  decorate?: (media: SealedMedia, token: string) => Promise<SealedPoster | null>;
}): Promise<SealedMedia> {
  if (options.mode !== 'relay') throw new Error(MEDIA_BLOCKED);
  const base = (options.backendUrl ?? relayBase()).replace(/\/+$/, '');
  const endpoint = `${base}/api/upload`;
  if (isMirrorUrl(endpoint)) throw new Error('Media is not stored on the mirror');
  const mime = String(options.mime || '').split(';')[0].trim().toLowerCase();
  if (!ALLOWED.has(mime)) throw new Error('Only PNG, JPG, WebP, MP4, WebM');
  const bytes = options.bytes;
  if (!bytes || bytes.byteLength === 0) throw new Error('Empty file');
  const video = mime.startsWith('video/');
  if (bytes.byteLength > (video ? VIDEO_MAX : IMAGE_MAX)) {
    throw new Error(video ? 'Too big — 100 MB max' : 'Image is too large');
  }
  const enc = await encryptStream(bytes);
  if (enc.blob.size > SEALED_MAX) throw new Error(video ? 'Too big — 100 MB max' : 'Image is too large');
  const account = typeof options.account === 'string' ? options.account.trim() : '';
  const accountOk = /^\d+\.\d+\.\d+$/.test(account);
  const fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init) as Promise<UploadResponse>);

  const attempt = async (token: string): Promise<SealedMedia> => {
    const url = await postSealedBlob({
      body: enc.blob,
      mode: 'relay',
      account,
      uploadToken: token,
      turnstile: options.turnstile,
      fetchImpl,
      backendUrl: base,
    });
    const media: SealedMedia = {
      url,
      fileKey: enc.fileKey,
      header: enc.header,
      mime,
      size: bytes.byteLength,
      w: cleanEdge(options.width),
      h: cleanEdge(options.height),
    };
    if (options.decorate) {
      const poster = await options.decorate(media, token);
      if (poster) media.poster = poster;
    }
    return media;
  };

  let token = '';
  if (options.storage && accountOk) {
    const grant = await readGrant(options.storage, account);
    if (grant) token = grant.token;
  }
  try {
    return await attempt(token);
  } catch (err) {
    const status = (err as StatusError).status;
    if (status !== 401 || !options.sign) throw err;
    if (options.storage && accountOk) await clearGrant(options.storage, account);
    const grant = await options.sign();
    if (!grant || typeof grant.token !== 'string' || grant.token.length === 0) {
      throw new Error('Upload failed, please try again');
    }
    if (options.storage) await writeGrant(options.storage, grant);
    try {
      return await attempt(grant.token);
    } catch (again) {
      if ((again as StatusError).status === 401 && options.storage) {
        await clearGrant(options.storage, grant.account || account);
      }
      throw again;
    }
  }
}
