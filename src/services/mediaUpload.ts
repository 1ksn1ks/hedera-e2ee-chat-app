// Previews stay in memory on the web. Native decrypted files live in the
// app cache directory and are deleted on chat close and logout. A picked
// name is never read. Nothing here writes the gallery.
// The base URL matches backend.ts (default onlyonhbar.com).
import { NativeModules } from 'react-native';

export const MEDIA_BLOCKED = 'Media is off on Direct Hedera — no server to hold files.';

// mediaurl.js. A legacy clear video is an extension, including a query or hash.
const VIDEO_URL = /\.(mp4|webm|mov|m4v)(?=$|[?#])/i;

const held = new Set<string>();
const heldFiles = new Set<string>();
const releaseListeners = new Set<() => void>();

type CacheMediaNative = {
  append(name: string, base64: string, append: boolean): Promise<string>;
  remove(uri: string): Promise<void>;
  clear(): Promise<void>;
};

function cacheMedia(): CacheMediaNative | null {
  const mod = (NativeModules as { CacheMedia?: CacheMediaNative } | undefined)?.CacheMedia;
  if (!mod || typeof mod.append !== 'function' || typeof mod.clear !== 'function') return null;
  return mod;
}

function cacheExtension(mime: string): string {
  if (mime === 'image/png') return 'png';
  if (mime === 'image/webp') return 'webp';
  if (mime === 'image/jpeg') return 'jpg';
  if (mime === 'video/webm') return 'webm';
  if (mime === 'video/mp4') return 'mp4';
  return 'bin';
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

// App cache only. The native module refuses a name that leaves that directory.
export async function holdCacheFile(bytes: Uint8Array, mime: string): Promise<string> {
  const mod = cacheMedia();
  if (!mod) throw new Error('decrypt');
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let id = '';
  for (let i = 0; i < 12; i += 1) id += alphabet[Math.floor(Math.random() * alphabet.length)];
  const name = `${id}.${cacheExtension(mime)}`;
  const piece = 48 * 1024;
  let uri = '';
  if (bytes.byteLength === 0) uri = await mod.append(name, '', false);
  for (let i = 0; i < bytes.byteLength; i += piece) {
    const slice = bytes.subarray(i, Math.min(bytes.byteLength, i + piece));
    uri = await mod.append(name, bytesToBase64(slice), i > 0);
  }
  if (!uri.startsWith('file:')) throw new Error('decrypt');
  heldFiles.add(uri);
  return uri;
}

function dropCacheFile(uri: string): void {
  heldFiles.delete(uri);
  const mod = cacheMedia();
  if (!mod || typeof mod.remove !== 'function') return;
  mod.remove(uri).catch(() => {
    // Already deleted.
  });
}

function dropCacheFiles(): void {
  heldFiles.clear();
  const mod = cacheMedia();
  if (!mod) return;
  mod.clear().catch(() => {
    // The directory is already gone.
  });
}

function relayBase(): string {
  const configured = (globalThis as { __E2EE_BACKEND_URL__?: string }).__E2EE_BACKEND_URL__;
  if (typeof configured === 'string') return configured.replace(/\/+$/, '');
  return 'https://onlyonhbar.com';
}

export function relayUploadBase(): string {
  return relayBase();
}

export function isVideoUrl(url: string): boolean {
  return typeof url === 'string' && VIDEO_URL.test(url);
}

// hedera-only has no relay to store a file. Callers must stop before fetch.
export function mediaSendingAllowed(mode: 'relay' | 'hedera-only'): boolean {
  return mode === 'relay';
}

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
  if (!url) return;
  if (heldFiles.has(url)) {
    dropCacheFile(url);
    return;
  }
  if (!held.has(url)) return;
  held.delete(url);
  if (typeof URL === 'undefined') return;
  try {
    URL.revokeObjectURL(url);
  } catch {
    /* already revoked */
  }
}

export function onMediaReleased(listener: () => void): () => void {
  releaseListeners.add(listener);
  return () => {
    releaseListeners.delete(listener);
  };
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
  dropCacheFiles();
  for (const listener of releaseListeners) listener();
}

// The filename is never read. Bytes and the MIME type are the whole file.
export function pickLocalMedia(): Promise<{ bytes: Uint8Array; mime: string } | null> {
  if (typeof document === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/png,image/jpeg,image/webp,video/mp4,video/webm';
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
