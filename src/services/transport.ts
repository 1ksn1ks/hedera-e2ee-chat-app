// TRANSPORT decisions. The settings switch only picks `mode`. These functions
// decide whether a read stays on Globe's relay or moves to the public mirror.
// Encryption is not involved: both paths carry the same ciphertext.

export type TransportMode = 'relay' | 'hedera-only';

export type ActiveTransport = 'relay' | 'mirror';

// Result of one relay read. `ok` is false on a network error or a non-2xx
// response. `timedOut` is the ~4s abort. `ready` is the backend's own flag
// (false = offline or this topic is not backfilled).
export interface BackendRead {
  ok: boolean;
  ready: boolean;
  timedOut?: boolean;
}

// relay + a healthy ready response stays on the relay. Anything else, and
// hedera-only, reads the mirror.
export function chooseTransport(mode: TransportMode, read: BackendRead | null): ActiveTransport {
  if (mode !== 'relay') return 'mirror';
  if (!read || read.ok !== true || read.timedOut === true || read.ready !== true) return 'mirror';
  return 'relay';
}

// hedera-only never calls the relay, including history and the live stream.
export function shouldContactBackend(mode: TransportMode): boolean {
  return mode === 'relay';
}

// A fallen-back relay session also skips POST /api/submit. The wallet
// already submitted to Hedera; the mirror poll picks the message up.
export function shouldReportSubmit(mode: TransportMode, active: ActiveTransport): boolean {
  return mode === 'relay' && active === 'relay';
}

// A dead SSE connection is a relay failure. Ignore it once we are already
// on the mirror, and never while hedera-only (that mode does not open one).
export function shouldFallbackOnStreamError(
  mode: TransportMode,
  active: ActiveTransport
): boolean {
  return mode === 'relay' && active === 'relay';
}
