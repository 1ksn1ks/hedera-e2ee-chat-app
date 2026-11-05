// Wallet send path — the same WalletConnect / HIP-820 pattern as
// hedera-notifications-frontend's walletConnect.ts: UniversalProvider with a
// `hedera` namespace, pairing via the display_uri event, account read from
// the session. Sending is `hedera_signAndExecuteTransaction`: the dApp
// builds the unsigned HCS transaction, the EXTERNAL wallet signs it and pays
// the network fee. No custodial key ever touches this app, no IAP packs.
import {
  AccountId,
  Client,
  TopicId,
  TopicMessageSubmitTransaction,
} from '@hashgraph/sdk';
import UniversalProvider from '@walletconnect/universal-provider';
import { signatureBytesFromWallet } from './sealedMedia';

// Same WalletConnect Cloud project as the notifications app.
const PROJECT_ID = '4bb3a1d4a8c30b0e3b1bd4c7285330b6';

const HEDERA_METHODS = [
  'hedera_signMessage',
  'hedera_signTransaction',
  'hedera_signAndExecuteTransaction',
];

let provider: any = null;
let accountCache: string | null = null;

export async function initProvider(): Promise<any> {
  if (!provider) {
    provider = await UniversalProvider.init({
      projectId: PROJECT_ID,
      metadata: {
        name: 'Hedera E2EE Chat',
        description: 'Encrypted topic chat for Hedera consensus topics',
        url: 'https://hedera.com',
        icons: ['https://hedera.com/logo.png'],
      },
    });
  }
  return provider;
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

export async function disconnectWallet(): Promise<void> {
  if (provider) {
    try {
      await provider.disconnect();
    } catch {
      /* already gone */
    }
    provider = null;
  }
  accountCache = null;
}

function hexEncode(text: string): string {
  return Array.from(new TextEncoder().encode(text))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

// HIP-820. The wallet signs the nonce, and the upload server wants the raw
// 64-byte signature (it also accepts the Hedera signed-message prefix).
export async function signUploadNonce(nonce: string): Promise<string> {
  if (!provider?.session) throw new Error('Connect your wallet to upload');
  const account = await getConnectedAccount();
  if (!account) throw new Error('Connect your wallet to upload');
  const result: unknown = await provider.request({
    method: 'hedera_signMessage',
    params: [{ message: hexEncode(nonce) }],
    account: `hedera:mainnet:${account}`,
  });
  const bytes = signatureBytesFromWallet(result);
  if (!bytes || bytes.length !== 64) throw new Error('Upload failed, please try again');
  return bytesToBase64(bytes);
}

// Base64 without Node's Buffer (RN has none): chunked btoa.
function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

// Submit a body to the topic through the connected wallet: build the
// unsigned TopicMessageSubmitTransaction, hand it to the wallet, which
// signs (hedera_signAndExecuteTransaction) and executes it. Returns the
// transaction id when the wallet reports one.
export async function sendTopicMessage(
  topicId: string,
  jsonBody: string
): Promise<string | null> {
  if (!provider?.session) throw new Error('No wallet session — connect a wallet first');
  const account = await getConnectedAccount();
  if (!account) throw new Error('Wallet connected but no Hedera account in session');

  const client = Client.forMainnet();
  try {
    // 2.81: the node map is a public property (getNetwork() was removed).
    const network = (client as unknown as { _network: Record<string, string> })._network;
    const nodes = Object.values(network || {});
    if (!nodes.length) throw new Error('No relay network available');
    const node = nodes[Math.floor(Math.random() * nodes.length)];

    const tx = new TopicMessageSubmitTransaction()
      .setTopicId(TopicId.fromString(topicId))
      .setMessage(jsonBody)
      .setNodeAccountIds([AccountId.fromString(node)]);

    const body = bytesToBase64(new Uint8Array(tx.toBytes()));

    const result: any = await provider.request({
      method: 'hedera_signAndExecuteTransaction',
      params: [{ transaction: body }],
      account: `hedera:mainnet:${account}`,
    });

    return result && typeof result === 'object'
      ? String(result.transactionId ?? result.txId ?? '')
      : String(result ?? '');
  } finally {
    await client.close();
  }
}
