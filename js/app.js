// HTML-escape helper for any string sourced from external APIs (tx error
// messages, explorer URLs, etc.) before it lands inside an innerHTML string.
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => (
    { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]
  ));
}

// Custom confirm dialog — drop-in replacement for the browser-native
// confirm(), which on Android/iOS WebViews renders as an OS pop-up that
// clashes with the wallet's dark theme. Pass a `lines` array of
// [label, value] tuples (or [label, value, { code: true }] for monospace
// values like addresses) to render a structured key/value summary.
// Returns Promise<boolean>.
function confirmModal({ title = 'Confirm', lines = [], confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = false } = {}) {
  return new Promise(resolve => {
    const root = document.createElement('div');
    root.className = 'modal-backdrop';
    const linesHtml = lines.map(([label, value, opts = {}]) => `
      <div class="confirm-row">
        <span class="confirm-label">${escapeHtml(label)}</span>
        <span class="confirm-value${opts.code ? ' confirm-value-code' : ''}">${escapeHtml(String(value))}</span>
      </div>
    `).join('');
    root.innerHTML = `<div class="modal">
      <h2>${escapeHtml(title)}</h2>
      <div class="confirm-rows">${linesHtml}</div>
      <div class="modal-actions">
        <button class="btn btn-outline" id="cm-cancel">${escapeHtml(cancelLabel)}</button>
        <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" id="cm-ok">${escapeHtml(confirmLabel)}</button>
      </div>
    </div>`;
    document.body.appendChild(root);
    const close = (val) => { root.remove(); resolve(val); };
    root.querySelector('#cm-ok').onclick = () => close(true);
    root.querySelector('#cm-cancel').onclick = () => close(false);
    root.addEventListener('click', e => { if (e.target === root) close(false); });
  });
}
window.confirmModal = confirmModal;

// ── Wallet encryption (AES-256-GCM, PBKDF2 key derivation) ───────────────────
//
// Format v1 (legacy): salt(16) | iv(12) | ciphertext, 300k PBKDF2 iterations.
//   Identified by the absence of the v2 magic prefix.
// Format v2 (current): magic(4) | iter(4 BE) | salt(16) | iv(12) | ciphertext.
//   Magic = 0xFE 0xED 0xC0 0xDE. 600k PBKDF2 iterations (matches OWASP's
//   2024+ guidance for SHA-256). Self-describing — no localStorage version
//   key needed, so an interrupted upgrade can never desync metadata vs blob.
//
// Existing v1 wallets keep decrypting via the legacy path and get
// opportunistically re-encrypted as v2 on the next successful unlock.
const PBKDF2_ITERATIONS = 600_000;
const V2_MAGIC = new Uint8Array([0xFE, 0xED, 0xC0, 0xDE]);

function _hasV2Magic(data) {
  return data.length >= 36 &&
    data[0] === V2_MAGIC[0] && data[1] === V2_MAGIC[1] &&
    data[2] === V2_MAGIC[2] && data[3] === V2_MAGIC[3];
}

async function encryptMnemonic(mnemonic, password) {
  const enc = new TextEncoder();
  const keyMat = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iterations = PBKDF2_ITERATIONS;
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    keyMat, { name: 'AES-GCM', length: 256 }, false, ['encrypt']
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(mnemonic));
  const out = new Uint8Array(4 + 4 + 16 + 12 + ct.byteLength);
  out.set(V2_MAGIC, 0);
  new DataView(out.buffer).setUint32(4, iterations, false);
  out.set(salt, 8);
  out.set(iv, 24);
  out.set(new Uint8Array(ct), 36);
  return btoa(String.fromCharCode(...out));
}

async function decryptMnemonic(encrypted, password) {
  const enc = new TextEncoder();
  const data = Uint8Array.from(atob(encrypted), c => c.charCodeAt(0));
  let iterations, salt, iv, ct;
  if (_hasV2Magic(data)) {
    iterations = new DataView(data.buffer, data.byteOffset + 4, 4).getUint32(0, false);
    salt = data.slice(8, 24);
    iv = data.slice(24, 36);
    ct = data.slice(36);
  } else {
    iterations = 300_000;
    salt = data.slice(0, 16);
    iv = data.slice(16, 28);
    ct = data.slice(28);
  }
  const keyMat = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    keyMat, { name: 'AES-GCM', length: 256 }, false, ['decrypt']
  );
  try {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
    return new TextDecoder().decode(pt);
  } catch { throw new Error('Incorrect password'); }
}

// Re-encrypt a legacy v1 blob with v2 parameters after a successful unlock.
// Idempotent — bails out if already v2.
async function maybeUpgradeEncryption(mnemonic, password) {
  const existing = localStorage.getItem('wallet_encrypted');
  if (!existing) return;
  const data = Uint8Array.from(atob(existing), c => c.charCodeAt(0));
  if (_hasV2Magic(data)) return;
  try {
    const upgraded = await encryptMnemonic(mnemonic, password);
    // Verify round-trip before overwriting the working blob.
    const roundTrip = await decryptMnemonic(upgraded, password);
    if (roundTrip !== mnemonic) throw new Error('round-trip mismatch');
    localStorage.setItem('wallet_encrypted', upgraded);
  } catch (e) {
    // Don't block unlock on a failed upgrade — the v1 blob still works.
    console.warn('Encryption upgrade failed:', e);
  }
}

// ── Coin icon CDN ─────────────────────────────────────────────────────────────
const CDN = 'https://cdn.jsdelivr.net/npm/cryptocurrency-icons@0.18.1/svg/color';

