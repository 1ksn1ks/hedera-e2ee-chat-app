# Hedera E2EE Chat

A standalone Play/App Store messenger for **encrypted Hedera consensus topics** (`0.0.x`).
Signal/Telegram layout — header + grouped bubble list + bottom composer — dark glass, cyan accents.
No map, no globe, no feed, no NFT gates, no push-notification product.

## How it relates to the Globe map (step_by_step)

Same wire, separate app. The Globe map's encrypted topic chat
(`encryptedtopicchat.js` + `sodium.js` + `msgbackend.js`) and this app speak
the exact same protocol against the same topic-message backend:

| Concern | Wire (identical in both apps) |
| --- | --- |
| Message | `{ encryptedMessage: { ciphertext } }` — `crypto_box_seal` (libsodium-sumo, Ed25519→X25519), 48-byte overhead, **unpadded** base64. Plaintext never goes on chain. |
| Edit own | `{ editEncryptedMessage: { created, timestamp, encryptedMessage, image? } }` — a *new* message naming the original by ISO `created`. HCS is immutable, so clients keep a latest-wins map per `payer\|created`, decrypt the new text and **rewrite the rendered bubble in place** with an "edited" mark. |
| Edit gates | wrong key / malformed ciphertext / other payer / stale envelope (`at <= created`) → rejected; a pending edit never replaces a known one. |
| Payload | `packChatPayload`: raw text, or `\x1echat1\n` + JSON `{t, i}` once an image is attached. |
| Byte gate | 18 KB HCS ceiling measured on the **final outgoing JSON**; the live counter predicts it exactly (fixed 48-byte seal + unpadded-base64 math) before encrypting. |
| Live | SSE `GET /api/stream?topics=…` — one shared connection; when the topic set changes the connection reopens once with the full list (a live EventSource can't grow its list). Events: `pending` / `message` / `confirmed` / `expired`. |
| Keys | Topic public key = the admin-pinned `{ publicKey }` message in history (DER hex, last 32 bytes). Private key = DER hex, last 32 bytes are the ed25519 seed. Admin-pinned `{ encryptedPrivateKey, nonce, salt }` (URLSAFE_NO_PADDING base64) unlocks with a password via argon2id pwhash + secretbox. |
| Stamps | `dd/mm/yy HH:MM` |

The notifications apps (`hedera-notifications-backend` / `-frontend`) are a
separate product (FCM push for public topics) and are untouched by this app.

## Security model

- **Unlock**: the unwrapped topic private key lives in the platform keystore
  (iOS Keychain / Android Keystore via `react-native-keychain`, gated by the
  device passcode). Never in AsyncStorage, never long-lived in JS state.
  In the browser preview the keychain resolves to an **in-memory** stub — a
  reload drops the key and forces a re-unlock (by design).
- **Send**: external wallet only. The app builds the unsigned
  `TopicMessageSubmitTransaction`, the wallet signs and pays the HBAR network
  fee (`hedera_signAndExecuteTransaction`, HIP-820 — the same WalletConnect
  pattern as `hedera-notifications-frontend`). No custodial key, no IAP
  message packs.
- **Read**: requires the topic key (password unwrap or key import). A viewer
  without the key sees an empty list — ciphertext only, nothing to decrypt.

## Layout

```
App.tsx                  state machine: connect/unlock → chat
index.js                 RN entry (polyfills + AppRegistry)
web/main.tsx             browser-preview entry (Vite)
web-shims/, web-stubs/   browser stand-ins (keychain = in-memory)
src/theme.ts             dark glass + cyan palette
src/services/sodium.ts   crypto (port of step_by_step/sodium.js)
src/services/chatPayload.ts  payload pack/unpack + 18 KB gate math
src/services/backend.ts  /api/messages + SSE (re-subscribe on topic change) + /api/submit
src/services/secretStore.ts  Keystore/Keychain topic keys
src/services/wallet.ts   WalletConnect/HIP-820 pairing + topic submit
src/services/identity.ts profiles, domains, following, topic-input rules (Globe's, ported)
src/services/identityFetch.ts  /api/user-settings, /api/following, or the same topics off the mirror
src/hooks/useE2eeChat.ts engine: unlock, ingest, live, pending, edit map
src/hooks/useIdentity.ts profiles every 30s, domains, following per wallet
src/screens/             ConnectScreen (topic/domain/payer + following + unlock + wallet), ChatScreen (messenger)
src/components/          MessageBubble (grouped, avatar + name, edited mark), Composer (byte counter, edit mode)
android/, ios/           native shells (renamed from the notifications app)
```

## Install a test build (Android)

Every push to `main` builds an installable APK in GitHub Actions
(`.github/workflows/android-apk.yml`) and publishes it as the
`android-latest` pre-release. On the phone, open:

https://github.com/1ksn1ks/hedera-e2ee-chat-app/releases/download/android-latest/hedera-e2ee-chat.apk

then open the downloaded file and allow installing from that source. Builds
are signed with the committed test key (`android/app/e2ee-test.p12`), so each
one installs over the last and keeps the saved topic keys. That key is public
on purpose and only for test builds: store builds use the private upload key
from `android/keystore.properties` (never committed). Because the keys
differ, uninstall the test build before installing the store one. iOS has
no GitHub install path; test it through TestFlight.

## Run it

```bash
npm install
npm run start:web    # browser preview on :5175, /api proxied to 127.0.0.1:8787
npm run typecheck    # tsc --noEmit
npm run android      # device build (needs Android SDK; iOS: pod install)
```

The preview expects the topic-message backend (step_by_step's `server/`) on
`127.0.0.1:8787`; point `vite.config.js` → `server.proxy['/api'].target`
elsewhere (or set `window.__E2EE_BACKEND_URL__`) to use another instance.

## Verified (headless, web preview, real backend + real crypto)

20/20: connect screen → keygen/seal in-page (libsodium WASM) → key-import
unlock → history decrypt/render → `dd/mm/yy HH:MM` stamps → SSE live message
→ SSE edit directive rewrites in place with the "edited" mark (no second
bubble) → 18 KB gate blocks oversized sends → wrong key renders nothing.
Not covered headless: the wallet pairing round-trip and the on-device
Keystore (phone-only paths; the pairing URI flow and keychain calls are the
same pattern as the notifications app).
