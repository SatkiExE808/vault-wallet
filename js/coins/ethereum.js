const EthereumWallet = (() => {
  const INFURA = 'https://mainnet.infura.io/v3/9aa3d95b3bc440fa88ea12eaa4456161';
  const ETHERSCAN = 'https://api.etherscan.io/api';

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
    return new ethers.JsonRpcProvider(INFURA);
  }

  async function getETHBalance(address) {
    try {
      const provider = getProvider();
      const bal = await provider.getBalance(address);
      return parseFloat(ethers.formatEther(bal)).toFixed(6);
    } catch { return '0.000000'; }
  }

  async function getTokenBalance(address, token) {
    try {
      const provider = getProvider();
      const contract = new ethers.Contract(TOKENS[token].address, ERC20_ABI, provider);
      const bal = await contract.balanceOf(address);
      return parseFloat(ethers.formatUnits(bal, TOKENS[token].decimals)).toFixed(2);
    } catch { return '0.00'; }
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
    const child = ethers.HDNodeWallet.fromPhrase(mnemonic).derivePath("m/44'/60'/0'/0/0");
    return child.address;
  }

  async function derivePrivateKey(mnemonic) {
    const child = ethers.HDNodeWallet.fromPhrase(mnemonic).derivePath("m/44'/60'/0'/0/0");
    return child.privateKey;
  }

  return { getETHBalance, getTokenBalance, sendETH, sendToken, deriveAddress, derivePrivateKey };
})();
