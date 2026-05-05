// ── Wallet encryption (AES-256-GCM, PBKDF2 key derivation) ───────────────────
async function encryptMnemonic(mnemonic, password) {
  const enc = new TextEncoder();
  const keyMat = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 300000, hash: 'SHA-256' },
    keyMat, { name: 'AES-GCM', length: 256 }, false, ['encrypt']
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(mnemonic));
  const out = new Uint8Array(28 + ct.byteLength);
  out.set(salt); out.set(iv, 16); out.set(new Uint8Array(ct), 28);
  return btoa(String.fromCharCode(...out));
}

async function decryptMnemonic(encrypted, password) {
  const enc = new TextEncoder();
  const data = Uint8Array.from(atob(encrypted), c => c.charCodeAt(0));
  const salt = data.slice(0, 16), iv = data.slice(16, 28), ct = data.slice(28);
  const keyMat = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 300000, hash: 'SHA-256' },
    keyMat, { name: 'AES-GCM', length: 256 }, false, ['decrypt']
  );
  try {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
    return new TextDecoder().decode(pt);
  } catch { throw new Error('Incorrect password'); }
}

// ── Coin icon CDN ─────────────────────────────────────────────────────────────
const CDN = 'https://cdn.jsdelivr.net/npm/cryptocurrency-icons@0.18.1/svg/color';

