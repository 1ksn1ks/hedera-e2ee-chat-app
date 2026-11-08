// The bytes handed to the wallet, decoded with the real protobuf: topic,
// payer, node, valid transaction ids, and chunks that join back into the
// original body with chunk 1's id as every part's initial id.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AccountId, TransactionId } from '@hashgraph/sdk';
import { proto } from '@hiero-ledger/proto';
import {
  chunkCount,
  freezeChunk,
  freezeSingle,
  HCS_CHUNK_SIZE,
  pickNode,
  signAndExecuteParams,
} from './hcsTx.ts';

const PAYER = '0.0.9779355';
const TOPIC = '0.0.9609912';

function bodies(transactionList: string) {
  const list = proto.TransactionList.decode(Buffer.from(transactionList, 'base64'));
  return (list.transactionList || []).map((t) => {
    const signed = proto.SignedTransaction.decode(t.signedTransactionBytes as Uint8Array);
    return proto.TransactionBody.decode(signed.bodyBytes as Uint8Array);
  });
}

const idText = (id: proto.ITransactionID | null | undefined) =>
  `${id?.accountID?.accountNum}@${id?.transactionValidStart?.seconds}.${id?.transactionValidStart?.nanos}`;

test('pickNode returns a real mainnet node id', () => {
  const node = pickNode();
  assert.ok(node instanceof AccountId);
  assert.match(node.toString(), /^0\.0\.\d+$/);
  assert.ok(Number(node.toString().split('.')[2]) >= 3);
});

test('one-chunk body: frozen for the payer on one node, HIP-820 params', () => {
  const message = new TextEncoder().encode('{"encryptedMessage":{"ciphertext":"abc"}}');
  const node = AccountId.fromString('0.0.5');
  const tx = freezeSingle({ topicId: TOPIC, message, node, transactionId: TransactionId.generate(PAYER) });
  const params = signAndExecuteParams(tx, 'hedera:mainnet', PAYER);
  assert.equal(params.signerAccountId, `hedera:mainnet:${PAYER}`);
  const [body, ...rest] = bodies(params.transactionList);
  assert.equal(rest.length, 0);
  assert.equal(String(body.transactionID?.accountID?.accountNum), '9779355');
  assert.equal(String(body.nodeAccountID?.accountNum), '5');
  assert.equal(String(body.consensusSubmitMessage?.topicID?.topicNum), '9609912');
  assert.equal(new TextDecoder().decode(body.consensusSubmitMessage?.message as Uint8Array), new TextDecoder().decode(message));
});

test('a long body is one frozen transaction per chunk that joins back together', () => {
  const text = 'x'.repeat(HCS_CHUNK_SIZE * 2 + 300);
  const message = new TextEncoder().encode(text);
  const total = chunkCount(message);
  assert.equal(total, 3);
  const node = AccountId.fromString('0.0.7');
  const first = TransactionId.generate(PAYER);
  const firstId = idText(first._toProtobuf());
  const parts: string[] = [];
  const ids: string[] = [];
  for (let number = 1; number <= total; number++) {
    const transactionId = number === 1 ? first : TransactionId.generate(PAYER);
    const tx = freezeChunk({ topicId: TOPIC, message, node, transactionId, initialTransactionId: first, number, total });
    const list = bodies(signAndExecuteParams(tx, 'hedera:mainnet', PAYER).transactionList);
    assert.equal(list.length, 1, 'each approval carries exactly one body');
    const body = list[0];
    const info = body.consensusSubmitMessage?.chunkInfo;
    assert.equal(info?.number, number);
    assert.equal(info?.total, total);
    assert.equal(idText(info?.initialTransactionID), firstId, 'every part names chunk 1');
    assert.equal(String(body.nodeAccountID?.accountNum), '7');
    ids.push(idText(body.transactionID));
    parts.push(new TextDecoder().decode(body.consensusSubmitMessage?.message as Uint8Array));
  }
  assert.equal(parts.join(''), text);
  assert.equal(parts[0].length, HCS_CHUNK_SIZE);
  assert.equal(ids[0], firstId, 'chunk 1 is sent under its own initial id');
  assert.equal(new Set(ids).size, total, 'each later chunk has its own valid-start');
});
