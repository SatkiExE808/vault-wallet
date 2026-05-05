// Multi-chain EVM helpers — each chain uses its own BIP44 coin type where available
const EVMChains = (() => {
  const ERC20_ABI = [
    'function balanceOf(address) view returns (uint256)',
    'function transfer(address to, uint256 amount) returns (bool)',
  ];

  const CHAINS = {
    // L1s — each has its own registered BIP44 coin type → unique address per chain
    BSC:       { rpc: 'https://bsc-dataseed.binance.org/',            coinType: 60   },
    POLYGON:   { rpc: 'https://polygon-rpc.com/',                     coinType: 60   },
    AVALANCHE: { rpc: 'https://api.avax.network/ext/bc/C/rpc',        coinType: 60   },
    // L2 rollups — no separate BIP44 coin type; they settle on Ethereum and require
    // the same Ethereum private key by design. coinType 60 = same address as ETH.
    ARBITRUM:  { rpc: 'https://arb1.arbitrum.io/rpc',                 coinType: 60   },
    OPTIMISM:  { rpc: 'https://mainnet.optimism.io',                   coinType: 60   },
    BASE:      { rpc: 'https://mainnet.base.org',                      coinType: 60   },
  };

  const ETH_RPC = 'https://cloudflare-eth.com';

  // Token registry — rpc key must match a CHAINS key (or 'ETH' for mainnet)
  const TOKEN = {
    USDC_ERC20:  { rpc: 'ETH',       addr: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', dec: 6  },
    DAI:         { rpc: 'ETH',       addr: '0x6B175474E89094C44Da98b954EedeAC495271d0F', dec: 18 },
    USDT_BEP20:  { rpc: 'BSC',       addr: '0x55d398326f99059fF775485246999027B3197955', dec: 18 },
    USDC_BEP20:  { rpc: 'BSC',       addr: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', dec: 18 },
    USDT_POLY:   { rpc: 'POLYGON',   addr: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F', dec: 6  },
    USDC_POLY:   { rpc: 'POLYGON',   addr: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', dec: 6  },
    USDT_AVAX:   { rpc: 'AVALANCHE', addr: '0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7', dec: 6  },
    USDC_AVAX:   { rpc: 'AVALANCHE', addr: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E', dec: 6  },
    ARB:         { rpc: 'ARBITRUM',  addr: '0x912CE59144191C1204E64559FE8253a0e49E6548', dec: 18 },
    USDT_ARB:    { rpc: 'ARBITRUM',  addr: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', dec: 6  },
    USDC_ARB:    { rpc: 'ARBITRUM',  addr: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', dec: 6  },
    OP:          { rpc: 'OPTIMISM',  addr: '0x4200000000000000000000000000000000000042', dec: 18 },
    USDT_OPT:    { rpc: 'OPTIMISM',  addr: '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58', dec: 6  },
    USDC_OPT:    { rpc: 'OPTIMISM',  addr: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', dec: 6  },
    USDT_BASE:   { rpc: 'BASE',      addr: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2', dec: 6  },
    USDC_BASE:   { rpc: 'BASE',      addr: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', dec: 6  },
  };

  function provider(chainKey) {
    return new ethers.JsonRpcProvider(chainKey === 'ETH' ? ETH_RPC : CHAINS[chainKey].rpc);
  }

  function coinTypeFor(chainKey) {
    return CHAINS[chainKey]?.coinType ?? 60;
  }

  // Derive address using chain-specific BIP44 coin type
  async function deriveAddress(mnemonic, chainKey) {
    const ct = coinTypeFor(chainKey);
    const child = ethers.HDNodeWallet.fromPhrase(mnemonic).derivePath(`m/44'/${ct}'/0'/0/0`);
    return child.address;
  }

  async function _privateKey(mnemonic, chainKey) {
    const ct = coinTypeFor(chainKey);
    const child = ethers.HDNodeWallet.fromPhrase(mnemonic).derivePath(`m/44'/${ct}'/0'/0/0`);
    return child.privateKey;
  }

  async function getNative(address, chainKey) {
    try {
      const bal = await provider(chainKey).getBalance(address);
      return parseFloat(ethers.formatEther(bal)).toFixed(6);
    } catch { return '0.000000'; }
  }

  async function getToken(address, tokenKey) {
    try {
      const t = TOKEN[tokenKey];
      const contract = new ethers.Contract(t.addr, ERC20_ABI, provider(t.rpc));
      const bal = await contract.balanceOf(address);
      return parseFloat(ethers.formatUnits(bal, t.dec)).toFixed(t.dec <= 6 ? 2 : 4);
    } catch { return '0.00'; }
  }

  async function sendNative(mnemonic, chainKey, to, amt) {
    const pk = await _privateKey(mnemonic, chainKey);
    const wallet = new ethers.Wallet(pk, provider(chainKey));
    const tx = await wallet.sendTransaction({ to, value: ethers.parseEther(String(amt)) });
    await tx.wait();
    return tx.hash;
  }

  async function sendToken(mnemonic, tokenKey, to, amt) {
    const t = TOKEN[tokenKey];
    const pk = await _privateKey(mnemonic, t.rpc);
    const wallet = new ethers.Wallet(pk, provider(t.rpc));
    const contract = new ethers.Contract(t.addr, ERC20_ABI, wallet);
    const tx = await contract.transfer(to, ethers.parseUnits(String(amt), t.dec));
    await tx.wait();
    return tx.hash;
  }

  return { deriveAddress, getNative, getToken, sendNative, sendToken };
})();
