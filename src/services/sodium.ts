// E2EE crypto — wire-compatible with the Globe map's encrypted topic chat
// (step_by_step/sodium.js). Same helpers, byte for byte:
//   - Ed25519 keys travel as DER hex; the last 32 bytes are the seed.
//   - Message seal: crypto_box_seal (Ed25519 → X25519 conversion), 48-byte
//     fixed overhead, base64 UNPADDED.
//   - Key-at-rest: argon2id pwhash + secretbox (the admin-pinned
//     encryptedPrivateKey flow).
// libsodium-wrappers-sumo is pure WASM — no native module needed on RN.
import _sodium from 'libsodium-wrappers-sumo';

type Sodium = typeof _sodium;

let ready: Promise<Sodium> | null = null;

function sodiumReady(): Promise<Sodium> {
  if (!ready) {
    ready = (async () => {
      await _sodium.ready;
      return _sodium as unknown as Sodium;
    })();
  }
  return ready;
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = String(hex || '').replace(/\s/g, '');
  const bytes = new Uint8Array(Math.floor(clean.length / 2));
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.substr(i * 2, 2), 16);
  }
  return bytes;
}

// Topic public key: DER hex → last 32 bytes (the ed25519 public key).
export function parsePublicKey(derHex: string): Uint8Array {
  const derBytes = hexToBytes(derHex);
  return derBytes.slice(derBytes.length - 32);
}

// Topic private key: DER hex → last 32 bytes are the seed → full 64-byte
// ed25519 secret key (sign keypair from seed).
export function parsePrivateKey(derHex: string): Uint8Array {
  const sodium = _sodium as unknown as Sodium;
  const derBytes = hexToBytes(derHex);
  const seed = derBytes.slice(derBytes.length - 32);
  const keyPair = sodium.crypto_sign_seed_keypair(seed);
  return keyPair.privateKey as unknown as Uint8Array;
}

// Sealed message: { ciphertext: base64 } — the exact shape on the wire.
export async function encryptMessage(
  message: string,
  recipientPublicKey: Uint8Array
): Promise<{ ciphertext: string }> {
  const sodium = await sodiumReady();
  const recipientX25519Public = sodium.crypto_sign_ed25519_pk_to_curve25519(
    recipientPublicKey
  );
  const ciphertext = sodium.crypto_box_seal(
    sodium.from_string(message),
    recipientX25519Public
  );
  return { ciphertext: sodium.to_base64(ciphertext) };
}

export async function decryptMessage(
  encryptedData: { ciphertext: string },
  recipientPrivateKey: Uint8Array
): Promise<string> {
  const sodium = await sodiumReady();
  const recipientPublicKey = (recipientPrivateKey as unknown as {
    slice: (start: number) => Uint8Array;
  }).slice(32);
  const recipientX25519Private = sodium.crypto_sign_ed25519_sk_to_curve25519(
    recipientPrivateKey
  );
  const recipientX25519Public = sodium.crypto_sign_ed25519_pk_to_curve25519(
    recipientPublicKey
  );
  const ciphertext = sodium.from_base64(encryptedData.ciphertext);
  const decrypted = sodium.crypto_box_seal_open(
    ciphertext,
    recipientX25519Public,
    recipientX25519Private
  );
  return sodium.to_string(decrypted);
}

// ── Password-wrapped topic key (admin-pinned encryptedPrivateKey) ────────

export interface PasswordBundle {
  encrypted: string;
  nonce: string;
  salt: string;
}

export async function encryptWithPassword(data: string, password: string): Promise<PasswordBundle> {
  const sodium = await sodiumReady();
  if (!data || typeof data !== 'string' || data.length === 0) {
    throw new Error('Private key cannot be empty');
  }
  if (!password || typeof password !== 'string' || password.length < 5) {
    throw new Error('Password must be at least 5 characters long');
  }
  const dataBytes = sodium.from_string(data);
  const passwordBytes = sodium.from_string(password);
  const salt = sodium.randombytes_buf(sodium.crypto_pwhash_SALTBYTES);
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
  const key = sodium.crypto_pwhash(
    sodium.crypto_secretbox_KEYBYTES,
    passwordBytes,
    salt,
    sodium.crypto_pwhash_OPSLIMIT_INTERACTIVE,
    sodium.crypto_pwhash_MEMLIMIT_INTERACTIVE,
    sodium.crypto_pwhash_ALG_ARGON2ID13
  );
  const encryptedBytes = sodium.crypto_secretbox_easy(dataBytes, nonce, key);
  return {
    encrypted: sodium.to_base64(encryptedBytes),
    nonce: sodium.to_base64(nonce),
    salt: sodium.to_base64(salt),
  };
}

// The on-chain bundle is URLSAFE_NO_PADDING base64 (same as the Globe map).
export async function decryptWithPassword(
  encrypted: string,
  nonce: string,
  salt: string,
  password: string
): Promise<string> {
  const sodium = await sodiumReady();
  const variant = (sodium as unknown as {
    base64_variants: { URLSAFE_NO_PADDING: number };
  }).base64_variants.URLSAFE_NO_PADDING;
  const encryptedBytes = sodium.from_base64(encrypted, variant);
  const nonceBytes = sodium.from_base64(nonce, variant);
  const saltBytes = sodium.from_base64(salt, variant);
  const passwordBytes = sodium.from_string(password);
  const key = sodium.crypto_pwhash(
    sodium.crypto_secretbox_KEYBYTES,
    passwordBytes,
    saltBytes,
    sodium.crypto_pwhash_OPSLIMIT_INTERACTIVE,
    sodium.crypto_pwhash_MEMLIMIT_INTERACTIVE,
    sodium.crypto_pwhash_ALG_ARGON2ID13
  );
  try {
    const decryptedBytes = sodium.crypto_secretbox_open_easy(encryptedBytes, nonceBytes, key);
    return sodium.to_string(decryptedBytes);
  } catch (error) {
    throw new Error('Decryption failed: Incorrect password.');
  }
}
