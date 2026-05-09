// Multi-chain EVM helpers
const EVMChains = (() => {
  const CHAIN_IDS = {
    ETH: 1, BSC: 56, POLYGON: 137, AVALANCHE: 43114,
    ARBITRUM: 42161, OPTIMISM: 10, BASE: 8453,
  };

  const RPCS = {
    ETH:       ['https://eth.llamarpc.com', 'https://ethereum.publicnode.com', 'https://rpc.flashbots.net'],
    BSC:       ['https://bsc-dataseed.binance.org/', 'https://bsc-dataseed1.binance.org/', 'https://bsc.publicnode.com'],
    POLYGON:   ['https://polygon-rpc.com/', 'https://polygon.publicnode.com'],
    AVALANCHE: ['https://api.avax.network/ext/bc/C/rpc', 'https://avalanche-c-chain-rpc.publicnode.com'],
    ARBITRUM:  ['https://arb1.arbitrum.io/rpc', 'https://arbitrum-one-rpc.publicnode.com'],
    OPTIMISM:  ['https://mainnet.optimism.io', 'https://optimism-rpc.publicnode.com'],
    BASE:      ['https://mainnet.base.org', 'https://base-rpc.publicnode.com'],
  };

  // Token registry — chain key matches RPCS / CHAIN_IDS
  const TOKEN = {
    USDC_ERC20:  { chain: 'ETH',       addr: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', dec: 6  },
    DAI:         { chain: 'ETH',       addr: '0x6B175474E89094C44Da98b954EedeAC495271d0F', dec: 18 },
    USDT_BEP20:  { chain: 'BSC',       addr: '0x55d398326f99059fF775485246999027B3197955', dec: 18 },
    USDC_BEP20:  { chain: 'BSC',       addr: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', dec: 18 },
    USDT_POLY:   { chain: 'POLYGON',   addr: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F', dec: 6  },
    USDC_POLY:   { chain: 'POLYGON',   addr: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', dec: 6  },
    USDT_AVAX:   { chain: 'AVALANCHE', addr: '0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7', dec: 6  },
    USDC_AVAX:   { chain: 'AVALANCHE', addr: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E', dec: 6  },
    ARB:         { chain: 'ARBITRUM',  addr: '0x912CE59144191C1204E64559FE8253a0e49E6548', dec: 18 },
    USDT_ARB:    { chain: 'ARBITRUM',  addr: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', dec: 6  },
    USDC_ARB:    { chain: 'ARBITRUM',  addr: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', dec: 6  },
    OP:          { chain: 'OPTIMISM',  addr: '0x4200000000000000000000000000000000000042', dec: 18 },
    USDT_OPT:    { chain: 'OPTIMISM',  addr: '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58', dec: 6  },
    USDC_OPT:    { chain: 'OPTIMISM',  addr: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', dec: 6  },
    USDT_BASE:   { chain: 'BASE',      addr: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2', dec: 6  },
    USDC_BASE:   { chain: 'BASE',      addr: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', dec: 6  },
  };

  // Rollups (Optimism, Base, Arbitrum) charge an L1 data fee on top of L2 gas.
  // We track these so callers can apply a wider safety buffer.
  const IS_ROLLUP = { ARBITRUM: true, OPTIMISM: true, BASE: true };

  async function rpc(chainKey, method, params) {
    const urls = RPCS[chainKey];
    let lastErr;
    for (const url of urls) {
      try {
        const res = await fetch(url, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
          signal: AbortSignal.timeout(8000),
        });
        const j = await res.json();
        if (j.error) {
          lastErr = new Error(j.error.message || 'RPC error');
          // Retry on rate limit / server error so a single throttled endpoint doesn't kill the call
          const msg = (j.error.message || '').toLowerCase();
          if (msg.includes('rate') || msg.includes('limit') || msg.includes('throttle') ||
              msg.includes('timeout') || msg.includes('busy')) continue;
          throw lastErr;
        }
        return j.result;
      } catch(e) {
        lastErr = e;
        // Network-level errors fall through to next endpoint; programmer errors do not.
        if (!(e instanceof TypeError) && e.name !== 'AbortError' && !/RPC error/i.test(e.message)) throw e;
      }
    }
    throw lastErr || new Error(`Network error: cannot reach ${chainKey} RPC`);
  }

  async function deriveAddress(mnemonic) {
    return ethers.Wallet.fromPhrase(mnemonic).address;
  }

  async function _privateKey(mnemonic) {
    return ethers.Wallet.fromPhrase(mnemonic).privateKey;
  }

  async function getNative(address, chainKey) {
    try {
      const hex = await rpc(chainKey, 'eth_getBalance', [address, 'latest']);
      return parseFloat(ethers.formatEther(BigInt(hex))).toFixed(6);
    } catch { return '0.000000'; }
  }

  async function getToken(address, tokenKey) {
    try {
      const t = TOKEN[tokenKey];
      const data = '0x70a08231' + address.slice(2).padStart(64, '0');
      const hex = await rpc(t.chain, 'eth_call', [{ to: t.addr, data }, 'latest']);
      return parseFloat(ethers.formatUnits(BigInt(hex), t.dec)).toFixed(t.dec <= 6 ? 2 : 4);
    } catch { return '0.00'; }
  }

  async function estimateFee(chainKey, isToken = false) {
    const gasPriceHex = await rpc(chainKey, 'eth_gasPrice', []);
    const gasPrice = BigInt(gasPriceHex);
    const baseGasLimit = isToken ? 100000n : 21000n;
    // On rollups, eth_gasPrice covers only L2 execution. The L1 data fee can equal or
    // exceed the L2 fee, so we use a much higher gas-equivalent for the displayed fee.
    // Callers should also apply at least a 1.5x buffer when validating balance.
    const gasLimit = IS_ROLLUP[chainKey] ? baseGasLimit * 3n : baseGasLimit;
    const symbols  = { BSC: 'BNB', POLYGON: 'POL', AVALANCHE: 'AVAX', ARBITRUM: 'ETH', OPTIMISM: 'ETH', BASE: 'ETH' };
    const gweiVal  = parseFloat(ethers.formatUnits(gasPrice, 'gwei'));
    const gwei     = gweiVal < 1 ? gweiVal.toFixed(3) : gweiVal < 100 ? gweiVal.toFixed(1) : gweiVal.toFixed(0);
    return {
      fee: parseFloat(ethers.formatEther(gasPrice * gasLimit)).toFixed(6),
      symbol: symbols[chainKey] || 'ETH',
      gwei,
      isRollup: !!IS_ROLLUP[chainKey],
    };
  }

  async function sendNative(mnemonic, chainKey, to, amt) {
    const wallet = new ethers.Wallet(await _privateKey(mnemonic));
    const [nonceHex, gasPriceHex] = await Promise.all([
      rpc(chainKey, 'eth_getTransactionCount', [wallet.address, 'pending']),
      rpc(chainKey, 'eth_gasPrice', []),
    ]);
    const tx = ethers.Transaction.from({
      to, value: ethers.parseEther(String(amt)),
      nonce: parseInt(nonceHex, 16), gasPrice: BigInt(gasPriceHex),
      gasLimit: 21000, chainId: CHAIN_IDS[chainKey],
    });
    return rpc(chainKey, 'eth_sendRawTransaction', [await wallet.signTransaction(tx)]);
  }

  async function sendToken(mnemonic, tokenKey, to, amt) {
    const t = TOKEN[tokenKey];
    const wallet = new ethers.Wallet(await _privateKey(mnemonic));
    const data = new ethers.Interface(['function transfer(address,uint256)']).encodeFunctionData(
      'transfer', [to, ethers.parseUnits(String(amt), t.dec)]
    );
    const [nonceHex, gasPriceHex] = await Promise.all([
      rpc(t.chain, 'eth_getTransactionCount', [wallet.address, 'pending']),
      rpc(t.chain, 'eth_gasPrice', []),
    ]);
    const tx = ethers.Transaction.from({
      to: t.addr, data,
      nonce: parseInt(nonceHex, 16), gasPrice: BigInt(gasPriceHex),
      gasLimit: 100000, chainId: CHAIN_IDS[t.chain],
    });
    return rpc(t.chain, 'eth_sendRawTransaction', [await wallet.signTransaction(tx)]);
  }

  return { deriveAddress, getNative, getToken, estimateFee, sendNative, sendToken };
})();
