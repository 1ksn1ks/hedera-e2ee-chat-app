// Previews stay in memory. The ciphertext upload lives in sealedMedia.ts.
// A picked name is never read. Revoke runs on chat close and logout.
// The base URL matches backend.ts (default onlyonhbar.com).

export const MEDIA_BLOCKED = 'Media is off on Direct Hedera — no server to hold files.';

// mediaurl.js. A legacy clear video is an extension, including a query or hash.
const VIDEO_URL = /\.(mp4|webm|mov|m4v)(?=$|[?#])/i;

const held = new Set<string>();
const releaseListeners = new Set<() => void>();

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
  if (!url || !held.has(url)) return;
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
