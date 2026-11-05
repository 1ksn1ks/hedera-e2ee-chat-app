// LOGIC CHANGE. A video still is its own secretstream, never a clear JPEG.
// Capture edges match videoposter.js THUMB_EDGES (720, 480, 320, 160) at 0.1s.
// The still is embedded when the ciphertext is at most 24 KB and the sealed
// topic message still fits 18 KB. Otherwise that ciphertext is a second
// octet-stream upload. The composer chip is a local blob only.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { HCS_MESSAGE_MAX_BYTES } from './chatPayload';
import {
  holdCacheFile,
  holdPreview,
  relayUploadBase,
} from './mediaUpload';
import {
  e2eeWireBytes,
  packSealedMedia,
  postSealedBlob,
  rememberGrant,
  sealPosterBytes,
  uploadSealedChatMedia,
  type GrantStorage,
  type SealedMedia,
  type SealedPoster,
  type UploadGrant,
  decryptSealedBytes,
  decryptSealedPart,
} from './sealedMedia';
import { signUploadNonce } from './wallet';

export {
  MEDIA_BLOCKED,
  holdPreview,
  isVideoUrl,
  mediaSendingAllowed,
  onMediaReleased,
  pickLocalMedia,
  releaseHeldMedia,
  releasePreview,
} from './mediaUpload';

export type { SealedMedia, SealedPoster } from './sealedMedia';

const THUMB_EDGES = [720, 480, 320, 160];
const THUMB_AT_S = 0.1;

const grantStorage: GrantStorage = {
  getItem: (key) => AsyncStorage.getItem(key),
  setItem: (key, value) => AsyncStorage.setItem(key, value),
  removeItem: (key) => AsyncStorage.removeItem(key),
};

function evenFloor(n: number): number {
  const v = Math.floor(Number(n) || 0);
  const even = v - (v % 2);
  return even < 2 ? 2 : even;
}

function dataUrlBytes(dataUrl: string): Uint8Array | null {
  if (!dataUrl.startsWith('data:image/jpeg')) return null;
  const comma = dataUrl.indexOf(',');
  if (comma < 0) return null;
  let bin = '';
  try {
    bin = atob(dataUrl.slice(comma + 1));
  } catch {
    return null;
  }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function captureFrame(
  bytes: Uint8Array,
  mime: string,
  edge: number
): Promise<{ bytes: Uint8Array; w: number; h: number } | null> {
  if (typeof document === 'undefined' || !mime.startsWith('video/')) return Promise.resolve(null);
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const blobUrl = URL.createObjectURL(new Blob([copy], { type: mime }));
  return new Promise((resolve) => {
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    let done = false;
    const finish = (value: { bytes: Uint8Array; w: number; h: number } | null) => {
      if (done) return;
      done = true;
      window.clearTimeout(timer);
      try {
        URL.revokeObjectURL(blobUrl);
      } catch {
        /* already revoked */
      }
      video.removeAttribute('src');
      try {
        video.load();
      } catch {
        /* already idle */
      }
      resolve(value);
    };
    const timer = window.setTimeout(() => finish(null), 4000);
    video.onerror = () => finish(null);
    video.onloadeddata = () => {
      const at = video.duration > 0 ? Math.min(THUMB_AT_S, Math.max(0, video.duration - 0.05)) : 0;
      const draw = () => {
        try {
          const w = video.videoWidth || 0;
          const h = video.videoHeight || 0;
          if (!w || !h) {
            finish(null);
            return;
          }
          const long = Math.max(w, h);
          const scale = long > edge ? edge / long : 1;
          const canvas = document.createElement('canvas');
          canvas.width = evenFloor(w * scale);
          canvas.height = evenFloor(h * scale);
          const ctx = canvas.getContext('2d');
          if (!ctx) {
            finish(null);
            return;
          }
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          const jpeg = dataUrlBytes(canvas.toDataURL('image/jpeg', 0.85));
          finish(jpeg ? { bytes: jpeg, w, h } : null);
        } catch {
          finish(null);
        }
      };
      if (Math.abs((video.currentTime || 0) - at) < 0.001) {
        draw();
        return;
      }
      video.onseeked = draw;
      try {
        video.currentTime = at;
      } catch {
        draw();
      }
    };
    video.src = blobUrl;
  });
}

async function measureImage(bytes: Uint8Array, mime: string): Promise<{ w: number; h: number }> {
  if (typeof createImageBitmap !== 'function' || !mime.startsWith('image/')) return { w: 0, h: 0 };
  try {
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    const bmp = await createImageBitmap(new Blob([copy], { type: mime }));
    const box = { w: bmp.width, h: bmp.height };
    if (bmp.close) bmp.close();
    return box;
  } catch {
    return { w: 0, h: 0 };
  }
}

async function requestUploadGrant(account: string, base: string): Promise<UploadGrant> {
  let challenge: { nonce?: unknown } | null = null;
  try {
    const challengeRes = await fetch(`${base}/api/upload/challenge`);
    challenge = (await challengeRes.json().catch(() => null)) as { nonce?: unknown } | null;
    if (!challengeRes.ok || !challenge || typeof challenge.nonce !== 'string') {
      throw new Error('Upload failed, please try again');
    }
  } catch (err) {
    if (err instanceof Error && err.message === 'Upload failed, please try again') throw err;
    throw new Error('Upload failed, please try again');
  }
  const signature = await signUploadNonce(challenge.nonce as string);
  const authRes = await fetch(`${base}/api/upload/auth`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ accountId: account, nonce: challenge.nonce, signature }),
  });
  const auth = (await authRes.json().catch(() => null)) as {
    token?: unknown;
    exp?: unknown;
    expiresIn?: unknown;
  } | null;
  if (authRes.status === 503) {
    const err = new Error('Upload auth is not configured') as Error & { status?: number };
    err.status = 503;
    throw err;
  }
  if (!authRes.ok || !auth || typeof auth.token !== 'string') {
    throw new Error('Upload failed, please try again');
  }
  const grant = rememberGrant(account, auth);
  await grantStorage.setItem(`upload-grant:${account}`, JSON.stringify(grant));
  return grant;
}