// ── Full coin registry ────────────────────────────────────────────────────────
const COINS = [
  // ── Bitcoin ──
  {
    id: 'BTC', name: 'Bitcoin', symbol: 'BTC', category: 'Bitcoin',
    icon: `${CDN}/btc.svg`, color: '#f7931a', networkClass: 'network-btc',
    derive:  m    => BitcoinWallet.deriveAddress(m),
    balance: addr => BitcoinWallet.getBalance(addr),
    canSend: true, defaultEnabled: true,
    send: async (m, to, amt) => BitcoinWallet.sendBTC(m, to, amt),
  },

  // ── Ethereum ──
  {
    id: 'ETH', name: 'Ethereum', symbol: 'ETH', category: 'Ethereum',
    icon: `${CDN}/eth.svg`, color: '#627eea', networkClass: 'network-erc20',
    derive:  m    => EthereumWallet.deriveAddress(m),
    balance: addr => EthereumWallet.getETHBalance(addr),
    canSend: true, defaultEnabled: true,
    send: async (m, to, amt) => EthereumWallet.sendETH(await EthereumWallet.derivePrivateKey(m), to, amt),
  },
  {
    id: 'USDT_ERC20', name: 'Tether USD', symbol: 'USDT', category: 'Ethereum',
    networkLabel: 'ERC-20', icon: `${CDN}/usdt.svg`, color: '#26a17b', networkClass: 'network-erc20',
    derive:  m    => EthereumWallet.deriveAddress(m),
    balance: addr => EthereumWallet.getTokenBalance(addr, 'USDT'),
    canSend: true, defaultEnabled: true,
    send: async (m, to, amt) => EthereumWallet.sendToken(await EthereumWallet.derivePrivateKey(m), to, amt, 'USDT'),
  },
  {
    id: 'USDC_ERC20', name: 'USD Coin', symbol: 'USDC', category: 'Ethereum',
    networkLabel: 'ERC-20', icon: `${CDN}/usdc.svg`, color: '#2775ca', networkClass: 'network-erc20',
    derive:  m    => EthereumWallet.deriveAddress(m),
    balance: addr => EVMChains.getToken(addr, 'USDC_ERC20'),
    canSend: true, defaultEnabled: false,
    send: async (m, to, amt) => EVMChains.sendToken(m, 'USDC_ERC20', to, amt),
  },
  {
    id: 'DAI', name: 'Dai', symbol: 'DAI', category: 'Ethereum',
    networkLabel: 'ERC-20', icon: `${CDN}/dai.svg`, color: '#f5ac37', networkClass: 'network-erc20',
    derive:  m    => EthereumWallet.deriveAddress(m),
    balance: addr => EVMChains.getToken(addr, 'DAI'),
    canSend: true, defaultEnabled: false,
    send: async (m, to, amt) => EVMChains.sendToken(m, 'DAI', to, amt),
  },

  // ── BNB Chain ──
  {
    id: 'BNB', name: 'BNB', symbol: 'BNB', category: 'BNB Chain',
    networkLabel: 'BEP-20', icon: `${CDN}/bnb.svg`, color: '#f3ba2f', networkClass: 'network-bsc',
    derive:  m    => EthereumWallet.deriveAddress(m),
    balance: addr => EVMChains.getNative(addr, 'BSC'),
    canSend: true, defaultEnabled: false,
    send: async (m, to, amt) => EVMChains.sendNative(m, 'BSC', to, amt),
  },
  {
    id: 'USDT_BEP20', name: 'Tether USD', symbol: 'USDT', category: 'BNB Chain',
    networkLabel: 'BEP-20', icon: `${CDN}/usdt.svg`, color: '#26a17b', networkClass: 'network-bsc',
    derive:  m    => EthereumWallet.deriveAddress(m),
    balance: addr => EVMChains.getToken(addr, 'USDT_BEP20'),
    canSend: true, defaultEnabled: false,
    send: async (m, to, amt) => EVMChains.sendToken(m, 'USDT_BEP20', to, amt),
  },
  {
    id: 'USDC_BEP20', name: 'USD Coin', symbol: 'USDC', category: 'BNB Chain',
    networkLabel: 'BEP-20', icon: `${CDN}/usdc.svg`, color: '#2775ca', networkClass: 'network-bsc',
    derive:  m    => EthereumWallet.deriveAddress(m),
    balance: addr => EVMChains.getToken(addr, 'USDC_BEP20'),
    canSend: true, defaultEnabled: false,
    send: async (m, to, amt) => EVMChains.sendToken(m, 'USDC_BEP20', to, amt),
  },

  // ── Polygon ──
  {
    id: 'POL', name: 'Polygon', symbol: 'POL', category: 'Polygon',
    networkLabel: 'Polygon', icon: `${CDN}/matic.svg`, color: '#8247e5', networkClass: 'network-poly',
    derive:  m    => EthereumWallet.deriveAddress(m),
    balance: addr => EVMChains.getNative(addr, 'POLYGON'),
    canSend: true, defaultEnabled: false,
    send: async (m, to, amt) => EVMChains.sendNative(m, 'POLYGON', to, amt),
  },
  {
    id: 'USDT_POLY', name: 'Tether USD', symbol: 'USDT', category: 'Polygon',
    networkLabel: 'Polygon', icon: `${CDN}/usdt.svg`, color: '#26a17b', networkClass: 'network-poly',
    derive:  m    => EthereumWallet.deriveAddress(m),
    balance: addr => EVMChains.getToken(addr, 'USDT_POLY'),
    canSend: true, defaultEnabled: false,
    send: async (m, to, amt) => EVMChains.sendToken(m, 'USDT_POLY', to, amt),
  },
  {
    id: 'USDC_POLY', name: 'USD Coin', symbol: 'USDC', category: 'Polygon',
    networkLabel: 'Polygon', icon: `${CDN}/usdc.svg`, color: '#2775ca', networkClass: 'network-poly',
    derive:  m    => EthereumWallet.deriveAddress(m),
    balance: addr => EVMChains.getToken(addr, 'USDC_POLY'),
    canSend: true, defaultEnabled: false,
    send: async (m, to, amt) => EVMChains.sendToken(m, 'USDC_POLY', to, amt),
  },

  // ── Avalanche ──
  {
    id: 'AVAX', name: 'Avalanche', symbol: 'AVAX', category: 'Avalanche',
    networkLabel: 'C-Chain', icon: `${CDN}/avax.svg`, color: '#e84142', networkClass: 'network-avax',
    derive:  m    => EthereumWallet.deriveAddress(m),
    balance: addr => EVMChains.getNative(addr, 'AVALANCHE'),
    canSend: true, defaultEnabled: false,
    send: async (m, to, amt) => EVMChains.sendNative(m, 'AVALANCHE', to, amt),
  },
  {
    id: 'USDT_AVAX', name: 'Tether USD', symbol: 'USDT', category: 'Avalanche',
    networkLabel: 'Avalanche', icon: `${CDN}/usdt.svg`, color: '#26a17b', networkClass: 'network-avax',
    derive:  m    => EthereumWallet.deriveAddress(m),
    balance: addr => EVMChains.getToken(addr, 'USDT_AVAX'),
    canSend: true, defaultEnabled: false,
    send: async (m, to, amt) => EVMChains.sendToken(m, 'USDT_AVAX', to, amt),
  },
  {
    id: 'USDC_AVAX', name: 'USD Coin', symbol: 'USDC', category: 'Avalanche',
    networkLabel: 'Avalanche', icon: `${CDN}/usdc.svg`, color: '#2775ca', networkClass: 'network-avax',
    derive:  m    => EthereumWallet.deriveAddress(m),
    balance: addr => EVMChains.getToken(addr, 'USDC_AVAX'),
    canSend: true, defaultEnabled: false,
    send: async (m, to, amt) => EVMChains.sendToken(m, 'USDC_AVAX', to, amt),
  },

  // ── Arbitrum ──
  {
    id: 'ARB', name: 'Arbitrum', symbol: 'ARB', category: 'Arbitrum',
    networkLabel: 'Arbitrum', icon: 'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/arbitrum/assets/0x912CE59144191C1204E64559FE8253a0e49E6548/logo.png', color: '#28a0f0', networkClass: 'network-arb',
    derive:  m    => EthereumWallet.deriveAddress(m),
    balance: addr => EVMChains.getToken(addr, 'ARB'),
    canSend: true, defaultEnabled: false,
    send: async (m, to, amt) => EVMChains.sendToken(m, 'ARB', to, amt),
  },
  {
    id: 'ARB_ETH', name: 'Ethereum', symbol: 'ETH', category: 'Arbitrum',
    networkLabel: 'Arbitrum', icon: `${CDN}/eth.svg`, color: '#28a0f0', networkClass: 'network-arb',
    derive:  m    => EthereumWallet.deriveAddress(m),
    balance: addr => EVMChains.getNative(addr, 'ARBITRUM'),
    canSend: true, defaultEnabled: false,
    send: async (m, to, amt) => EVMChains.sendNative(m, 'ARBITRUM', to, amt),
  },
  {
    id: 'USDT_ARB', name: 'Tether USD', symbol: 'USDT', category: 'Arbitrum',
    networkLabel: 'Arbitrum', icon: `${CDN}/usdt.svg`, color: '#26a17b', networkClass: 'network-arb',
    derive:  m    => EthereumWallet.deriveAddress(m),
    balance: addr => EVMChains.getToken(addr, 'USDT_ARB'),
    canSend: true, defaultEnabled: false,
    send: async (m, to, amt) => EVMChains.sendToken(m, 'USDT_ARB', to, amt),
  },
  {
    id: 'USDC_ARB', name: 'USD Coin', symbol: 'USDC', category: 'Arbitrum',
    networkLabel: 'Arbitrum', icon: `${CDN}/usdc.svg`, color: '#2775ca', networkClass: 'network-arb',
    derive:  m    => EthereumWallet.deriveAddress(m),
    balance: addr => EVMChains.getToken(addr, 'USDC_ARB'),
    canSend: true, defaultEnabled: false,
    send: async (m, to, amt) => EVMChains.sendToken(m, 'USDC_ARB', to, amt),
  },

  // ── Optimism ──
  {
    id: 'OP', name: 'Optimism', symbol: 'OP', category: 'Optimism',
    networkLabel: 'Optimism', icon: 'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/optimism/assets/0x4200000000000000000000000000000000000042/logo.png', color: '#ff0420', networkClass: 'network-opt',
    derive:  m    => EthereumWallet.deriveAddress(m),
    balance: addr => EVMChains.getToken(addr, 'OP'),
    canSend: true, defaultEnabled: false,
    send: async (m, to, amt) => EVMChains.sendToken(m, 'OP', to, amt),
  },
  {
    id: 'OP_ETH', name: 'Ethereum', symbol: 'ETH', category: 'Optimism',
    networkLabel: 'Optimism', icon: `${CDN}/eth.svg`, color: '#ff0420', networkClass: 'network-opt',
    derive:  m    => EthereumWallet.deriveAddress(m),
    balance: addr => EVMChains.getNative(addr, 'OPTIMISM'),
    canSend: true, defaultEnabled: false,
    send: async (m, to, amt) => EVMChains.sendNative(m, 'OPTIMISM', to, amt),
  },
  {
    id: 'USDT_OPT', name: 'Tether USD', symbol: 'USDT', category: 'Optimism',
    networkLabel: 'Optimism', icon: `${CDN}/usdt.svg`, color: '#26a17b', networkClass: 'network-opt',
    derive:  m    => EthereumWallet.deriveAddress(m),
    balance: addr => EVMChains.getToken(addr, 'USDT_OPT'),
    canSend: true, defaultEnabled: false,
    send: async (m, to, amt) => EVMChains.sendToken(m, 'USDT_OPT', to, amt),
  },
  {
    id: 'USDC_OPT', name: 'USD Coin', symbol: 'USDC', category: 'Optimism',
    networkLabel: 'Optimism', icon: `${CDN}/usdc.svg`, color: '#2775ca', networkClass: 'network-opt',
    derive:  m    => EthereumWallet.deriveAddress(m),
    balance: addr => EVMChains.getToken(addr, 'USDC_OPT'),
    canSend: true, defaultEnabled: false,
    send: async (m, to, amt) => EVMChains.sendToken(m, 'USDC_OPT', to, amt),
  },

  // ── Base ──
  {
    id: 'BASE_ETH', name: 'Ethereum', symbol: 'ETH', category: 'Base',
    networkLabel: 'Base', icon: `${CDN}/eth.svg`, color: '#0052ff', networkClass: 'network-base',
    derive:  m    => EthereumWallet.deriveAddress(m),
    balance: addr => EVMChains.getNative(addr, 'BASE'),
    canSend: true, defaultEnabled: false,
    send: async (m, to, amt) => EVMChains.sendNative(m, 'BASE', to, amt),
  },
  {
    id: 'USDT_BASE', name: 'Tether USD', symbol: 'USDT', category: 'Base',
    networkLabel: 'Base', icon: `${CDN}/usdt.svg`, color: '#26a17b', networkClass: 'network-base',
    derive:  m    => EthereumWallet.deriveAddress(m),
    balance: addr => EVMChains.getToken(addr, 'USDT_BASE'),
    canSend: true, defaultEnabled: false,
    send: async (m, to, amt) => EVMChains.sendToken(m, 'USDT_BASE', to, amt),
  },
  {
    id: 'USDC_BASE', name: 'USD Coin', symbol: 'USDC', category: 'Base',
    networkLabel: 'Base', icon: `${CDN}/usdc.svg`, color: '#2775ca', networkClass: 'network-base',
    derive:  m    => EthereumWallet.deriveAddress(m),
    balance: addr => EVMChains.getToken(addr, 'USDC_BASE'),
    canSend: true, defaultEnabled: false,
    send: async (m, to, amt) => EVMChains.sendToken(m, 'USDC_BASE', to, amt),
  },

  // ── Monero ──
  {
    id: 'XMR', name: 'Monero', symbol: 'XMR', category: 'Monero',
    icon: `${CDN}/xmr.svg`, color: '#ff6600', networkClass: 'network-xmr',
    derive:  m    => MoneroWallet.deriveAddress(m),
    balance: async (addr, extra) => MoneroWallet.getBalance(addr, extra?.viewKey),
    extra:      async m => ({ viewKey: await MoneroWallet.deriveViewKey(m) }),
    exportKeys: async m => ({
      spendKey: await MoneroWallet.deriveSpendKeyHex(m),
      viewKey:  await MoneroWallet.deriveViewKeyHex(m),
    }),
    canSend: true, defaultEnabled: true,
    send: async (mnemonic, to, amt) => {
      const restoreHeight = parseInt(localStorage.getItem('xmr_restore_height') || '0');
      showSyncOverlay();
      try {
        return await MoneroWallet.sendXMR(mnemonic, to, amt, restoreHeight, updateSyncProgress);
      } finally {
        hideSyncOverlay();
      }
    },
  },

  // ── TRON ──
  {
    id: 'TRX', name: 'TRON', symbol: 'TRX', category: 'TRON',
    icon: `${CDN}/trx.svg`, color: '#ef4444', networkClass: 'network-trc20',
    derive:  m    => TronWallet.deriveAddress(m),
    balance: addr => TronWallet.getTRXBalance(addr),
    canSend: true, defaultEnabled: true,
    send: async (m, to, amt) => TronWallet.sendTRX(await TronWallet.derivePrivateKey(m), to, amt),
  },
  {
    id: 'USDT_TRC20', name: 'Tether USD', symbol: 'USDT', category: 'TRON',
    networkLabel: 'TRC-20', icon: `${CDN}/usdt.svg`, color: '#26a17b', networkClass: 'network-trc20',
    derive:  m    => TronWallet.deriveAddress(m),
    balance: addr => TronWallet.getUSDTBalance(addr),
    canSend: true, defaultEnabled: true,
    send: async (m, to, amt) => TronWallet.sendUSDT(await TronWallet.derivePrivateKey(m), to, amt),
  },

  // ── Litecoin ──
  {
    id: 'LTC', name: 'Litecoin', symbol: 'LTC', category: 'Litecoin',
    icon: `${CDN}/ltc.svg`, color: '#a6a9aa', networkClass: 'network-ltc',
    derive:  m    => LitecoinWallet.deriveAddress(m),
    balance: addr => LitecoinWallet.getBalance(addr),
    canSend: true, defaultEnabled: false,
    send: async (m, to, amt) => LitecoinWallet.sendLTC(m, to, amt),
  },

  // ── Dogecoin ──
  {
    id: 'DOGE', name: 'Dogecoin', symbol: 'DOGE', category: 'Dogecoin',
    icon: `${CDN}/doge.svg`, color: '#c2a633', networkClass: 'network-doge',
    derive:  m    => DogecoinWallet.deriveAddress(m),
    balance: addr => DogecoinWallet.getBalance(addr),
    canSend: true, defaultEnabled: false,
    send: async (m, to, amt) => DogecoinWallet.sendDOGE(m, to, amt),
  },
];

