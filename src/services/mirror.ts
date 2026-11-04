// Direct reads from the public Hedera mirror. No relay, no keys, no plaintext.
// Rows are base64 topic messages mapped into the same AppMessage shape the
// relay's /api/messages route serves (server/index.js toAppMessage).
import type { AppMessage } from './backend';

// The user-facing mirror. mainnet.mirrornode.hedera.com is the same data;
// this host is the one the chat app calls.
export const MIRROR_ORIGIN = 'https://mainnet-public.mirrornode.hedera.com';

// Live tail cadence. The tail does not fetch while the app is hidden.
export const MIRROR_POLL_MS = 3000;

const PAGE_LIMIT = 100;
const MAX_PAGES = 30;
const HCS_MAX_CHUNKS = 20;

export interface MirrorChunkInfo {
  number?: number;
  total?: number;
  nonce?: number;
  scheduled?: boolean;
  initial_transaction_id?:
    | string
    | {
        account_id?: string;
        nonce?: number;
        scheduled?: boolean;
        transaction_valid_start?: string | { seconds?: number | string; nanos?: number | string };
      };
}

export interface MirrorRow {
  consensus_timestamp?: string | number;
  message?: string;
  payer_account_id?: string;
  sequence_number?: number;
  chunk_info?: MirrorChunkInfo | null;
  topic_id?: string;
}

interface ChunkGroup {
  total: number;
  parts: Map<number, Uint8Array>;
  seqs: number[];
  first: { sequence_number: number; consensus_timestamp: string | number; payer_account_id: string } | null;
}

export interface ChunkAssembler {
  push(topicId: string, row: MirrorRow): MirrorRow | null;
  pendingSequences(topicId: string): number[];
}

// gt:0 is a 400 on the public mirror (confirmed 2026-11-04). The first page
// is order=asc with no sequence filter. Later pages use sequencenumber=gt:{n}.
export function mirrorMessagesUrl(topicId: string, afterSeq: number): string {
  const after = Math.floor(Number(afterSeq) || 0);
  const filter = after > 0 ? `&sequencenumber=gt:${after}` : '';
  return (
    `${MIRROR_ORIGIN}/api/v1/topics/${encodeURIComponent(topicId)}` +
    `/messages?limit=${PAGE_LIMIT}&order=asc${filter}`
  );
}

function decodeBase64(value: string): Uint8Array {
  const clean = String(value || '').replace(/\s/g, '');
  if (!clean) return new Uint8Array();
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(clean, 'base64'));
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function groupKey(topicId: string, info: MirrorChunkInfo): string {
  const id = info.initial_transaction_id;
  let idText = '';
  if (typeof id === 'string') {
    idText = id;
  } else if (id && typeof id === 'object') {
    const start = id.transaction_valid_start;
    const startText =
      typeof start === 'string'
        ? start
        : start && typeof start === 'object'
          ? `${start.seconds ?? ''}.${start.nanos ?? ''}`
          : '';
    idText = `${id.account_id || ''}@${startText}`;
  }
  if (!idText) return '';
  const nonce = info.nonce != null ? info.nonce : id && typeof id === 'object' && id.nonce != null ? id.nonce : 0;
  const scheduled =
    info.scheduled != null ? info.scheduled : id && typeof id === 'object' ? id.scheduled : false;
  return `${topicId}\0${idText}\0${nonce}\0${scheduled ? 1 : 0}`;
}

function accountFromInitial(id: MirrorChunkInfo['initial_transaction_id']): string {
  if (typeof id === 'string') {
    const hyphen = id.indexOf('-');
    const at = id.indexOf('@');
    let end = -1;
    if (hyphen > 0 && at > 0) end = Math.min(hyphen, at);
    else if (hyphen > 0) end = hyphen;
    else if (at > 0) end = at;
    if (end <= 0) return '';
    return id.slice(0, end).trim();
  }
  if (id && typeof id === 'object' && typeof id.account_id === 'string') return id.account_id.trim();
  return '';
}