// ── Full coin registry ────────────────────────────────────────────────────────
const COINS = [
  // ── Bitcoin ──
  {
    id: 'BTC', name: 'Bitcoin', symbol: 'BTC', category: 'Bitcoin',
    icon: `${CDN}/btc.svg`, color: '#f7931a', networkLabel: 'Native SegWit', networkClass: 'network-btc',
    derive:  m    => BitcoinWallet.deriveAddress(m),
    balance: addr => BitcoinWallet.getBalance(addr),
    canSend: true, defaultEnabled: true,
    send: async (m, to, amt) => BitcoinWallet.sendBTC(m, to, amt),
    history: addr => BitcoinWallet.getHistory(addr),
    explorerAddr: addr => `https://mempool.space/address/${addr}`,
  },

  // ── Ethereum ──
  {
    id: 'ETH', name: 'Ethereum', symbol: 'ETH', category: 'Ethereum',
    icon: `${CDN}/eth.svg`, color: '#627eea', networkLabel: 'Mainnet', networkClass: 'network-erc20',
    derive:  m    => EthereumWallet.deriveAddress(m),
    balance: addr => EthereumWallet.getETHBalance(addr),
    canSend: true, defaultEnabled: true,
    send: async (m, to, amt) => EthereumWallet.sendETH(await EthereumWallet.derivePrivateKey(m), to, amt),
    history: addr => fetchEvmHistory(addr, 'ETH'),
    explorerAddr: addr => `https://etherscan.io/address/${addr}`,
  },
  {
    id: 'USDT_ERC20', name: 'Tether USD', symbol: 'USDT', category: 'Ethereum',
    networkLabel: 'ERC-20', icon: `${CDN}/usdt.svg`, color: '#26a17b', networkClass: 'network-erc20',
    derive:  m    => EthereumWallet.deriveAddress(m),
    balance: addr => EthereumWallet.getTokenBalance(addr, 'USDT'),
    canSend: true, defaultEnabled: true,
    send: async (m, to, amt) => EthereumWallet.sendToken(await EthereumWallet.derivePrivateKey(m), to, amt, 'USDT'),
    history: addr => fetchEvmHistory(addr, 'ETH', '0xdAC17F958D2ee523a2206206994597C13D831ec7', 6),
    explorerAddr: addr => `https://etherscan.io/address/${addr}`,
  },
  {
    id: 'USDC_ERC20', name: 'USD Coin', symbol: 'USDC', category: 'Ethereum',
    networkLabel: 'ERC-20', icon: `${CDN}/usdc.svg`, color: '#2775ca', networkClass: 'network-erc20',
    derive:  m    => EthereumWallet.deriveAddress(m),
    balance: addr => EVMChains.getToken(addr, 'USDC_ERC20'),
    canSend: true, defaultEnabled: false,
    send: async (m, to, amt) => EVMChains.sendToken(m, 'USDC_ERC20', to, amt),
    history: addr => fetchEvmHistory(addr, 'ETH', '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', 6),
    explorerAddr: addr => `https://etherscan.io/address/${addr}`,
  },
  {
    id: 'DAI', name: 'Dai', symbol: 'DAI', category: 'Ethereum',
    networkLabel: 'ERC-20', icon: `${CDN}/dai.svg`, color: '#f5ac37', networkClass: 'network-erc20',
    derive:  m    => EthereumWallet.deriveAddress(m),
    balance: addr => EVMChains.getToken(addr, 'DAI'),
    canSend: true, defaultEnabled: false,
    send: async (m, to, amt) => EVMChains.sendToken(m, 'DAI', to, amt),
    history: addr => fetchEvmHistory(addr, 'ETH', '0x6B175474E89094C44Da98b954EedeAC495271d0F', 18),
    explorerAddr: addr => `https://etherscan.io/address/${addr}`,
  },

  // ── BNB Chain ──
  {
    id: 'BNB', name: 'BNB', symbol: 'BNB', category: 'BNB Chain',
    networkLabel: 'BEP-20', icon: `${CDN}/bnb.svg`, color: '#f3ba2f', networkClass: 'network-bsc',
    derive:  m    => EthereumWallet.deriveAddress(m),
    balance: addr => EVMChains.getNative(addr, 'BSC'),
    canSend: true, defaultEnabled: false,
    send: async (m, to, amt) => EVMChains.sendNative(m, 'BSC', to, amt),
    history: addr => fetchEvmHistory(addr, 'BSC'),
    explorerAddr: addr => `https://bscscan.com/address/${addr}`,
  },
  {
    id: 'USDT_BEP20', name: 'Tether USD', symbol: 'USDT', category: 'BNB Chain',
    networkLabel: 'BEP-20', icon: `${CDN}/usdt.svg`, color: '#26a17b', networkClass: 'network-bsc',
    derive:  m    => EthereumWallet.deriveAddress(m),
    balance: addr => EVMChains.getToken(addr, 'USDT_BEP20'),
    canSend: true, defaultEnabled: false,
    send: async (m, to, amt) => EVMChains.sendToken(m, 'USDT_BEP20', to, amt),
    history: addr => fetchEvmHistory(addr, 'BSC', '0x55d398326f99059fF775485246999027B3197955', 18),
    explorerAddr: addr => `https://bscscan.com/address/${addr}`,
  },
  {
    id: 'USDC_BEP20', name: 'USD Coin', symbol: 'USDC', category: 'BNB Chain',
    networkLabel: 'BEP-20', icon: `${CDN}/usdc.svg`, color: '#2775ca', networkClass: 'network-bsc',
    derive:  m    => EthereumWallet.deriveAddress(m),
    balance: addr => EVMChains.getToken(addr, 'USDC_BEP20'),
    canSend: true, defaultEnabled: false,
    send: async (m, to, amt) => EVMChains.sendToken(m, 'USDC_BEP20', to, amt),
    history: addr => fetchEvmHistory(addr, 'BSC', '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', 18),
    explorerAddr: addr => `https://bscscan.com/address/${addr}`,
  },

  // ── Polygon ──
  {
    id: 'POL', name: 'Polygon', symbol: 'POL', category: 'Polygon',
    networkLabel: 'Polygon', icon: `${CDN}/matic.svg`, color: '#8247e5', networkClass: 'network-poly',
    derive:  m    => EthereumWallet.deriveAddress(m),
    balance: addr => EVMChains.getNative(addr, 'POLYGON'),
    canSend: true, defaultEnabled: false,
    send: async (m, to, amt) => EVMChains.sendNative(m, 'POLYGON', to, amt),
    history: addr => fetchEvmHistory(addr, 'POLYGON'),
    explorerAddr: addr => `https://polygonscan.com/address/${addr}`,
  },
  {
    id: 'USDT_POLY', name: 'Tether USD', symbol: 'USDT', category: 'Polygon',
    networkLabel: 'Polygon', icon: `${CDN}/usdt.svg`, color: '#26a17b', networkClass: 'network-poly',
    derive:  m    => EthereumWallet.deriveAddress(m),
    balance: addr => EVMChains.getToken(addr, 'USDT_POLY'),
    canSend: true, defaultEnabled: false,
    send: async (m, to, amt) => EVMChains.sendToken(m, 'USDT_POLY', to, amt),
    history: addr => fetchEvmHistory(addr, 'POLYGON', '0xc2132D05D31c914a87C6611C10748AEb04B58e8F', 6),
    explorerAddr: addr => `https://polygonscan.com/address/${addr}`,
  },
  {
    id: 'USDC_POLY', name: 'USD Coin', symbol: 'USDC', category: 'Polygon',
    networkLabel: 'Polygon', icon: `${CDN}/usdc.svg`, color: '#2775ca', networkClass: 'network-poly',
    derive:  m    => EthereumWallet.deriveAddress(m),
    balance: addr => EVMChains.getToken(addr, 'USDC_POLY'),
    canSend: true, defaultEnabled: false,
    send: async (m, to, amt) => EVMChains.sendToken(m, 'USDC_POLY', to, amt),
    history: addr => fetchEvmHistory(addr, 'POLYGON', '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', 6),
    explorerAddr: addr => `https://polygonscan.com/address/${addr}`,
  },

  // ── Avalanche ──
  {
    id: 'AVAX', name: 'Avalanche', symbol: 'AVAX', category: 'Avalanche',
    networkLabel: 'C-Chain', icon: `${CDN}/avax.svg`, color: '#e84142', networkClass: 'network-avax',
    derive:  m    => EthereumWallet.deriveAddress(m),
    balance: addr => EVMChains.getNative(addr, 'AVALANCHE'),
    canSend: true, defaultEnabled: false,
    send: async (m, to, amt) => EVMChains.sendNative(m, 'AVALANCHE', to, amt),
    history: addr => fetchEvmHistory(addr, 'AVALANCHE'),
    explorerAddr: addr => `https://snowtrace.io/address/${addr}`,
  },
  {
    id: 'USDT_AVAX', name: 'Tether USD', symbol: 'USDT', category: 'Avalanche',
    networkLabel: 'Avalanche', icon: `${CDN}/usdt.svg`, color: '#26a17b', networkClass: 'network-avax',
    derive:  m    => EthereumWallet.deriveAddress(m),
    balance: addr => EVMChains.getToken(addr, 'USDT_AVAX'),
    canSend: true, defaultEnabled: false,
    send: async (m, to, amt) => EVMChains.sendToken(m, 'USDT_AVAX', to, amt),
    history: addr => fetchEvmHistory(addr, 'AVALANCHE', '0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7', 6),
    explorerAddr: addr => `https://snowtrace.io/address/${addr}`,
  },
  {
    id: 'USDC_AVAX', name: 'USD Coin', symbol: 'USDC', category: 'Avalanche',
    networkLabel: 'Avalanche', icon: `${CDN}/usdc.svg`, color: '#2775ca', networkClass: 'network-avax',
    derive:  m    => EthereumWallet.deriveAddress(m),
    balance: addr => EVMChains.getToken(addr, 'USDC_AVAX'),
    canSend: true, defaultEnabled: false,
    send: async (m, to, amt) => EVMChains.sendToken(m, 'USDC_AVAX', to, amt),
    history: addr => fetchEvmHistory(addr, 'AVALANCHE', '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E', 6),
    explorerAddr: addr => `https://snowtrace.io/address/${addr}`,
  },

  // ── Arbitrum ──
  {
    id: 'ARB', name: 'Arbitrum', symbol: 'ARB', category: 'Arbitrum',
    networkLabel: 'Arbitrum', icon: 'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/arbitrum/assets/0x912CE59144191C1204E64559FE8253a0e49E6548/logo.png', color: '#28a0f0', networkClass: 'network-arb',
    derive:  m    => EthereumWallet.deriveAddress(m),
    balance: addr => EVMChains.getToken(addr, 'ARB'),
    canSend: true, defaultEnabled: false,
    send: async (m, to, amt) => EVMChains.sendToken(m, 'ARB', to, amt),
    history: addr => fetchEvmHistory(addr, 'ARBITRUM', '0x912CE59144191C1204E64559FE8253a0e49E6548', 18),
    explorerAddr: addr => `https://arbiscan.io/address/${addr}`,
  },
  {
    id: 'ARB_ETH', name: 'Ethereum', symbol: 'ETH', category: 'Arbitrum',
    networkLabel: 'Arbitrum', icon: `${CDN}/eth.svg`, color: '#28a0f0', networkClass: 'network-arb',
    derive:  m    => EthereumWallet.deriveAddress(m),
    balance: addr => EVMChains.getNative(addr, 'ARBITRUM'),
    canSend: true, defaultEnabled: false,
    send: async (m, to, amt) => EVMChains.sendNative(m, 'ARBITRUM', to, amt),
    history: addr => fetchEvmHistory(addr, 'ARBITRUM'),
    explorerAddr: addr => `https://arbiscan.io/address/${addr}`,
  },
  {
    id: 'USDT_ARB', name: 'Tether USD', symbol: 'USDT', category: 'Arbitrum',
    networkLabel: 'Arbitrum', icon: `${CDN}/usdt.svg`, color: '#26a17b', networkClass: 'network-arb',
    derive:  m    => EthereumWallet.deriveAddress(m),
    balance: addr => EVMChains.getToken(addr, 'USDT_ARB'),
    canSend: true, defaultEnabled: false,
    send: async (m, to, amt) => EVMChains.sendToken(m, 'USDT_ARB', to, amt),
    history: addr => fetchEvmHistory(addr, 'ARBITRUM', '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', 6),
    explorerAddr: addr => `https://arbiscan.io/address/${addr}`,
  },
  {
    id: 'USDC_ARB', name: 'USD Coin', symbol: 'USDC', category: 'Arbitrum',
    networkLabel: 'Arbitrum', icon: `${CDN}/usdc.svg`, color: '#2775ca', networkClass: 'network-arb',
    derive:  m    => EthereumWallet.deriveAddress(m),
    balance: addr => EVMChains.getToken(addr, 'USDC_ARB'),
    canSend: true, defaultEnabled: false,
    send: async (m, to, amt) => EVMChains.sendToken(m, 'USDC_ARB', to, amt),
    history: addr => fetchEvmHistory(addr, 'ARBITRUM', '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', 6),
    explorerAddr: addr => `https://arbiscan.io/address/${addr}`,
  },

  // ── Optimism ──
  {
    id: 'OP', name: 'Optimism', symbol: 'OP', category: 'Optimism',
    networkLabel: 'Optimism', icon: 'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/optimism/assets/0x4200000000000000000000000000000000000042/logo.png', color: '#ff0420', networkClass: 'network-opt',
    derive:  m    => EthereumWallet.deriveAddress(m),
    balance: addr => EVMChains.getToken(addr, 'OP'),
    canSend: true, defaultEnabled: false,
    send: async (m, to, amt) => EVMChains.sendToken(m, 'OP', to, amt),
    history: addr => fetchEvmHistory(addr, 'OPTIMISM', '0x4200000000000000000000000000000000000042', 18),
    explorerAddr: addr => `https://optimistic.etherscan.io/address/${addr}`,
  },
  {
    id: 'OP_ETH', name: 'Ethereum', symbol: 'ETH', category: 'Optimism',
    networkLabel: 'Optimism', icon: `${CDN}/eth.svg`, color: '#ff0420', networkClass: 'network-opt',
    derive:  m    => EthereumWallet.deriveAddress(m),
    balance: addr => EVMChains.getNative(addr, 'OPTIMISM'),
    canSend: true, defaultEnabled: false,
    send: async (m, to, amt) => EVMChains.sendNative(m, 'OPTIMISM', to, amt),
    history: addr => fetchEvmHistory(addr, 'OPTIMISM'),
    explorerAddr: addr => `https://optimistic.etherscan.io/address/${addr}`,
  },
  {
    id: 'USDT_OPT', name: 'Tether USD', symbol: 'USDT', category: 'Optimism',
    networkLabel: 'Optimism', icon: `${CDN}/usdt.svg`, color: '#26a17b', networkClass: 'network-opt',
    derive:  m    => EthereumWallet.deriveAddress(m),
    balance: addr => EVMChains.getToken(addr, 'USDT_OPT'),
    canSend: true, defaultEnabled: false,
    send: async (m, to, amt) => EVMChains.sendToken(m, 'USDT_OPT', to, amt),
    history: addr => fetchEvmHistory(addr, 'OPTIMISM', '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58', 6),
    explorerAddr: addr => `https://optimistic.etherscan.io/address/${addr}`,
  },
  {
    id: 'USDC_OPT', name: 'USD Coin', symbol: 'USDC', category: 'Optimism',
    networkLabel: 'Optimism', icon: `${CDN}/usdc.svg`, color: '#2775ca', networkClass: 'network-opt',
    derive:  m    => EthereumWallet.deriveAddress(m),
    balance: addr => EVMChains.getToken(addr, 'USDC_OPT'),
    canSend: true, defaultEnabled: false,
    send: async (m, to, amt) => EVMChains.sendToken(m, 'USDC_OPT', to, amt),
    history: addr => fetchEvmHistory(addr, 'OPTIMISM', '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', 6),
    explorerAddr: addr => `https://optimistic.etherscan.io/address/${addr}`,
  },

  // ── Base ──
  {
    id: 'BASE_ETH', name: 'Ethereum', symbol: 'ETH', category: 'Base',
    networkLabel: 'Base', icon: `${CDN}/eth.svg`, color: '#0052ff', networkClass: 'network-base',
    derive:  m    => EthereumWallet.deriveAddress(m),
    balance: addr => EVMChains.getNative(addr, 'BASE'),
    canSend: true, defaultEnabled: false,
    send: async (m, to, amt) => EVMChains.sendNative(m, 'BASE', to, amt),
    history: addr => fetchEvmHistory(addr, 'BASE'),
    explorerAddr: addr => `https://basescan.org/address/${addr}`,
  },
  {
    id: 'USDT_BASE', name: 'Tether USD', symbol: 'USDT', category: 'Base',
    networkLabel: 'Base', icon: `${CDN}/usdt.svg`, color: '#26a17b', networkClass: 'network-base',
    derive:  m    => EthereumWallet.deriveAddress(m),
    balance: addr => EVMChains.getToken(addr, 'USDT_BASE'),
    canSend: true, defaultEnabled: false,
    send: async (m, to, amt) => EVMChains.sendToken(m, 'USDT_BASE', to, amt),
    history: addr => fetchEvmHistory(addr, 'BASE', '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2', 6),
    explorerAddr: addr => `https://basescan.org/address/${addr}`,
  },
  {
    id: 'USDC_BASE', name: 'USD Coin', symbol: 'USDC', category: 'Base',
    networkLabel: 'Base', icon: `${CDN}/usdc.svg`, color: '#2775ca', networkClass: 'network-base',
    derive:  m    => EthereumWallet.deriveAddress(m),
    balance: addr => EVMChains.getToken(addr, 'USDC_BASE'),
    canSend: true, defaultEnabled: false,
    send: async (m, to, amt) => EVMChains.sendToken(m, 'USDC_BASE', to, amt),
    history: addr => fetchEvmHistory(addr, 'BASE', '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', 6),
    explorerAddr: addr => `https://basescan.org/address/${addr}`,
  },

  // ── Monero ──
  {
    id: 'XMR', name: 'Monero', symbol: 'XMR', category: 'Monero',
    icon: `${CDN}/xmr.svg`, color: '#ff6600', networkLabel: 'Stealth', networkClass: 'network-xmr',
    derive:  m    => MoneroWallet.deriveAddress(m),
    balance: async (addr, extra) => MoneroWallet.getBalance(addr, extra?.viewKey),
    extra:      async m => ({ viewKey: await MoneroWallet.deriveViewKey(m) }),
    exportKeys: async m => ({
      spendKey: await MoneroWallet.deriveSpendKeyHex(m),
      viewKey:  await MoneroWallet.deriveViewKeyHex(m),
    }),
    explorerAddr: addr => `https://xmrchain.net/search?value=${addr}`,
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
    icon: `${CDN}/trx.svg`, color: '#ef4444', networkLabel: 'TRC-20', networkClass: 'network-trc20',
    derive:  m    => TronWallet.deriveAddress(m),
    balance: addr => TronWallet.getTRXBalance(addr),
    canSend: true, defaultEnabled: true, canStake: true,
    send: async (m, to, amt) => TronWallet.sendTRX(await TronWallet.derivePrivateKey(m), to, amt),
    history: addr => TronWallet.getTRXHistory(addr),
    explorerAddr: addr => `https://tronscan.org/#/address/${addr}`,
  },
  {
    id: 'USDT_TRC20', name: 'Tether USD', symbol: 'USDT', category: 'TRON',
    networkLabel: 'TRC-20', icon: `${CDN}/usdt.svg`, color: '#26a17b', networkClass: 'network-trc20',
    derive:  m    => TronWallet.deriveAddress(m),
    balance: addr => TronWallet.getUSDTBalance(addr),
    canSend: true, defaultEnabled: true,
    send: async (m, to, amt) => TronWallet.sendUSDT(await TronWallet.derivePrivateKey(m), to, amt),
    history: addr => TronWallet.getUSDTHistory(addr),
    explorerAddr: addr => `https://tronscan.org/#/address/${addr}`,
  },

  // ── Litecoin ──
  {
    id: 'LTC', name: 'Litecoin', symbol: 'LTC', category: 'Litecoin',
    icon: `${CDN}/ltc.svg`, color: '#a6a9aa', networkLabel: 'Native SegWit', networkClass: 'network-ltc',
    derive:  m    => LitecoinWallet.deriveAddress(m),
    balance: addr => LitecoinWallet.getBalance(addr),
    canSend: true, defaultEnabled: false,
    send: async (m, to, amt) => LitecoinWallet.sendLTC(m, to, amt),
    history: addr => LitecoinWallet.getHistory(addr),
    explorerAddr: addr => `https://litecoinspace.org/address/${addr}`,
  },

  // ── Dogecoin ──
  {
    id: 'DOGE', name: 'Dogecoin', symbol: 'DOGE', category: 'Dogecoin',
    icon: `${CDN}/doge.svg`, color: '#c2a633', networkLabel: 'Legacy', networkClass: 'network-doge',
    derive:  m    => DogecoinWallet.deriveAddress(m),
    balance: addr => DogecoinWallet.getBalance(addr),
    canSend: true, defaultEnabled: false,
    send: async (m, to, amt) => DogecoinWallet.sendDOGE(m, to, amt),
    history: addr => DogecoinWallet.getHistory(addr),
    explorerAddr: addr => `https://dogechain.info/address/${addr}`,
  },

  // ── Solana ──
  // The cryptocurrency-icons CDN ships an outdated pre-rebrand SOL logo.
  // CoinGecko hosts the current gradient-bars logo at a stable URL.
  {
    id: 'SOL', name: 'Solana', symbol: 'SOL', category: 'Solana',
    icon: 'https://assets.coingecko.com/coins/images/4128/large/solana.png',
    color: '#9945ff', networkLabel: 'SPL', networkClass: 'network-sol',
    derive:  m    => SolanaWallet.deriveAddress(m),
    balance: addr => SolanaWallet.getBalance(addr),
    canSend: true, defaultEnabled: false, canStake: true,
    send: async (m, to, amt) => SolanaWallet.sendSOL(m, to, amt),
    history: addr => SolanaWallet.getHistory(addr),
    explorerAddr: addr => `https://solscan.io/account/${addr}`,
  },
];

