// The video fixture is produced by step_by_step/videoposter.js packSealedThumb
// (the E2EE chat packer) when that file is next to this repo. The embedded
// string is the same call's output: packSealedThumb("hello\nthere",
// "https://cdn.example/markers/12-ab.mp4", "data:image/jpeg;base64,/9j/4AAQ").
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { packChatPayload, unpackChatPayload } from './chatPayload.ts';

const TEXT = 'hello\nthere';
const VIDEO = 'https://cdn.example/markers/12-ab.mp4';
const POSTER = 'data:image/jpeg;base64,/9j/4AAQ';
const GLOBE = resolve(process.cwd(), '../step_by_step/videoposter.js');

// Prefix byte is U+001E. The JSON newline is the two characters \ and n.
const EMBEDDED =
  '\u001echat1\n{"t":"hello\\nthere","i":"https://cdn.example/markers/12-ab.mp4","p":"data:image/jpeg;base64,/9j/4AAQ"}';

test('round trip matches step_by_step packSealedThumb', async () => {
  let packed = EMBEDDED;
  if (existsSync(GLOBE)) {
    const mod = (await import(pathToFileURL(GLOBE).href)) as {
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
  }
  const parts = unpackChatPayload(packed);
  assert.equal(parts.text, TEXT);
  assert.equal(parts.image, VIDEO);
  assert.equal(parts.poster, POSTER);
  assert.equal(parts.legacyPlain, false);
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
  assert.equal(packChatPayload('hi', 'https://cdn.example/a.jpg', 'https://cdn.example/not-a-still.jpg'), raw);
  const blocked = unpackChatPayload('\u001echat1\n' + JSON.stringify({ t: 'x', i: 'javascript:alert(1)' }));
  assert.equal(blocked.image, '');
  assert.equal(blocked.legacyPlain, false);
});
