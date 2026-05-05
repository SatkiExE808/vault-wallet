const TronWallet = (() => {
  const TRONGRID = 'https://api.trongrid.io';
  const USDT_TRC20 = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';

  function getTronWeb(privateKey = null) {
    const config = {
      fullHost: TRONGRID,
      headers: { 'TRON-PRO-API-KEY': '' }
    };
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
    const child = ethers.HDNodeWallet.fromPhrase(mnemonic).derivePath("m/44'/195'/0'/0/0");
    return child.privateKey.replace('0x', '');
  }

  async function deriveAddress(mnemonic) {
    try {
      const pk = await derivePrivateKey(mnemonic);
      return privateKeyToTronAddress(pk);
    } catch(e) { console.error('TRX derive:', e); return null; }
  }

  return { getTRXBalance, getUSDTBalance, sendUSDT, sendTRX, privateKeyToTronAddress, deriveAddress, derivePrivateKey };
})();