// Stablecoins available for one-tap Aave v3 yield. Kept in one place so the
// list stays in sync with js/aave.js SUPPORTED.
['USDT_POLY','USDC_POLY','USDT_ARB','USDC_ARB','USDT_OPT','USDC_OPT',
 'USDC_BASE','USDT_AVAX','USDC_AVAX','USDT_BEP20','USDC_BEP20'].forEach(id => {
  const c = COINS.find(x => x.id === id);
  if (c) c.canEarn = true;
});

// ── EVM chain config — Blockscout (free, no API key) + explorer links ─────────
const CHAIN_CONFIG = {
  ETH:       { blockscout: 'https://eth.blockscout.com',      explorer: 'https://etherscan.io' },
  // Etherscan V2 unified API. Free tier (5 req/s, 100k/day) covers
  // every supported chain via the chainid parameter, authorized by the
  // single ETHERSCAN_API_KEY at the top of this file.
  BSC:       { etherscan:  'https://api.etherscan.io/v2/api', chainId: 56, explorer: 'https://bscscan.com' },
  POLYGON:   { blockscout: 'https://polygon.blockscout.com',  explorer: 'https://polygonscan.com' },
  AVALANCHE: { etherscan:  'https://api.routescan.io/v2/network/mainnet/evm/43114/etherscan/api', explorer: 'https://snowtrace.io' },
  ARBITRUM:  { blockscout: 'https://arbitrum.blockscout.com', explorer: 'https://arbiscan.io' },
  OPTIMISM:  { etherscan:  'https://api.etherscan.io/v2/api', chainId: 10, explorer: 'https://optimistic.etherscan.io' },
  BASE:      { blockscout: 'https://base.blockscout.com',     explorer: 'https://basescan.org' },
};