function concatParts(group: ChunkGroup): Uint8Array | null {
  let length = 0;
  const parts: Uint8Array[] = [];
  for (let number = 1; number <= group.total; number++) {
    const part = group.parts.get(number);
    if (!part) return null;
    parts.push(part);
    length += part.length;
  }
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function createChunkAssembler(): ChunkAssembler {
  const groups = new Map<string, ChunkGroup>();

  function push(topicId: string, row: MirrorRow): MirrorRow | null {
    if (!row || typeof row !== 'object') return null;
    const info = row.chunk_info;
    if (info == null) return row;

    const total = Number(info.total);
    const number = Number(info.number);
    if (!Number.isInteger(total) || total < 1 || total > HCS_MAX_CHUNKS) return null;
    if (!Number.isInteger(number) || number < 1 || number > total) return null;

    const key = groupKey(topicId, info);
    if (!key) return null;
    const payer = typeof row.payer_account_id === 'string' ? row.payer_account_id.trim() : '';
    if (!payer || payer !== accountFromInitial(info.initial_transaction_id)) return null;

    let group = groups.get(key);
    if (!group) {
      group = { total, parts: new Map(), seqs: [], first: null };
      groups.set(key, group);
    } else if (group.total !== total) {
      return null;
    }
    if (group.parts.has(number)) return null;

    try {
      group.parts.set(number, decodeBase64(String(row.message || '')));
    } catch {
      return null;
    }
    const seq = Number(row.sequence_number);
    if (Number.isFinite(seq)) group.seqs.push(seq);
    if (number === 1) {
      group.first = {
        sequence_number: Number(row.sequence_number),
        consensus_timestamp: row.consensus_timestamp ?? '',
        payer_account_id: payer,
      };
    }
    if (group.parts.size < group.total || !group.first) return null;

    const joined = concatParts(group);
    groups.delete(key);
    if (!joined) return null;
    let message = '';
    if (typeof Buffer !== 'undefined') message = Buffer.from(joined).toString('base64');
    else {
      let bin = '';
      for (const byte of joined) bin += String.fromCharCode(byte);
      message = btoa(bin);
    }
    return {
      sequence_number: group.first.sequence_number,
      consensus_timestamp: group.first.consensus_timestamp,
      payer_account_id: group.first.payer_account_id,
      message,
      topic_id: row.topic_id || topicId,
    };
  }

  function pendingSequences(topicId: string): number[] {
    const prefix = `${topicId}\0`;
    const seqs: number[] = [];
    for (const [key, group] of groups) {
      if (!key.startsWith(prefix)) continue;
      for (const seq of group.seqs) seqs.push(seq);
    }
    return seqs;
  }

  return { push, pendingSequences };
}

function createdFromConsensus(ts: string | number): string {
  const ms = Number(ts) * 1000;
  if (!Number.isFinite(ms)) return '';
  return new Date(ms).toISOString();
}

// One finished mirror row (already joined, if it was chunked) → AppMessage.
// Non-JSON bodies are skipped, matching the relay, which does not store them.
export function mapMirrorMessage(row: MirrorRow): AppMessage | null {
  if (!row || typeof row.message !== 'string' || !row.message) return null;
  const payer = typeof row.payer_account_id === 'string' ? row.payer_account_id : '';
  const sequence = Number(row.sequence_number);
  if (!payer || !Number.isFinite(sequence)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(decodeBase64(row.message)));
  } catch {
    return null;
  }
  const base =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  const consensus = row.consensus_timestamp ?? '';
  return {
    ...base,
    payer,
    created: createdFromConsensus(consensus),
    consensus_timestamp: consensus,
    sequence_number: sequence,
  };
}

export interface MappedMirrorPage {
  messages: AppMessage[];
  lastSeq: number;
}

