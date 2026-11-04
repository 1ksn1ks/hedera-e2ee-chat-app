import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MEDIA_BLOCKED, uploadChatMedia, type UploadFetch } from './mediaUpload.ts';

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);

test('hedera-only mode blocks uploads before any request', async () => {
  let calls = 0;
  const fetchImpl: UploadFetch = async () => {
    calls += 1;
    throw new Error('fetch should not run');
  };
  await assert.rejects(
    () =>
      uploadChatMedia({
        bytes: JPEG,
        mime: 'image/jpeg',
        mode: 'hedera-only',
        fetchImpl,
        backendUrl: 'https://onlyonhbar.com',
      }),
    (err: unknown) => err instanceof Error && err.message === MEDIA_BLOCKED
  );
  assert.equal(calls, 0);
});

test('relay upload posts the file type to /api/upload and never the mirror', async () => {
  let seenUrl = '';
  let seen: { method: string; headers: Record<string, string>; body: Blob } | null = null;
  const fetchImpl: UploadFetch = async (url, init) => {
    seenUrl = url;
    seen = init;
    return {
      ok: true,
      status: 200,
      url,
      json: async () => ({ ok: true, url: 'https://cdn.example/markers/1.jpg' }),
    };
  };
  const out = await uploadChatMedia({
    bytes: JPEG,
    mime: 'image/jpeg',
    mode: 'relay',
    account: '0.0.9',
    fetchImpl,
    backendUrl: 'https://onlyonhbar.com',
  });
  assert.equal(out.url, 'https://cdn.example/markers/1.jpg');
  assert.equal(seenUrl, 'https://onlyonhbar.com/api/upload');
  assert.ok(seen);
  assert.equal(seen.headers['Content-Type'], 'image/jpeg');
  assert.equal(seen.headers['X-Sealed'], '1');
  assert.equal(seen.headers['X-Account'], '0.0.9');
  assert.equal(JSON.stringify(seen.headers).toLowerCase().includes('filename'), false);
  assert.equal(seen.headers['Content-Type'] === 'application/octet-stream', false);
  assert.equal(seen.body.type, 'image/jpeg');

  let mirrorCalls = 0;
  const mirrorFetch: UploadFetch = async () => {
    mirrorCalls += 1;
    throw new Error('mirror fetch');
  };
  await assert.rejects(
    () =>
      uploadChatMedia({
        bytes: JPEG,
        mime: 'image/jpeg',
        mode: 'relay',
        fetchImpl: mirrorFetch,
        backendUrl: 'https://mainnet-public.mirrornode.hedera.com',
      }),
    /mirror/
  );
  assert.equal(mirrorCalls, 0);
});
