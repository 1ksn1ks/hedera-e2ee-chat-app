# 💬 Hedera E2EE Chat

A standalone messenger for **encrypted Hedera consensus topics** (`0.0.x`).

Header, grouped bubbles, bottom composer. Dark glass, cyan accents. No map, no feed, no NFT gates, and no push product. It speaks the same wire as the globe’s encrypted topic chat, against the same topic-message backend.

**Relay:** [onlyonhbar.com](https://onlyonhbar.com)

---

## 🚀 Getting started

### Install a test build (Android)

Every push to `main` builds an APK (`.github/workflows/android-apk.yml`) and publishes it as the `android-latest` pre-release. On the phone, open:

https://github.com/1ksn1ks/hedera-e2ee-chat-app/releases/download/android-latest/hedera-e2ee-chat.apk

Then open the file and allow installs from that source.

Test builds are signed with a private test key kept in GitHub Actions secrets, not in the repo, so each one installs over the last and keeps the saved topic keys. The first build after the key change does not: uninstall the old test app once, then unlock the topic again. Store builds use the private upload key in `android/keystore.properties`, which is never committed. The two keys differ, so uninstall the test build before installing a store build. There is no GitHub install path for iOS; use TestFlight.

Package id is `com.hederae2eechat`, separate from the notifier, so the two apps do not overwrite each other.

### From source

Node `>= 22.11.0`.

```bash
npm install
npm run start:web    # browser preview on :5175
npm test             # wire, mirror, transport, payload, media
npm run typecheck    # tsc --noEmit
npm run android      # device build (iOS: pod install, then npm run ios)
```

The app calls `https://onlyonhbar.com` unless `globalThis.__E2EE_BACKEND_URL__` is set. An empty string stays on the page origin. The Vite preview proxies `/api` to `http://127.0.0.1:8787`, so that empty override uses a local copy of the globe server. If 5175 is taken, Vite prints the port it picked.

---

## ✨ Features

- **🔐 Sealed topic chat** — `crypto_box_seal` (libsodium, Ed25519 → X25519). Plaintext never goes on chain. A viewer without the topic key sees nothing to read.
- **✏️ Edit in place** — an edit is a new consensus message that names the original. Clients keep the latest one and rewrite that bubble, with an “edited” mark. Hedera itself stays immutable.
- **📎 Sealed files** — a picture or video is secretstream-sealed, then uploaded as ciphertext. The topic message carries only the key and the URL. Older clear `{t, i}` links still open and are marked unencrypted.
- **⚡ Relay, then the mirror** — reads and the live tail prefer the globe relay, with a short timeout and an automatic fall back to the public mirror. A “Hedera only” switch never calls the relay.
- **👛 Wallet sends** — the app builds the unsigned topic submit. The wallet signs it and pays the HBAR fee. No custodial key and no in-app message packs.
- **🪪 Same people as the globe** — usernames, pictures, domains, and following come from the globe’s public topics and API.

---

## 🏗️ Architecture

```
phone app (React Native)
        │  reads: relay /api/messages + /api/stream, else the mirror
        │  sends: wallet → Hedera → relay /api/submit (pending)
        ▼
topic-message backend (the globe’s server)   ← optional cache, not source of truth
        │
        ▼
Hedera mirror node                            ← source of truth
```

- A wallet-confirmed send is reported as **pending** so other viewers see it immediately. The mirror confirms it a few seconds later. If the relay is down, the mirror poll still picks the message up.
- The notifier ([hedera-notifications-frontend](https://github.com/1ksn1ks/hedera-notifications-frontend)) is a different product. It pushes public topics and does not hold these keys.

---

## 🔐 Wire

Same bytes as `encryptedtopicchat.js`, `sodium.js`, and `msgbackend.js` in the globe.

| Concern | On the wire |
| --- | --- |
| Message | `{ encryptedMessage: { ciphertext } }` — `crypto_box_seal`, 48-byte overhead, unpadded base64 |
| Edit own | `{ editEncryptedMessage: { created, timestamp, encryptedMessage, image? } }` — a new message naming the original by ISO `created`. Latest wins per `payer\|created` |
| Edit gates | Wrong key, malformed ciphertext, another payer, or a stale envelope (`at <= created`) is rejected. A pending edit never replaces a known one |
| Payload | Raw text, or `\x1echat1\n` plus JSON. A sealed file is `{t, m}` (`url`, `fileKey`, `header`, `mime`, `size`, and optional `w`, `h`, `poster`). An older `{t, i}` link still unpacks |
| Byte gate | 18 KB measured on the final outgoing JSON. The counter predicts it (fixed 48-byte seal, unpadded base64) before encrypting |
| Live | `GET /api/stream?topics=…` — one connection. A topic-list change reopens it with the full list. Events: `pending`, `message`, `confirmed`, `expired` |
| Keys | Topic public key is the admin-pinned `{ publicKey }` (DER hex, last 32 bytes). The private key is DER hex; the last 32 bytes are the Ed25519 seed. `{ encryptedPrivateKey, nonce, salt }` unlocks with a password (argon2id + secretbox) |
| Stamps | `dd/mm/yy HH:MM` |

---

## 🛡️ Keys

- **Unlock.** The unwrapped topic private key lives in the platform keystore (iOS Keychain / Android Keystore, gated by the device passcode). Never in AsyncStorage, and not kept in JS state. In the browser preview the keychain is an in-memory stub: a reload drops the key and asks for it again.
- **Send.** External wallet only (`hedera_signAndExecuteTransaction`, HIP-820).
- **Read.** Password unwrap or key import. Without the key the list stays empty.

---

## 🧰 Tech stack

| Layer | Stack |
| --- | --- |
| **App** | React Native 0.86, TypeScript, React Native Web |
| **Crypto** | libsodium-wrappers-sumo (`crypto_box_seal`, secretstream for files) |
| **Keys** | `react-native-keychain` |
| **Wallet** | WalletConnect, `@hashgraph/sdk` |
| **Browser preview** | Vite on port 5175 |
| **Relay** | The globe backend at [onlyonhbar.com](https://onlyonhbar.com). Mirror fallback is `mainnet-public.mirrornode.hedera.com` |

---

## 📁 Project structure

```
App.tsx                     connect and unlock, then the chat
index.js                    React Native entry
web/main.tsx                browser preview entry
src/theme.ts                dark glass and cyan
src/services/sodium.ts      seal and open (port of the globe’s sodium.js)
src/services/chatPayload.ts pack, unpack, and the 18 KB gate
src/services/sealedMedia.ts secretstream files and the {t, m} envelope
src/services/backend.ts     /api/messages, /api/stream, /api/submit
src/services/transport.ts   relay, timeout, mirror fallback
src/services/mirror.ts      direct mirror history and live tail
src/services/secretStore.ts Keystore / Keychain topic keys
src/services/wallet.ts      WalletConnect pairing and topic submit
src/services/identity.ts    profiles, domains, following
src/hooks/useE2eeChat.ts    unlock, ingest, live tail, edits
src/screens/                ConnectScreen, ChatScreen
src/components/             MessageBubble, Composer, RelayStatus
android/, ios/              native shells
```

---

## 📝 Notes

- The mirror node is the source of truth. The relay is a cache, the same one the globe uses. Hedera-only mode never contacts it.
- A sealed upload is `application/octet-stream` with `X-Sealed: 1`. The real type stays inside the encrypted envelope.
- Decrypted pictures and video stay in memory on the web, and in an app cache file on the phone. Both are dropped when the chat closes or the key locks.
- The browser preview cannot exercise the on-device keystore or the wallet round-trip. Those follow the same WalletConnect pattern as the notifier.