// ── Enabled coins (persisted) ─────────────────────────────────────────────────
const DEFAULT_ENABLED = new Set(COINS.filter(c => c.defaultEnabled).map(c => c.id));

function loadEnabledCoins() {
  try {
    const raw = localStorage.getItem('enabled_coins');
    if (raw) return new Set(JSON.parse(raw));
  } catch {}
  return new Set(DEFAULT_ENABLED);
}

function saveEnabledCoins() {
  localStorage.setItem('enabled_coins', JSON.stringify([...enabledCoins]));
}

let enabledCoins = loadEnabledCoins();
function getActiveCoins() { return COINS.filter(c => enabledCoins.has(c.id)); }

// ── App state ─────────────────────────────────────────────────────────────────
const state = {
  mnemonic: null,
  addresses: {},
  balances: {},
  extras: {},
  active: 'BTC',
};

// ── Setup ─────────────────────────────────────────────────────────────────────
function showSetup() {
  const box = document.getElementById('setup-box');
  box.innerHTML = `
    <h1>Crypto Wallet</h1>
    <p>A self-custodial wallet for BTC, ETH, XMR, TRX and more.</p>
    <div style="display:flex;flex-direction:column;gap:12px;margin-top:8px">
      <button class="btn btn-primary" id="btn-new" style="padding:14px">Create New Wallet</button>
      <button class="btn btn-outline" id="btn-import" style="padding:14px">Import Existing Wallet</button>
    </div>`;
  document.getElementById('btn-new').onclick = showNewWallet;
  document.getElementById('btn-import').onclick = showImport;
}

