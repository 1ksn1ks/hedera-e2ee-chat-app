// LOGIC CHANGE. The sealed still is a data:image URL inside the topic
// payload (videoposter.js:145-154), not a second ciphertext. Capture matches
// captureVideoPoster: 0.1s (videoposter.js:8) and edges 720, 480, 320, 160
// (videoposter.js:9), shrunk until the 18 KB message fits
// (uploadmedia.js dataUrlForSeal). The frame stays in memory. Upload and
// preview lifetime live in mediaUpload.ts.
import { HCS_MESSAGE_MAX_BYTES, sendOutgoingBytes } from './chatPayload';

export {
  MEDIA_BLOCKED,
  holdPreview,
  isVideoUrl,
  mediaSendingAllowed,
  pickLocalMedia,
  releaseHeldMedia,
  releasePreview,
  uploadChatMedia,
} from './mediaUpload';

const THUMB_EDGES = [720, 480, 320, 160];
const THUMB_AT_S = 0.1;

function evenFloor(n: number): number {
  const v = Math.floor(Number(n) || 0);
  const even = v - (v % 2);
  return even < 2 ? 2 : even;
}

function captureFrame(bytes: Uint8Array, mime: string, edge: number): Promise<string> {
  if (typeof document === 'undefined' || !mime.startsWith('video/')) return Promise.resolve('');
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const blobUrl = URL.createObjectURL(new Blob([copy], { type: mime }));
  return new Promise((resolve) => {
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    let done = false;
    const finish = (value: string) => {
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
      resolve(value.startsWith('data:image/') ? value : '');
    };
    const timer = window.setTimeout(() => finish(''), 4000);
    video.onerror = () => finish('');
    video.onloadeddata = () => {
      const at = video.duration > 0 ? Math.min(THUMB_AT_S, Math.max(0, video.duration - 0.05)) : 0;
      const draw = () => {
        try {
          const w = video.videoWidth || 0;
          const h = video.videoHeight || 0;
          if (!w || !h) {
            finish('');
            return;
          }
          const long = Math.max(w, h);
          const scale = long > edge ? edge / long : 1;
          const canvas = document.createElement('canvas');
          canvas.width = evenFloor(w * scale);
          canvas.height = evenFloor(h * scale);
          const ctx = canvas.getContext('2d');
          if (!ctx) {
            finish('');
            return;
          }
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          finish(canvas.toDataURL('image/jpeg', 0.85));
        } catch {
          finish('');
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

// Shrink the still until the sealed topic message fits. A miss drops it.
export async function posterForSeal(
  bytes: Uint8Array,
  mime: string,
  text: string,
  imageUrl: string
): Promise<string> {
  if (!mime.startsWith('video/')) return '';
  for (const edge of THUMB_EDGES) {
    const data = await captureFrame(bytes, mime, edge);
    if (!data) return '';
    if (sendOutgoingBytes(text, imageUrl, data) <= HCS_MESSAGE_MAX_BYTES) return data;
  }
  return '';
}
