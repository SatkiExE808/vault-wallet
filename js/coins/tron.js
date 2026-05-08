const TronWallet = (() => {
  const TRONGRID = 'https://api.trongrid.io';
  const USDT_TRC20 = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';

  // Set a TronGrid API key here for higher rate limits. Empty string would still
  // count against the unauthenticated quota AND get rejected by some proxies, so we
  // omit the header entirely when no key is configured.
  const TRONGRID_API_KEY = '';

  function getTronWeb(privateKey = null) {
    const config = { fullHost: TRONGRID };
    if (TRONGRID_API_KEY) config.headers = { 'TRON-PRO-API-KEY': TRONGRID_API_KEY };
    if (privateKey) config.privateKey = privateKey;
    return new TronWeb(config);
  }

  async function getTRXBalance(address) {
    try {
      const tw = getTronWeb();
      const bal = await tw.trx.getBalance(address);
      return (bal / 1e6).toFixed(6);
    } catch { return '0.000000'; }
  }

  async function getUSDTBalance(address) {
    try {
      const tw = getTronWeb();
      const contract = await tw.contract().at(USDT_TRC20);
      const bal = await contract.balanceOf(address).call();
      return (Number(bal) / 1e6).toFixed(2);
    } catch { return '0.00'; }
  }

  async function sendUSDT(privateKey, toAddress, amount) {
    const tw = getTronWeb(privateKey);
    const contract = await tw.contract().at(USDT_TRC20);
    const tx = await contract.transfer(
      toAddress,
      Math.floor(amount * 1e6)
    ).send();
    return tx;
  }

  async function sendTRX(privateKey, toAddress, amount) {
    const tw = getTronWeb(privateKey);
    const tx = await tw.trx.sendTransaction(toAddress, Math.floor(amount * 1e6));
    return tx.transaction?.txID || tx.txid;
  }

  function privateKeyToTronAddress(privateKey) {
    try {
      const tw = getTronWeb();
      return tw.address.fromPrivateKey(privateKey.replace('0x', ''));
    } catch { return null; }
  }

  async function derivePrivateKey(mnemonic) {
    const child = ethers.HDNodeWallet.fromPhrase(mnemonic, undefined, "m/44'/195'/0'/0/0");
    return child.privateKey.replace('0x', '');
  }

  async function deriveAddress(mnemonic) {
    try {
      const pk = await derivePrivateKey(mnemonic);
      return privateKeyToTronAddress(pk);
    } catch(e) { console.error('TRX derive:', e); return null; }
  }

  async function getTRXHistory(address) {
    const r = await fetch(`${TRONGRID}/v1/accounts/${address}/transactions?limit=20&only_confirmed=true`, { signal: AbortSignal.timeout(10000) });
    const j = await r.json();
    return (j.data || [])
      .filter(tx => tx.raw_data?.contract?.[0]?.type === 'TransferContract')
      .map(tx => {
        const val  = tx.raw_data.contract[0].parameter.value;
        const from = TronWeb.address.fromHex(val.owner_address);
        return {
          hash: tx.txID, type: from === address ? 'send' : 'receive',
          amount: (val.amount / 1e6).toFixed(6),
          time: tx.block_timestamp, confirmed: true, status: 'ok',
          explorerUrl: `https://tronscan.org/#/transaction/${tx.txID}`,
        };
      });
  }

  async function getUSDTHistory(address) {
    const r = await fetch(`${TRONGRID}/v1/accounts/${address}/transactions/trc20?limit=20&contract_address=${USDT_TRC20}`, { signal: AbortSignal.timeout(10000) });
    const j = await r.json();
    return (j.data || []).map(tx => ({
      hash: tx.transaction_id, type: tx.from === address ? 'send' : 'receive',
      amount: (Number(tx.value) / 1e6).toFixed(2),
      time: tx.block_timestamp, confirmed: true, status: 'ok',
      explorerUrl: `https://tronscan.org/#/transaction/${tx.transaction_id}`,
    }));
  }

  return { getTRXBalance, getUSDTBalance, sendUSDT, sendTRX, privateKeyToTronAddress, deriveAddress, derivePrivateKey, getTRXHistory, getUSDTHistory };
})();