async function _blockscoutHistory(addr, base, explorer, tokenAddr, decimals) {
  const url = tokenAddr
    ? `${base}/api/v2/addresses/${addr}/token-transfers?token=${tokenAddr}`
    : `${base}/api/v2/addresses/${addr}/transactions`;
  const r = await fetch(url, { signal: AbortSignal.timeout(12000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  return (j.items || []).map(tx => {
    const hash   = tokenAddr ? (tx.transaction_hash || tx.tx_hash) : tx.hash;
    const from   = (tx.from?.hash || '').toLowerCase();
    const isSend = from === addr.toLowerCase();
    const dec    = Number(tx.total?.decimals ?? decimals ?? 18);
    const amount = tokenAddr
      ? parseFloat(ethers.formatUnits(tx.total?.value || '0', dec)).toFixed(dec <= 6 ? 2 : 4)
      : parseFloat(ethers.formatEther(tx.value || '0')).toFixed(6);
    const txStatus = tokenAddr ? 'ok' : (tx.status === 'ok' ? 'ok' : tx.status === 'error' ? 'error' : 'pending');
    return {
      hash, type: isSend ? 'send' : 'receive', amount,
      time: tx.timestamp ? new Date(tx.timestamp).getTime() : null,
      confirmed: txStatus === 'ok',
      status: txStatus,
      errorMsg: txStatus === 'error' ? (tx.revert_reason?.raw || tx.error || 'Reverted') : null,
      explorerUrl: `${explorer}/tx/${hash}`,
    };
  });
}

// Etherscan V2 unified API key. Free tier covers 5 req/s, 100k req/day —
// plenty for a per-user wallet. Registered at etherscan.io/myapikey;
// safe to embed because rate limits are per-key, not per-IP, and the
// key only authorizes read-only history queries (no signing capability).
// Replace with your own at https://etherscan.io/apidashboard if you fork.
const ETHERSCAN_API_KEY = '4IS9KAY8J155HS8KM176G57BWWC32PYR1T';

async function _etherscanHistory(addr, apiBase, explorer, tokenAddr, decimals, chainId) {
  // Etherscan V2 takes chainid as a query param and ignores it on per-chain
  // endpoints, so passing it always is safe and lets us use the unified
  // endpoint when needed.
  const params = new URLSearchParams({
    module: 'account', action: tokenAddr ? 'tokentx' : 'txlist',
    address: addr, sort: 'desc', offset: '25',
    apikey: ETHERSCAN_API_KEY,
  });
  if (chainId) params.set('chainid', String(chainId));
  if (tokenAddr) params.set('contractaddress', tokenAddr);
  const r = await fetch(`${apiBase}?${params}`, { signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  if (j.status !== '1' || !Array.isArray(j.result)) {
    // Surface the actual API reason so a missing-key / rate-limit / bad-chain
    // problem is visible instead of just "No results".
    const reason = (typeof j.result === 'string' ? j.result : '') || j.message || 'No results';
    if (Array.isArray(j.result) && j.result.length === 0) return []; // empty history is not an error
    throw new Error(reason);
  }
  return j.result.map(tx => ({
    hash: tx.hash,
    type: tx.from.toLowerCase() === addr.toLowerCase() ? 'send' : 'receive',
    amount: tokenAddr
      ? parseFloat(ethers.formatUnits(tx.value || '0', decimals)).toFixed(decimals <= 6 ? 2 : 4)
      : parseFloat(ethers.formatEther(tx.value || '0')).toFixed(6),
    time: parseInt(tx.timeStamp) * 1000, confirmed: tx.isError !== '1',
    status: tx.isError === '1' ? 'error' : 'ok',
    errorMsg: tx.isError === '1' ? (tx.errDescription || 'Failed') : null,
    explorerUrl: `${explorer}/tx/${tx.hash}`,
  }));
}

// Blockchair adapter — used for chains where Etherscan V2 free tier
// gates behind a subscription (BSC, Optimism). Free tier: ~30 req/min
// per IP without an API key. Two API hits per call: one to list tx
// hashes, one batched call to fetch details for amount/direction.
async function _blockchairHistory(addr, chain, explorer, tokenAddr, decimals) {
  const lower = addr.toLowerCase();
  const listUrl = `https://api.blockchair.com/${chain}/dashboards/address/${addr}?limit=20`;
  const r1 = await fetch(listUrl, { signal: AbortSignal.timeout(15000) });
  if (!r1.ok) throw new Error(`Blockchair HTTP ${r1.status}`);
  const j1 = await r1.json();
  const data = j1.data?.[lower] || j1.data?.[addr];
  if (!data) return [];
  const hashes = (data.transactions || []).slice(0, 20);
  if (!hashes.length) return [];
  const detailsUrl = `https://api.blockchair.com/${chain}/dashboards/transactions/${hashes.join(',')}`;
  const r2 = await fetch(detailsUrl, { signal: AbortSignal.timeout(15000) });
  if (!r2.ok) {
    // Fall back to bare hash list if the batched details call fails.
    return hashes.map(h => ({
      hash: h, type: 'send', amount: '—', time: null,
      confirmed: true, status: 'ok',
      explorerUrl: `${explorer}/tx/${h}`,
    }));
  }
  const j2 = await r2.json();
  const out = [];
  for (const h of hashes) {
    const entry = j2.data?.[h];
    const t = entry?.transaction;
    if (!t) continue;
    out.push({
      hash: t.hash || h,
      type: (t.sender || '').toLowerCase() === lower ? 'send' : 'receive',
      amount: parseFloat(ethers.formatEther(String(t.value || '0'))).toFixed(6),
      time: t.time ? new Date(t.time + 'Z').getTime() : null,
      confirmed: !t.failed,
      status: t.failed ? 'error' : 'ok',
      explorerUrl: `${explorer}/tx/${t.hash || h}`,
    });
  }
  return out;
}

async function fetchEvmHistory(addr, chainKey, tokenAddr, decimals) {
  const cfg = CHAIN_CONFIG[chainKey];
  if (!cfg) return [];
  if (cfg.blockchair) return _blockchairHistory(addr, cfg.blockchair, cfg.explorer, tokenAddr, decimals);
  if (cfg.blockscout) return _blockscoutHistory(addr, cfg.blockscout, cfg.explorer, tokenAddr, decimals);
  return _etherscanHistory(addr, cfg.etherscan, cfg.explorer, tokenAddr, decimals, cfg.chainId);
}

// ── EVM gas table — which chain each coin is on and which coin pays gas ───────
const EVM_GAS = {
  ETH:       { chain: 'ETH',       token: false, feeId: 'ETH'      },
  USDT_ERC20:{ chain: 'ETH',       token: true,  feeId: 'ETH'      },
  USDC_ERC20:{ chain: 'ETH',       token: true,  feeId: 'ETH'      },
  DAI:       { chain: 'ETH',       token: true,  feeId: 'ETH'      },
  BNB:       { chain: 'BSC',       token: false, feeId: 'BNB'      },
  USDT_BEP20:{ chain: 'BSC',       token: true,  feeId: 'BNB'      },
  USDC_BEP20:{ chain: 'BSC',       token: true,  feeId: 'BNB'      },
  POL:       { chain: 'POLYGON',   token: false, feeId: 'POL'      },
  USDT_POLY: { chain: 'POLYGON',   token: true,  feeId: 'POL'      },
  USDC_POLY: { chain: 'POLYGON',   token: true,  feeId: 'POL'      },
  AVAX:      { chain: 'AVALANCHE', token: false, feeId: 'AVAX'     },
  USDT_AVAX: { chain: 'AVALANCHE', token: true,  feeId: 'AVAX'     },
  USDC_AVAX: { chain: 'AVALANCHE', token: true,  feeId: 'AVAX'     },
  ARB:       { chain: 'ARBITRUM',  token: true,  feeId: 'ARB_ETH'  },
  ARB_ETH:   { chain: 'ARBITRUM',  token: false, feeId: 'ARB_ETH'  },
  USDT_ARB:  { chain: 'ARBITRUM',  token: true,  feeId: 'ARB_ETH'  },
  USDC_ARB:  { chain: 'ARBITRUM',  token: true,  feeId: 'ARB_ETH'  },
  OP:        { chain: 'OPTIMISM',  token: true,  feeId: 'OP_ETH'   },
  OP_ETH:    { chain: 'OPTIMISM',  token: false, feeId: 'OP_ETH'   },
  USDT_OPT:  { chain: 'OPTIMISM',  token: true,  feeId: 'OP_ETH'   },
  USDC_OPT:  { chain: 'OPTIMISM',  token: true,  feeId: 'OP_ETH'   },
  BASE_ETH:  { chain: 'BASE',      token: false, feeId: 'BASE_ETH' },
  USDT_BASE: { chain: 'BASE',      token: true,  feeId: 'BASE_ETH' },
  USDC_BASE: { chain: 'BASE',      token: true,  feeId: 'BASE_ETH' },
};

async function estimateEvmFee(coinId) {
  const g = EVM_GAS[coinId];
  if (!g) return null;
  const info = g.chain === 'ETH'
    ? await EthereumWallet.estimateFee(g.token)
    : await EVMChains.estimateFee(g.chain, g.token);
  return { ...info, feeId: g.feeId };
}

// ── USD price (CoinGecko free API, no key required) ───────────────────────────
const PRICE_IDS = {
  BTC:        'bitcoin',
  ETH:        'ethereum',
  USDT_ERC20: 'tether',     USDC_ERC20: 'usd-coin',   DAI:        'dai',
  BNB:        'binancecoin',
  USDT_BEP20: 'tether',     USDC_BEP20: 'usd-coin',
  POL:        'matic-network',
  USDT_POLY:  'tether',     USDC_POLY:  'usd-coin',
  AVAX:       'avalanche-2',
  USDT_AVAX:  'tether',     USDC_AVAX:  'usd-coin',
  ARB:        'arbitrum',   ARB_ETH:    'ethereum',
  USDT_ARB:   'tether',     USDC_ARB:   'usd-coin',
  OP:         'optimism',   OP_ETH:     'ethereum',
  USDT_OPT:   'tether',     USDC_OPT:   'usd-coin',
  BASE_ETH:   'ethereum',
  USDT_BASE:  'tether',     USDC_BASE:  'usd-coin',
  XMR:        'monero',
  TRX:        'tron',       USDT_TRC20: 'tether',
  LTC:        'litecoin',
  DOGE:       'dogecoin',
  SOL:        'solana',
};

// User-selectable display currency. Whatever's stored here is sent to
// CoinGecko as vs_currency and used by Intl.NumberFormat for the symbol.
const CURRENCIES = ['usd','eur','gbp','jpy','cny','inr','idr','php','myr','sgd','aud','cad','krw','thb'];
function getDisplayCurrency() {
  const c = (localStorage.getItem('vault.currency') || 'usd').toLowerCase();
  return CURRENCIES.includes(c) ? c : 'usd';
}
function setDisplayCurrency(c) {
  c = String(c).toLowerCase();
  if (!CURRENCIES.includes(c)) return;
  localStorage.setItem('vault.currency', c);
  // Re-fetch in the new currency and redraw — UI updates silently.
  fetchPrices().then(() => {
    if (typeof updateHome === 'function') updateHome();
    if (typeof updateBalCard === 'function') updateBalCard();
  }).catch(() => {});
}
window.getDisplayCurrency = getDisplayCurrency;
window.setDisplayCurrency = setDisplayCurrency;

// Formats a (balance × price) as a localized fiat string using the user's
// chosen display currency. Kept the legacy name `formatUSD` because it's
// referenced from many call sites — the body now respects whatever
// currency the user picked.
function formatUSD(balStr, price) {
  if (!price || !balStr || balStr === '…' || balStr === '—') return '';
  const bal = parseFloat(balStr);
  if (isNaN(bal) || bal < 0) return '';
  const value = bal * price;
  const ccy = getDisplayCurrency().toUpperCase();
  // JPY / KRW / IDR / VND have 0 fraction digits in their conventional
  // formatting; everything else uses 2.
  const noDecimals = new Set(['JPY','KRW','IDR','VND']);
  const digits = noDecimals.has(ccy) ? 0 : 2;
  const fmt = (n) => new Intl.NumberFormat(undefined, {
    style: 'currency', currency: ccy, minimumFractionDigits: digits, maximumFractionDigits: digits,
  }).format(n);
  if (value === 0) return fmt(0);
  // Tiny-amount sentinel that matches the fiat's natural precision.
  const tiny = digits === 0 ? 1 : 0.01;
  if (value < tiny) return '<' + fmt(tiny);
  return fmt(value);
}

async function fetchPrices() {
  const ids = [...new Set(Object.values(PRICE_IDS))].join(',');
  const ccy = getDisplayCurrency();
  try {
    const r = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=${ccy}`,
      { signal: AbortSignal.timeout(10000) }
    );
    if (!r.ok) return;
    const data = await r.json();
    for (const [coinId, cgId] of Object.entries(PRICE_IDS)) {
      if (data[cgId]?.[ccy] != null) state.prices[coinId] = data[cgId][ccy];
    }
    updateBalCard();
    getActiveCoins().forEach(c => updateSidebarBal(c.id));
  } catch {}
}

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
  // BIP39 passphrase ("25th word"). Held in memory only after unlock; never
  // persisted. Empty string = standard wallet (no passphrase). Coin modules
  // read this via window.getPassphrase() when deriving addresses or signing.
  passphrase: '',
  addresses: {},
  balances: {},
  extras: {},
  prices: {},
  active: 'BTC',
};

// Global helper so every coin module can read the current passphrase
// without each one needing to take a new parameter. Returns '' when no
// passphrase is set, which matches the standard BIP39 derivation.
window.getPassphrase = function() {
  return (state && state.passphrase) || '';
};

// Whether the user has opted in to passphrase protection. We DON'T store
// the passphrase itself — only whether to prompt for one on unlock.
function isPassphraseEnabled() {
  return localStorage.getItem('vault.passphrase_enabled') === 'true';
}
function setPassphraseEnabled(on) {
  if (on) localStorage.setItem('vault.passphrase_enabled', 'true');
  else    localStorage.removeItem('vault.passphrase_enabled');
}
window.isPassphraseEnabled = isPassphraseEnabled;
window.setPassphraseEnabled = setPassphraseEnabled;

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
    <button class="btn btn-primary btn-sm" id="btn-copy-seed" style="width:100%;margin-bottom:12px">⧉ Copy all 12 words</button>
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
  document.getElementById('btn-copy-seed').onclick = async () => {
    try { await navigator.clipboard.writeText(phrase); toast('Recovery phrase copied — clear your clipboard after saving it'); }
    catch { toast('Copy failed'); }
  };
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
    // Verify we can decrypt back to the original mnemonic before discarding the legacy plaintext.
    // This guards against quota errors, partial writes, and crypto bugs that could otherwise lose the seed.
    const stored = localStorage.getItem('wallet_encrypted');
    const roundTrip = await decryptMnemonic(stored, password);
    if (roundTrip !== mnemonic) throw new Error('Encrypted wallet failed verification — refusing to discard backup');
    localStorage.removeItem('wallet_mnemonic'); // remove legacy plaintext if any
    state.mnemonic = mnemonic;
    await loadWallet();
  } catch(e) {
    box.innerHTML = `<h1>Error</h1><p style="color:var(--red);margin-top:8px">${e.message}</p><button class="btn btn-outline" onclick="showSetup()" style="margin-top:16px;width:100%">Back</button>`;
  }
}

function showUnlock() {
  const box = document.getElementById('setup-box');
  const bioEnabled = window.biometricEnabled?.();
  box.innerHTML = `
    <h1>Unlock Wallet</h1>
    <p>Enter your password to access your wallet.</p>
    <div class="form-group" style="margin-top:8px">
      <label>Password</label>
      <input type="password" id="unlock-pwd" placeholder="Enter password" autocomplete="current-password">
    </div>
    <p id="unlock-err" class="text-red text-sm" style="display:none;margin-bottom:12px">Incorrect password. Try again.</p>
    <button class="btn btn-primary" id="btn-unlock" style="width:100%;padding:14px">Unlock</button>
    ${bioEnabled ? `<button class="btn btn-outline" id="btn-biometric" style="width:100%;margin-top:10px;padding:14px">Unlock with Face ID / Biometric</button>` : ''}
    <button class="btn btn-outline btn-sm" id="btn-forgot" style="width:100%;margin-top:10px">Forgot password / Remove wallet</button>`;
  const doUnlock = async () => {
    const pwd = document.getElementById('unlock-pwd').value;
    const btn = document.getElementById('btn-unlock');
    const err = document.getElementById('unlock-err');
    btn.disabled = true; btn.textContent = 'Unlocking…';
    try {
      const mnemonic = await decryptMnemonic(localStorage.getItem('wallet_encrypted'), pwd);
      // Opportunistic upgrade of v1 blobs (300k iterations) to v2 (600k).
      // Fire-and-forget — never block the unlock flow on an upgrade attempt.
      maybeUpgradeEncryption(mnemonic, pwd).catch(() => {});
      // If passphrase protection is on, ask for the 25th word before deriving.
      // Wrong passphrase silently produces a different (empty) wallet — this is
      // a BIP39 design feature ("plausible deniability"), not a bug.
      if (isPassphraseEnabled()) {
        showPassphrasePrompt(mnemonic);
        return;
      }
      state.passphrase = '';
      state.mnemonic = mnemonic;
      await loadWallet();
    } catch {
      err.style.display = 'block';
      btn.disabled = false; btn.textContent = 'Unlock';
    }
  };
  document.getElementById('unlock-pwd').addEventListener('keydown', e => { if (e.key === 'Enter') doUnlock(); });
  document.getElementById('btn-unlock').onclick = doUnlock;
  document.getElementById('btn-biometric')?.addEventListener('click', async () => {
    const btn = document.getElementById('btn-biometric');
    btn.disabled = true; btn.textContent = 'Verifying…';
    try {
      const pwd = await window.unlockWithBiometric();
      const mnemonic = await decryptMnemonic(localStorage.getItem('wallet_encrypted'), pwd);
      maybeUpgradeEncryption(mnemonic, pwd).catch(() => {});
      if (isPassphraseEnabled()) {
        showPassphrasePrompt(mnemonic);
        return;
      }
      state.passphrase = '';
      state.mnemonic = mnemonic;
      await loadWallet();
    } catch (e) {
      btn.disabled = false; btn.textContent = 'Unlock with Face ID / Biometric';
      const err = document.getElementById('unlock-err');
      err.textContent = 'Biometric failed: ' + (e.message || e.name);
      err.style.display = 'block';
    }
  });
  document.getElementById('btn-forgot').onclick = () => {
    if (confirm('Remove wallet from this device? Make absolutely sure you have your recovery phrase backed up.')) {
      localStorage.clear(); location.reload();
    }
  };
}

// BIP39 passphrase prompt shown after a successful password unlock when the
// user has opted in to passphrase protection. Wrong passphrase = different
// addresses (BIP39 spec, not an error), so we can't validate it before
// deriving — the user has to recognize their own addresses on the home view.
function showPassphrasePrompt(mnemonic) {
  const box = document.getElementById('setup-box');
  box.innerHTML = `
    <h1>Enter Passphrase</h1>
    <p>Your wallet is protected by a BIP39 passphrase ("25th word"). Enter it to unlock the correct addresses.</p>
    <div class="warning-box" style="margin-top:8px">⚠ A wrong passphrase silently opens a different wallet — your real funds will not appear. Leave blank to use the standard wallet.</div>
    <div class="form-group" style="margin-top:12px">
      <label>Passphrase</label>
      <input type="password" id="pp-input" placeholder="Your 25th word" autocomplete="off" autocapitalize="off" spellcheck="false">
    </div>
    <button class="btn btn-primary" id="btn-pp-ok" style="width:100%;padding:14px">Unlock</button>
    <button class="btn btn-outline btn-sm" id="btn-pp-cancel" style="width:100%;margin-top:10px">Cancel</button>`;
  const submit = async () => {
    state.passphrase = document.getElementById('pp-input').value || '';
    state.mnemonic = mnemonic;
    const btn = document.getElementById('btn-pp-ok');
    btn.disabled = true; btn.textContent = 'Deriving…';
    await loadWallet();
  };
  document.getElementById('pp-input').addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
  document.getElementById('btn-pp-ok').onclick = submit;
  document.getElementById('btn-pp-cancel').onclick = showUnlock;
  setTimeout(() => document.getElementById('pp-input')?.focus(), 50);
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
  document.getElementById('app').style.display = 'flex';

  renderCoinList();
  const first = getActiveCoins()[0];
  if (first) selectCoin(first.id);
  refreshBalances();
  fetchPrices();
  if (typeof TxProgress !== 'undefined') TxProgress.start();
  if (typeof AaveEarn !== 'undefined') AaveEarn.startApyRefresh();
}

// ── Balance refresh ───────────────────────────────────────────────────────────
async function refreshBalances() {
  // Per-coin baseline of "last balance we acknowledged with a notification
  // (or established silently on first sight)". Persisted in localStorage so
  // it survives reloads. Comparing against THIS instead of the previous
  // refresh's snapshot prevents the spam where transient API failures
  // returning '0' bounce back to the real balance and look like fresh
  // deposits — that bug fired the same '+2.49 USDC' notification 6 times.
  let baseline = {};
  try { baseline = JSON.parse(localStorage.getItem('vault.balBaseline') || '{}'); } catch {}

  await Promise.all(getActiveCoins().map(async coin => {
    const addr = state.addresses[coin.id];
    if (!addr) return;
    try {
      state.balances[coin.id] = await coin.balance(addr, state.extras[coin.id]);
    } catch { state.balances[coin.id] = '—'; }
    updateSidebarBal(coin.id);
    if (state.active === coin.id) updateBalCard();
  }));

  if (typeof Inbox === 'undefined') return;
  let baselineChanged = false;
  for (const coin of getActiveCoins()) {
    const newBal = parseFloat(state.balances[coin.id]);
    if (!Number.isFinite(newBal) || newBal < 0) continue;
    const last = baseline[coin.id];
    const threshold = (coin.symbol === 'BTC' || coin.symbol === 'ETH') ? 1e-7 : 0.0001;
    if (last === undefined) {
      // First time seeing this coin — establish baseline silently. No
      // notification (we don't know whether the wallet was just created
      // empty or has been in use for years).
      baseline[coin.id] = newBal;
      baselineChanged = true;
    } else if (newBal > last + threshold) {
      // Real increase past the baseline — fire ONE notification and
      // bump the baseline so the same balance can't re-notify.
      const dec = (coin.symbol === 'USDT' || coin.symbol === 'USDC' || coin.symbol === 'DAI') ? 2 : 6;
      const delta = newBal - last;
      Inbox.add({
        type: 'receive',
        title: `${coin.symbol} deposit received`,
        network: coin.category,
        subtitle: `+${delta.toFixed(dec)} ${coin.symbol} · now ${newBal.toFixed(dec)} ${coin.symbol}`,
      });
      baseline[coin.id] = newBal;
      baselineChanged = true;
    } else if (newBal < last) {
      // Decrease (user sent some out, or first-after-recovery dip).
      // Lower the baseline silently so the next deposit fires correctly.
      baseline[coin.id] = newBal;
      baselineChanged = true;
    }
  }
  if (baselineChanged) {
    try { localStorage.setItem('vault.balBaseline', JSON.stringify(baseline)); } catch {}
  }
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
  if (!el || !coin) return;
  const bal = state.balances[id] ?? '…';
  const usd = formatUSD(bal, state.prices[id]);
  el.innerHTML = `${bal} ${coin.symbol}${usd ? `<span style="display:block;font-size:11px">${usd}</span>` : ''}`;
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
  if (document.getElementById('tab-history')?.classList.contains('active')) updateHistoryTab();
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
  const bal = state.balances[state.active] ?? '…';
  document.getElementById('bal-amount').textContent = `${bal} ${coin.symbol}`;
  const usd = formatUSD(bal, state.prices[state.active]);
  document.getElementById('bal-usd').textContent = usd ? `≈ ${usd}` : '';
}

function updateReceiveTab() {
  const addr = state.addresses[state.active] ?? '—';
  document.getElementById('address-display').textContent = addr;
  const out = document.getElementById('qr-output');
  out.innerHTML = '';
  if (addr !== '—' && typeof QRCode !== 'undefined') {
    new QRCode(out, { text: addr, width: 320, height: 320,
      colorDark: '#000000', colorLight: '#ffffff', correctLevel: QRCode.CorrectLevel.H });
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
  clearFeeTimer();
  const coin = COINS.find(c => c.id === state.active);
  document.getElementById('send-unavailable').style.display = coin.canSend ? 'none' : 'block';
  document.getElementById('send-form').style.display = coin.canSend ? 'block' : 'none';
  if (coin.canSend) {
    document.getElementById('send-symbol').textContent = coin.symbol;
    document.getElementById('send-to').value = '';
    document.getElementById('send-amount').value = '';

    const feeRow = document.getElementById('send-fee-row');
    const feeDisplay = document.getElementById('send-fee-display');
    if (EVM_GAS[coin.id]) {
      feeRow.style.display = 'block';
      feeDisplay.textContent = 'Estimating…';
      delete feeRow.dataset.fee;
      const coinId = coin.id;
      estimateEvmFee(coinId).then(info => {
        feeDisplay.textContent = `~${info.fee} ${info.symbol}`;
        feeRow.dataset.fee    = info.fee;
        feeRow.dataset.feeId  = info.feeId;
        feeRow.dataset.token  = EVM_GAS[coinId].token ? '1' : '0';
        feeRow.dataset.rollup = info.isRollup ? '1' : '0';

        // Auto-fill max sendable amount (use 1.5x buffer on rollups for L1 data fee)
        const bal = parseFloat(state.balances[coinId] || '0');
        if (bal > 0) {
          const amtInput = document.getElementById('send-amount');
          if (EVM_GAS[coinId].token) {
            amtInput.value = bal.toString();
          } else {
            const buffer = info.isRollup ? 1.5 : 1.2;
            const max = Math.max(0, bal - parseFloat(info.fee) * buffer);
            if (max > 0) amtInput.value = max.toFixed(6);
          }
        }

        // Refresh every 15 s while send tab is open
        _feeTimer = setInterval(() => refreshFeeDisplay(coinId), 15000);
      }).catch(() => { feeDisplay.textContent = 'Unable to estimate'; });
    } else {
      feeRow.style.display = 'none';
    }
  }
}

// ── History tab ───────────────────────────────────────────────────────────────
function timeAgo(ms) {
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60)   return 'Just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  if (s < 2592000) return Math.floor(s / 86400) + 'd ago';
  return new Date(ms).toLocaleDateString();
}

// Opens a URL in the device's external browser.
// In Capacitor WebView, target="_blank" doesn't always launch the system
// browser, so we explicitly use window.open with the _system target which
// Capacitor's intent handler picks up.
function openExternal(url) {
  if (!url) return;
  try {
    if (window.Capacitor?.Plugins?.Browser?.open) {
      window.Capacitor.Plugins.Browser.open({ url });
      return;
    }
  } catch {}
  // Fallback: plain window.open. _system is a Cordova convention; modern
  // browsers ignore it and just open in a new tab/window.
  const w = window.open(url, '_system');
  if (!w) window.open(url, '_blank');
}
window.openExternal = openExternal;

async function updateHistoryTab() {
  const coin = COINS.find(c => c.id === state.active);
  const list = document.getElementById('history-list');
  if (!list) return;

  if (!coin.history) {
    const url = coin.explorerAddr ? coin.explorerAddr(state.addresses[coin.id]) : '';
    list.innerHTML = `<p style="color:var(--text2);font-size:13px;padding:12px 0">
      History not available for ${coin.name}.</p>
      ${url ? `<button class="btn btn-outline btn-sm explorer-btn" data-url="${url}" style="margin-top:6px">View address on explorer ↗</button>` : ''}`;
    list.querySelectorAll('.explorer-btn').forEach(btn => btn.onclick = () => openExternal(btn.dataset.url));
    return;
  }

  list.innerHTML = `<p style="color:var(--text2);font-size:13px;padding:8px 0">Loading…</p>`;
  try {
    const addr = state.addresses[coin.id];
    const txs  = await coin.history(addr);
    if (!txs || txs.length === 0) {
      const url = coin.explorerAddr ? coin.explorerAddr(addr) : '';
      list.innerHTML = `<p style="color:var(--text2);font-size:13px;padding:12px 0">No transactions found.</p>
        ${url ? `<button class="btn btn-outline btn-sm explorer-btn" data-url="${url}" style="margin-top:6px">View on explorer ↗</button>` : ''}`;
      list.querySelectorAll('.explorer-btn').forEach(btn => btn.onclick = () => openExternal(btn.dataset.url));
      return;
    }
    list.innerHTML = txs.map((tx, i) => {
      const send = tx.type === 'send';
      const time = tx.time ? timeAgo(tx.time) : 'Pending';
      const st   = tx.status || (tx.confirmed ? 'ok' : 'pending');
      const badge = st === 'error'
        ? `<span style="font-size:10px;padding:1px 6px;border-radius:4px;font-weight:600;
             background:rgba(239,68,68,0.15);color:#ef4444">
             Failed${tx.errorMsg ? ': ' + escapeHtml(tx.errorMsg) : ''}</span>`
        : st === 'pending'
        ? `<span style="font-size:10px;padding:1px 6px;border-radius:4px;font-weight:600;
             background:rgba(234,179,8,0.15);color:#eab308">Pending</span>`
        : `<span style="font-size:10px;padding:1px 6px;border-radius:4px;font-weight:600;
             background:rgba(34,197,94,0.15);color:#22c55e">Completed</span>`;
      const url = escapeHtml(tx.explorerUrl || '');
      return `<div style="display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid var(--border)">
        <div style="width:32px;height:32px;border-radius:50%;flex-shrink:0;display:flex;align-items:center;
          justify-content:center;font-size:15px;
          background:${send ? 'rgba(239,68,68,0.15)' : 'rgba(34,197,94,0.15)'};
          color:${send ? '#ef4444' : '#22c55e'}">
          ${send ? '↑' : '↓'}
        </div>
        <div style="flex:1;min-width:0">
          <div style="font-size:13px;font-weight:600">${send ? 'Sent' : 'Received'} ${escapeHtml(tx.amount)} ${escapeHtml(coin.symbol)}</div>
          <div style="font-size:11px;color:var(--text2);margin-top:2px;display:flex;align-items:center;gap:6px">
            <span>${time}</span>${badge}
          </div>
        </div>
        ${url
          ? `<button class="btn btn-outline btn-sm explorer-btn" data-url="${url}"
               style="padding:6px 10px;font-size:12px;flex-shrink:0">
               Explorer ↗
             </button>`
          : ''}
      </div>`;
    }).join('');

    // Wire explorer buttons. window.open with _system target works in Capacitor;
    // also set href fallback so it works in plain browser.
    list.querySelectorAll('.explorer-btn').forEach(btn => {
      btn.onclick = () => openExternal(btn.dataset.url);
    });
  } catch(e) {
    const url = coin.explorerAddr ? coin.explorerAddr(state.addresses[coin.id]) : '';
    list.innerHTML = `<p style="color:var(--text2);font-size:13px;padding:12px 0">
      Could not load history: ${e.message}</p>
      ${url ? `<button class="btn btn-outline btn-sm explorer-btn" data-url="${url}" style="margin-top:6px">View on explorer ↗</button>` : ''}`;
    list.querySelectorAll('.explorer-btn').forEach(btn => btn.onclick = () => openExternal(btn.dataset.url));
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
  document.getElementById('tab-history').classList.toggle('active', id === 'history');
  if (id !== 'send') clearFeeTimer();
  if (id === 'send' && EVM_GAS[state.active]) {
    refreshFeeDisplay(state.active);
    if (!_feeTimer) _feeTimer = setInterval(() => refreshFeeDisplay(state.active), 15000);
  }
  if (id === 'history') updateHistoryTab();
});

document.getElementById('receive-tab-btn').onclick = () => {
  clearFeeTimer();
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === 'receive'));
  document.getElementById('tab-receive').classList.add('active');
  document.getElementById('tab-send').classList.remove('active');
  document.getElementById('tab-history').classList.remove('active');
};

document.getElementById('send-tab-btn').onclick = () => {
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === 'send'));
  document.getElementById('tab-send').classList.add('active');
  document.getElementById('tab-receive').classList.remove('active');
  document.getElementById('tab-history').classList.remove('active');
};