function showNewWallet() {
  const phrase = ethers.Wallet.createRandom().mnemonic.phrase;
  const words = phrase.split(' ');
  const box = document.getElementById('setup-box');
  box.innerHTML = `
    <h1>Your Recovery Phrase</h1>
    <p>Write these 12 words down and keep them safe. They are the only way to recover your wallet.</p>
    <div class="warning-box">⚠ Never share your seed phrase with anyone.</div>
    <div class="seed-display">
      ${words.map((w, i) => `<div class="seed-word"><span>${i + 1}</span>${w}</div>`).join('')}
    </div>
    <label style="display:flex;align-items:center;gap:10px;font-size:13px;margin:16px 0;cursor:pointer">
      <input type="checkbox" id="chk-backup"> I have written down my recovery phrase
    </label>
    <button class="btn btn-primary" id="btn-continue" style="width:100%;padding:14px" disabled>Continue</button>
    <button class="btn btn-outline btn-sm" id="btn-back" style="width:100%;margin-top:10px">Back</button>`;
  document.getElementById('chk-backup').onchange = e =>
    document.getElementById('btn-continue').disabled = !e.target.checked;
  document.getElementById('btn-continue').onclick = async () => {
    const btn = document.getElementById('btn-continue');
    btn.disabled = true; btn.textContent = 'Fetching block height…';
    const height = await MoneroWallet.getCurrentHeight();
    showPasswordStep(phrase, height);
  };
  document.getElementById('btn-back').onclick = showSetup;
}

