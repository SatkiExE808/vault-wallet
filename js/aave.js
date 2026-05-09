// Aave v3 stablecoin earn integration. Deposits route through the chain's
// Aave Pool contract; aTokens (interest-bearing receipts) are fetched
// dynamically via getReserveData so we don't hardcode addresses that
// could drift between deployments.
//
// Scope: cheap-gas chains only (Polygon / Arbitrum / Optimism / Base /
// BSC). Skipping Ethereum mainnet because gas would eat the yield on
// typical user balances.
const AaveEarn = (() => {
  const POOLS = {
    POLYGON:   '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
    ARBITRUM:  '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
    OPTIMISM:  '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
    AVALANCHE: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
    BASE:      '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5',
    BSC:       '0x6807dc923806fE8Fd134338EABCA509979a7e0cB',
  };

  const RPC = {
    POLYGON:   'https://polygon-rpc.com/',
    ARBITRUM:  'https://arb1.arbitrum.io/rpc',
    OPTIMISM:  'https://mainnet.optimism.io',
    AVALANCHE: 'https://api.avax.network/ext/bc/C/rpc',
    BASE:      'https://mainnet.base.org',
    BSC:       'https://bsc-dataseed.binance.org/',
  };

  // coinId → reserve config. Underlying token addresses are duplicated
  // here on purpose so this module is self-contained.
  const SUPPORTED = {
    USDT_POLY:  { chain: 'POLYGON',   underlying: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F', dec: 6  },
    USDC_POLY:  { chain: 'POLYGON',   underlying: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', dec: 6  },
    USDT_ARB:   { chain: 'ARBITRUM',  underlying: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', dec: 6  },
    USDC_ARB:   { chain: 'ARBITRUM',  underlying: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', dec: 6  },
    USDT_OPT:   { chain: 'OPTIMISM',  underlying: '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58', dec: 6  },
    USDC_OPT:   { chain: 'OPTIMISM',  underlying: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', dec: 6  },
    USDT_AVAX:  { chain: 'AVALANCHE', underlying: '0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7', dec: 6  },
    USDC_AVAX:  { chain: 'AVALANCHE', underlying: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E', dec: 6  },
    USDC_BASE:  { chain: 'BASE',      underlying: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', dec: 6  },
    USDT_BEP20: { chain: 'BSC',       underlying: '0x55d398326f99059fF775485246999027B3197955', dec: 18 },
    USDC_BEP20: { chain: 'BSC',       underlying: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', dec: 18 },
  };

  const CHAIN_IDS = {
    POLYGON: 137, ARBITRUM: 42161, OPTIMISM: 10, AVALANCHE: 43114, BASE: 8453, BSC: 56,
  };

  const POOL_ABI = [
    'function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external',
    'function withdraw(address asset, uint256 amount, address to) external returns (uint256)',
  ];

  const ERC20_ABI = [
    'function balanceOf(address) view returns (uint256)',
    'function approve(address spender, uint256 amount) returns (bool)',
    'function allowance(address owner, address spender) view returns (uint256)',
  ];

  const _providerCache = {};
  function getProvider(chain) {
    if (!_providerCache[chain]) {
      // staticNetwork avoids ethers' auto chain-id probe, which some public
      // RPCs reject or rate-limit and is the most common cause of
      // "Failed to load Aave data" on a fresh modal open.
      const network = ethers.Network.from(CHAIN_IDS[chain]);
      _providerCache[chain] = new ethers.JsonRpcProvider(RPC[chain], network, { staticNetwork: network });
    }
    return _providerCache[chain];
  }

  // Raw eth_call avoids ABI mismatches across Aave v3.0 / v3.1 / v3.2
  // (each version added fields to ReserveData). We only read the slots we
  // care about: currentLiquidityRate (slot 2) and aTokenAddress (slot 8).
  async function rawEthCall(rpcUrl, to, dataHex) {
    const r = await fetch(rpcUrl, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data: dataHex }, 'latest'] }),
      signal: AbortSignal.timeout(12000),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status} from ${new URL(rpcUrl).host}`);
    const j = await r.json();
    if (j.error) throw new Error(j.error.message || 'RPC error');
    return j.result;
  }

  async function readReserve(chain, underlying) {
    const selector = '0x35ea6a75'; // keccak256("getReserveData(address)").slice(0,4)
    const padded = underlying.replace(/^0x/, '').toLowerCase().padStart(64, '0');
    const result = await rawEthCall(RPC[chain], POOLS[chain], selector + padded);
    if (!result || result === '0x') throw new Error('Empty getReserveData response');
    const hex = result.replace(/^0x/, '');
    if (hex.length < 64 * 9) throw new Error(`Short response: ${hex.length} hex chars`);
    const liquidityRate = BigInt('0x' + hex.slice(64 * 2, 64 * 3));
    const aTokenAddr = ethers.getAddress('0x' + hex.slice(64 * 8 + 24, 64 * 9));
    return { liquidityRate, aTokenAddr };
  }

  function isSupported(coinId) { return !!SUPPORTED[coinId]; }

  // Throws on failure so the UI can show the actual error message.
  async function getInfo(coinId, userAddress) {
    const cfg = SUPPORTED[coinId];
    if (!cfg) throw new Error(`Asset ${coinId} not on Aave`);
    const { liquidityRate, aTokenAddr } = await readReserve(cfg.chain, cfg.underlying);
    const provider = getProvider(cfg.chain);
    const aToken = new ethers.Contract(aTokenAddr, ERC20_ABI, provider);
    const balance = await aToken.balanceOf(userAddress);
    return {
      apy: rateToApyPercent(liquidityRate),
      deposited: balance,
      depositedFormatted: parseFloat(ethers.formatUnits(balance, cfg.dec)).toFixed(cfg.dec <= 6 ? 2 : 4),
      aTokenAddress: aTokenAddr,
    };
  }

  // Aave's currentLiquidityRate is the *annualized* rate (APR) in ray (1e27).
  // APY = (1 + APR / secondsPerYear) ^ secondsPerYear − 1.
  // Hardcoded sanity caps catch any chain where the rate is encoded
  // unexpectedly (or where we're reading the wrong slot) — beats showing
  // "Infinity" or a 6-digit nonsense number to the user.
  function rateToApyPercent(liquidityRate) {
    const SECONDS_PER_YEAR = 31_536_000;
    const apr = Number(liquidityRate) / 1e27;
    if (!Number.isFinite(apr) || apr <= 0 || apr > 5) return '0.00'; // 500% APR sanity cap
    const apy = ((1 + apr / SECONDS_PER_YEAR) ** SECONDS_PER_YEAR - 1) * 100;
    if (!Number.isFinite(apy) || apy <= 0 || apy > 200) return '0.00';
    return apy.toFixed(2);
  }

  async function supply(mnemonic, coinId, amount) {
    const cfg = SUPPORTED[coinId];
    if (!cfg) throw new Error('Asset not supported on Aave');
    const provider = getProvider(cfg.chain);
    const wallet = ethers.Wallet.fromPhrase(mnemonic).connect(provider);
    const underlying = new ethers.Contract(cfg.underlying, ERC20_ABI, wallet);
    const pool = new ethers.Contract(POOLS[cfg.chain], POOL_ABI, wallet);
    const amt = ethers.parseUnits(String(amount), cfg.dec);
    const allowance = await underlying.allowance(wallet.address, POOLS[cfg.chain]);
    if (allowance < amt) {
      // USDT contracts on Ethereum and BSC reject approve(spender, X) when
      // the existing allowance is non-zero — requires reset to 0 first.
      // Other ERC-20s allow direct overwrite, but resetting first is harmless.
      if (allowance > 0n) {
        const resetTx = await underlying.approve(POOLS[cfg.chain], 0);
        await resetTx.wait();
      }
      const approveTx = await underlying.approve(POOLS[cfg.chain], ethers.MaxUint256);
      await approveTx.wait();
    }
    const tx = await pool.supply(cfg.underlying, amt, wallet.address, 0);
    return tx.hash;
  }

  // Pass null amount to withdraw the full position (Aave reads MaxUint256).
  async function withdraw(mnemonic, coinId, amount) {
    const cfg = SUPPORTED[coinId];
    if (!cfg) throw new Error('Asset not supported on Aave');
    const provider = getProvider(cfg.chain);
    const wallet = ethers.Wallet.fromPhrase(mnemonic).connect(provider);
    const pool = new ethers.Contract(POOLS[cfg.chain], POOL_ABI, wallet);
    const amt = (amount == null || amount === 'max')
      ? ethers.MaxUint256
      : ethers.parseUnits(String(amount), cfg.dec);
    const tx = await pool.withdraw(cfg.underlying, amt, wallet.address);
    return tx.hash;
  }

  // ── Bulk APY refresh (powers the per-row APY badges) ──────────────
  // Keeps a module-level cache and mirrors it onto state.aaveApy so
  // the home renderer can read it synchronously at draw time.
  const APY_REFRESH_MS = 5 * 60 * 1000;
  let _apyTimer = null;
  let _apyCache = {};

  async function refreshAllApys() {
    const ids = Object.keys(SUPPORTED);
    await Promise.allSettled(ids.map(async id => {
      const cfg = SUPPORTED[id];
      try {
        const { liquidityRate } = await readReserve(cfg.chain, cfg.underlying);
        _apyCache[id] = rateToApyPercent(liquidityRate);
      } catch { /* leave previous value */ }
    }));
    if (typeof state !== 'undefined') state.aaveApy = { ..._apyCache };
    if (typeof updateHome === 'function') updateHome();
  }

  function startApyRefresh() {
    if (_apyTimer) return;
    refreshAllApys().catch(() => {});
    _apyTimer = setInterval(() => refreshAllApys().catch(() => {}), APY_REFRESH_MS);
  }
  function stopApyRefresh() {
    clearInterval(_apyTimer); _apyTimer = null;
    // Drop the cache so re-unlocking with a different mnemonic can't briefly
    // see APYs from the previous session before the next refresh tick.
    _apyCache = {};
    if (typeof state !== 'undefined') state.aaveApy = {};
  }
  function getApy(coinId) { return _apyCache[coinId] || null; }

  return { isSupported, getInfo, supply, withdraw,
           startApyRefresh, stopApyRefresh, refreshAllApys, getApy };
})();
