// Bridge to the topic-message backend (the same wire as the Globe map's
// msgbackend.js): history via GET /api/messages, live via SSE /api/stream,
// wallet-confirmed sends reported via POST /api/submit so every viewer sees
// them instantly as pending.
//
// Globe keeps BACKEND_URL = "" (msgbackend.js:13) so the page calls its own
// origin. That origin in production is https://onlyonhbar.com (placeurl.js:45).
// Dev and the production reverse proxy forward /api to the topic backend
// (msgbackend.js:10-12, step_by_step/vite.config.js /api proxy).
// These routes already exist and take this app's bodies:
//   GET  /api/messages  server/index.js:3279  { ready, messages }
//   GET  /api/stream    server/index.js:3334  text/event-stream
//   POST /api/submit    server/index.js:3076  { topic, body, payer }
// CORS is app-wide at server/index.js:1734-1739 (Allow-Origin *, methods
// GET,POST,OPTIONS, header Content-Type, OPTIONS → 204). The SSE writeHead
// at server/index.js:3339 does not replace those headers. A browser on
// another origin is allowed through. Live responses from
// https://onlyonhbar.com on 2026-11-04 carried Access-Control-Allow-Origin *.
//
// This app is not served from that origin, so the default base is the
// production origin. Set globalThis.__E2EE_BACKEND_URL__ to override it
// ("" keeps same-origin, which the Vite preview proxies to :8787).
export const GLOBE_PRODUCTION_ORIGIN = 'https://onlyonhbar.com';

// Relay reads and the pending report abort after this. A timeout is a
// failed read and the chat falls back to the mirror.
export const BACKEND_TIMEOUT_MS = 4000;

function readBackendUrl(): string {
  const configured = (globalThis as { __E2EE_BACKEND_URL__?: string }).__E2EE_BACKEND_URL__;
  if (typeof configured === 'string') return configured.replace(/\/+$/, '');
  return GLOBE_PRODUCTION_ORIGIN;
}

export const BACKEND_URL = readBackendUrl();

// One backend row, already in the app shape the Globe map consumes:
// the parsed body's fields spread first, then the envelope.
export interface AppMessage {
  [key: string]: unknown;
  payer: string;
  created: string; // ISO string (provisional = submit time while pending)
  consensus_timestamp: string | number;
  sequence_number: number; // provisional negative while pending
  pending?: boolean;
}

export interface MessagesResponse {
  ready: boolean;
  messages: AppMessage[];
  // Network error, non-2xx, or a body that is not JSON.
  failed: boolean;
  // The ~4s abort fired. Also a failure.
  timedOut: boolean;
}

function failedRead(timedOut: boolean): MessagesResponse {
  return { ready: false, messages: [], failed: true, timedOut };
}

async function fetchWithTimeout(url: string, init: RequestInit = {}): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), BACKEND_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

function isTimeout(err: unknown): boolean {
  const name = err && typeof err === 'object' && 'name' in err ? String((err as { name?: string }).name) : '';
  return name === 'AbortError' || name === 'TimeoutError';
}

// ready=false → backend offline or topic not backfilled yet.
// A timeout, network error, or HTTP error is failed (the caller falls back).
export async function fetchMessages(
  topicId: string,
  limit = 1000,
  afterSeq = 0
): Promise<MessagesResponse> {
  const after = afterSeq > 0 ? `&after_seq=${Math.floor(afterSeq)}` : '';
  try {
    const res = await fetchWithTimeout(
      `${BACKEND_URL}/api/messages?topic=${encodeURIComponent(topicId)}&limit=${limit}${after}`
    );
    if (!res.ok) return failedRead(false);
    const data = await res.json();
    return {
      ready: !!data.ready,
      messages: Array.isArray(data.messages) ? data.messages : [],
      failed: false,
      timedOut: false,
    };
  } catch (err) {
    return failedRead(isTimeout(err));
  }
}

// Stable identity of one chat message: the pending form and the confirmed
// form of the same send must produce the same signature (volatile fields
// like created / seq are stripped, payer and body are not). Ported from
// msgbackend.js.
export function messageSig(m: AppMessage): string {
  const { created, consensus_timestamp, sequence_number, pending, _pendingId, ...rest } = m;
  return (m.payer || '') + '|' + JSON.stringify(rest);
}

export type StreamEventType = 'pending' | 'message' | 'confirmed' | 'expired';

export interface StreamEvent {
  topic: string;
  type: StreamEventType;
  message: AppMessage;
}

// ── Live stream ─────────────────────────────────────────────────────────
// ONE shared connection per app. Panels subscribe per topic (streamOnTopic)
// and the server pushes events the moment they happen. A live EventSource
// can't grow its topic list, so adding a topic to an OPEN connection reopens
// it once with the full list (the same cheap-reopen the removal path uses).
// On every (re)open the registered callbacks fire so the panel can re-fetch
// anything missed (its signature dedupe absorbs duplicates).
//
// Where EventSource is unavailable (RN/JSCore), a 3s polling tail on
// /api/messages?after_seq delivers the same events.
const STREAM_REOPEN_MS = 5000;
const STREAM_REOPEN_JITTER_MS = 25000;
const POLL_FALLBACK_MS = 3000;

let source: EventSource | null = null;

// TRANSPORT: the chat hook registers this. A closed SSE connection asks the
// hook whether it took over (mirror fallback). True skips the relay reopen.
type BackendFailureHandler = (reason: string) => boolean;
let onBackendFailure: BackendFailureHandler | null = null;

