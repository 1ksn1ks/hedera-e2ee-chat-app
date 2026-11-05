// Round trip against step_by_step/e2eemedia.js. Old {t,i,p} still matches
// videoposter.js packSealedThumb. The embedded string is that call's output.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sendOutgoingBytes } from './chatPayload.ts';
import {
  STREAM_CHUNK,
  decryptStream,
  e2eeWireBytes,
  encryptStream,
  packChatPayload,
  packSealedMedia,
  readSealedMedia,
  sealPosterBytes,
  sealedReady,
  signatureBytesFromWallet,
  unpackChatPayload,
} from './sealedMedia.ts';

const TEXT = 'hello\nthere';
const VIDEO = 'https://cdn.example/markers/12-ab.mp4';
const POSTER = 'data:image/jpeg;base64,/9j/4AAQ';
const GLOBE_THUMB = resolve(process.cwd(), '../step_by_step/videoposter.js');
const GLOBE_MEDIA = resolve(process.cwd(), '../step_by_step/e2eemedia.js');

const EMBEDDED =
  '\u001echat1\n{"t":"hello\\nthere","i":"https://cdn.example/markers/12-ab.mp4","p":"data:image/jpeg;base64,/9j/4AAQ"}';

function markerBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

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

async function blobBytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

test('round trip matches step_by_step packSealedThumb', async () => {
  let packed = EMBEDDED;
  if (existsSync(GLOBE_THUMB)) {
    const mod = (await import(pathToFileURL(GLOBE_THUMB).href)) as {
      packSealedThumb: (text: string, image: string, poster: string) => string;
      unpackSealedThumb: (raw: string) => { text: string; image: string; poster: string };
    };
    packed = mod.packSealedThumb(TEXT, VIDEO, POSTER);
    assert.equal(packed, EMBEDDED);
    const theirs = mod.unpackSealedThumb(packed);
    const ours = unpackChatPayload(packed);
    assert.equal(ours.text, theirs.text);
    assert.equal(ours.image, theirs.image);
    assert.equal(ours.poster, theirs.poster);
    assert.equal(ours.media, null);
  }
  const parts = unpackChatPayload(packed);
  assert.equal(parts.text, TEXT);
  assert.equal(parts.image, VIDEO);
  assert.equal(parts.poster, POSTER);
  assert.equal(parts.legacyPlain, false);
  assert.equal(parts.media, null);
  assert.equal(packChatPayload(TEXT, VIDEO, POSTER), packed);
  const again = unpackChatPayload(packChatPayload(TEXT, VIDEO, POSTER));
  assert.equal(again.text, TEXT);
  assert.equal(again.image, VIDEO);
  assert.equal(again.poster, POSTER);
});

test('old plain {t,i} image links still parse', () => {
  const raw = '\u001echat1\n' + JSON.stringify({ t: 'hi', i: 'https://cdn.example/a.jpg' });
  const parts = unpackChatPayload(raw);
  assert.equal(parts.text, 'hi');
  assert.equal(parts.image, 'https://cdn.example/a.jpg');
  assert.equal(parts.poster, '');
  assert.equal(parts.legacyPlain, true);
  assert.equal(parts.media, null);
  assert.equal(packChatPayload('hi', 'https://cdn.example/a.jpg', 'https://cdn.example/not-a-still.jpg'), raw);
  const blocked = unpackChatPayload('\u001echat1\n' + JSON.stringify({ t: 'x', i: 'javascript:alert(1)' }));
  assert.equal(blocked.image, '');
  assert.equal(blocked.legacyPlain, false);
  assert.equal(readSealedMedia(raw), null);
});