function showPasswordStep(mnemonic, restoreHeight) {
  const box = document.getElementById('setup-box');
  box.innerHTML = `
    <h1>Set a Password</h1>
    <p>This password encrypts your wallet on this device. You will need it every time you unlock.</p>
    <div class="form-group">
      <label>Password</label>
      <input type="password" id="pwd1" placeholder="Minimum 8 characters" autocomplete="new-password">
    </div>
    <div class="form-group">
      <label>Confirm Password</label>
      <input type="password" id="pwd2" placeholder="Repeat password" autocomplete="new-password">
    </div>
    <p id="pwd-err" class="text-red text-sm" style="display:none;margin-bottom:12px"></p>
    <button class="btn btn-primary" id="btn-create-final" style="width:100%;padding:14px">Create Wallet</button>`;
  document.getElementById('btn-create-final').onclick = async () => {
    const p1 = document.getElementById('pwd1').value;
    const p2 = document.getElementById('pwd2').value;
    const err = document.getElementById('pwd-err');
    if (p1.length < 8) { err.textContent = 'Password must be at least 8 characters.'; err.style.display = 'block'; return; }
    if (p1 !== p2) { err.textContent = 'Passwords do not match.'; err.style.display = 'block'; return; }
    err.style.display = 'none';
    await completeSetup(mnemonic, restoreHeight, p1);
  };
}

function showImport() {
  const box = document.getElementById('setup-box');
  box.innerHTML = `
    <h1>Import Wallet</h1>
    <p>Enter your 12 or 24-word BIP39 recovery phrase.</p>
    <div class="form-group">
      <label>Recovery Phrase</label>
      <textarea id="import-phrase" rows="4" style="width:100%;background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:12px;color:var(--text);font-size:14px;resize:none;outline:none;font-family:monospace" placeholder="word1 word2 word3 …" spellcheck="false"></textarea>
    </div>
    <div class="form-group">
      <label>Monero Restore Height <span style="color:var(--text2);font-weight:400">(leave 0 to scan all blocks)</span></label>
      <input type="number" id="import-height" placeholder="0" min="0">
    </div>
    <div class="form-group">
      <label>Password</label>
      <input type="password" id="import-pwd1" placeholder="Minimum 8 characters" autocomplete="new-password">
    </div>
    <div class="form-group">
      <label>Confirm Password</label>
      <input type="password" id="import-pwd2" placeholder="Repeat password" autocomplete="new-password">
    </div>
    <p id="phrase-err" class="text-red text-sm" style="display:none;margin-bottom:12px"></p>
    <button class="btn btn-primary" id="btn-import-ok" style="width:100%;padding:14px">Import Wallet</button>
    <button class="btn btn-outline btn-sm" id="btn-back" style="width:100%;margin-top:10px">Back</button>`;
  document.getElementById('btn-import-ok').onclick = async () => {
    const phrase = document.getElementById('import-phrase').value.trim().replace(/\s+/g, ' ');
    const p1 = document.getElementById('import-pwd1').value;
    const p2 = document.getElementById('import-pwd2').value;
    const err = document.getElementById('phrase-err');
    if (!ethers.Mnemonic.isValidMnemonic(phrase)) { err.textContent = 'Invalid recovery phrase — please check your words.'; err.style.display = 'block'; return; }
    if (p1.length < 8) { err.textContent = 'Password must be at least 8 characters.'; err.style.display = 'block'; return; }
    if (p1 !== p2) { err.textContent = 'Passwords do not match.'; err.style.display = 'block'; return; }
    err.style.display = 'none';
    const h = document.getElementById('import-height').value.trim();
    await completeSetup(phrase, h ? parseInt(h) : 0, p1);
  };
  document.getElementById('btn-back').onclick = showSetup;
}

async function completeSetup(mnemonic, restoreHeight, password) {
  const box = document.getElementById('setup-box');
  box.innerHTML = `<h1>Setting up…</h1><p style="color:var(--text2);margin-top:8px">Encrypting wallet and deriving addresses…</p>`;
  try {
    const encrypted = await encryptMnemonic(mnemonic, password);
    localStorage.setItem('wallet_encrypted', encrypted);
    localStorage.setItem('xmr_restore_height', String(restoreHeight ?? 0));
    localStorage.removeItem('wallet_mnemonic'); // remove legacy plaintext if any
    state.mnemonic = mnemonic;
    await loadWallet();
  } catch(e) {
    box.innerHTML = `<h1>Error</h1><p style="color:var(--red);margin-top:8px">${e.message}</p><button class="btn btn-outline" onclick="showSetup()" style="margin-top:16px;width:100%">Back</button>`;
  }
}

function showUnlock() {
  const box = document.getElementById('setup-box');
  box.innerHTML = `
    <h1>Unlock Wallet</h1>
    <p>Enter your password to access your wallet.</p>
    <div class="form-group" style="margin-top:8px">
      <label>Password</label>
      <input type="password" id="unlock-pwd" placeholder="Enter password" autocomplete="current-password">
    </div>
    <p id="unlock-err" class="text-red text-sm" style="display:none;margin-bottom:12px">Incorrect password. Try again.</p>
    <button class="btn btn-primary" id="btn-unlock" style="width:100%;padding:14px">Unlock</button>
    <button class="btn btn-outline btn-sm" id="btn-forgot" style="width:100%;margin-top:10px">Forgot password / Remove wallet</button>`;
  const doUnlock = async () => {
    const pwd = document.getElementById('unlock-pwd').value;
    const btn = document.getElementById('btn-unlock');
    const err = document.getElementById('unlock-err');
    btn.disabled = true; btn.textContent = 'Unlocking…';
    try {
      const mnemonic = await decryptMnemonic(localStorage.getItem('wallet_encrypted'), pwd);
      state.mnemonic = mnemonic;
      await loadWallet();
    } catch {
      err.style.display = 'block';
      btn.disabled = false; btn.textContent = 'Unlock';
    }
  };
  document.getElementById('unlock-pwd').addEventListener('keydown', e => { if (e.key === 'Enter') doUnlock(); });
  document.getElementById('btn-unlock').onclick = doUnlock;
  document.getElementById('btn-forgot').onclick = () => {
    if (confirm('Remove wallet from this device? Make absolutely sure you have your recovery phrase backed up.')) {
      localStorage.clear(); location.reload();
    }
  };
}