// ── Address validation ────────────────────────────────────────────────────────
// Verifies checksums where possible (BTC/LTC/DOGE via UTXOCrypto.addressToScript,
// TRX via TronWeb.isAddress) so a typo doesn't get accepted and broadcast.
function validateAddress(address, coinId) {
  if (!address) return 'Recipient address is required';
  if (EVM_GAS[coinId]) {
    if (!ethers.isAddress(address)) return 'Invalid Ethereum address';
    return null;
  }
  if (coinId === 'TRX' || coinId === 'USDT_TRC20') {
    if (!address.startsWith('T') || address.length !== 34) return 'Invalid TRON address (should start with T, 34 chars)';
    try { if (typeof TronWeb !== 'undefined' && !TronWeb.isAddress(address)) return 'Invalid TRON address checksum'; } catch {}
    return null;
  }
  if (coinId === 'BTC') {
    if (!address.startsWith('bc1') && !address.startsWith('1') && !address.startsWith('3'))
      return 'Invalid Bitcoin address';
    try { UTXOCrypto.addressToScript(address, 'bc'); } catch(e) { return 'Invalid Bitcoin address: ' + e.message; }
    return null;
  }
  if (coinId === 'LTC') {
    if (!address.startsWith('ltc1') && !address.startsWith('L') && !address.startsWith('M'))
      return 'Invalid Litecoin address';
    try { UTXOCrypto.addressToScript(address, 'ltc'); } catch(e) { return 'Invalid Litecoin address: ' + e.message; }
    return null;
  }
  if (coinId === 'DOGE') {
    if (!address.startsWith('D') || address.length < 26 || address.length > 36)
      return 'Invalid Dogecoin address';
    try { UTXOCrypto.addressToScript(address, null); } catch(e) { return 'Invalid Dogecoin address: ' + e.message; }
    return null;
  }
  if (coinId === 'XMR') {
    // Standard mainnet (4...) and subaddress (8...) are 95 chars; integrated
    // addresses (4...) carrying an embedded 8-byte payment ID are 106 chars.
    if (!address.startsWith('4') && !address.startsWith('8')) return 'Invalid Monero address';
    if (address.length !== 95 && address.length !== 106) return 'Invalid Monero address (wrong length)';
    return null;
  }
  if (coinId === 'SOL') {
    try {
      if (typeof solanaWeb3 === 'undefined') return null; // lib not loaded yet — skip
      const pk = new solanaWeb3.PublicKey(address);
      if (!solanaWeb3.PublicKey.isOnCurve(pk.toBytes())) return 'Invalid Solana address';
      return null;
    } catch { return 'Invalid Solana address'; }
  }
  return null;
}