// Map one mirror page. `lastSeq` stops before an unfinished chunk group so
// the next poll still sees those bytes (a fresh assembler can finish it).
export function mapMirrorRows(
  topicId: string,
  rows: MirrorRow[],
  afterSeq = 0,
  assembler: ChunkAssembler = createChunkAssembler()
): MappedMirrorPage {
  const messages: AppMessage[] = [];
  for (const row of rows || []) {
    const ready = assembler.push(topicId, row);
    if (!ready) continue;
    const message = mapMirrorMessage(ready);
    if (message) messages.push(message);
  }
  const floor = Math.floor(Number(afterSeq) || 0);
  let maxSeq = floor;
  let hole = Infinity;
  const pending = new Set(assembler.pendingSequences(topicId));
  for (const row of rows || []) {
    const seq = Number(row && row.sequence_number);
    if (!Number.isFinite(seq)) continue;
    if (pending.has(seq)) {
      if (seq < hole) hole = seq;
      continue;
    }
    if (seq > maxSeq) maxSeq = seq;
  }
  const lastSeq = hole !== Infinity ? Math.max(floor, hole - 1) : maxSeq;
  return { messages, lastSeq };
}

export async function fetchMirrorMessages(
  topicId: string,
  afterSeq = 0,
  fetchImpl: typeof fetch = fetch
): Promise<MappedMirrorPage> {
  const assembler = createChunkAssembler();
  let seq = Math.max(0, Math.floor(Number(afterSeq) || 0));
  const messages: AppMessage[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await fetchImpl(mirrorMessagesUrl(topicId, seq));
    if (!res.ok) throw new Error('mirror HTTP ' + res.status);
    const data = (await res.json()) as { messages?: MirrorRow[]; links?: { next?: string | null } };
    const rows = Array.isArray(data.messages) ? data.messages : [];
    if (rows.length === 0) break;
    const mapped = mapMirrorRows(topicId, rows, seq, assembler);
    messages.push(...mapped.messages);
    if (mapped.lastSeq <= seq) break;
    seq = mapped.lastSeq;
    if (!data.links || !data.links.next) break;
  }
  return { messages, lastSeq: seq };
}

export interface MirrorTail {
  close: () => void;
}

// Poll sequencenumber=gt:{n} about every 3s. While `isVisible` is false the
// timer stays armed and no request is sent.
export function startMirrorTail(options: {
  topicId: string;
  afterSeq: number;
  intervalMs?: number;
  isVisible?: () => boolean;
  fetchPage?: (topicId: string, afterSeq: number) => Promise<MappedMirrorPage>;
  onMessages: (messages: AppMessage[]) => void;
  // Fires with the poll cursor, including ticks that carried no chat rows,
  // so the next request can use sequencenumber=gt:{n}.
  onAdvance?: (lastSeq: number) => void;
}): MirrorTail {
  let stopped = false;
  let seq = Math.max(0, Math.floor(Number(options.afterSeq) || 0));
  let timer: ReturnType<typeof setTimeout> | null = null;
  const intervalMs = options.intervalMs ?? MIRROR_POLL_MS;
  const isVisible = options.isVisible ?? (() => true);
  const fetchPage =
    options.fetchPage ?? ((id: string, after: number) => fetchMirrorMessages(id, after));

  const tick = async () => {
    if (stopped) return;
    if (!isVisible()) {
      timer = setTimeout(() => {
        void tick();
      }, intervalMs);
      return;
    }
    try {
      const page = await fetchPage(options.topicId, seq);
      if (stopped) return;
      if (page.lastSeq > seq) {
        seq = page.lastSeq;
        if (options.onAdvance) options.onAdvance(seq);
      }
      if (page.messages.length > 0) options.onMessages(page.messages);
    } catch {
      // Mirror blip. The next tick tries again.
    }
    if (!stopped) {
      timer = setTimeout(() => {
        void tick();
      }, intervalMs);
    }
  };

  void tick();
  return {
    close() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