function showMigratePassword(mnemonic) {
  const box = document.getElementById('setup-box');
  box.innerHTML = `
    <h1>Secure Your Wallet</h1>
    <p>Your wallet needs to be encrypted with a password. This only happens once.</p>
    <div class="form-group" style="margin-top:8px">
      <label>Password</label>
      <input type="password" id="mpwd1" placeholder="Minimum 8 characters" autocomplete="new-password">
    </div>
    <div class="form-group">
      <label>Confirm Password</label>
      <input type="password" id="mpwd2" placeholder="Repeat password" autocomplete="new-password">
    </div>
    <p id="mpwd-err" class="text-red text-sm" style="display:none;margin-bottom:12px"></p>
    <button class="btn btn-primary" id="btn-migrate" style="width:100%;padding:14px">Encrypt & Continue</button>`;
  document.getElementById('btn-migrate').onclick = async () => {
    const p1 = document.getElementById('mpwd1').value;
    const p2 = document.getElementById('mpwd2').value;
    const err = document.getElementById('mpwd-err');
    if (p1.length < 8) { err.textContent = 'Password must be at least 8 characters.'; err.style.display = 'block'; return; }
    if (p1 !== p2) { err.textContent = 'Passwords do not match.'; err.style.display = 'block'; return; }
    err.style.display = 'none';
    const h = parseInt(localStorage.getItem('xmr_restore_height') || '0');
    await completeSetup(mnemonic, h, p1);
  };
}

// ── Wallet load ───────────────────────────────────────────────────────────────
async function loadWallet() {
  // Derive addresses only for enabled coins (lazy-derive others on first enable)
  await Promise.all(getActiveCoins().map(async coin => {
    try {
      state.addresses[coin.id] = await coin.derive(state.mnemonic);
      if (coin.extra) state.extras[coin.id] = await coin.extra(state.mnemonic);
    } catch(e) { console.error(`Derive ${coin.id}:`, e); }
  }));

  document.getElementById('setup-screen').style.display = 'none';
  document.getElementById('sidebar').style.display = 'flex';
  document.getElementById('main').style.display = 'flex';

  renderCoinList();
  const first = getActiveCoins()[0];
  if (first) selectCoin(first.id);
  refreshBalances();
}

// ── Balance refresh ───────────────────────────────────────────────────────────
async function refreshBalances() {
  await Promise.all(getActiveCoins().map(async coin => {
    const addr = state.addresses[coin.id];
    if (!addr) return;
    try {
      state.balances[coin.id] = await coin.balance(addr, state.extras[coin.id]);
    } catch { state.balances[coin.id] = '—'; }
    updateSidebarBal(coin.id);
    if (state.active === coin.id) updateBalCard();
  }));
}

// ── Render helpers ────────────────────────────────────────────────────────────
function renderCoinList() {
  const active = getActiveCoins();
  const categories = [...new Set(active.map(c => c.category))];
  let html = '';
  for (const cat of categories) {
    html += `<div class="coin-category">${cat}</div>`;
    html += active.filter(c => c.category === cat).map(coin => `
      <div class="coin-item ${coin.id === state.active ? 'active' : ''}" id="ci-${coin.id}" onclick="selectCoin('${coin.id}')">
        <div class="coin-icon">
          <img src="${coin.icon}" alt="${coin.symbol}" width="32" height="32" onerror="this.style.display='none'">
        </div>
        <div class="coin-info">
          <div class="coin-name">${coin.name}${coin.networkLabel
            ? ` <span class="network-badge ${coin.networkClass}">${coin.networkLabel}</span>` : ''}</div>
          <div class="coin-bal" id="sb-${coin.id}">${state.balances[coin.id] ?? '…'} ${coin.symbol}</div>
        </div>
      </div>`).join('');
  }
  document.getElementById('coin-list').innerHTML = html;
}

function updateSidebarBal(id) {
  const el = document.getElementById(`sb-${id}`);
  const coin = COINS.find(c => c.id === id);
  if (el && coin) el.textContent = `${state.balances[id] ?? '…'} ${coin.symbol}`;
}

function selectCoin(id) {
  state.active = id;
  document.querySelectorAll('.coin-item').forEach(el => el.classList.remove('active'));
  document.getElementById(`ci-${id}`)?.classList.add('active');

  const coin = COINS.find(c => c.id === id);
  document.getElementById('coin-title').textContent =
    coin.name + (coin.networkLabel ? ` (${coin.networkLabel})` : '');

  updateBalCard();
  updateReceiveTab();
  updateSendTab();
}

function updateBalCard() {
  const coin = COINS.find(c => c.id === state.active);
  document.getElementById('bal-icon').innerHTML =
    `<img src="${coin.icon}" alt="${coin.symbol}" width="22" height="22" style="border-radius:50%;vertical-align:middle">`;
  document.getElementById('bal-symbol').textContent = coin.symbol;
  const net = document.getElementById('bal-network');
  if (coin.networkLabel) {
    net.textContent = coin.networkLabel;
    net.className = `network-badge ${coin.networkClass}`;
    net.style.display = '';
  } else {
    net.style.display = 'none';
  }
  document.getElementById('bal-amount').textContent =
    `${state.balances[state.active] ?? '…'} ${coin.symbol}`;
}