test('sealed pack matches step_by_step and both sides decrypt', async () => {
  assert.equal(existsSync(GLOBE_MEDIA), true);
  await sealedReady();
  const globe = (await import(pathToFileURL(GLOBE_MEDIA).href)) as {
    STREAM_CHUNK: number;
    decryptStream: (source: Blob | Uint8Array, fileKey: string, header: string) => Promise<Blob>;
    encryptStream: (source: Uint8Array) => Promise<{ blob: Blob; fileKey: string; header: string }>;
    packSealedMedia: (text: string, media: unknown) => string;
    readSealedMedia: (raw: string) => { text: string; media: { fileKey: string; header: string; mime: string; poster?: { b64?: string } } } | null;
  };
  assert.equal(globe.STREAM_CHUNK, STREAM_CHUNK);

  const marker = markerBytes('PLAINTEXT-MARKER-ftyp-SECRET-do-not-store');
  const plain = new Uint8Array(STREAM_CHUNK + 30);
  plain.set(marker, 0);
  plain[STREAM_CHUNK] = 9;

  const ours = await encryptStream(plain);
  const ourBody = await blobBytes(ours.blob);
  assert.equal(indexOfBytes(ourBody, marker), -1);
  assert.equal(ours.blob.type, 'application/octet-stream');
  const openedByGlobe = await globe.decryptStream(ours.blob, ours.fileKey, ours.header);
  assert.deepEqual(await blobBytes(openedByGlobe), plain);
  const openedByUs = await decryptStream(ourBody, ours.fileKey, ours.header);
  assert.deepEqual(await blobBytes(openedByUs), plain);

  const theirs = await globe.encryptStream(plain);
  const theirBody = await blobBytes(theirs.blob);
  assert.equal(indexOfBytes(theirBody, marker), -1);
  const openedTheirs = await decryptStream(theirs.blob, theirs.fileKey, theirs.header);
  assert.deepEqual(await blobBytes(openedTheirs), plain);

  const empty = await encryptStream(new Uint8Array(0));
  const emptyBack = await decryptStream(empty.blob, empty.fileKey, empty.header);
  assert.equal((await blobBytes(emptyBack)).length, 0);

  const exact = new Uint8Array(STREAM_CHUNK);
  for (let i = 0; i < exact.length; i += 1) exact[i] = i & 255;
  const exactEnc = await encryptStream(exact);
  assert.deepEqual(await blobBytes(await decryptStream(exactEnc.blob, exactEnc.fileKey, exactEnc.header)), exact);

  const media = {
    url: 'https://cdn.example/markers/1700000000000-ab12cd',
    fileKey: ours.fileKey,
    header: ours.header,
    mime: 'video/mp4',
    size: plain.byteLength,
    w: 320,
    h: 180,
    name: 'holiday.mp4',
  };
  const packedOurs = packSealedMedia(TEXT, media);
  const packedTheirs = globe.packSealedMedia(TEXT, media);
  assert.equal(packedOurs, packedTheirs);
  assert.equal(packedOurs.includes('holiday.mp4'), false);
  assert.equal(packedOurs.includes('PLAINTEXT'), false);
  assert.equal(packedOurs.includes('"i"'), false);
  const read = unpackChatPayload(packedTheirs);
  assert.equal(read.text, TEXT);
  assert.equal(read.image, '');
  assert.equal(read.media && read.media.mime, 'video/mp4');
  assert.equal(read.media && read.media.w, 320);
  assert.equal(read.legacyPlain, false);
  const globeRead = globe.readSealedMedia(packedOurs);
  assert.equal(globeRead && globeRead.media.fileKey, ours.fileKey);

  const missing = unpackChatPayload(
    '\u001echat1\n' + JSON.stringify({ t: 'locked', m: { url: 'https://cdn.example/markers/1' } })
  );
  assert.equal(missing.text, 'locked');
  assert.equal(missing.image, '');
  assert.ok(missing.media);
  assert.equal(missing.media && missing.media.fileKey, '');
  assert.equal(missing.media && missing.media.header, '');

  assert.equal(e2eeWireBytes(packedOurs), sendOutgoingBytes(packedOurs));
  assert.equal(e2eeWireBytes('hello'), sendOutgoingBytes('hello'));
});