// ── Send ──────────────────────────────────────────────────────────────────────
// Paste / Scan recipient address. Reuses QrScanner.extractAddress to strip
// any URI prefix (bitcoin:, ethereum:, etc.).
async function pasteAddress(inputEl) {
  // Capacitor / iOS WebViews and many Android builds block
  // navigator.clipboard.readText() unless the page is focused AND the host
  // app has clipboard permission. Try the modern API first, then fall back
  // to focusing the field and instructing the user to long-press paste.
  try {
    if (navigator.clipboard?.readText) {
      const text = await navigator.clipboard.readText();
      const cleaned = window.QrScanner ? QrScanner.extractAddress(text) : (text || '').trim();
      if (!cleaned) { toast('Clipboard is empty'); return; }
      inputEl.value = cleaned;
      return;
    }
  } catch { /* fall through */ }
  // Fallback: focus + select so the user can long-press → Paste from the
  // native context menu. We can't trigger it programmatically.
  inputEl.focus();
  inputEl.select();
  toast('Long-press the address field, then tap Paste');
}
async function scanAddress(inputEl) {
  if (!window.QrScanner) { toast('Scanner unavailable'); return; }
  try {
    const text = await QrScanner.open();
    inputEl.value = QrScanner.extractAddress(text);
  } catch (e) {
    if (e.message === 'Cancelled') return;
    const msg = (e.message || '').toLowerCase();
    if (msg.includes('permission') || msg.includes('denied') || msg.includes('not allowed')) {
      // Capacitor APK needs CAMERA in AndroidManifest. Reinstalling the
      // SAME APK doesn't add it; the wallet must be rebuilt locally.
      toast('Camera permission missing. If using the installed app, rebuild the APK (npm run sync). For now, use the clipboard button.', 6000);
    } else if (msg.includes('not available') || msg.includes('not found')) {
      toast('No camera available on this device');
    } else {
      toast(e.message || 'Scan failed');
    }
  }
}
document.getElementById('paste-addr').onclick = () => pasteAddress(document.getElementById('send-to'));
document.getElementById('scan-addr').onclick = () => scanAddress(document.getElementById('send-to'));
// Expose so home.js's wallet-view send can reuse the same logic.
window.pasteAddress = pasteAddress;
window.scanAddress = scanAddress;