function updateReceiveTab() {
  const addr = state.addresses[state.active] ?? '—';
  document.getElementById('address-display').textContent = addr;
  const out = document.getElementById('qr-output');
  out.innerHTML = '';
  if (addr !== '—' && typeof QRCode !== 'undefined') {
    new QRCode(out, { text: addr, width: 180, height: 180,
      colorDark: '#e2e8f0', colorLight: '#1a1d27', correctLevel: QRCode.CorrectLevel.M });
  }

  // Remove any existing keys export section
  document.getElementById('xmr-keys-section')?.remove();

  const coin = COINS.find(c => c.id === state.active);
  if (coin?.exportKeys && state.mnemonic) {
    const section = document.createElement('div');
    section.id = 'xmr-keys-section';
    section.style.cssText = 'margin-top:16px';
    section.innerHTML = `
      <button class="btn btn-outline btn-sm" id="xmr-keys-toggle" style="width:100%">
        Show keys for other Monero wallets
      </button>
      <div id="xmr-keys-content" style="display:none;margin-top:12px">
        <div class="warning-box" style="margin-bottom:12px;font-size:12px">
          ⚠ Keep these private. Use them to import into Cake Wallet, Feather, or Monero GUI via "Restore from private key".
        </div>
        <div style="font-size:12px;color:var(--text2);margin-bottom:4px">Private Spend Key</div>
        <div class="address-box" style="margin-top:0;margin-bottom:10px">
          <code id="xmr-spend-key" style="font-size:11px">Loading…</code>
          <button class="btn btn-outline btn-sm" onclick="copyXmrKey('xmr-spend-key')">Copy</button>
        </div>
        <div style="font-size:12px;color:var(--text2);margin-bottom:4px">Private View Key</div>
        <div class="address-box" style="margin-top:0">
          <code id="xmr-view-key" style="font-size:11px">Loading…</code>
          <button class="btn btn-outline btn-sm" onclick="copyXmrKey('xmr-view-key')">Copy</button>
        </div>
      </div>`;
    document.getElementById('tab-receive').appendChild(section);

    document.getElementById('xmr-keys-toggle').onclick = async () => {
      const content = document.getElementById('xmr-keys-content');
      const btn = document.getElementById('xmr-keys-toggle');
      if (content.style.display === 'none') {
        content.style.display = 'block';
        btn.textContent = 'Hide keys';
        if (document.getElementById('xmr-spend-key').textContent === 'Loading…') {
          const keys = await coin.exportKeys(state.mnemonic);
          document.getElementById('xmr-spend-key').textContent = keys.spendKey;
          document.getElementById('xmr-view-key').textContent  = keys.viewKey;
        }
      } else {
        content.style.display = 'none';
        btn.textContent = 'Show keys for other Monero wallets';
      }
    };
  }
}

function copyXmrKey(elId) {
  const text = document.getElementById(elId)?.textContent;
  if (text) navigator.clipboard.writeText(text).then(() => toast('Key copied!'));
}

function updateSendTab() {
  const coin = COINS.find(c => c.id === state.active);
  document.getElementById('send-unavailable').style.display = coin.canSend ? 'none' : 'block';
  document.getElementById('send-form').style.display = coin.canSend ? 'block' : 'none';
  if (coin.canSend) {
    document.getElementById('send-symbol').textContent = coin.symbol;
    document.getElementById('send-to').value = '';
    document.getElementById('send-amount').value = '';
  }
}

// ── Tab switching ─────────────────────────────────────────────────────────────
document.addEventListener('click', e => {
  const tab = e.target.closest('.tab');
  if (!tab || !tab.dataset.tab) return;
  const id = tab.dataset.tab;
  tab.closest('.tabs').querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === id));
  document.getElementById('tab-receive').classList.toggle('active', id === 'receive');
  document.getElementById('tab-send').classList.toggle('active', id === 'send');
});

document.getElementById('receive-tab-btn').onclick = () => {
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === 'receive'));
  document.getElementById('tab-receive').classList.add('active');
  document.getElementById('tab-send').classList.remove('active');
};

document.getElementById('send-tab-btn').onclick = () => {
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === 'send'));
  document.getElementById('tab-send').classList.add('active');
  document.getElementById('tab-receive').classList.remove('active');
};

// ── Send ──────────────────────────────────────────────────────────────────────
document.getElementById('do-send-btn').onclick = async () => {
  const coin = COINS.find(c => c.id === state.active);
  const to  = document.getElementById('send-to').value.trim();
  const amt = document.getElementById('send-amount').value.trim();
  if (!to || !amt || parseFloat(amt) <= 0) { toast('Enter a valid address and amount.'); return; }
  const btn = document.getElementById('do-send-btn');
  btn.disabled = true; btn.textContent = 'Sending…';
  try {
    const txid = await coin.send(state.mnemonic, to, amt);
    toast(`Sent! TX: ${String(txid).slice(0, 20)}…`);
    document.getElementById('send-to').value = '';
    document.getElementById('send-amount').value = '';
    setTimeout(refreshBalances, 4000);
  } catch(e) {
    toast(`Error: ${e.message || 'Transaction failed.'}`);
  } finally {
    btn.disabled = false; btn.textContent = 'Send';
  }
};

// ── Copy address ──────────────────────────────────────────────────────────────
document.getElementById('copy-btn').onclick = () => {
  const addr = state.addresses[state.active];
  if (!addr) return;
  navigator.clipboard.writeText(addr).then(() => toast('Address copied!'));
};

