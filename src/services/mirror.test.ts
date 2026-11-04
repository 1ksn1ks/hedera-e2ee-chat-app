import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createChunkAssembler,
  mapMirrorRows,
  mirrorMessagesUrl,
  startMirrorTail,
  type MirrorRow,
} from './mirror.ts';

const TOPIC = '0.0.42';

function b64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

function plain(body: unknown, seq: number, payer = '0.0.5'): MirrorRow {
  return {
    consensus_timestamp: '1700000000.000000000',
    message: b64(JSON.stringify(body)),
    payer_account_id: payer,
    sequence_number: seq,
    topic_id: TOPIC,
  };
}

test('maps a mirror row onto the relay AppMessage shape', () => {
  const ts = '1700000000.000000000';
  const mapped = mapMirrorRows(TOPIC, [
    plain({ encryptedMessage: { ciphertext: 'abc' }, publicKey: 'aa' }, 7),
  ]);
  assert.equal(mapped.messages.length, 1);
  const message = mapped.messages[0];
  assert.equal(message.payer, '0.0.5');
  assert.equal(message.consensus_timestamp, ts);
  assert.equal(message.sequence_number, 7);
  assert.equal(message.created, new Date(Number(ts) * 1000).toISOString());
  assert.deepEqual(message.encryptedMessage, { ciphertext: 'abc' });
  assert.equal(message.publicKey, 'aa');
  assert.equal(mapped.lastSeq, 7);
});

test('joins chunked mirror rows, including a one-part chunk_info group', () => {
  const text = '{"encryptedMessage":{"ciphertext":"hello"}}';
  const bytes = Buffer.from(text, 'utf8');
  const mid = 10;
  const part = (start: number, end: number) => Buffer.from(bytes.subarray(start, end)).toString('base64');
  const id = {
    account_id: '0.0.5',
    nonce: 0,
    scheduled: false,
    transaction_valid_start: '1700000000.070836376',
  };
  const chunk = (number: number, total: number, seq: number, message: string): MirrorRow => ({
    consensus_timestamp: '1700000000.000000000',
    message,
    payer_account_id: '0.0.5',
    sequence_number: seq,
    chunk_info: { number, total, initial_transaction_id: id },
  });

  const one = mapMirrorRows(TOPIC, [chunk(1, 1, 3, b64(text))]);
  assert.equal(one.messages.length, 1);
  assert.deepEqual(one.messages[0].encryptedMessage, { ciphertext: 'hello' });
  assert.equal(one.messages[0].sequence_number, 3);
  assert.equal(one.messages[0].payer, '0.0.5');

  const split = mapMirrorRows(TOPIC, [
    chunk(1, 2, 4, part(0, mid)),
    chunk(2, 2, 5, part(mid, bytes.length)),
  ]);
  assert.equal(split.messages.length, 1);
  assert.deepEqual(split.messages[0].encryptedMessage, { ciphertext: 'hello' });
  assert.equal(split.messages[0].sequence_number, 4);
  assert.equal(split.messages[0].consensus_timestamp, '1700000000.000000000');
  assert.equal(split.lastSeq, 5);
});

test('holds the cursor in front of an unfinished chunk group', () => {
  const id = { account_id: '0.0.5', nonce: 0, scheduled: false, transaction_valid_start: '1.2' };
  const mapped = mapMirrorRows(
    TOPIC,
    [
      {
        consensus_timestamp: '1700000000.000000000',
        message: b64('{"encryptedMessage":{"ciphertext":"x"}}'),
        payer_account_id: '0.0.5',
        sequence_number: 8,
        chunk_info: { number: 1, total: 2, initial_transaction_id: id },
      },
    ],
    0
  );
  assert.equal(mapped.messages.length, 0);
  assert.equal(mapped.lastSeq, 7);
});

test('skips non-JSON and a chunk whose payer is not the initial account', () => {
  const junk = mapMirrorRows(TOPIC, [
    {
      consensus_timestamp: '1700000000.000000000',
      message: b64('not json'),
      payer_account_id: '0.0.5',
      sequence_number: 2,
    },
  ]);
  assert.equal(junk.messages.length, 0);
  assert.equal(junk.lastSeq, 2);

  const wrong = mapMirrorRows(TOPIC, [
    {
      consensus_timestamp: '1700000000.000000000',
      message: b64('{"encryptedMessage":{"ciphertext":"no"}}'),
      payer_account_id: '0.0.9',
      sequence_number: 6,
      chunk_info: {
        number: 1,
        total: 1,
        initial_transaction_id: {
          account_id: '0.0.5',
          nonce: 0,
          scheduled: false,
          transaction_valid_start: '1.0',
        },
      },
    },
  ]);
  assert.equal(wrong.messages.length, 0);
  assert.equal(wrong.lastSeq, 6);
  assert.equal(createChunkAssembler().pendingSequences(TOPIC).length, 0);
});

test('first mirror page omits sequencenumber=gt:0 and later pages send gt:{n}', () => {
  const first = mirrorMessagesUrl(TOPIC, 0);
  assert.match(first, /^https:\/\/mainnet-public\.mirrornode\.hedera\.com\/api\/v1\/topics\/0\.0\.42\/messages\?/);
  assert.match(first, /order=asc/);
  assert.equal(first.includes('sequencenumber='), false);
  const next = mirrorMessagesUrl('0.0.42', 5);
  assert.match(next, /sequencenumber=gt:5$/);
});

test('mirror tail pauses while hidden and polls while visible', async () => {
  let hiddenCalls = 0;
  const hidden = startMirrorTail({
    topicId: TOPIC,
    afterSeq: 0,
    intervalMs: 15,
    isVisible: () => false,
    fetchPage: async () => {
      hiddenCalls += 1;
      return { messages: [], lastSeq: 0 };
    },
    onMessages: () => {},
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  hidden.close();
  assert.equal(hiddenCalls, 0);

  let seenAfter = -1;
  let calls = 0;
  const visible = startMirrorTail({
    topicId: TOPIC,
    afterSeq: 4,
    intervalMs: 40,
    isVisible: () => true,
    fetchPage: async (_topic, after) => {
      calls += 1;
      seenAfter = after;
      return { messages: [], lastSeq: after };
    },
    onMessages: () => {},
  });
  await new Promise((resolve) => setTimeout(resolve, 15));
  visible.close();
  assert.equal(calls, 1);
  assert.equal(seenAfter, 4);
});