export function setBackendFailureHandler(handler: BackendFailureHandler | null): void {
  onBackendFailure = handler;
}
let pollTimer: ReturnType<typeof setTimeout> | null = null;
let pollSeq = 0;
let pollSeen = new Set<string>();
const topicRefs = new Map<string, number>();
const topicHandlers = new Map<string, Set<(evt: StreamEvent) => void>>();
const reconnectCallbacks = new Set<() => void>();

function topicList(): string {
  return [...topicRefs.keys()].join(',');
}

function runReconnectCallbacks(): void {
  for (const fn of [...reconnectCallbacks]) {
    try {
      fn();
    } catch {
      /* panel gone */
    }
  }
}

function openSource(): void {
  if (source || topicRefs.size === 0) return;
  const s = new EventSource(`${BACKEND_URL}/api/stream?topics=${topicList()}`);
  source = s;
  s.onmessage = (e: MessageEvent) => {
    let evt: StreamEvent;
    try {
      evt = JSON.parse(String(e.data));
    } catch {
      return;
    }
    if (evt && evt.topic && evt.type && evt.message) {
      const set = topicHandlers.get(evt.topic);
      if (set) {
        for (const h of [...set]) {
          try {
            h(evt);
          } catch (err) {
            console.error('stream handler:', err);
          }
        }
      }
    }
  };
  s.onopen = () => runReconnectCallbacks();
  s.onerror = () => {
    if (s.readyState !== 2 /* CLOSED */) return;
    if (source !== s) return;
    source = null;
    try {
      s.close();
    } catch {
      /* already closed */
    }
    if (onBackendFailure && onBackendFailure('stream')) return;
    setTimeout(openSource, STREAM_REOPEN_MS + Math.random() * STREAM_REOPEN_JITTER_MS);
  };
}

function startPolling(): void {
  if (pollTimer || typeof EventSource !== 'undefined' || topicRefs.size === 0) return;
  const poll = async () => {
    if (pollTimer === null) return;
    try {
      const data = await fetchMessages(topicList().split(',')[0], 100, pollSeq);
      if (data.failed || data.timedOut || !data.ready) {
        if (onBackendFailure && onBackendFailure('poll')) {
          stopPolling();
          return;
        }
      }
      for (const m of data.messages) {
        const sig = messageSig(m);
        if (pollSeen.has(sig)) continue;
        pollSeen.add(sig);
        if (!m.pending && m.sequence_number > pollSeq) pollSeq = m.sequence_number;
        const evt: StreamEvent = {
          topic: topicList().split(',')[0],
          type: m.pending ? 'pending' : 'message',
          message: m,
        };
        const set = topicHandlers.get(evt.topic);
        if (set) {
          for (const h of [...set]) {
            try {
              h(evt);
            } catch (err) {
              console.error('stream handler:', err);
            }
          }
        }
      }
    } catch {
      // backend offline — keep trying on the next tick
    }
    pollTimer = setTimeout(poll, POLL_FALLBACK_MS);
  };
  pollTimer = setTimeout(poll, POLL_FALLBACK_MS);
}

function stopPolling(): void {
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
}

function ensureLive(): void {
  if (typeof EventSource !== 'undefined') {
    openSource();
  } else {
    startPolling();
  }
}

// Subscribe a handler to one topic. Returns an unsubscribe function. When a
// NEW topic is added to an open connection the connection reopens with the
// full list; when the last ref to a topic drops it reopens reduced.
export function streamOnTopic(
  topicId: string,
  handler: (evt: StreamEvent) => void
): () => void {
  if (!topicId || !/^\d+\.\d+\.\d+$/.test(topicId)) return () => {};
  const isNewTopic = !topicRefs.has(topicId);
  topicRefs.set(topicId, (topicRefs.get(topicId) || 0) + 1);
  if (!topicHandlers.has(topicId)) topicHandlers.set(topicId, new Set());
  topicHandlers.get(topicId)!.add(handler);
  if (isNewTopic && source) {
    // A live EventSource can't grow its topic list: one cheap reopen with
    // the full list (same pattern as when a topic is dropped).
    const old = source;
    source = null;
    old.close();
  }
  if (isNewTopic && pollTimer) stopPolling();
  pollSeen = new Set();
  pollSeq = 0;
  ensureLive();
  return () => {
    const set = topicHandlers.get(topicId);
    if (set) {
      set.delete(handler);
      if (set.size === 0) topicHandlers.delete(topicId);
    }
    const n = (topicRefs.get(topicId) || 1) - 1;
    if (n <= 0) {
      topicRefs.delete(topicId);
      if (topicRefs.size === 0) {
        if (source) {
          const old = source;
          source = null;
          old.close();
        }
        stopPolling();
      } else if (source) {
        // Reconnect with the reduced topic list (one cheap reopen)
        const old = source;
        source = null;
        old.close();
      }
    } else {
      topicRefs.set(topicId, n);
    }
    if (source && topicRefs.size > 0) ensureLive();
    if (!source && pollTimer && topicRefs.size > 0) startPolling();
  };
}

// Called on every (re)open of the live stream — panels use it to re-fetch
// their topic and absorb anything missed while disconnected.
export function streamOnReconnect(fn: () => void): () => void {
  reconnectCallbacks.add(fn);
  return () => reconnectCallbacks.delete(fn);
}

// A wallet-confirmed send is reported as PENDING so every viewer sees the
// message instantly; the backend's mirror poller confirms it. The mirror
// (source of truth) still has the message if the backend is offline.
// Returns false when the relay did not accept the report (timeout, network,
// or non-2xx). The Hedera submit has already happened either way.
export async function reportPendingSend(
  topicId: string,
  body: string,
  payer: string
): Promise<boolean> {
  try {
    const res = await fetchWithTimeout(`${BACKEND_URL}/api/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: topicId, body, payer }),
    });
    return res.ok;
  } catch {
    return false;
  }
}
