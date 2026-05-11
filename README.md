# Vault — Self-Custodial Crypto Wallet

A mobile-first multi-chain wallet that runs entirely on your device. No server, no account, no third party. Your keys never leave your phone.

**Live PWA:** https://satkiexe808.github.io/vault-wallet/
**Android APK:** [Download latest release](https://github.com/SatkiExE808/vault-wallet/releases/latest)

## Screenshots

| Setup | Home | Coin Detail |
|---|---|---|
| ![Setup](screenshots/01-setup.png) | ![Home](screenshots/02-home.png) | ![Coin Detail](screenshots/03-coin-detail.png) |

## Supported Assets

| Chain | Native | Tokens |
|---|---|---|
| Bitcoin | BTC (Native SegWit, `bc1q…`) | — |
| Ethereum | ETH | USDT, USDC, DAI |
| BNB Chain | BNB | USDT, USDC |
| Polygon | POL | USDT, USDC |
| Avalanche | AVAX | USDT, USDC |
| Arbitrum | ARB, ETH | USDT, USDC |
| Optimism | OP, ETH | USDT, USDC |
| Base | ETH | USDT, USDC |
| TRON | TRX | USDT (TRC-20) |
| Solana | SOL | — |
| Monero | XMR | — |
| Litecoin | LTC (Native SegWit, `ltc1q…`) | — |
| Dogecoin | DOGE | — |

## Features

- **Mobile-first UI** — bottom nav (Home / Wallets / Settings), one screen per tab
- **Wallets tab** — pick any coin to display its QR + address; send and view history inline without navigating away
- **Home tab** — total USD balance + asset list grouped by network; reorder networks via Edit mode
- **Receive** — QR code + copyable address per coin
- **Send** — inline send form with auto gas-fee estimation (incl. L2 rollup data fee)
- **History** — recent transactions with one-tap link to the network explorer (Etherscan, Tronscan, mempool.space, etc.)
- **Biometric unlock** — Face ID / fingerprint via native Capacitor plugin (Android/iOS) or WebAuthn (browser PWA)
- **Auth on send** — every transaction is gated by biometric or password
- **Recovery phrase reveal** — password-gated display of the 12 words for backup
- **Change password** — re-encrypts the seed in place; biometric is reset (re-enable required)
- **Manage assets** — toggle individual networks/tokens on or off
- **PWA + Android APK** — installable from browser or sideload the signed APK
- **Auto-updates** — APK loads from GitHub Pages, so pushes propagate without reinstall

## Security

- Seed phrase encrypted with **AES-256-GCM**, key derived from your password via **PBKDF2-SHA256** (300,000 iterations)
- Raw seed never persisted — only the encrypted blob lives in `localStorage`
- Round-trip decryption verified before any legacy plaintext is discarded (no possible seed loss)
- Biometric path: password is encrypted with a per-install AES-256 key; the biometric (native iOS Keychain / Android BiometricPrompt or WebAuthn) is the gate to retrieving it
- All key derivation runs locally using BIP39 / BIP44 / SLIP-44 (coin types 0/2/3/60/195/501)
- EVM chains use the standard MetaMask path (`m/44'/60'/0'/0/0`)
- BTC / LTC use BIP84 native SegWit (`m/84'/0'/0'/0/0`)
- Bech32m enforced per BIP350 (Taproot/`bc1p` accepted with correct checksum, v0 still uses bech32)
- Low-S signature normalization on UTXO chains (no malleability)

## Run in Browser

The wallet uses the Web Crypto API (`crypto.subtle`), which requires a **secure context** (HTTPS or `localhost`):

```bash
# Python
python3 -m http.server 8080

# Node
npx serve .
```

Then open `http://localhost:8080` in your browser. To install as a PWA, use the browser's "Add to Home Screen" option.

## Build Android APK

### Prerequisites
- [Node.js](https://nodejs.org) v18+
- [Android Studio](https://developer.android.com/studio) with Android SDK + bundled JDK

### Build a debug APK

```bash
npm install
node build-www.js
npx cap sync android
cd android
./gradlew assembleDebug
```

Output: `android/app/build/outputs/apk/debug/app-debug.apk`

### Build a signed release APK

1. Generate a keystore (one-time):
   ```bash
   keytool -genkey -v \
     -keystore android/vault-release.keystore \
     -storetype PKCS12 \
     -keyalg RSA -keysize 2048 -validity 10000 \
     -alias vault
   ```

2. Create `android/keystore.properties` (not committed):
   ```
   storeFile=vault-release.keystore
   storePassword=<your password>
   keyAlias=vault
   keyPassword=<your password>
   ```

3. Build:
   ```bash
   cd android
   ./gradlew assembleRelease
   ```

   Output: `android/app/build/outputs/apk/release/app-release.apk`

> Keep `vault-release.keystore` and the password backed up safely — you cannot push signature-matching updates without them.

### Updating the live web build

The APK has `server.url` set to the GitHub Pages URL, so changes pushed to `main` reach the app on next launch — no APK rebuild required for HTML/CSS/JS updates.

## Project Structure

```
vault-wallet/
├── index.html               # Main app shell
├── manifest.json            # PWA manifest
├── sw.js                    # Service worker (network-first)
├── capacitor.config.json    # Capacitor / Android config
├── build-www.js             # Copies app files → www/
├── css/style.css
├── js/
│   ├── app.js               # Main logic, coin registry, send/receive flow
│   ├── home.js              # Home / Wallets view rendering, view routing
│   ├── settings.js          # Settings menu, biometric, password change
│   ├── tx-progress.js       # Send-tx progress UI
│   ├── qr-scanner.js        # Camera-based address scanning
│   └── coins/
│       ├── utxo.js          # Shared UTXO tx builder (BTC / LTC / DOGE)
│       ├── bitcoin.js / litecoin.js / dogecoin.js
│       ├── ethereum.js      # ETH mainnet RPC + tx
│       ├── evm-chains.js    # BSC, Polygon, AVAX, Arbitrum, Optimism, Base
│       ├── monero.js        # WASM-based XMR wallet
│       ├── tron.js          # TRX + TRC-20
│       └── solana.js
├── lib/                     # Pre-built Monero browser bundle + WASM
├── monero_web_worker.js     # Monero scan worker (must stay at root)
├── icons/                   # PWA icons + source
├── android/                 # Capacitor Android project (gitignored)
└── screenshots/
```

## Compatibility

Addresses derived here are compatible with:
- **MetaMask, Trust Wallet, Rainbow** — all EVM chains (`m/44'/60'/0'/0/0`)
- **TronLink** — TRX and TRC-20 (`m/44'/195'/0'/0/0`)
- **Electrum, BlueWallet, Sparrow** — Bitcoin Native SegWit (`m/84'/0'/0'/0/0`)
- **Litecoin Core** — Litecoin Native SegWit (`m/84'/2'/0'/0/0`)
- **Dogecoin Core** — Dogecoin (`m/44'/3'/0'/0/0`)
- **Phantom, Solflare** — Solana (`m/44'/501'/0'/0'`)

Monero addresses are derived from the BIP39 seed, not a Monero 25-word seed. To import into another Monero wallet, use **Show keys** on the XMR receive tab and "Restore from keys" in the destination wallet.

## License

MIT — see [LICENSE](LICENSE) if present.
