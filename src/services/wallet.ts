// Wallet send path — WalletConnect / HIP-820: UniversalProvider with a
// `hedera` namespace, pairing via the display_uri event, account read from
// the session. Sending is `hedera_signAndExecuteTransaction` with the same
// request the Globe map's wallet library sends (@hashgraph/hedera-wallet-connect
// DAppSigner): the dApp freezes the HCS transaction for the connected
// account, the EXTERNAL wallet signs it, executes it and pays the network
// fee. No custodial key ever touches this app, no IAP packs.
import { Transaction, TransactionId } from '@hashgraph/sdk';
import UniversalProvider from '@walletconnect/universal-provider';
import { signatureBytesFromWallet } from './sealedMedia';
import {
  bytesToBase64,
  chunkCount,
  freezeChunk,
  freezeSingle,
  HCS_MAX_CHUNKS,
  pickNode,
  signAndExecuteParams,
} from './hcsTx';

// Same WalletConnect Cloud project as the notifications app.
const PROJECT_ID = '4bb3a1d4a8c30b0e3b1bd4c7285330b6';

// CAIP-2 chain of every request (DAppSigner ledgerIdToCAIPChainId).
const CHAIN = 'hedera:mainnet';

const HEDERA_METHODS = [
  'hedera_signMessage',
  'hedera_signTransaction',
  'hedera_signAndExecuteTransaction',
];

let provider: any = null;
let initRun: Promise<any> | null = null;
let accountCache: string | null = null;
const endedListeners = new Set<() => void>();

// One provider for the app's life (a second init warns and duplicates the
// relay connection). Created on first use, or at launch by restoreSession.
export async function initProvider(): Promise<any> {
  if (provider) return provider;
  if (!initRun) {
    initRun = UniversalProvider.init({
      projectId: PROJECT_ID,
      metadata: {
        name: 'Hedera E2EE Chat',
        description: 'Encrypted topic chat for Hedera consensus topics',
        url: 'https://hedera.com',
        icons: ['https://hedera.com/logo.png'],
      },
    }).then(
      (p: any) => {
        provider = p;
        // The wallet ended the session (or it expired): log out here too.
        p.on('disconnect', () => {
          accountCache = null;
          for (const fn of [...endedListeners]) fn();
        });
        return p;
      },
      (err: unknown) => {
        initRun = null;
        throw err;
      }
    );
  }
  return initRun;
}

// Stay logged in across restarts, like the Globe map: WalletConnect keeps an
// approved session in app storage (AsyncStorage on phones, IndexedDB in
// browsers) and the provider picks it up when it starts. Returns that
// session's account, or null when there is none or it has expired.
export async function restoreSession(): Promise<string | null> {
  const p = await initProvider();
  const session = p.session;
  if (!session) return null;
  if (session.expiry && session.expiry * 1000 <= Date.now()) return null;
  accountCache = readAccount(session);
  return accountCache;
}

// Called when the wallet side ends the session. Returns an unsubscribe.
export function onWalletSessionEnded(fn: () => void): () => void {
  endedListeners.add(fn);
  return () => endedListeners.delete(fn);
}

// Kick off the pairing flow. On web the pairing URI is handed to the UI to
// show; on RN a QR could render it. Resolves once the wallet approves.
export async function connectWallet(
  onPairingUri?: (uri: string) => void
): Promise<{ account: string | null }> {
  const p = await initProvider();
  const onUri = (uri: string) => onPairingUri?.(uri);
  p.on('display_uri', onUri);
  try {
    await p.connect({
      optionalNamespaces: {
        hedera: {
          methods: HEDERA_METHODS,
          chains: ['hedera:mainnet'],
          events: ['chainChanged', 'accountsChanged'],
        },
      },
    });
  } finally {
    p.off?.('display_uri', onUri);
  }
  accountCache = readAccount(p.session) || accountCache;
  return { account: accountCache };
}

