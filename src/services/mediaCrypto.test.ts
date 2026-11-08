import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import {
  MEDIA_BLOCKED,
  decryptStream,
  uploadSealedChatMedia,
  type UploadFetch,
  type UploadGrant,
} from './sealedMedia.ts';

process.env.R2_PUBLIC_BASE_URL = 'https://cdn.example/media';
(globalThis as { __R2_PUBLIC_BASE?: string }).__R2_PUBLIC_BASE = 'https://cdn.example/media';

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xd9, 1, 2, 3, 4]);
const MARKER = new TextEncoder().encode('PLAINTEXT-MARKER-ftyp-SECRET-do-not-store');

function indexOfBytes(hay: Uint8Array, needle: Uint8Array): number {
  if (!needle.length || hay.length < needle.length) return -1;
  outer: for (let i = 0; i + needle.length <= hay.length; i += 1) {
    for (let j = 0; j < needle.length; j += 1) {
      if (hay[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

test('hedera-only mode blocks uploads before any request', async () => {
  let calls = 0;
  let signs = 0;
  const fetchImpl: UploadFetch = async () => {
    calls += 1;
    throw new Error('fetch should not run');
  };
  await assert.rejects(
    () =>
      uploadSealedChatMedia({
        bytes: JPEG,
        mime: 'image/jpeg',
        mode: 'hedera-only',
        fetchImpl,
        backendUrl: 'https://onlyonhbar.com',
        sign: async () => {
          signs += 1;
          return { account: '0.0.9', token: 'nope', exp: Date.now() + 1000 };
        },
      }),
    (err: unknown) => err instanceof Error && err.message === MEDIA_BLOCKED
  );
  assert.equal(calls, 0);
  assert.equal(signs, 0);
});

test('relay upload posts ciphertext as octet-stream and never the mirror', async () => {
  const plain = new Uint8Array(80);
  plain.set(MARKER, 0);
  plain.set(JPEG, 40);
  let seenUrl = '';
  let seen: { method: string; headers: Record<string, string>; body: Blob } | null = null;
  const fetchImpl: UploadFetch = async (url, init) => {
    seenUrl = url;
    seen = init;
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, url: 'https://cdn.example/media/markers/1700000000000-ab12cd' }),
    };
  };
  const out = await uploadSealedChatMedia({
    bytes: plain,
    mime: 'image/jpeg',
    mode: 'relay',
    account: '0.0.9',
    width: 12,
    height: 8,
    fetchImpl,
    backendUrl: 'https://onlyonhbar.com',
  });
  assert.equal(out.url, 'https://cdn.example/media/markers/1700000000000-ab12cd');
  assert.equal(out.mime, 'image/jpeg');
  assert.equal(out.size, plain.byteLength);
  assert.equal(out.w, 12);
  assert.equal(out.h, 8);
  assert.equal(seenUrl, 'https://onlyonhbar.com/api/upload');
  assert.ok(seen);
  const headers = seen.headers;
  assert.equal(headers['Content-Type'], 'application/octet-stream');
  assert.equal(headers['X-Sealed'], '1');
  assert.equal(headers['X-Account'], '0.0.9');
  assert.equal(headers['X-Upload-Token'], undefined);
  assert.equal(headers['X-Media-Role'], undefined);
  assert.equal(headers['X-Media-Duration'], undefined);
  assert.equal(headers['X-Poster-For'], undefined);
  assert.equal(headers['Content-Disposition'], undefined);
  assert.equal(JSON.stringify(headers).toLowerCase().includes('filename'), false);
  assert.equal(JSON.stringify(headers).includes('image/jpeg'), false);
  assert.equal(seen.body.type, 'application/octet-stream');
  const body = new Uint8Array(await seen.body.arrayBuffer());
  assert.equal(indexOfBytes(body, MARKER), -1);
  assert.equal(indexOfBytes(body, JPEG), -1);
  const opened = await decryptStream(body, out.fileKey, out.header);
  assert.deepEqual(new Uint8Array(await opened.arrayBuffer()), plain);

  let mirrorCalls = 0;
  const mirrorFetch: UploadFetch = async () => {
    mirrorCalls += 1;
    throw new Error('mirror fetch');
  };
  await assert.rejects(
    () =>
      uploadSealedChatMedia({
        bytes: plain,
        mime: 'image/jpeg',
        mode: 'relay',
        fetchImpl: mirrorFetch,
        backendUrl: 'https://mainnet-public.mirrornode.hedera.com',
      }),
    /mirror/
  );
  assert.equal(mirrorCalls, 0);
});

test('a 401 signs once and retries the same ciphertext', async () => {
  const calls: { headers: Record<string, string>; body: Uint8Array }[] = [];
  let signs = 0;
  const fetchImpl: UploadFetch = async (_url, init) => {
    calls.push({ headers: init.headers, body: new Uint8Array(await init.body.arrayBuffer()) });
    if (calls.length === 1) return { ok: false, status: 401, json: async () => ({ ok: false }) };
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, url: 'https://cdn.example/media/markers/2' }),
    };
  };
  const storage = new Map<string, string>();
  const grant: UploadGrant = { account: '0.0.9', token: 'signed-token', exp: Date.now() + 60_000 };
  const out = await uploadSealedChatMedia({
    bytes: JPEG,
    mime: 'image/jpeg',
    mode: 'relay',
    account: '0.0.9',
    fetchImpl,
    backendUrl: 'https://onlyonhbar.com',
    storage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => {
        storage.set(key, value);
      },
      removeItem: (key) => {
        storage.delete(key);
      },
    },
    sign: async () => {
      signs += 1;
      return grant;
    },
  });
  assert.equal(out.url, 'https://cdn.example/media/markers/2');
  assert.equal(signs, 1);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].headers['X-Upload-Token'], undefined);
  assert.equal(calls[1].headers['X-Upload-Token'], 'signed-token');
  assert.equal(calls[0].headers['Content-Type'], 'application/octet-stream');
  assert.deepEqual(calls[0].body, calls[1].body);
  assert.equal(indexOfBytes(calls[0].body, JPEG), -1);
  assert.equal(storage.get('upload-grant:0.0.9')?.includes('signed-token'), true);
});

