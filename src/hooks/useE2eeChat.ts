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
import {
  AppMessage,
  fetchMessages,
  messageSig,
  reportPendingSend,
  streamOnReconnect,
  streamOnTopic,
  StreamEvent,
} from '../services/backend';
import {
  editOutgoingBytes,
  HCS_MESSAGE_MAX_BYTES,
  HCS_TOO_LONG,
  packChatPayload,
  sendOutgoingBytes,
  unpackChatPayload,
  utf8ByteLength,
} from '../services/chatPayload';
import {
  decryptMessage,
  decryptWithPassword,
  encryptMessage,
  parsePrivateKey,
  parsePublicKey,
} from '../services/sodium';
import { loadTopicKey, storeTopicKey } from '../services/secretStore';
import { connectWallet, disconnectWallet, getConnectedAccount, sendTopicMessage } from '../services/wallet';

export interface Bubble {
  sig: string;
  payer: string;
  created: string; // ISO (provisional = submit time while pending)
  text: string;
  image: string;
  pending: boolean;
  edited: boolean;
  mine: boolean;
}

interface EditEntry {
  text: string;
  image: string;
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

  const setAccountBoth = (acc: string | null) => {
    accountRef.current = acc;
    setAccount(acc);
  };

  const stopLive = () => {
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
      const image = data.image ? String(data.image) : parts.image || '';
      if (!text && !image) return null;
      const at = createdIso(envelope) || '';
      // An edit that names a bubble from its own future is malformed noise.
      if (created && at && at <= created) return null;
      const mapKey = `${payer}|${created}`;
      const prev = editsRef.current.get(mapKey);
      // A pending edit (no consensus time yet) never replaces a known one.
      if (!at && prev) return null;
      // Latest wins: an older edit arriving late never replaces a newer one.
      if (prev && prev.at && at && at < prev.at) return null;
      const entry: EditEntry = { text, image, at };
      editsRef.current.set(mapKey, entry);
      // Rewrite the on-screen bubbles in place (+ the "edited" mark).
      setBubbles((bs) =>
        bs.map((b) =>
          b.payer === payer && b.created === created
            ? { ...b, text, image, edited: true }
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
      if (!parts.text && !parts.image) return;
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
            pending: isPending,
            created: isPending ? next[i].created : created,
            mine,
            edited: edited || next[i].edited,
          };
          return next;
        }
        return [
          ...bs,
          { sig, payer: m.payer, created, text: parts.text, image: parts.image, pending: isPending, edited, mine },
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

  // Re-fetch anything missed while the stream was down (signature dedupe
  // absorbs duplicates).
  const refetchMissed = useCallback(async () => {
    const topic = topicIdRef.current;
    if (!topic || !privateKeyRef.current) return;
    const data = await fetchMessages(topic, 1000);
    for (const m of data.messages) {
      const sig = messageSig(m);
      if (seenRef.current.has(sig)) continue;
      seenRef.current.add(sig);
      await ingest(m);
    }
  }, [ingest]);

  const startLive = useCallback(() => {
    const topic = topicIdRef.current;
    if (!topic) return;
    stopLive();
    offStreamRef.current = streamOnTopic(topic, handleStream);
    offReconnectRef.current = streamOnReconnect(() => {
      if (!liveReadyRef.current) {
        liveReadyRef.current = true;
        return;
      }
      void refetchMissed();
    });
  }, [handleStream, refetchMissed]);

  // ── History load (unlock gate) ─────────────────────────────────────────

  const loadHistory = useCallback(
    async (topic: string): Promise<{ meta: TopicMeta; bubbles: Bubble[] }> => {
      const data = await fetchMessages(topic, 1000);
      if (!data.ready) {
        throw new Error('Topic not available yet (backend offline or not backfilled)');
      }
      const messages = data.messages;

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
    async (topicId: string): Promise<Result> => {
      const topic = String(topicId || '').trim();
      if (!/^\d+\.\d+\.\d+$/.test(topic)) {
        return { ok: false, error: 'Topic must look like 0.0.123' };
      }
      setPhase('idle');
      setBubbles([]);
      setPairingUri(null);
      seenRef.current = new Set();
      editsRef.current = new Map();
      stopLive();
      setUnlock({ status: 'connecting', message: '' });
      topicIdRef.current = topic;
      try {
        const { meta } = await loadHistory(topic);
        setMeta(meta);
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
    [finishUnlock, loadHistory]
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

  const unlockWithKey = useCallback(
    async (derHex: string): Promise<Result> => {
      await finishUnlock(String(derHex || '').trim());
      return { ok: true };
    },
    [finishUnlock]
  );

  // ── Send + edit (wallet-confirmed, 18 KB gated) ────────────────────────

  const send = useCallback(
    async (text: string, imageUrl = ''): Promise<Result> => {
      const topic = topicIdRef.current;
      const pub = publicKeyRef.current;
      if (!topic) return { ok: false, error: 'No topic connected' };
      if (!pub) {
        return { ok: false, error: 'No public key found for this topic. The admin must pin one first.' };
      }
      const acc = (await getConnectedAccount()) || accountRef.current;
      if (!acc) return { ok: false, error: 'Connect a wallet to send (HBAR network fee only)' };
      // Predict the exact outgoing size before encrypting (fixed 48-byte
      // seal, unpadded base64).
      const predicted = sendOutgoingBytes(text, imageUrl);
      if (predicted > HCS_MESSAGE_MAX_BYTES) return { ok: false, error: HCS_TOO_LONG };
      try {
        // Encrypt before build: plaintext never enters the HCS JSON.
        const encryptedMessage = await encryptMessage(packChatPayload(text, imageUrl), pub);
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
        void reportPendingSend(topic, outgoing, acc);
        await ingest(local);
        return { ok: true };
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
      if (bubble.image) data.image = bubble.image;
      const predicted = editOutgoingBytes(data, newText, bubble.image);
      if (predicted > HCS_MESSAGE_MAX_BYTES) return { ok: false, error: HCS_TOO_LONG };
      try {
        const encryptedMessage = await encryptMessage(packChatPayload(newText, bubble.image), pub);
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
        void reportPendingSend(topic, outgoing, acc);
        // Apply locally right away; the topic stream confirms the same edit.
        await rememberE2eeEdit(acc, body, new Date().toISOString());
        return { ok: true };
      } catch (e: any) {
        return { ok: false, error: e?.message || 'Edit was not saved' };
      }
    },
    [rememberE2eeEdit]
  );

  // ── Wallet ─────────────────────────────────────────────────────────────

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
      setWalletBusy(false);
    }
  }, []);

  const walletDisconnect = useCallback(async () => {
    await disconnectWallet();
    setAccountBoth(null);
    setPairingUri(null);
  }, []);

  // ── Leave the topic ────────────────────────────────────────────────────

  const leave = useCallback(() => {
    stopLive();
    topicIdRef.current = null;
    privateKeyRef.current = null;
    publicKeyRef.current = null;
    pinnedRef.current = null;
    setMeta(null);
    setBubbles([]);
    setUnlock({ status: 'none', message: '' });
    setPhase('idle');
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
    leave,
    unlockWithPassword,
    unlockWithKey,
    send,
    edit,
    walletConnect,
    walletDisconnect,
    formatStamp,
  };
}

export type E2eeChat = ReturnType<typeof useE2eeChat>;
