# Vault — Self-Custodial Crypto Wallet

A browser-based HD wallet that runs entirely on your device. No server, no account, no third party. Your keys never leave your browser.

## Screenshots

| Setup | Home | Coin Detail |
|---|---|---|
| ![Setup](screenshots/01-setup.png) | ![Home](screenshots/02-home.png) | ![Coin Detail](screenshots/03-coin-detail.png) |

**Live demo (no login):**
- Home: https://satkiexe808.github.io/vault-wallet/demo.html
- Coin detail: https://satkiexe808.github.io/vault-wallet/demo-coin.html


## Supported Assets

| Chain | Native | Tokens |
|---|---|---|
| Bitcoin | BTC | — |
| Ethereum | ETH | USDT, USDC, DAI |
| BNB Chain | BNB | USDT, USDC |
| Polygon | POL | USDT, USDC |
| Avalanche | AVAX | USDT, USDC |
| Arbitrum | ARB, ETH | USDT, USDC |
| Optimism | OP, ETH | USDT, USDC |
| Base | ETH | USDT, USDC |
| TRON | TRX | USDT |
| Monero | XMR | — |
| Litecoin | LTC | — |
| Dogecoin | DOGE | — |

## Security

- Seed phrase encrypted with **AES-256-GCM** using a key derived from your password via **PBKDF2** (300,000 iterations)
- The raw seed phrase is **never stored** — only the encrypted blob lives in `localStorage`
- All keys derived locally using BIP39 / BIP44 standards
- All EVM chains use coin type 60 (compatible with MetaMask, Trust Wallet)
- Monero: private spend key and view key exportable for import into Cake Wallet, Feather, or Monero GUI

## Run in Browser

Requires any local HTTP server (the wallet uses `crypto.subtle` which needs a secure context):

```bash
# Python
python3 -m http.server 8080

# Node
npx serve .
```

Then open `http://localhost:8080` in your browser.

## Build Android APK

### Prerequisites
- [Node.js](https://nodejs.org) v18+
- [Android Studio](https://developer.android.com/studio) with Android SDK

### Steps

**1. Install dependencies**
```bash
npm install
```

**2. Generate app icons (one time)**

Open `icons/create-icons.html` in your browser. It auto-downloads `icon-192.png` and `icon-512.png`. Move both files into the `icons/` folder.

**3. Build and sync web assets**
```bash
npm run sync
```

**4. Set up Android project (first time only)**
```bash
npx cap add android
npm run sync
```

**5. Open in Android Studio**
```bash
npm run open
```

**6. Build APK**

In Android Studio: **Build → Build Bundle(s) / APK(s) → Build APK(s)**

APK output: `android/app/build/outputs/apk/debug/app-debug.apk`

Transfer the APK to your phone and install it. Enable **"Install from unknown sources"** in Android Settings → Security if prompted.

### After editing code

```bash
npm run sync   # rebuilds www/ and syncs to Android project
```

Then rebuild in Android Studio.

## Project Structure

```
vault-wallet/
├── index.html              # Main app shell
├── manifest.json           # PWA manifest
├── sw.js                   # Service worker (offline support)
├── capacitor.config.json   # Capacitor / Android config
├── build-www.js            # Script: copies app files → www/
├── css/
│   └── style.css
├── js/
│   ├── app.js              # Main app logic, coin registry, UI
│   └── coins/
│       ├── utxo.js         # Shared UTXO tx builder (BTC/LTC/DOGE)
│       ├── bitcoin.js
│       ├── litecoin.js
│       ├── dogecoin.js
│       ├── ethereum.js
│       ├── evm-chains.js   # BSC, Polygon, Avalanche, Arbitrum, Optimism, Base
│       ├── monero.js
│       └── tron.js
├── lib/
│   ├── monero-browser.js       # Webpack bundle of monero-javascript
│   └── monero_wallet_full.wasm # Monero WASM binary
├── monero_web_worker.js    # Monero web worker (must stay at root)
├── src/
│   └── monero-entry.js     # Webpack entry for Monero library
├── icons/
│   └── create-icons.html   # Open in browser to generate PNG icons
└── webpack.config.js       # Only needed to rebuild Monero library
```

## Rebuilding the Monero Library

The pre-built Monero library (`lib/monero-browser.js`) is included so you don't need to rebuild it. If you need to rebuild it:

```bash
npm install
npx webpack
```

## Compatibility

Addresses are compatible with:
- MetaMask, Trust Wallet, Rainbow — all EVM chains
- TronLink — TRX and TRC-20 tokens
- Electrum, BlueWallet — Bitcoin (P2PKH legacy addresses)
- Litecoin Core — Litecoin
- Dogecoin Core, Dogecoin wallets

Monero addresses are derived from the BIP39 seed (not a Monero 25-word seed). To import into another Monero wallet, use the **"Show keys"** button on the XMR receive tab to get your private spend key and view key, then import via "Restore from keys".
