// The E2EE topic-chat engine: unlock, history ingest, live stream, pending
// lifecycle, and the edit pipeline. Same wire semantics as the Globe map's
// encryptedtopicchat.js:
//   - an edit is a directive, not a bubble: it names the original by ISO
//     created and carries the NEW text re-encrypted with the same topic key;
//   - a latest-wins map per `${payer}|${createdIso}` rewrites the rendered
//     bubble in place with an "edited" mark;
//   - wrong key / other payer / stale envelope → rejected;
//   - the 18 KB HCS gate is measured on the final outgoing JSON.
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import {
  AppMessage,
  fetchMessages,
  messageSig,
  reportPendingSend,
  setBackendFailureHandler,
  streamOnReconnect,
  streamOnTopic,
  StreamEvent,
} from '../services/backend';
import { fetchMirrorHistory, startMirrorTail } from '../services/mirror';
import {
  chooseTransport,
  shouldContactBackend,
  shouldFallbackOnStreamError,
  shouldReportSubmit,
  type ActiveTransport,
  type TransportMode,
} from '../services/transport';
import {
  editOutgoingBytes,
  HCS_MESSAGE_MAX_BYTES,
  HCS_TOO_LONG,
  sendOutgoingBytes,
  utf8ByteLength,
} from '../services/chatPayload';
import { packFitting, unpackChatPayload, type SealedMedia } from '../services/sealedMedia';
import {
  decryptMessage,
  decryptWithPassword,
  encryptWithPassword,
  encryptMessage,
  parsePrivateKey,
  parsePublicKey,
} from '../services/sodium';
import { releaseHeldMedia } from '../services/mediaCrypto';
import { loadTopicKey, storeTopicKey } from '../services/secretStore';
import { connectWallet, disconnectWallet, getConnectedAccount, sendTopicMessage } from '../services/wallet';
import { isTopicId, RESOLVE_EMPTY } from '../services/identity';
import { useIdentity } from './useIdentity';

export interface Bubble {
  sig: string;
  payer: string;
  created: string; // ISO (provisional = submit time while pending)
  text: string;
  image: string;
  poster: string;
  legacyPlain: boolean;
  media: SealedMedia | null;
  pending: boolean;
  edited: boolean;
  mine: boolean;
}

interface EditEntry {
  text: string;
  image: string;
  poster: string;
  legacyPlain: boolean;
  media: SealedMedia | null;
  at: string;
}

export type UnlockStatus =
  | 'none'
  | 'connecting'
  | 'need-password' // history has an admin-pinned encryptedPrivateKey
  | 'need-key' // no pinned key — import the topic private key
  | 'unlocked'
  | 'error';

export interface PinnedKeyBundle {
  encrypted: string;
  nonce: string;
  salt: string;
}

export interface TopicMeta {
  topicId: string;
  ready: boolean;
  hasPinnedKey: boolean;
  pinned: PinnedKeyBundle | null;
  publicKeyHex: string | null;
  // The domain or payer id the topic was opened by, if not the id itself.
  via: string | null;
}