test(
  'globe decrypts the bytes this app would upload',
  { skip: existsSync(resolve(process.cwd(), '../step_by_step/e2eemedia.js')) ? false : 'needs the step_by_step checkout next to this repo' },
  async () => {
  const globePath = resolve(process.cwd(), '../step_by_step/e2eemedia.js');
  assert.equal(existsSync(globePath), true);
  const globe = (await import(pathToFileURL(globePath).href)) as {
    decryptStream: (source: Uint8Array, fileKey: string, header: string) => Promise<Blob>;
  };
  let body = new Uint8Array(0);
  let key = '';
  let header = '';
  const fetchImpl: UploadFetch = async (_url, init) => {
    body = new Uint8Array(await init.body.arrayBuffer());
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, url: 'https://cdn.example/media/markers/3' }),
    };
  };
  const out = await uploadSealedChatMedia({
    bytes: JPEG,
    mime: 'image/png',
    mode: 'relay',
    fetchImpl,
    backendUrl: 'https://onlyonhbar.com',
  });
  key = out.fileKey;
  header = out.header;
  const opened = await globe.decryptStream(body, key, header);
  assert.deepEqual(new Uint8Array(await opened.arrayBuffer()), JPEG);
});

test('a video poster seeks once and draws every edge from that frame', () => {
  const crypto = readFileSync(new URL('./mediaCrypto.ts', import.meta.url), 'utf8');
  assert.equal(crypto.includes('captureFrame'), false);
  assert.equal(crypto.split('URL.createObjectURL').length - 1, 1);
  assert.equal(crypto.split('video.currentTime = at').length - 1, 1);
  assert.match(crypto, /URL\.revokeObjectURL/);
  assert.match(crypto, /for \(const edge of THUMB_EDGES\)/);
  assert.match(crypto, /frame\.jpegAt\(edge\)/);
  assert.match(crypto, /frame\.close\(\)/);
  assert.match(crypto, /toDataURL\('image\/jpeg', 0\.85\)/);
  assert.match(crypto, /choice\.mode === 'embed'/);
  assert.match(crypto, /postSealedBlob/);
});
