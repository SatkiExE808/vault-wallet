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
        if (j.result !== undefined) return j.result;
      } catch { /* try next */ }
    }
    throw new Error('All ETH RPC endpoints failed');
  }

  const ERC20_ABI = [
    'function balanceOf(address) view returns (uint256)',
    'function decimals() view returns (uint8)',
    'function transfer(address to, uint256 amount) returns (bool)'
  ];

  const TOKENS = {
    USDT: { address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', decimals: 6 },
    USDC: { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6 }
  };

  function getProvider() {
    return new ethers.JsonRpcProvider(ETH_RPCS[0]);
  }

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

  async function sendETH(privateKey, toAddress, amount) {
    const provider = getProvider();
    const wallet = new ethers.Wallet(privateKey, provider);
    const tx = await wallet.sendTransaction({
      to: toAddress,
      value: ethers.parseEther(amount.toString())
    });
    await tx.wait();
    return tx.hash;
  }

  async function sendToken(privateKey, toAddress, amount, token) {
    const provider = getProvider();
    const wallet = new ethers.Wallet(privateKey, provider);
    const contract = new ethers.Contract(TOKENS[token].address, ERC20_ABI, wallet);
    const tx = await contract.transfer(
      toAddress,
      ethers.parseUnits(amount.toString(), TOKENS[token].decimals)
    );
    await tx.wait();
    return tx.hash;
  }

  async function deriveAddress(mnemonic) {
    return ethers.Wallet.fromPhrase(mnemonic).address;
  }

  async function derivePrivateKey(mnemonic) {
    return ethers.Wallet.fromPhrase(mnemonic).privateKey;
  }

  return { getETHBalance, getTokenBalance, sendETH, sendToken, deriveAddress, derivePrivateKey };
})();