test('a poster is ciphertext, embedded or uploaded, and never a clear JPEG', async () => {
  await sealedReady();
  const marker = markerBytes('POSTER-PLAINTEXT-UNIQUE');
  const plain = new Uint8Array(64);
  plain.set([0xff, 0xd8, 0xff], 0);
  plain.set(marker, 8);
  const embedded = await sealPosterBytes(plain, { fits: () => true });
  assert.equal(embedded.mode, 'embed');
  assert.equal(embedded.uploads.length, 0);
  assert.equal(typeof embedded.poster.b64, 'string');
  const hidden = await (async () => {
    const { sealedReady: ready, decryptStream: open } = await import('./sealedMedia.ts');
    await ready();
    const sodium = (await import('libsodium-wrappers-sumo')).default;
    await sodium.ready;
    return sodium.from_base64(embedded.poster.b64 || '');
  })();
  assert.equal(indexOfBytes(hidden, marker), -1);
  assert.equal(indexOfBytes(hidden, new Uint8Array([0xff, 0xd8, 0xff])), -1);
  const opened = await decryptStream(hidden, embedded.poster.fileKey, embedded.poster.header);
  assert.deepEqual(await blobBytes(opened), plain);

  const uploaded = await sealPosterBytes(plain, { fits: () => false });
  assert.equal(uploaded.mode, 'upload');
  assert.equal(uploaded.poster.b64, undefined);
  assert.equal(uploaded.uploads.length, 1);
  assert.equal(uploaded.uploads[0].contentType, 'application/octet-stream');
  assert.equal(uploaded.uploads[0].headers['Content-Type'], 'application/octet-stream');
  assert.equal(uploaded.uploads[0].headers['X-Sealed'], '1');
  assert.equal(uploaded.uploads[0].headers['X-Poster-For'], undefined);
  assert.equal(uploaded.uploads[0].headers['X-Media-Role'], undefined);
  assert.equal(indexOfBytes(uploaded.uploads[0].body, marker), -1);
  assert.equal(indexOfBytes(uploaded.uploads[0].body, new Uint8Array([0xff, 0xd8, 0xff])), -1);

  const packed = packSealedMedia('hello', {
    url: 'https://cdn.example/markers/1700000000000-ab12cd',
    fileKey: embedded.poster.fileKey,
    header: embedded.poster.header,
    mime: 'image/jpeg',
    size: 64,
    w: 8,
    h: 8,
    poster: embedded.poster,
  });
  assert.equal(packed.includes('POSTER-PLAINTEXT'), false);
  assert.equal(packed.startsWith('\u001echat1\n'), true);
  const read = readSealedMedia(packed);
  assert.equal(read && read.media.poster && read.media.poster.b64, embedded.poster.b64);
});

test('wallet signature bytes are the 64-byte field, not the protobuf map', () => {
  const sig = new Uint8Array(64);
  sig.fill(0x11);
  const pair = new Uint8Array(2 + 64);
  pair[0] = 0x12;
  pair[1] = 64;
  pair.set(sig, 2);
  const map = new Uint8Array(2 + pair.length);
  map[0] = 0x0a;
  map[1] = pair.length;
  map.set(pair, 2);
  const text = Buffer.from(map).toString('base64');
  const found = signatureBytesFromWallet({ signatureMap: text });
  assert.ok(found);
  assert.deepEqual(found, sig);
  const raw = signatureBytesFromWallet(Buffer.from(sig).toString('base64'));
  assert.ok(raw);
  assert.deepEqual(raw, sig);
});

test('the send path no longer posts a clear file', () => {
  const upload = readFileSync(new URL('./mediaUpload.ts', import.meta.url), 'utf8');
  const crypto = readFileSync(new URL('./mediaCrypto.ts', import.meta.url), 'utf8');
  const screen = readFileSync(new URL('../screens/ChatScreen.tsx', import.meta.url), 'utf8');
  assert.equal(upload.includes('X-Media-Role'), false);
  assert.equal(upload.includes('X-Media-Duration'), false);
  assert.equal(upload.includes("Content-Type': mime"), false);
  assert.match(crypto, /uploadSealedChatMedia/);
  assert.match(crypto, /sealPosterBytes/);
  assert.doesNotMatch(crypto, /X-Media-Role|X-Media-Duration|X-Poster-For|Content-Disposition/);
  assert.match(screen, /uploadChatMedia/);
  assert.doesNotMatch(screen, /posterForSeal/);
});
