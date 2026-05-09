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

  function _toSun(amount, decimals = 6) {
    const n = Number(amount);
    if (!Number.isFinite(n) || n <= 0) throw new Error('Invalid amount');
    const sun = Math.floor(n * Math.pow(10, decimals));
    if (sun <= 0) throw new Error('Amount too small (must be at least 1 sun)');
    return sun;
  }

  async function sendUSDT(privateKey, toAddress, amount) {
    const tw = getTronWeb(privateKey);
    const contract = await tw.contract().at(USDT_TRC20);
    const tx = await contract.transfer(toAddress, _toSun(amount, 6)).send();
    return tx;
  }

  async function sendTRX(privateKey, toAddress, amount) {
    const tw = getTronWeb(privateKey);
    const tx = await tw.trx.sendTransaction(toAddress, _toSun(amount, 6));
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

  // ── Native staking (Stake 2.0 / TIP-491) ──────────────────────────
  // Freeze TRX to gain ENERGY (cheap USDT transfers) or BANDWIDTH.
  // Unbonding period: 14 days.
  async function getStakeInfo(address) {
    try {
      const tw = getTronWeb();
      const acc = await tw.trx.getAccount(address);
      const byResource = { ENERGY: 0, BANDWIDTH: 0 };
      for (const f of (acc.frozenV2 || [])) {
        const key = (f.type === 'ENERGY' || f.type === 1) ? 'ENERGY' : 'BANDWIDTH';
        byResource[key] += Number(f.amount || 0);
      }
      const pending = (acc.unfrozenV2 || []).map(u => ({
        amount: Number(u.unfreeze_amount || 0) / 1e6,
        expireMs: Number(u.unfreeze_expire_time || 0),
        resource: (u.type === 'ENERGY' || u.type === 1) ? 'ENERGY' : 'BANDWIDTH',
      }));
      return {
        energy: byResource.ENERGY / 1e6,
        bandwidth: byResource.BANDWIDTH / 1e6,
        totalFrozen: (byResource.ENERGY + byResource.BANDWIDTH) / 1e6,
        pending,
      };
    } catch { return { energy: 0, bandwidth: 0, totalFrozen: 0, pending: [] }; }
  }

  async function _signAndBroadcast(tw, unsigned) {
    const signed = await tw.trx.sign(unsigned);
    const result = await tw.trx.sendRawTransaction(signed);
    if (result.code) throw new Error(result.message || result.code);
    return result.txid || result.transaction?.txID;
  }

  async function freezeTRX(mnemonic, amount, resource = 'ENERGY') {
    const pk = await derivePrivateKey(mnemonic);
    const tw = getTronWeb(pk);
    const owner = privateKeyToTronAddress(pk);
    const sun = Math.floor(Number(amount) * 1e6);
    if (!Number.isFinite(sun) || sun <= 0) throw new Error('Invalid amount');
    const unsigned = await tw.transactionBuilder.freezeBalanceV2(sun, resource, owner);
    return _signAndBroadcast(tw, unsigned);
  }

  async function unfreezeTRX(mnemonic, amount, resource = 'ENERGY') {
    const pk = await derivePrivateKey(mnemonic);
    const tw = getTronWeb(pk);
    const owner = privateKeyToTronAddress(pk);
    const sun = Math.floor(Number(amount) * 1e6);
    if (!Number.isFinite(sun) || sun <= 0) throw new Error('Invalid amount');
    const unsigned = await tw.transactionBuilder.unfreezeBalanceV2(sun, resource, owner);
    return _signAndBroadcast(tw, unsigned);
  }

  async function withdrawUnfrozenTRX(mnemonic) {
    const pk = await derivePrivateKey(mnemonic);
    const tw = getTronWeb(pk);
    const owner = privateKeyToTronAddress(pk);
    const unsigned = await tw.transactionBuilder.withdrawExpireUnfreeze(owner);
    return _signAndBroadcast(tw, unsigned);
  }

  // ── SR voting & rewards ──────────────────────────────────────────
  // Each frozen TRX gives 1 TRON Power that can be allocated across
  // Super Representatives. Voting earns ~3–5% APY claimable via
  // withdrawBlockRewards (24h cooldown between claims).
  async function getVotingInfo(address) {
    try {
      const tw = getTronWeb();
      const [acc, rewardSun] = await Promise.all([
        tw.trx.getAccount(address),
        tw.trx.getReward(address).catch(() => 0),
      ]);
      const tronPower = (acc.frozenV2 || []).reduce((s, f) => s + Number(f.amount || 0), 0) / 1e6;
      const votesUsed = (acc.votes || []).reduce((s, v) => s + Number(v.vote_count || 0), 0);
      const currentVotes = (acc.votes || []).map(v => ({
        srAddress: TronWeb.address.fromHex(v.vote_address),
        voteCount: Number(v.vote_count),
      }));
      return {
        tronPower,
        tronPowerUsed: votesUsed,
        tronPowerAvailable: Math.max(0, tronPower - votesUsed),
        currentVotes,
        claimableRewards: Number(rewardSun) / 1e6,
      };
    } catch { return { tronPower: 0, tronPowerUsed: 0, tronPowerAvailable: 0, currentVotes: [], claimableRewards: 0 }; }
  }

  // Stacks a new vote on top of existing ones. TRON's vote() overwrites
  // all votes, so we merge with the current set to preserve them.
  async function voteForSR(mnemonic, srAddress, voteCount) {
    const pk = await derivePrivateKey(mnemonic);
    const tw = getTronWeb(pk);
    const owner = privateKeyToTronAddress(pk);
    const acc = await tw.trx.getAccount(owner);
    const merged = {};
    for (const v of (acc.votes || [])) {
      const addr = TronWeb.address.fromHex(v.vote_address);
      merged[addr] = Number(v.vote_count || 0);
    }
    const count = Math.floor(Number(voteCount));
    if (!Number.isFinite(count) || count <= 0) throw new Error('Invalid vote count');
    merged[srAddress] = (merged[srAddress] || 0) + count;
    const unsigned = await tw.transactionBuilder.vote(merged, owner);
    return _signAndBroadcast(tw, unsigned);
  }

  // Replace all current votes with a fresh allocation. Pass an empty
  // object to clear all votes.
  async function setVotes(mnemonic, votesObj) {
    const pk = await derivePrivateKey(mnemonic);
    const tw = getTronWeb(pk);
    const owner = privateKeyToTronAddress(pk);
    const sanitized = {};
    for (const [addr, count] of Object.entries(votesObj || {})) {
      const c = Math.floor(Number(count));
      if (c > 0) sanitized[addr] = c;
    }
    const unsigned = await tw.transactionBuilder.vote(sanitized, owner);
    return _signAndBroadcast(tw, unsigned);
  }

  async function claimRewards(mnemonic) {
    const pk = await derivePrivateKey(mnemonic);
    const tw = getTronWeb(pk);
    const owner = privateKeyToTronAddress(pk);
    const unsigned = await tw.transactionBuilder.withdrawBlockRewards(owner);
    return _signAndBroadcast(tw, unsigned);
  }

  return { getTRXBalance, getUSDTBalance, sendUSDT, sendTRX, privateKeyToTronAddress, deriveAddress, derivePrivateKey, getTRXHistory, getUSDTHistory,
           getStakeInfo, freezeTRX, unfreezeTRX, withdrawUnfrozenTRX,
           getVotingInfo, voteForSR, setVotes, claimRewards };
})();