document.getElementById('send-max-btn').onclick = () => {
  const coin = COINS.find(c => c.id === state.active);
  const balance = parseFloat(state.balances[coin.id] || '0');
  if (balance <= 0) return;
  const feeRow = document.getElementById('send-fee-row');
  const g = EVM_GAS[coin.id];
  if (g && !g.token && feeRow.dataset.fee) {
    // Match the buffer used in pre-send validation: 1.5x on rollups, 1.2x on L1
    const isRollup = feeRow.dataset.rollup === '1';
    const buffer = isRollup ? 1.5 : 1.2;
    const fee = parseFloat(feeRow.dataset.fee) * buffer;
    document.getElementById('send-amount').value = Math.max(0, balance - fee).toFixed(6);
  } else {
    document.getElementById('send-amount').value = balance.toString();
  }
};

// Pre-validate EVM gas before sending. Throws with a user-friendly message
// when the gas balance or native balance won't cover the tx + fee, so both
// the coin-detail and wallet-view send paths share the same guard rails.
async function validateEvmGas(coinId, amt) {
  const g = EVM_GAS[coinId];
  if (!g) return;
  const feeInfo = await estimateEvmFee(coinId).catch(() => null);
  if (!feeInfo) return; // Flaky RPC — let the chain reject downstream
  const buffer = feeInfo.isRollup ? 1.5 : 1.2;
  const fee = parseFloat(feeInfo.fee) * buffer;
  let feeBal = state.balances[feeInfo.feeId];
  if (feeBal === undefined) {
    const addr = state.addresses[coinId];
    feeBal = g.chain === 'ETH'
      ? await EthereumWallet.getETHBalance(addr)
      : await EVMChains.getNative(addr, g.chain);
  }
  if (parseFloat(feeBal) < fee) {
    const needed = (fee - parseFloat(feeBal || '0')).toFixed(6).replace(/\.?0+$/, '');
    throw new Error(
      `Need ~${fee.toFixed(6)} ${feeInfo.symbol} for gas (have ${feeBal}). ` +
      `Top up at least ${needed} ${feeInfo.symbol} on this chain to send.`
    );
  }
  if (!g.token) {
    const bal = parseFloat(state.balances[coinId] || '0');
    if (parseFloat(amt) + fee > bal) {
      const coin = COINS.find(c => c.id === coinId);
      throw new Error(`Insufficient balance for gas. Max sendable: ~${Math.max(0, bal - fee).toFixed(6)} ${coin?.symbol || coinId}`);
    }
  }
}
window.validateEvmGas = validateEvmGas;

