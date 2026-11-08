// HCS transactions for the wallet, frozen the way the Globe map freezes them
// (hedera.js freezeForConnectedAccount, hcssplit.js freezeOneHcsChunk).
// Only @hashgraph/sdk is imported, so the node tests load this file alone.
import {
  AccountId,
  Client,
  TopicId,
  TopicMessageSubmitTransaction,
  Transaction,
  TransactionId,
} from '@hashgraph/sdk';

// HCS splits a body into 1024-byte chunks (hcschunks.js). One wallet
// sign-and-execute carries one transaction body, so a longer body is sent
// as one approval per chunk.
export const HCS_CHUNK_SIZE = 1024;
export const HCS_MAX_CHUNKS = 20;

export function chunkCount(bytes: Uint8Array): number {
  return Math.max(1, Math.ceil(bytes.length / HCS_CHUNK_SIZE));
}

// One mainnet consensus node, picked at random. client.network maps each
// node address to its AccountId (the private _network is the SDK's own
// Network object, not a node list).
export function pickNode(): AccountId {
  const client = Client.forMainnet();
  try {
    const ids = [...new Set(Object.values(client.network).map((id) => String(id)))];
    if (!ids.length) throw new Error('No Hedera node available');
    return AccountId.fromString(ids[Math.floor(Math.random() * ids.length)]);
  } finally {
    void client.close();
  }
}

// A body of one chunk, frozen for the payer on one node.
export function freezeSingle(opts: {
  topicId: string;
  message: Uint8Array;
  node: AccountId;
  transactionId: TransactionId;
}): TopicMessageSubmitTransaction {
  return new TopicMessageSubmitTransaction()
    .setTopicId(TopicId.fromString(opts.topicId))
    .setMessage(opts.message)
    .setNodeAccountIds([opts.node])
    .setTransactionId(opts.transactionId)
    .freeze();
}

// Chunk `number` of `total` as its own one-body transaction with its own
// valid-start, while chunkInfo keeps chunk 1's id so the mirror joins them.
export function freezeChunk(opts: {
  topicId: string;
  message: Uint8Array;
  node: AccountId;
  transactionId: TransactionId;
  initialTransactionId: TransactionId;
  number: number;
  total: number;
}): TopicMessageSubmitTransaction {
  const tx = new TopicMessageSubmitTransaction()
    .setTopicId(TopicId.fromString(opts.topicId))
    .setMessage(opts.message)
    .setMaxChunks(HCS_MAX_CHUNKS)
    .setChunkSize(HCS_CHUNK_SIZE);
  tx.setNodeAccountIds([opts.node]);
  tx.setTransactionId(opts.transactionId);
  (tx as unknown as { _chunkInfo: unknown })._chunkInfo = {
    initialTransactionID: (opts.initialTransactionId as unknown as { _toProtobuf: () => unknown })._toProtobuf(),
    total: opts.total,
    number: opts.number,
  };
  (Transaction.prototype.freezeWith as (this: Transaction, client: null) => Transaction).call(tx, null);
  return tx;
}

// Base64 without Node's Buffer (RN has none): chunked btoa.
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

// HIP-820 hedera_signAndExecuteTransaction params, as DAppSigner sends them:
// the frozen transaction as a base64 TransactionList.
export function signAndExecuteParams(tx: Transaction, chain: string, account: string) {
  return {
    signerAccountId: `${chain}:${account}`,
    transactionList: bytesToBase64(new Uint8Array(tx.toBytes())),
  };
}