async function sealVideoPoster(
  bytes: Uint8Array,
  mime: string,
  text: string,
  media: SealedMedia,
  token: string,
  account: string,
  base: string
): Promise<{ poster: SealedPoster | null; jpeg: Uint8Array | null; w: number; h: number }> {
  let fallback: Awaited<ReturnType<typeof sealPosterBytes>> | null = null;
  let jpeg: Uint8Array | null = null;
  let w = 0;
  let h = 0;
  for (const edge of THUMB_EDGES) {
    const frame = await captureFrame(bytes, mime, edge);
    if (!frame) return { poster: null, jpeg, w, h };
    if (!w) {
      w = frame.w;
      h = frame.h;
    }
    jpeg = frame.bytes;
    if (!media.w && frame.w) media.w = frame.w;
    if (!media.h && frame.h) media.h = frame.h;
    const choice = await sealPosterBytes(frame.bytes, {
      fits(poster) {
        const packed = packSealedMedia(text, { ...media, poster });
        return !!packed && e2eeWireBytes(packed) <= HCS_MESSAGE_MAX_BYTES;
      },
    });
    if (choice.mode === 'embed') return { poster: choice.poster, jpeg, w, h };
    fallback = choice;
  }
  if (!fallback || !fallback.uploads.length) return { poster: null, jpeg, w, h };
  const upload = fallback.uploads[0];
  const copy = new Uint8Array(upload.body.byteLength);
  copy.set(upload.body);
  const posterUrl = await postSealedBlob({
    body: new Blob([copy], { type: upload.contentType }),
    mode: 'relay',
    account,
    uploadToken: token,
    backendUrl: base,
  });
  return {
    poster: {
      url: posterUrl,
      fileKey: fallback.poster.fileKey,
      header: fallback.poster.header,
      mime: 'image/jpeg',
      size: fallback.poster.size,
    },
    jpeg,
    w,
    h,
  };
}

export async function uploadChatMedia(options: {
  bytes: Uint8Array;
  mime: string;
  mode: 'relay' | 'hedera-only';
  account?: string;
  text?: string;
}): Promise<{ media: SealedMedia; chipBytes: Uint8Array | null }> {
  const mime = String(options.mime || '').split(';')[0].trim().toLowerCase();
  const base = relayUploadBase();
  const account = options.account || '';
  const dims = mime.startsWith('image/') ? await measureImage(options.bytes, mime) : { w: 0, h: 0 };
  let chipBytes: Uint8Array | null = null;
  const media = await uploadSealedChatMedia({
    bytes: options.bytes,
    mime,
    mode: options.mode,
    account,
    width: dims.w,
    height: dims.h,
    backendUrl: base,
    storage: grantStorage,
    sign: account ? () => requestUploadGrant(account, base) : undefined,
    decorate: mime.startsWith('video/')
      ? async (partial, token) => {
          const sealed = await sealVideoPoster(
            options.bytes,
            mime,
            options.text || '',
            partial,
            token,
            account,
            base
          );
          chipBytes = sealed.jpeg;
          return sealed.poster;
        }
      : undefined,
  });
  return { media, chipBytes };
}

// Decrypt one sealed part. Web keeps a blob URL. Native writes a file in
// the app cache (deleted on chat close and logout) and never a data: URL.
export async function openSealedPart(part: {
  url?: string;
  b64?: string;
  fileKey: string;
  header: string;
  mime?: string;
  size?: number;
}): Promise<string> {
  const mime = part.mime || 'application/octet-stream';
  if (typeof document === 'undefined') {
    const bytes = await decryptSealedBytes(part);
    return holdCacheFile(bytes, mime);
  }
  const blob = await decryptSealedPart(part);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return holdPreview(bytes, mime);
}
