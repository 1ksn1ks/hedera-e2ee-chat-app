import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createChunkAssembler,
  fetchMirrorHistory,
  mapMirrorRows,
  mirrorHistoryUrl,
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

test('history is newest-first and the tail is sequencenumber=gt:{n} order=asc', () => {
  const history = mirrorHistoryUrl(TOPIC);
  assert.match(history, /^https:\/\/mainnet-public\.mirrornode\.hedera\.com\/api\/v1\/topics\/0\.0\.42\/messages\?/);
  assert.match(history, /limit=100/);
  assert.match(history, /order=desc/);
  assert.equal(history.includes('sequencenumber='), false);

  const tailStart = mirrorMessagesUrl(TOPIC, 0);
  assert.match(tailStart, /order=asc/);
  assert.equal(tailStart.includes('sequencenumber='), false);
  const tail = mirrorMessagesUrl('0.0.42', 5);
  assert.match(tail, /order=asc/);
  assert.match(tail, /sequencenumber=gt:5$/);
});

function jsonResponse(body: unknown): Response {
  return { ok: true, json: async () => body } as Response;
}

test('history reverses desc pages, keeps chunks and the payer check, and seeds the highest sequence', async () => {
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
  const newer: { messages: MirrorRow[]; links: { next: string | null } } = {
    messages: [
      plain({ encryptedMessage: { ciphertext: 'new' } }, 9),
      chunk(2, 2, 8, part(mid, bytes.length)),
      {
        consensus_timestamp: '1700000000.000000000',
        message: b64('{"encryptedMessage":{"ciphertext":"no"}}'),
        payer_account_id: '0.0.9',
        sequence_number: 7,
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
    ],
    links: { next: '/api/v1/topics/0.0.42/messages?limit=100&order=desc&sequencenumber=lt:7' },
  };
  const older = {
    messages: [chunk(1, 2, 6, part(0, mid)), plain({ encryptedMessage: { ciphertext: 'old' } }, 4)],
    links: { next: null },
  };
  const urls: string[] = [];
  const page = await fetchMirrorHistory(TOPIC, async (url) => {
    urls.push(url);
    return jsonResponse(urls.length === 1 ? newer : older);
  });
  assert.match(urls[0], /order=desc/);
  assert.match(urls[1], /sequencenumber=lt:7/);
  assert.deepEqual(
    page.messages.map((message) => message.sequence_number),
    [4, 6, 9]
  );
  assert.deepEqual(page.messages[1].encryptedMessage, { ciphertext: 'hello' });
  assert.equal(page.messages.some((message) => message.sequence_number === 7), false);
  assert.equal(page.lastSeq, 9);
});

test('history stops after 10 pages', async () => {
  let calls = 0;
  const page = await fetchMirrorHistory(TOPIC, async () => {
    calls += 1;
    const seq = 1000 - calls;
    return jsonResponse({
      messages: [plain({ encryptedMessage: { ciphertext: String(seq) } }, seq)],
      links: { next: '/api/v1/topics/0.0.42/messages?limit=100&order=desc&sequencenumber=lt:' + seq },
    });
  });
  assert.equal(calls, 10);
  assert.equal(page.lastSeq, 999);
  assert.equal(page.messages[0].sequence_number, 990);
  assert.equal(page.messages[page.messages.length - 1].sequence_number, 999);
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