function readAccount(session: any): string | null {
  const accounts: string[] =
    session?.namespaces?.hedera?.accounts ||
    session?.namespaces?.hip820?.accounts ||
    [];
  if (!accounts.length) return null;
  const parts = accounts[0].split(':');
  return parts[parts.length - 1] || null;
}

export async function getConnectedAccount(): Promise<string | null> {
  if (provider?.session) {
    accountCache = readAccount(provider.session) || accountCache;
  }
  return accountCache;
}

export function isConnected(): boolean {
  return !!provider?.session;
}

// Log out: end the session in the wallet too. The provider itself stays, so
// the next Connect wallet reuses it.
export async function disconnectWallet(): Promise<void> {
  if (provider?.session) {
    try {
      await provider.disconnect();
    } catch {
      /* already gone */
    }
  }
  accountCache = null;
}

// HIP-820. The wallet signs the nonce text itself (the Globe map signs
// TextEncoder(nonce) the same way), and the upload server checks the raw
// 64-byte signature over that text, with or without the Hedera
// signed-message prefix.
export async function signUploadNonce(nonce: string): Promise<string> {
  if (!provider?.session) throw new Error('Connect your wallet to upload');
  const account = await getConnectedAccount();
  if (!account) throw new Error('Connect your wallet to upload');
  const result: unknown = await provider.request(
    {
      method: 'hedera_signMessage',
      params: { signerAccountId: `${CHAIN}:${account}`, message: nonce },
    },
    CHAIN
  );
  const bytes = signatureBytesFromWallet(result);
  if (!bytes || bytes.length !== 64) throw new Error('Upload failed, please try again');
  return bytesToBase64(bytes);
}

// DAppSigner._tryExecuteTransactionRequest: the frozen transaction as a
// base64 TransactionList, signed by the session account on hedera:mainnet.
async function signAndExecute(tx: Transaction, account: string): Promise<string> {
  const result: any = await provider.request(
    { method: 'hedera_signAndExecuteTransaction', params: signAndExecuteParams(tx, CHAIN, account) },
    CHAIN
  );
  return result && typeof result === 'object'
    ? String(result.transactionId ?? result.txId ?? '')
    : String(result ?? '');
}

// Submit a body to the topic through the connected wallet. Each body (one,
// or one per 1024-byte chunk) is frozen for the session account and sent
// with hedera_signAndExecuteTransaction; the wallet signs, executes and
// pays. Returns the last transaction id the wallet reports.
export async function sendTopicMessage(
  topicId: string,
  jsonBody: string
): Promise<string | null> {
  if (!provider?.session) throw new Error('No wallet session — connect a wallet first');
  const account = await getConnectedAccount();
  if (!account) throw new Error('Wallet connected but no Hedera account in session');

  const message = new TextEncoder().encode(jsonBody);
  const total = chunkCount(message);
  if (total > HCS_MAX_CHUNKS) throw new Error('Message too long for Hedera');
  const node = pickNode();

  if (total === 1) {
    const tx = freezeSingle({ topicId, message, node, transactionId: TransactionId.generate(account) });
    return signAndExecute(tx, account);
  }

  // Each approval gets its own valid-start; chunk 1's id stays the
  // initial transaction id of every part (hedera.js sendMessage).
  let initialTransactionId: TransactionId | null = null;
  let sent = 0;
  let last = '';
  for (let number = 1; number <= total; number++) {
    const transactionId = TransactionId.generate(account);
    if (!initialTransactionId) initialTransactionId = transactionId;
    const part = freezeChunk({ topicId, message, node, transactionId, initialTransactionId, number, total });
    try {
      last = await signAndExecute(part, account);
      sent += 1;
    } catch (e: any) {
      const why = e?.message ? ` (${e.message})` : '';
      throw new Error(`Sent ${sent} of ${total} parts, so this message won't appear. Send it again to retry.${why}`);
    }
  }
  return last;
}
