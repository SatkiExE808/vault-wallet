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

  const POOL_ABI = [
    'function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external',
    'function withdraw(address asset, uint256 amount, address to) external returns (uint256)',
    'function getReserveData(address asset) external view returns (tuple(uint256 configuration, uint128 liquidityIndex, uint128 currentLiquidityRate, uint128 variableBorrowIndex, uint128 currentVariableBorrowRate, uint128 currentStableBorrowRate, uint40 lastUpdateTimestamp, uint16 id, address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress, address interestRateStrategyAddress, uint128 accruedToTreasury, uint128 unbacked, uint128 isolationModeTotalDebt))',
  ];

  const ERC20_ABI = [
    'function balanceOf(address) view returns (uint256)',
    'function approve(address spender, uint256 amount) returns (bool)',
    'function allowance(address owner, address spender) view returns (uint256)',
  ];

  const _providerCache = {};
  function getProvider(chain) {
    if (!_providerCache[chain]) _providerCache[chain] = new ethers.JsonRpcProvider(RPC[chain]);
    return _providerCache[chain];
  }

  function isSupported(coinId) { return !!SUPPORTED[coinId]; }

  // Returns { apy, deposited, depositedFormatted } or null on failure.
  async function getInfo(coinId, userAddress) {
    const cfg = SUPPORTED[coinId];
    if (!cfg) return null;
    try {
      const provider = getProvider(cfg.chain);
      const pool = new ethers.Contract(POOLS[cfg.chain], POOL_ABI, provider);
      const data = await pool.getReserveData(cfg.underlying);
      const aTokenAddr = data.aTokenAddress;
      const aToken = new ethers.Contract(aTokenAddr, ERC20_ABI, provider);
      const balance = await aToken.balanceOf(userAddress);
      // Aave's currentLiquidityRate is a "ray" (1e27) per-second rate.
      // APY ≈ (1 + ratePerSecond) ^ secondsPerYear − 1.
      const SECONDS_PER_YEAR = 31_536_000;
      const ratePerSec = Number(data.currentLiquidityRate) / 1e27;
      const apy = ((1 + ratePerSec) ** SECONDS_PER_YEAR - 1) * 100;
      const depositedFormatted = ethers.formatUnits(balance, cfg.dec);
      return {
        apy: apy.toFixed(2),
        deposited: balance,
        depositedFormatted: parseFloat(depositedFormatted).toFixed(cfg.dec <= 6 ? 2 : 4),
        aTokenAddress: aTokenAddr,
      };
    } catch (e) { console.error('Aave getInfo:', e); return null; }
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

  return { isSupported, getInfo, supply, withdraw };
})();
