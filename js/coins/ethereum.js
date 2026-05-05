const EthereumWallet = (() => {
  const ETH_RPCS = [
    'https://eth.llamarpc.com',
    'https://rpc.ankr.com/eth',
    'https://ethereum.publicnode.com',
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

  async function getETHBalance(address) {
    const hex = await rpcCall('eth_getBalance', [address, 'latest']);
    return parseFloat(ethers.formatEther(BigInt(hex))).toFixed(6);
  }

  async function getTokenBalance(address, token) {
    const t = TOKENS[token];
    const data = '0x70a08231' + address.slice(2).padStart(64, '0');
    const hex = await rpcCall('eth_call', [{ to: t.address, data }, 'latest']);
    return parseFloat(ethers.formatUnits(BigInt(hex), t.decimals)).toFixed(2);
  }

  async function estimateFee(isToken = false) {
    const gasPriceHex = await rpcCall('eth_gasPrice', []);
    const gasPrice = BigInt(gasPriceHex);
    const gasLimit = isToken ? 65000n : 21000n;
    return { fee: parseFloat(ethers.formatEther(gasPrice * gasLimit)).toFixed(6), symbol: 'ETH' };
  }

  async function sendETH(privateKey, toAddress, amount) {
    const wallet = new ethers.Wallet(privateKey);
    const [nonceHex, gasPriceHex] = await Promise.all([
      rpcCall('eth_getTransactionCount', [wallet.address, 'latest']),
      rpcCall('eth_gasPrice', []),
    ]);
    const tx = ethers.Transaction.from({
      to: toAddress, value: ethers.parseEther(String(amount)),
      nonce: parseInt(nonceHex, 16), gasPrice: BigInt(gasPriceHex),
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
      rpcCall('eth_getTransactionCount', [wallet.address, 'latest']),
      rpcCall('eth_gasPrice', []),
    ]);
    const tx = ethers.Transaction.from({
      to: t.address, data,
      nonce: parseInt(nonceHex, 16), gasPrice: BigInt(gasPriceHex),
      gasLimit: 100000, chainId: 1,
    });
    return rpcCall('eth_sendRawTransaction', [await wallet.signTransaction(tx)]);
  }

  async function deriveAddress(mnemonic) {
    return ethers.Wallet.fromPhrase(mnemonic).address;
  }

  async function derivePrivateKey(mnemonic) {
    return ethers.Wallet.fromPhrase(mnemonic).privateKey;
  }

  return { getETHBalance, getTokenBalance, estimateFee, sendETH, sendToken, deriveAddress, derivePrivateKey };
})();
