// LOGIC CHANGE. File bytes go to Globe's relay, not the mirror, and not as
// a secretstream blob. step_by_step has no fileKey/header fields.
// POST /api/upload (uploadmedia.js:565, server/index.js:2445) accepts the
// real image or video type. application/octet-stream is 415
// (server/index.js:1913-1920, :2461-2465). X-Sealed: 1 (uploadmedia.js:571)
// skips the public poster-edit token (server/index.js:2573-2577).
// hedera-only never calls fetch: there is no server to hold the file.
// This file does not log bytes, keys, or filenames, and it does not write
// the gallery. Previews are blob URLs revoked on chat close and logout.
// The base URL matches backend.ts readBackendUrl (default onlyonhbar.com).

export const MEDIA_BLOCKED = 'Media is off on Direct Hedera — no server to hold files.';

const VIDEO_MAX = 100 * 1024 * 1024;
const IMAGE_MAX = 20 * 1024 * 1024;
const ALLOWED = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'video/mp4',
  'video/webm',
  'video/quicktime',
]);

// mediaurl.js:6-7. A video is an extension, including a query or hash.
const VIDEO_URL = /\.(mp4|webm|mov|m4v)(?=$|[?#])/i;

const MIRROR_HOSTS = new Set([
  'mainnet-public.mirrornode.hedera.com',
  'mainnet.mirrornode.hedera.com',
]);

const held = new Set<string>();

function relayBase(): string {
  const configured = (globalThis as { __E2EE_BACKEND_URL__?: string }).__E2EE_BACKEND_URL__;
  if (typeof configured === 'string') return configured.replace(/\/+$/, '');
  return 'https://onlyonhbar.com';
}

export function isVideoUrl(url: string): boolean {
  return typeof url === 'string' && VIDEO_URL.test(url);
}

// hedera-only has no relay to store a file. Callers must stop before fetch.
export function mediaSendingAllowed(mode: 'relay' | 'hedera-only'): boolean {
  return mode === 'relay';
}

function httpUrl(value: string): string {
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

export interface UploadResponse {
  ok: boolean;
  status: number;
  url?: string;
  json: () => Promise<unknown>;
}

export type UploadFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: Blob }
) => Promise<UploadResponse>;

// A picked file becomes a memory blob URL for the composer chip. Revoke
// drops it. Nothing here is written to disk or the gallery.
function mediaBlob(bytes: Uint8Array, mime: string): Blob {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new Blob([copy], { type: mime });
}

export function holdPreview(bytes: Uint8Array, mime: string): string {
  if (typeof URL === 'undefined' || typeof Blob === 'undefined') return '';
  const url = URL.createObjectURL(mediaBlob(bytes, mime || 'application/octet-stream'));
  held.add(url);
  return url;
}

export function releasePreview(url: string): void {
  if (!url || !held.has(url)) return;
  held.delete(url);
  if (typeof URL === 'undefined') return;
  try {
    URL.revokeObjectURL(url);
  } catch {
    /* already revoked */
  }
}

export function releaseHeldMedia(): void {
  if (typeof URL !== 'undefined') {
    for (const url of held) {
      try {
        URL.revokeObjectURL(url);
      } catch {
        /* already revoked */
      }
    }
  }
  held.clear();
}

// The filename is never read. Bytes and the MIME type are the whole file.
export function pickLocalMedia(): Promise<{ bytes: Uint8Array; mime: string } | null> {
  if (typeof document === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/png,image/jpeg,image/webp,video/mp4,video/webm,video/quicktime';
    let settled = false;
    const finish = (value: { bytes: Uint8Array; mime: string } | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    input.onchange = () => {
      const file = input.files && input.files[0];
      if (!file) {
        finish(null);
        return;
      }
      const mime = file.type;
      file.arrayBuffer().then(
        (buf) => finish({ bytes: new Uint8Array(buf), mime }),
        () => finish(null)
      );
    };
    window.addEventListener(
      'focus',
      () => {
        setTimeout(() => {
          if (!input.files || !input.files[0]) finish(null);
        }, 500);
      },
      { once: true }
    );
    input.click();
  });
}

export async function uploadChatMedia(options: {
  bytes: Uint8Array;
  mime: string;
  mode: 'relay' | 'hedera-only';
  account?: string;
  fetchImpl?: UploadFetch;
  backendUrl?: string;
}): Promise<{ url: string }> {
  // Mode is checked before any request, including a mirror URL.
  if (!mediaSendingAllowed(options.mode)) {
    throw new Error(MEDIA_BLOCKED);
  }
  const mime = String(options.mime || '').split(';')[0].trim().toLowerCase();
  if (!ALLOWED.has(mime)) throw new Error('Only PNG, JPG, WebP, MP4, WebM');
  const bytes = options.bytes;
  if (!bytes || bytes.byteLength === 0) throw new Error('Empty file');
  const video = mime.startsWith('video/');
  if (bytes.byteLength > (video ? VIDEO_MAX : IMAGE_MAX)) {
    throw new Error(video ? 'Too big — 100 MB max' : 'Image is too large');
  }
  const base = (options.backendUrl ?? relayBase()).replace(/\/+$/, '');
  const endpoint = `${base}/api/upload`;
  if (isMirrorUrl(endpoint)) throw new Error('Media is not stored on the mirror');
  const headers: Record<string, string> = {
    'Content-Type': mime,
    'X-Sealed': '1',
    'X-Media-Role': 'media',
  };
  const account = typeof options.account === 'string' ? options.account.trim() : '';
  if (/^\d+\.\d+\.\d+$/.test(account)) headers['X-Account'] = account;
  const fetchImpl = options.fetchImpl ?? (fetch as unknown as UploadFetch);
  const res = await fetchImpl(endpoint, {
    method: 'POST',
    headers,
    body: mediaBlob(bytes, mime),
  });
  if (!res.ok) throw new Error('Upload failed');
  let data: { ok?: unknown; url?: unknown } = {};
  try {
    const parsed = await res.json();
    if (parsed && typeof parsed === 'object') data = parsed as { ok?: unknown; url?: unknown };
  } catch {
    throw new Error('Upload failed');
  }
  const url = httpUrl(typeof data.url === 'string' ? data.url : '');
  if (data.ok !== true || !url || isMirrorUrl(url)) throw new Error('Upload failed');
  return { url };
}