document.getElementById('do-send-btn').onclick = async () => {
  const coin = COINS.find(c => c.id === state.active);
  const to  = document.getElementById('send-to').value.trim();
  const amt = document.getElementById('send-amount').value.trim();
  if (!to || !amt || parseFloat(amt) <= 0) { toast('Enter a valid address and amount.'); return; }
  const addrErr = validateAddress(to, coin.id);
  if (addrErr) { toast(addrErr); return; }
  const feeText = document.getElementById('send-fee-display')?.textContent || '';
  const showFee = feeText && feeText !== '—' && feeText !== 'Estimating…';
  // Show the full address so a clipboard-poisoning swap is visible.
  const ok = await confirmModal({
    title: 'Confirm Send',
    lines: [
      ['Amount', `${amt} ${coin.symbol}`],
      ['To', to, { code: true }],
      ...(showFee ? [['Network fee', feeText]] : []),
    ],
    confirmLabel: 'Send',
  });
  if (!ok) return;

  // Require biometric / password before broadcasting — guards against shoulder-surfing
  // and accidental sends if someone grabs the unlocked phone.
  if (typeof verifyAuth === 'function') {
    try {
      await verifyAuth(`Confirm sending ${amt} ${coin.symbol}`);
    } catch {
      toast('Send cancelled');
      return;
    }
  }

  const btn = document.getElementById('do-send-btn');
  btn.disabled = true; btn.textContent = 'Sending…';
  try {
    await validateEvmGas(coin.id, amt);
    const txid = await coin.send(state.mnemonic, to, amt);
    toast(`Sent! TX: ${String(txid).slice(0, 20)}…`);
    if (typeof TxProgress !== 'undefined') TxProgress.track(coin.id, txid, 'send', amt);
    if (typeof Inbox !== 'undefined') Inbox.add({
      type: 'send',
      title: `${coin.symbol} withdrawal complete`,
      network: coin.category,
      subtitle: `Sent ${amt} ${coin.symbol} to ${to.slice(0, 8)}…${to.slice(-6)}`,
    });
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
document.getElementById('lock-btn').onclick = async () => {
  const ok = typeof confirmModal === 'function'
    ? await confirmModal({
        title: 'Lock Wallet',
        lines: [
          ['Status', 'Your encrypted wallet stays on this device.'],
          ['Next',   'You will need your password to unlock again.'],
        ],
        confirmLabel: 'Lock',
      })
    : window.confirm('Lock wallet? Your encrypted wallet stays on this device. Enter your password to unlock again.');
  if (!ok) return;
  clearFeeTimer();
  if (typeof TxProgress !== 'undefined') TxProgress.stop();
  if (typeof AaveEarn !== 'undefined') AaveEarn.stopApyRefresh();
  state.mnemonic = null;
  // Wipe ALL session state so prices / aave APYs / addresses from this
  // session don't leak into the next unlock.
  Object.assign(state, {
    addresses: {}, balances: {}, extras: {}, prices: {}, aaveApy: {},
    active: 'BTC',
  });
  document.getElementById('app').style.display = 'none';
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
  <div style="font-size:13px;font-weight:600;margin-bottom:6px">Legacy ETH Recovery</div>
  <p style="font-size:12px;color:var(--text2);margin-bottom:10px">A previous version of this wallet derived ETH addresses differently. If you sent ETH to an old address, sweep it to your current address here.</p>
  <div id="legacy-recovery-area" style="font-size:13px;color:var(--text2);margin-bottom:16px">Checking legacy address…</div>
</div>
<div style="padding-top:8px;border-top:1px solid var(--border)">
  <button class="btn btn-danger" onclick="confirmResetWallet()" style="width:100%;font-size:13px">Remove Wallet from this Device</button>
</div>`;
  document.getElementById('settings-coin-list').innerHTML = html;
  loadLegacyRecovery();
}

function confirmResetWallet() {
  if (confirm('Permanently remove this wallet from the device? Make absolutely sure your recovery phrase is backed up.')) {
    localStorage.clear(); location.reload();
  }
}

async function loadLegacyRecovery() {
  if (!state.mnemonic) return;
  const area = document.getElementById('legacy-recovery-area');
  if (!area) return;
  try {
    const { address: legacyAddr } = await EthereumWallet.deriveLegacyAddress(state.mnemonic);
    const bal = await EthereumWallet.getETHBalance(legacyAddr);
    const balNum = parseFloat(bal);
    const shortAddr = `${legacyAddr.slice(0, 10)}…${legacyAddr.slice(-8)}`;
    if (balNum <= 0) {
      area.innerHTML = `<span style="color:var(--text2)">Legacy address <code style="font-size:11px">${shortAddr}</code> — no ETH found.</span>`;
      return;
    }
    area.innerHTML = `
      <div style="background:var(--surface2);border-radius:8px;padding:10px 12px;margin-bottom:10px">
        <div style="font-size:11px;color:var(--text2);margin-bottom:4px">Legacy address</div>
        <code style="font-size:11px;word-break:break-all">${legacyAddr}</code>
      </div>
      <div style="font-size:14px;font-weight:600;margin-bottom:10px;color:#f97316">Found: ${bal} ETH</div>
      <button class="btn btn-primary btn-sm" id="sweep-legacy-btn" style="width:100%">
        Sweep ${bal} ETH → current wallet
      </button>`;
    document.getElementById('sweep-legacy-btn').onclick = async () => {
      const btn = document.getElementById('sweep-legacy-btn');
      if (typeof verifyAuth === 'function') {
        try { await verifyAuth(`Sweep ${bal} ETH from legacy address`); }
        catch { toast('Sweep cancelled'); return; }
      }
      btn.disabled = true; btn.textContent = 'Sending…';
      try {
        const txid = await EthereumWallet.sweepLegacy(state.mnemonic);
        area.innerHTML = `<div style="color:#22c55e;font-size:13px">Swept! TX: ${String(txid).slice(0, 22)}…<br><span style="color:var(--text2);font-size:12px">ETH balance will update shortly.</span></div>`;
        setTimeout(refreshBalances, 15000);
      } catch(e) {
        btn.disabled = false; btn.textContent = `Sweep ${bal} ETH → current wallet`;
        toast(`Error: ${e.message}`);
      }
    };
  } catch(e) {
    const el = document.getElementById('legacy-recovery-area');
    if (el) el.innerHTML = `<span style="color:var(--text2);font-size:12px">Error: ${e.message}</span>`;
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

  // If the newly enabled asset earns yield via Aave, kick an APY refresh
  // immediately so the badge appears right away instead of waiting for
  // the next 5-minute tick.
  if (typeof AaveEarn !== 'undefined' && AaveEarn.isSupported?.(id)) {
    AaveEarn.refreshAllApys?.().catch(() => {});
  }

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

// ── Fee polling ───────────────────────────────────────────────────────────────
let _feeTimer = null;
function clearFeeTimer() { clearInterval(_feeTimer); _feeTimer = null; }

async function refreshFeeDisplay(coinId) {
  const feeRow     = document.getElementById('send-fee-row');
  const feeDisplay = document.getElementById('send-fee-display');
  if (!feeRow || !feeDisplay) return;
  if (!document.getElementById('tab-send')?.classList.contains('active')) { clearFeeTimer(); return; }
  try {
    const info = await estimateEvmFee(coinId);
    if (!info) return;
    feeDisplay.textContent = `~${info.fee} ${info.symbol}`;
    feeRow.dataset.fee    = info.fee;
    feeRow.dataset.feeId  = info.feeId;
    feeRow.dataset.rollup = info.isRollup ? '1' : '0';
  } catch {}
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

// Auto-refresh balances every 60 s, prices every 5 min while wallet is unlocked.
// Tick body is a no-op when locked (state.mnemonic check), so leaving the
// interval running across lock is cheaper than tearing down and restarting.
setInterval(() => { if (state.mnemonic) refreshBalances(); }, 60000);
setInterval(() => { if (state.mnemonic) fetchPrices(); }, 300000);

// ── Bootstrap ─────────────────────────────────────────────────────────────────
// Wait for all scripts to load (settings.js, home.js) before deciding which
// screen to show — otherwise window.biometricEnabled isn't defined yet and
// the biometric button is missing from the unlock screen.
function bootApp() {
  const legacy = localStorage.getItem('wallet_mnemonic');
  if (legacy) { showMigratePassword(legacy); return; }
  const encrypted = localStorage.getItem('wallet_encrypted');
  if (encrypted) { showUnlock(); } else { showSetup(); }
}
if (document.readyState === 'complete') {
  bootApp();
} else {
  window.addEventListener('load', bootApp);
}
