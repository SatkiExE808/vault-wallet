const EthereumWallet = (() => {
  const ETH_RPCS = [
    'https://eth.llamarpc.com',
    'https://ethereum.publicnode.com',
    'https://rpc.flashbots.net',
  ];

  async function rpcCall(method, params) {
    for (const url of ETH_RPCS) {
      try {
        const res = await fetch(url, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
          signal: AbortSignal.timeout(8000),
        });
        const j = await res.json();
        if (j.error) throw new Error(j.error.message || 'RPC error');
        return j.result;
      } catch(e) {
        // Only retry on network/timeout errors, not RPC application errors
        if (!(e instanceof TypeError) && e.name !== 'AbortError') throw e;
      }
    }
    throw new Error('Network error: all ETH RPC endpoints failed');
  }

  const TOKENS = {
    USDT: { address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', decimals: 6 },
    USDC: { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6 },
  };

  // Defensive ceiling on gas price (5000 gwei is well above any historical
  // legitimate ETH spike). A misbehaving RPC could otherwise quote an absurd
  // gasPrice and silently burn the user's ETH on fees.
  // 500 gwei × 21k gas = 0.0105 ETH, ~$30 at $3k. Real honest spikes
  // above this are extremely rare; a malicious RPC quoting just under
  // the old 5000 cap could otherwise burn ~$300 of ETH per send with
  // no user-visible warning.
  const MAX_GWEI = 500;
  function _capGasPrice(gasPriceWei) {
    const capWei = ethers.parseUnits(String(MAX_GWEI), 'gwei');
    if (gasPriceWei > capWei) {
      throw new Error(`ETH gas price unreasonably high (${ethers.formatUnits(gasPriceWei,'gwei')} gwei > ${MAX_GWEI} cap). RPC may be misbehaving — refusing to sign.`);
    }
    return gasPriceWei;
  }

  async function getETHBalance(address) {
    try {
      const hex = await rpcCall('eth_getBalance', [address, 'latest']);
      return parseFloat(ethers.formatEther(BigInt(hex))).toFixed(6);
    } catch { return '0.000000'; }
  }

  async function getTokenBalance(address, token) {
    try {
      const t = TOKENS[token];
      const data = '0x70a08231' + address.slice(2).padStart(64, '0');
      const hex = await rpcCall('eth_call', [{ to: t.address, data }, 'latest']);
      return parseFloat(ethers.formatUnits(BigInt(hex), t.decimals)).toFixed(2);
    } catch { return '0.00'; }
  }

  async function estimateFee(isToken = false) {
    const gasPriceHex = await rpcCall('eth_gasPrice', []);
    const gasPrice = _capGasPrice(BigInt(gasPriceHex));
    const gasLimit = isToken ? 100000n : 21000n;
    const gweiVal  = parseFloat(ethers.formatUnits(gasPrice, 'gwei'));
    const gwei     = gweiVal < 1 ? gweiVal.toFixed(3) : gweiVal < 100 ? gweiVal.toFixed(1) : gweiVal.toFixed(0);
    return { fee: parseFloat(ethers.formatEther(gasPrice * gasLimit)).toFixed(6), symbol: 'ETH', gwei, isRollup: false };
  }

  async function sendETH(privateKey, toAddress, amount) {
    const wallet = new ethers.Wallet(privateKey);
    const [nonceHex, gasPriceHex] = await Promise.all([
      rpcCall('eth_getTransactionCount', [wallet.address, 'pending']),
      rpcCall('eth_gasPrice', []),
    ]);
    const gasPrice = _capGasPrice(BigInt(gasPriceHex));
    const tx = ethers.Transaction.from({
      to: toAddress, value: ethers.parseEther(String(amount)),
      nonce: parseInt(nonceHex, 16), gasPrice,
      gasLimit: 21000, chainId: 1,
    });
    return rpcCall('eth_sendRawTransaction', [await wallet.signTransaction(tx)]);
  }

  async function sendToken(privateKey, toAddress, amount, token) {
    const t = TOKENS[token];
    const wallet = new ethers.Wallet(privateKey);
    const data = new ethers.Interface(['function transfer(address,uint256)']).encodeFunctionData(
      'transfer', [toAddress, ethers.parseUnits(String(amount), t.decimals)]
    );
    const [nonceHex, gasPriceHex] = await Promise.all([
      rpcCall('eth_getTransactionCount', [wallet.address, 'pending']),
      rpcCall('eth_gasPrice', []),
    ]);
    // eth_estimateGas instead of hardcoded 100000 — some tokens
    // (USDT with hooks, fee-on-transfer, etc.) need more gas, and
    // hardcoding caused silent underpayment for those edge cases.
    let gasLimit = 100000n;
    try {
      const est = await rpcCall('eth_estimateGas', [{
        from: wallet.address, to: t.address, data,
      }]);
      gasLimit = BigInt(est) * 12n / 10n;  // 20% buffer over simulated estimate
    } catch { /* fall back to 100k */ }
    const gasPrice = _capGasPrice(BigInt(gasPriceHex));
    const tx = ethers.Transaction.from({
      to: t.address, data,
      nonce: parseInt(nonceHex, 16), gasPrice,
      gasLimit, chainId: 1,
    });
    return rpcCall('eth_sendRawTransaction', [await wallet.signTransaction(tx)]);
  }

  // BIP39 passphrase ("25th word"), pulled from app state at derive time.
  // '' means no passphrase, which yields the standard derivation.
  function _pp() { return (typeof window !== 'undefined' && window.getPassphrase) ? window.getPassphrase() : ''; }

  async function deriveAddress(mnemonic) {
    return ethers.Wallet.fromPhrase(mnemonic, _pp()).address;
  }

  async function derivePrivateKey(mnemonic) {
    return ethers.Wallet.fromPhrase(mnemonic, _pp()).privateKey;
  }

  // Old bug: HDNodeWallet.fromPhrase already derives at m/44'/60'/0'/0/0,
  // then calling .derivePath("m/44'/60'/0'/0/0") on it re-derives relative to that node,
  // ending up at m/44'/60'/0'/0/0/44'/60'/0'/0/0 — a non-standard address.
  async function deriveLegacyAddress(mnemonic) {
    // fromPhrase() lands at m/44'/60'/0'/0/0 (the default path).
    // The old bug then called .derivePath("m/44'/60'/0'/0/0") on that node,
    // which re-derives 44'/60'/0'/0/0 relative to the current node,
    // ending at m/44'/60'/0'/0/0/44'/60'/0'/0/0.
    const mid = ethers.HDNodeWallet.fromPhrase(mnemonic, _pp());
    const legacy = mid.derivePath("44'/60'/0'/0/0");
    return { address: legacy.address, privateKey: legacy.privateKey };
  }

  async function sweepLegacy(mnemonic) {
    const { address: legacyAddr, privateKey } = await deriveLegacyAddress(mnemonic);
    const currentAddr = await deriveAddress(mnemonic);
    const balHex = await rpcCall('eth_getBalance', [legacyAddr, 'latest']);
    const balWei = BigInt(balHex);
    const gasPriceHex = await rpcCall('eth_gasPrice', []);
    const gasPrice = _capGasPrice(BigInt(gasPriceHex));
    const gasLimit = 21000n;
    const gasCost = gasPrice * gasLimit;
    if (balWei <= gasCost) throw new Error('Balance too low to cover gas fee');
    const valueWei = balWei - gasCost;
    const nonceHex = await rpcCall('eth_getTransactionCount', [legacyAddr, 'pending']);
    const wallet = new ethers.Wallet(privateKey);
    const tx = ethers.Transaction.from({
      to: currentAddr, value: valueWei,
      nonce: parseInt(nonceHex, 16), gasPrice,
      gasLimit: 21000, chainId: 1,
    });
    return rpcCall('eth_sendRawTransaction', [await wallet.signTransaction(tx)]);
  }

  return { getETHBalance, getTokenBalance, estimateFee, sendETH, sendToken, deriveAddress, derivePrivateKey, deriveLegacyAddress, sweepLegacy };
})();