// dd/mm/yy HH:MM — the app's single timestamp presentation.
export function formatStamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${p(d.getDate())}/${p(d.getMonth() + 1)}/${String(d.getFullYear()).slice(-2)}` +
    ` ${p(d.getHours())}:${p(d.getMinutes())}`
  );
}

function createdIso(value: unknown): string {
  if (!value) return '';
  const d = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
}

interface Result {
  ok: boolean;
  error?: string;
  droppedPoster?: boolean;
}

export function useE2eeChat() {
  const [phase, setPhase] = useState<'idle' | 'ready'>('idle');
  const [meta, setMeta] = useState<TopicMeta | null>(null);
  const [bubbles, setBubbles] = useState<Bubble[]>([]);
  const [unlock, setUnlock] = useState<{ status: UnlockStatus; message: string }>({
    status: 'none',
    message: '',
  });
  const [account, setAccount] = useState<string | null>(null);
  const [walletBusy, setWalletBusy] = useState(false);
  const [pairingUri, setPairingUri] = useState<string | null>(null);
  // TRANSPORT: "Use relay server" is on at every launch; turning it off
  // lasts for this session only. `transport` is the path actually in use
  // (Relay vs Direct Hedera), which can fall back while the switch stays on.
  const [useRelay, setUseRelayState] = useState(true);
  const [transport, setTransport] = useState<ActiveTransport>('relay');

  // Secrets and maps live in refs: the topic key is in-memory only (its
  // persistent home is the keystore), never in React state or storage.
  const topicIdRef = useRef<string | null>(null);
  const privateKeyRef = useRef<Uint8Array | null>(null);
  const publicKeyRef = useRef<Uint8Array | null>(null);
  const pinnedRef = useRef<PinnedKeyBundle | null>(null);
  const historyRef = useRef<AppMessage[]>([]);
  const editsRef = useRef<Map<string, EditEntry>>(new Map());
  const seenRef = useRef<Set<string>>(new Set());
  const liveReadyRef = useRef(false);
  const offStreamRef = useRef<(() => void) | null>(null);
  const offReconnectRef = useRef<(() => void) | null>(null);
  const accountRef = useRef<string | null>(null);
  const modeRef = useRef<TransportMode>('relay');
  const activeRef = useRef<ActiveTransport>('relay');
  const seqRef = useRef(0);
  const visibleRef = useRef(true);
  const appStateRef = useRef<AppStateStatus>(AppState.currentState || 'active');
  const mirrorCloseRef = useRef<(() => void) | null>(null);
  const probeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const goMirrorRef = useRef<(topic: string) => void>(() => {});

  const identity = useIdentity(() => modeRef.current, account);

  const setAccountBoth = (acc: string | null) => {
    accountRef.current = acc;
    setAccount(acc);
  };

  const stopRelayStream = () => {
    if (offStreamRef.current) {
      offStreamRef.current();
      offStreamRef.current = null;
    }
    if (offReconnectRef.current) {
      offReconnectRef.current();
      offReconnectRef.current = null;
    }
    liveReadyRef.current = false;
  };

  const stopMirrorTail = () => {
    if (mirrorCloseRef.current) {
      mirrorCloseRef.current();
      mirrorCloseRef.current = null;
    }
  };

  const stopProbe = () => {
    if (probeTimerRef.current) {
      clearTimeout(probeTimerRef.current);
      probeTimerRef.current = null;
    }
  };

  const stopLive = () => {
    stopRelayStream();
    stopMirrorTail();
    stopProbe();
  };

  const refreshVisible = () => {
    const docHidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
    visibleRef.current = !docHidden && appStateRef.current !== 'background';
  };

  // ── Edit pipeline (port of rememberE2eeEdit) ──────────────────────────

  // Returns the stored edit when this one is the latest seen, else null.
  // `data` is the editEncryptedMessage body; `envelope` is the edit's own
  // created (consensus time, or now() when applied locally right after a
  // wallet-confirmed send).
  const rememberE2eeEdit = useCallback(
    async (payer: string, data: any, envelope: string): Promise<EditEntry | null> => {
      const key = privateKeyRef.current;
      if (!payer || !data || !data.created || !key) return null;
      const created = createdIso(data.created);
      if (!created) return null;
      let parts;
      try {
        const decryptedRaw = await decryptMessage(data.encryptedMessage, key);
        parts = unpackChatPayload(decryptedRaw);
      } catch {
        return null; // no key for this topic / malformed ciphertext: reject
      }
      const text = typeof parts.text === 'string' ? parts.text : '';
      // A sealed file keeps its URL inside `m`. data.image is only a
      // fallback for edits that were already sent the old way
      // (encryptedtopicchat.js:71-73). The ciphertext URL is never painted.
      const media = parts.media;
      const image = media ? '' : parts.image || (data.image ? String(data.image) : '');
      const poster = media ? '' : parts.poster || '';
      const legacyPlain = media ? false : !!image && !poster;
      if (!text && !image && !media) return null;
      const at = createdIso(envelope) || '';
      // An edit that names a bubble from its own future is malformed noise.
      if (created && at && at <= created) return null;
      const mapKey = `${payer}|${created}`;
      const prev = editsRef.current.get(mapKey);
      // A pending edit (no consensus time yet) never replaces a known one.
      if (!at && prev) return null;
      // Latest wins: an older edit arriving late never replaces a newer one.
      if (prev && prev.at && at && at < prev.at) return null;
      const entry: EditEntry = { text, image, poster, legacyPlain, media, at };
      editsRef.current.set(mapKey, entry);
      // Rewrite the on-screen bubbles in place (+ the "edited" mark).
      setBubbles((bs) =>
        bs.map((b) =>
          b.payer === payer && b.created === created
            ? { ...b, text, image, poster, legacyPlain, media, edited: true }
            : b
        )
      );
      return entry;
    },
    []
  );

  // ── Ingest ─────────────────────────────────────────────────────────────

  // One backend row in (history, live, or optimistic local). An edit is a
  // directive, not a bubble. Non-E2EE rows and rows this key cannot open
  // are dropped silently.
  const ingest = useCallback(
    async (m: AppMessage) => {
      if (!m.pending) {
        const seq = Number(m.sequence_number);
        if (Number.isFinite(seq) && seq > seqRef.current) seqRef.current = seq;
      }
      if (m.editEncryptedMessage) {
        await rememberE2eeEdit(
          m.payer,
          m.editEncryptedMessage,
          createdIso(m.created) || String(m.created || '')
        );
        return;
      }
      if (!m.encryptedMessage) return;
      const key = privateKeyRef.current;
      if (!key) return;
      let parts;
      try {
        const decryptedRaw = await decryptMessage(
          m.encryptedMessage as { ciphertext: string },
          key
        );
        parts = unpackChatPayload(decryptedRaw);
      } catch {
        return; // wrong key / malformed ciphertext: no bubble
      }
      if (!parts.text && !parts.image && !parts.media) return;
      const created = createdIso(m.created) || new Date().toISOString();
      const sig = messageSig(m);
      const isPending = !!m.pending;
      const mine = m.payer === accountRef.current;
      const edited = !!editsRef.current.get(`${m.payer}|${created}`);
      setBubbles((bs) => {
        const i = bs.findIndex((b) => b.sig === sig);
        if (i !== -1) {
          // Pending → confirmed re-tag, or a live edit already applied.
          const next = [...bs];
          next[i] = {
            ...next[i],
            text: parts.text,
            image: parts.image,
            poster: parts.poster,
            legacyPlain: parts.legacyPlain,
            media: parts.media,
            pending: isPending,
            created: isPending ? next[i].created : created,
            mine,
            edited: edited || next[i].edited,
          };
          return next;
        }
        return [
          ...bs,
          {
            sig,
            payer: m.payer,
            created,
            text: parts.text,
            image: parts.image,
            poster: parts.poster,
            legacyPlain: parts.legacyPlain,
            media: parts.media,
            pending: isPending,
            edited,
            mine,
          },
        ];
      });
    },
    [rememberE2eeEdit]
  );

  const handleStream = useCallback(
    (evt: StreamEvent) => {
      const m = evt.message;
      const sig = messageSig(m);
      if (evt.type === 'expired') {
        setBubbles((bs) => bs.filter((b) => !(b.sig === sig && b.pending)));
        return;
      }
      if (seenRef.current.has(sig)) {
        // Pending → confirmed: re-tag with the consensus time.
        void ingest(m);
        return;
      }
      seenRef.current.add(sig);
      void ingest(m);
    },
    [ingest]
  );

  const absorb = useCallback(
    async (messages: AppMessage[]) => {
      for (const m of messages) {
        const sig = messageSig(m);
        if (seenRef.current.has(sig)) {
          await ingest(m);
          continue;
        }
        seenRef.current.add(sig);
        await ingest(m);
      }
    },
    [ingest]
  );

  // Re-fetch anything missed while the stream was down (signature dedupe
  // absorbs duplicates). A failed relay read falls back to the mirror.
  const refetchMissed = useCallback(async () => {
    const topic = topicIdRef.current;
    if (!topic || !privateKeyRef.current) return;
    if (!shouldContactBackend(modeRef.current)) return;
    const data = await fetchMessages(topic, 1000);
    const next = chooseTransport(modeRef.current, {
      ok: !data.failed,
      ready: data.ready,
      timedOut: data.timedOut,
    });
    if (next === 'mirror') {
      goMirrorRef.current(topic);
      return;
    }
    await absorb(data.messages);
  }, [absorb]);

  const startRelayStream = useCallback(() => {
    const topic = topicIdRef.current;
    if (!topic) return;
    stopRelayStream();
    offStreamRef.current = streamOnTopic(topic, handleStream);
    offReconnectRef.current = streamOnReconnect(() => {
      if (!liveReadyRef.current) {
        liveReadyRef.current = true;
        return;
      }
      void refetchMissed();
    });
  }, [handleStream, refetchMissed]);

  const startMirror = useCallback(() => {
    const topic = topicIdRef.current;
    if (!topic) return;
    stopMirrorTail();
    const tail = startMirrorTail({
      topicId: topic,
      afterSeq: seqRef.current,
      isVisible: () => visibleRef.current,
      onAdvance: (lastSeq) => {
        if (lastSeq > seqRef.current) seqRef.current = lastSeq;
      },
      onMessages: (messages) => {
        void absorb(messages);
      },
    });
    mirrorCloseRef.current = tail.close;
  }, [absorb]);

  // TRANSPORT: while the relay is down, ask again in the background and
  // return to SSE once a read comes back ready.
  const scheduleProbe = useCallback(() => {
    if (probeTimerRef.current || modeRef.current !== 'relay') return;
    probeTimerRef.current = setTimeout(() => {
      probeTimerRef.current = null;
      void (async () => {
        if (modeRef.current !== 'relay' || activeRef.current !== 'mirror') return;
        if (!visibleRef.current) {
          scheduleProbe();
          return;
        }
        const topic = topicIdRef.current;
        if (!topic) return;
        const data = await fetchMessages(topic, 100, seqRef.current);
        if (modeRef.current !== 'relay' || activeRef.current !== 'mirror') return;
        const next = chooseTransport('relay', {
          ok: !data.failed,
          ready: data.ready,
          timedOut: data.timedOut,
        });
        if (next !== 'relay') {
          scheduleProbe();
          return;
        }
        await absorb(data.messages);
        if (modeRef.current !== 'relay' || activeRef.current !== 'mirror') return;
        activeRef.current = 'relay';
        setTransport('relay');
        stopMirrorTail();
        startRelayStream();
      })();
    }, 12000);
  }, [absorb, startRelayStream]);

  const goMirror = useCallback(
    (topic: string) => {
      if (!topic) return;
      activeRef.current = 'mirror';
      setTransport('mirror');
      stopRelayStream();
      startMirror();
      if (modeRef.current === 'relay') scheduleProbe();
      else stopProbe();
    },
    [scheduleProbe, startMirror]
  );
  goMirrorRef.current = goMirror;

  const startLive = useCallback(() => {
    const topic = topicIdRef.current;
    if (!topic) return;
    if (modeRef.current === 'hedera-only' || activeRef.current === 'mirror') {
      goMirror(topic);
      return;
    }
    stopMirrorTail();
    stopProbe();
    activeRef.current = 'relay';
    setTransport('relay');
    startRelayStream();
  }, [goMirror, startRelayStream]);

  // ── History load (unlock gate) ─────────────────────────────────────────

  const loadHistory = useCallback(
    async (topic: string): Promise<{ meta: TopicMeta; bubbles: Bubble[] }> => {
      // TRANSPORT: relay first unless the switch is off. A failed, timed-out,
      // or ready=false read loads the same history from the public mirror.
      let messages: AppMessage[];
      if (!shouldContactBackend(modeRef.current)) {
        const page = await fetchMirrorHistory(topic);
        seqRef.current = page.lastSeq;
        activeRef.current = 'mirror';
        setTransport('mirror');
        messages = page.messages;
      } else {
        const data = await fetchMessages(topic, 1000);
        const next = chooseTransport(modeRef.current, {
          ok: !data.failed,
          ready: data.ready,
          timedOut: data.timedOut,
        });
        if (next === 'relay') {
          let maxSeq = 0;
          for (const row of data.messages) {
            if (!row.pending && Number(row.sequence_number) > maxSeq) maxSeq = Number(row.sequence_number);
          }
          seqRef.current = maxSeq;
          activeRef.current = 'relay';
          setTransport('relay');
          messages = data.messages;
        } else {
          const page = await fetchMirrorHistory(topic);
          seqRef.current = page.lastSeq;
          activeRef.current = 'mirror';
          setTransport('mirror');
          messages = page.messages;
        }
      }

      // Key discovery, same scan the Globe map does: newest first.
      let publicKeyHex: string | null = null;
      let pinned: PinnedKeyBundle | null = null;
      for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (!pinned && msg.encryptedPrivateKey && msg.nonce && msg.salt) {
          pinned = {
            encrypted: String(msg.encryptedPrivateKey),
            nonce: String(msg.nonce),
            salt: String(msg.salt),
          };
        }
        if (!publicKeyHex && msg.publicKey) {
          publicKeyHex = String(msg.publicKey);
        }
        if (pinned && publicKeyHex) break;
      }
      if (publicKeyHex) {
        try {
          publicKeyRef.current = parsePublicKey(publicKeyHex);
        } catch {
          publicKeyRef.current = null;
        }
      }
      pinnedRef.current = pinned;
      historyRef.current = messages;
      const meta: TopicMeta = {
        topicId: topic,
        ready: true,
        hasPinnedKey: !!pinned,
        pinned,
        publicKeyHex,
        via: null,
      };

      // Render whatever this key can already read (empty while locked).
      const bubbles: Bubble[] = [];
      if (privateKeyRef.current) {
        for (const m of messages) {
          const sig = messageSig(m);
          if (seenRef.current.has(sig)) continue;
          seenRef.current.add(sig);
          await ingest(m);
        }
      }
      return { meta, bubbles };
    },
    [ingest]
  );

  // ── Unlock paths ───────────────────────────────────────────────────────

  const finishUnlock = useCallback(
    async (derHex: string) => {
      try {
        privateKeyRef.current = parsePrivateKey(derHex);
      } catch {
        setUnlock({ status: 'error', message: 'That is not a valid topic key (expected DER hex)' });
        return;
      }
      const topic = topicIdRef.current;
      if (topic) {
        try {
          await storeTopicKey(topic, derHex);
        } catch {
          // keystore unavailable — the session still works in memory
        }
      }
      // Now that the key is in memory, render the already-fetched history.
      for (const m of historyRef.current) {
        const sig = messageSig(m);
        if (seenRef.current.has(sig)) continue;
        seenRef.current.add(sig);
        await ingest(m);
      }
      setUnlock({ status: 'unlocked', message: '' });
      await startLive();
    },
    [ingest, startLive]
  );

  const connect = useCallback(
    async (input: string, opts: { person?: boolean } = {}): Promise<Result> => {
      // The field: a topic id or a domain. A person tapped in a list
      // (opts.person, input = their account id): their connected topic.
      const raw = String(input || '').trim();
      if (!raw) return { ok: false, error: RESOLVE_EMPTY };
      setPhase('idle');
      setBubbles([]);
      setPairingUri(null);
      seenRef.current = new Set();
      editsRef.current = new Map();
      seqRef.current = 0;
      stopLive();
      setUnlock({ status: 'connecting', message: '' });
      const resolved = opts.person ? await identity.resolvePerson(raw) : await identity.resolve(raw);
      const fail = (error: string): Result => {
        topicIdRef.current = null;
        setMeta(null);
        setUnlock({ status: 'none', message: '' });
        return { ok: false, error };
      };
      if ('error' in resolved) return fail(resolved.error);
      const topic = resolved.topicId;
      if (!isTopicId(topic)) {
        return fail('Enter a topic ID (0.0.123) or a domain.');
      }
      const via = resolved.via && resolved.via !== topic ? resolved.via : null;
      topicIdRef.current = topic;
      try {
        const { meta } = await loadHistory(topic);
        setMeta({ ...meta, via });
        // Keystore first: a key unwrapped in a previous session unlocks
        // without the password.
        const stored = await loadTopicKey(topic);
        if (stored) {
          await finishUnlock(stored);
        } else if (meta.hasPinnedKey) {
          setUnlock({ status: 'need-password', message: '' });
        } else {
          setUnlock({ status: 'need-key', message: '' });
        }
        setPhase('ready');
        const acc = await getConnectedAccount();
        if (acc) setAccountBoth(acc);
        return { ok: true };
      } catch (e: any) {
        setUnlock({ status: 'error', message: e?.message || String(e) });
        return { ok: false, error: e?.message || String(e) };
      }
    },
    [finishUnlock, identity.resolve, identity.resolvePerson, loadHistory]
  );

  const unlockWithPassword = useCallback(
    async (password: string): Promise<Result> => {
      const pinned = pinnedRef.current;
      if (!pinned) return { ok: false, error: 'This topic has no pinned key password' };
      let derHex: string;
      try {
        derHex = await decryptWithPassword(pinned.encrypted, pinned.nonce, pinned.salt, password);
      } catch {
        return { ok: false, error: 'Wrong password' };
      }
      await finishUnlock(derHex);
      return { ok: true };
    },
    [finishUnlock]
  );

  // A pasted key must belong to this topic: its public half has to equal the
  // pinned public key. A wrong key would otherwise "unlock" and show nothing,
  // or get saved under a password. 'nopub' = nothing pinned to check against.
  const checkTopicKey = (derHex: string): 'ok' | 'invalid' | 'mismatch' | 'nopub' => {
    let secret: Uint8Array;
    try {
      if (!/^[0-9a-fA-F]{64,}$/.test(derHex)) return 'invalid';
      secret = parsePrivateKey(derHex);
    } catch {
      return 'invalid';
    }
    const pub = publicKeyRef.current;
    if (!pub || pub.length !== 32) return 'nopub';
    const mine = secret.slice(32);
    for (let i = 0; i < 32; i++) if (mine[i] !== pub[i]) return 'mismatch';
    return 'ok';
  };

  const KEY_INVALID = 'That is not a valid topic key (expected DER hex)';
  const KEY_MISMATCH = "That key doesn't belong to this topic (it doesn't match the topic's public key).";

  const unlockWithKey = useCallback(
    async (derHex: string): Promise<Result> => {
      const key = String(derHex || '').trim();
      const check = checkTopicKey(key);
      if (check === 'invalid') return { ok: false, error: KEY_INVALID };
      if (check === 'mismatch') return { ok: false, error: KEY_MISMATCH };
      await finishUnlock(key);
      return { ok: true };
    },
    [finishUnlock]
  );

  // The Globe map's "Set password" (encryptedtopicchat.js): the topic key,
  // encrypted with a password (argon2id + secretbox), pinned on the topic as
  // { type: 'set_encrypted_key', encryptedPrivateKey, nonce, salt }. From
  // then on the password unlocks the topic here and in the Globe map. The
  // wallet pays the HBAR fee. The password itself never leaves this device.
  const setTopicPassword = useCallback(
    async (derHex: string, password: string): Promise<Result> => {
      const topic = topicIdRef.current;
      if (!topic) return { ok: false, error: 'No topic connected' };
      const key = String(derHex || '').trim();
      const check = checkTopicKey(key);
      if (check === 'invalid') return { ok: false, error: KEY_INVALID };
      if (check === 'mismatch') return { ok: false, error: KEY_MISMATCH };
      if (check === 'nopub') {
        return { ok: false, error: 'This topic has no public key pinned, so the key cannot be checked. Pin one first.' };
      }
      if (String(password || '').length < 5) {
        return { ok: false, error: 'Password must be at least 5 characters long' };
      }
      const acc = (await getConnectedAccount()) || accountRef.current;
      if (!acc) return { ok: false, error: 'Connect a wallet to save the password on the topic (HBAR network fee only)' };
      try {
        const bundle = await encryptWithPassword(key, password);
        const body = JSON.stringify({
          type: 'set_encrypted_key',
          encryptedPrivateKey: bundle.encrypted,
          nonce: bundle.nonce,
          salt: bundle.salt,
        });
        await sendTopicMessage(topic, body);
        setAccountBoth(acc);
        if (shouldReportSubmit(modeRef.current, activeRef.current)) {
          void reportPendingSend(topic, body, acc).then((ok) => {
            if (!ok) goMirrorRef.current(topic);
          });
        }
        const pinned: PinnedKeyBundle = { encrypted: bundle.encrypted, nonce: bundle.nonce, salt: bundle.salt };
        pinnedRef.current = pinned;
        setMeta((m) => (m ? { ...m, hasPinnedKey: true, pinned } : m));
      } catch (e: any) {
        return { ok: false, error: e?.message || 'The password was not saved' };
      }
      await finishUnlock(key);
      return { ok: true };
    },
    [finishUnlock]
  );

  // ── Send + edit (wallet-confirmed, 18 KB gated) ────────────────────────

  const send = useCallback(
    async (text: string, media: SealedMedia | null = null): Promise<Result> => {
      const topic = topicIdRef.current;
      const pub = publicKeyRef.current;
      if (!topic) return { ok: false, error: 'No topic connected' };
      if (!pub) {
        return { ok: false, error: 'No public key found for this topic. The admin must pin one first.' };
      }
      const acc = (await getConnectedAccount()) || accountRef.current;
      if (!acc) return { ok: false, error: 'Connect a wallet to send (HBAR network fee only)' };
      if (!String(text || '').trim() && !media?.url) return { ok: false, error: 'Please enter a message.' };
      // Predict the exact outgoing size before encrypting (fixed 48-byte
      // seal, unpadded base64). An embedded still that does not fit is
      // dropped. The ciphertext URL stays inside the sealed payload.
      const fit = packFitting(text, media);
      if (media?.url && !fit.packed.startsWith('\u001echat1\n')) {
        return { ok: false, error: 'Upload failed' };
      }
      const droppedPoster = fit.droppedPoster;
      const predicted = sendOutgoingBytes(fit.packed);
      if (predicted > HCS_MESSAGE_MAX_BYTES) return { ok: false, error: HCS_TOO_LONG };
      try {
        // Encrypt before build: plaintext never enters the HCS JSON.
        const encryptedMessage = await encryptMessage(fit.packed, pub);
        const outgoing = JSON.stringify({ encryptedMessage });
        // And measure the final JSON anyway — the ciphertext is the exact
        // length, so this can only ever disagree on a bug.
        if (utf8ByteLength(outgoing) > HCS_MESSAGE_MAX_BYTES) {
          return { ok: false, error: HCS_TOO_LONG };
        }
        await sendTopicMessage(topic, outgoing);
        setAccountBoth(acc);
        // Optimistic pending bubble; the backend's own "pending" broadcast
        // (same signature) is absorbed, and "message"/"confirmed" re-tag it
        // with the consensus time.
        const local: AppMessage = {
          encryptedMessage,
          payer: acc,
          created: new Date().toISOString(),
          consensus_timestamp: 0,
          sequence_number: 0,
          pending: true,
        };
        seenRef.current.add(messageSig(local));
        if (shouldReportSubmit(modeRef.current, activeRef.current)) {
          void reportPendingSend(topic, outgoing, acc).then((ok) => {
            if (!ok) goMirrorRef.current(topic);
          });
        }
        await ingest(local);
        return { ok: true, droppedPoster };
      } catch (e: any) {
        return { ok: false, error: e?.message || 'Send failed' };
      }
    },
    [ingest]
  );

  const edit = useCallback(
    async (bubble: Bubble, newText: string): Promise<Result> => {
      const topic = topicIdRef.current;
      const pub = publicKeyRef.current;
      if (!topic) return { ok: false, error: 'No topic connected' };
      if (!pub) return { ok: false, error: 'No public key found for this topic' };
      if (bubble.pending) return { ok: false, error: 'Wait for the message to confirm first' };
      const acc = (await getConnectedAccount()) || accountRef.current;
      if (!acc) return { ok: false, error: 'Connect a wallet to edit (HBAR network fee only)' };
      if (bubble.payer !== acc) return { ok: false, error: 'Only your own messages can be edited' };
      const data: { created: string; timestamp: string; image?: string } = {
        created: bubble.created,
        timestamp: formatStamp(bubble.created),
      };
      // A sealed file does not copy its ciphertext URL onto the outer edit.
      if (!bubble.media && bubble.image) data.image = bubble.image;
      const fit = packFitting(
        newText,
        bubble.media,
        bubble.media ? '' : bubble.image,
        bubble.media ? '' : bubble.poster
      );
      if (bubble.media?.url && !fit.packed.startsWith('\u001echat1\n')) {
        return { ok: false, error: 'Edit was not saved' };
      }
      const droppedPoster = fit.droppedPoster;
      const predicted = editOutgoingBytes(data, fit.packed);
      if (predicted > HCS_MESSAGE_MAX_BYTES) return { ok: false, error: HCS_TOO_LONG };
      try {
        const encryptedMessage = await encryptMessage(fit.packed, pub);
        const body: Record<string, unknown> = {
          created: data.created,
          timestamp: data.timestamp,
          encryptedMessage,
        };
        if (data.image) body.image = data.image;
        const outgoing = JSON.stringify({ editEncryptedMessage: body });
        if (utf8ByteLength(outgoing) > HCS_MESSAGE_MAX_BYTES) {
          return { ok: false, error: HCS_TOO_LONG };
        }
        await sendTopicMessage(topic, outgoing);
        setAccountBoth(acc);
        if (shouldReportSubmit(modeRef.current, activeRef.current)) {
          void reportPendingSend(topic, outgoing, acc).then((ok) => {
            if (!ok) goMirrorRef.current(topic);
          });
        }
        // Apply locally right away; the topic stream confirms the same edit.
        await rememberE2eeEdit(acc, body, new Date().toISOString());
        return { ok: true, droppedPoster };
      } catch (e: any) {
        return { ok: false, error: e?.message || 'Edit was not saved' };
      }
    },
    [rememberE2eeEdit]
  );

  // ── Wallet ─────────────────────────────────────────────────────────────

  // Your own E2EE chat: the topic connected to your profile (Edit profile →
  // Connect in the Globe map), opened like tapping yourself under People.
  const openMyChat = useCallback(async (): Promise<Result> => {
    const acc = accountRef.current || (await getConnectedAccount());
    if (!acc) return { ok: false, error: 'Connect a wallet first' };
    return connect(acc, { person: true });
  }, [connect]);

  // Logging in only connects the wallet. Your own chat opens from its
  // button (openMyChat), never by itself.
  const walletConnect = useCallback(async () => {
    setWalletBusy(true);
    setPairingUri(null);
    try {
      const { account: acc } = await connectWallet((uri) => setPairingUri(uri));
      setAccountBoth(acc);
      return { ok: true as const, account: acc };
    } catch (e: any) {
      return { ok: false as const, error: e?.message || 'Wallet connect failed' };
    } finally {
      // The pairing link carries the session's symKey and is single-use:
      // once pairing ends (approved or not) it is never shown again.
      setPairingUri(null);
      setWalletBusy(false);
    }
  }, []);

  const walletDisconnect = useCallback(async () => {
    await disconnectWallet();
    releaseHeldMedia();
    setAccountBoth(null);
    setPairingUri(null);
  }, []);

  // ── Leave the topic ────────────────────────────────────────────────────

  const leave = useCallback(() => {
    stopLive();
    releaseHeldMedia();
    topicIdRef.current = null;
    privateKeyRef.current = null;
    publicKeyRef.current = null;
    pinnedRef.current = null;
    seqRef.current = 0;
    const idle = modeRef.current === 'relay' ? 'relay' : 'mirror';
    activeRef.current = idle;
    setTransport(idle);
    setMeta(null);
    setBubbles([]);
    setUnlock({ status: 'none', message: '' });
    setPhase('idle');
  }, []);

  const setUseRelay = useCallback(
    (on: boolean) => {
      setUseRelayState(on);
      modeRef.current = on ? 'relay' : 'hedera-only';
      const topic = topicIdRef.current;
      if (!topic || !privateKeyRef.current) {
        const idle = on ? 'relay' : 'mirror';
        activeRef.current = idle;
        setTransport(idle);
        return;
      }
      if (!on) {
        goMirror(topic);
        return;
      }
      void (async () => {
        const data = await fetchMessages(topic, 100, seqRef.current);
        if (modeRef.current !== 'relay') return;
        const next = chooseTransport('relay', {
          ok: !data.failed,
          ready: data.ready,
          timedOut: data.timedOut,
        });
        if (next === 'mirror') {
          goMirror(topic);
          return;
        }
        await absorb(data.messages);
        if (modeRef.current !== 'relay') return;
        activeRef.current = 'relay';
        setTransport('relay');
        stopMirrorTail();
        stopProbe();
        startRelayStream();
      })();
    },
    [absorb, goMirror, startRelayStream]
  );

  useEffect(() => {
    refreshVisible();
    const onVis = () => refreshVisible();
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVis);
    const sub = AppState.addEventListener('change', (state) => {
      appStateRef.current = state;
      refreshVisible();
    });
    return () => {
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVis);
      sub.remove();
    };
  }, []);

  useEffect(() => {
    setBackendFailureHandler(() => {
      if (!shouldFallbackOnStreamError(modeRef.current, activeRef.current)) return false;
      const topic = topicIdRef.current;
      if (!topic) return false;
      goMirrorRef.current(topic);
      return true;
    });
    return () => setBackendFailureHandler(null);
  }, []);

  useEffect(() => () => stopLive(), []);

  return {
    phase,
    meta,
    bubbles,
    unlock,
    account,
    walletBusy,
    pairingUri,
    connect,
    openMyChat,
    leave,
    unlockWithPassword,
    unlockWithKey,
    setTopicPassword,
    send,
    edit,
    walletConnect,
    walletDisconnect,
    formatStamp,
    useRelay,
    transport,
    setUseRelay,
    profiles: identity.profiles,
    following: identity.following,
    followingStatus: identity.followingStatus,
    refreshFollowing: identity.refreshFollowing,
  };
}

export type E2eeChat = ReturnType<typeof useE2eeChat>;