// ── Refresh ───────────────────────────────────────────────────────────────────
document.getElementById('refresh-btn').onclick = async () => {
  const btn = document.getElementById('refresh-btn');
  btn.disabled = true; btn.textContent = '↻ Loading…';
  await refreshBalances();
  btn.disabled = false; btn.textContent = '↻ Refresh';
  toast('Balances updated.');
};

// ── Lock ──────────────────────────────────────────────────────────────────────
document.getElementById('lock-btn').onclick = () => {
  if (!confirm('Lock wallet? Your encrypted wallet stays on this device. Enter your password to unlock again.')) return;
  state.mnemonic = null;
  Object.assign(state, { addresses: {}, balances: {}, extras: {}, active: 'BTC' });
  document.getElementById('sidebar').style.display = 'none';
  document.getElementById('main').style.display = 'none';
  document.getElementById('setup-screen').style.display = 'flex';
  showUnlock();
};

// ── XMR sync overlay ─────────────────────────────────────────────────────────
function showSyncOverlay() {
  document.getElementById('sync-overlay').style.display = 'flex';
  updateSyncProgress(0);
}
function hideSyncOverlay() {
  document.getElementById('sync-overlay').style.display = 'none';
}
function updateSyncProgress(pct) {
  document.getElementById('sync-pct').textContent = pct + '%';
  document.getElementById('sync-bar-fill').style.width = pct + '%';
  document.getElementById('sync-label').textContent =
    pct < 100 ? `Syncing Monero wallet… ${pct}%` : 'Sending transaction…';
}

// ── Settings overlay ─────────────────────────────────────────────────────────
document.getElementById('settings-btn').onclick = () => {
  if (!state.mnemonic) return;
  renderSettingsList();
  document.getElementById('settings-overlay').style.display = 'flex';
};

document.getElementById('settings-close-btn').onclick = closeSettings;
document.getElementById('settings-overlay').addEventListener('click', e => {
  if (e.target === document.getElementById('settings-overlay')) closeSettings();
});

function closeSettings() {
  document.getElementById('settings-overlay').style.display = 'none';
}

function renderSettingsList() {
  const categories = [...new Set(COINS.map(c => c.category))];
  let html = '';
  for (const cat of categories) {
    const group = COINS.filter(c => c.category === cat);
    html += `<div class="coin-category" style="padding:16px 0 6px">${cat}</div>`;
    html += group.map(coin => {
      const on = enabledCoins.has(coin.id);
      return `
        <div class="settings-row">
          <div style="display:flex;align-items:center;gap:10px">
            <img src="${coin.icon}" alt="${coin.symbol}" width="28" height="28"
              style="border-radius:50%;flex-shrink:0" onerror="this.style.display='none'">
            <div>
              <div style="font-size:14px;font-weight:600">${coin.name}
                ${coin.networkLabel
                  ? `<span class="network-badge ${coin.networkClass}" style="margin-left:4px">${coin.networkLabel}</span>`
                  : ''}</div>
              <div style="font-size:12px;color:var(--text2)">${coin.symbol}</div>
            </div>
          </div>
          <label class="toggle-switch">
            <input type="checkbox" ${on ? 'checked' : ''} data-coin-id="${coin.id}" onchange="handleCoinToggle(this)">
            <span class="toggle-track"></span>
          </label>
        </div>`;
    }).join('');
  }
  html += `<div style="margin-top:24px;padding-top:16px;border-top:1px solid var(--border)">
  <button class="btn btn-danger" onclick="confirmResetWallet()" style="width:100%;font-size:13px">Remove Wallet from this Device</button>
</div>`;
  document.getElementById('settings-coin-list').innerHTML = html;
}

function confirmResetWallet() {
  if (confirm('Permanently remove this wallet from the device? Make absolutely sure your recovery phrase is backed up.')) {
    localStorage.clear(); location.reload();
  }
}

function handleCoinToggle(checkbox) {
  const id = checkbox.dataset.coinId;
  if (!checkbox.checked) {
    if (enabledCoins.size <= 1) {
      checkbox.checked = true;
      toast('At least one asset must be enabled.');
      return;
    }
    enabledCoins.delete(id);
    if (state.active === id) {
      const next = getActiveCoins()[0];
      if (next) selectCoin(next.id);
    }
    saveEnabledCoins();
    renderCoinList();
    return;
  }

  enabledCoins.add(id);
  saveEnabledCoins();

  // Lazy-derive address for newly enabled coin
  const coin = COINS.find(c => c.id === id);
  if (!state.addresses[id] && state.mnemonic) {
    coin.derive(state.mnemonic).then(async addr => {
      state.addresses[id] = addr;
      if (coin.extra) state.extras[id] = await coin.extra(state.mnemonic).catch(() => null);
      renderCoinList();
      coin.balance(addr, state.extras[id]).then(bal => {
        state.balances[id] = bal;
        updateSidebarBal(id);
      }).catch(() => {});
    }).catch(() => {});
  } else {
    renderCoinList();
  }
}

// ── Toast ─────────────────────────────────────────────────────────────────────
let _toastTimer;
function toast(msg, ms = 3000) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────
(async () => {
  const legacy = localStorage.getItem('wallet_mnemonic');
  if (legacy) { showMigratePassword(legacy); return; }
  const encrypted = localStorage.getItem('wallet_encrypted');
  if (encrypted) { showUnlock(); } else { showSetup(); }
})();
