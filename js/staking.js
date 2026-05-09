// Staking UI — modal flow for SOL (validator delegation) and TRX (resource freezing).
// Exposes window.openStakeModal(coinId).
const Staking = (() => {
  function el(html) {
    const t = document.createElement('template');
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
  }

  function showModal(html) {
    // Singleton guard: tearing down any existing modal so rapid taps on
    // Stake / Earn don't stack orphan backdrops in the DOM.
    document.querySelectorAll('.modal-backdrop').forEach(el => el.remove());
    const root = document.createElement('div');
    root.className = 'modal-backdrop';
    root.innerHTML = `<div class="modal">${html}</div>`;
    document.body.appendChild(root);
    const close = () => root.remove();
    root.addEventListener('click', e => { if (e.target === root) close(); });
    return { root, close };
  }

  // Render a segmented-control replacement for <select>. Pass an array of
  // { value, label }. Returns { el, getValue, onChange }.
  function segmentedControl(id, options, defaultValue) {
    const html = `<div class="seg-control" id="${id}">${
      options.map(o => `<button type="button" class="seg-btn${o.value === defaultValue ? ' active' : ''}" data-val="${o.value}">${o.label}</button>`).join('')
    }</div>`;
    return html;
  }
  function wireSeg(rootEl, id, onChange) {
    const el = rootEl.querySelector(`#${id}`);
    el.querySelectorAll('.seg-btn').forEach(btn => {
      btn.onclick = e => {
        e.preventDefault();
        if (btn.classList.contains('active')) return;
        el.querySelectorAll('.seg-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        if (onChange) onChange(btn.dataset.val);
      };
    });
    return {
      getValue: () => el.querySelector('.seg-btn.active')?.dataset.val,
    };
  }

  // ── Solana flow ──────────────────────────────────────────────────────
  // Top-level chooser: liquid (JupSOL, set-and-forget) or native (pick a validator).
  async function openSolModal() {
    const addr = state.addresses['SOL'];
    if (!addr) { toast('SOL wallet not loaded'); return; }
    const liquidBal = state.balances['SOL'] ?? '…';

    const { root, close } = showModal(`
      <h2>Stake SOL</h2>
      <p>Choose how you want to stake.</p>
      <div style="background:var(--surface2);border-radius:10px;padding:10px 12px;margin-bottom:14px;font-size:13px">
        <div style="display:flex;justify-content:space-between"><span style="color:var(--text2)">Liquid balance</span><span><b>${liquidBal} SOL</b></span></div>
      </div>
      <div style="display:grid;grid-template-columns:1fr;gap:10px;margin-bottom:14px">
        <button class="btn btn-primary" id="stk-pick-liquid" style="padding:14px;text-align:left">
          <div style="font-size:15px;font-weight:700">Liquid stake (JupSOL)</div>
          <div style="font-size:12px;font-weight:400;opacity:0.92;margin-top:2px">Set-and-forget · auto-managed validators · ~7% APY · instant exit via swap</div>
        </button>
        <button class="btn btn-outline" id="stk-pick-native" style="padding:14px;text-align:left">
          <div style="font-size:15px;font-weight:700">Native stake</div>
          <div style="font-size:12px;font-weight:400;opacity:0.85;margin-top:2px">Pick your own validator · no smart contract · ~3-day unbond</div>
        </button>
      </div>
      <div class="modal-actions" style="grid-template-columns:1fr">
        <button class="btn btn-outline" id="stk-cancel">Close</button>
      </div>
    `);
    root.querySelector('#stk-cancel').onclick = close;
    root.querySelector('#stk-pick-liquid').onclick = () => { close(); openSolLiquidModal(); };
    root.querySelector('#stk-pick-native').onclick = () => { close(); openSolNativeModal(); };
  }

  async function openSolLiquidModal() {
    const addr = state.addresses['SOL'];
    if (!addr) { toast('SOL wallet not loaded'); return; }
    const liquidBal = state.balances['SOL'] ?? '…';

    const { root, close } = showModal(`
      <h2>Liquid Stake (JupSOL)</h2>
      <p>Deposit SOL → receive JupSOL, a tradeable receipt token whose value grows vs SOL as rewards accrue. Unstake any time by swapping back.</p>
      <div style="background:var(--surface2);border-radius:10px;padding:10px 12px;margin-bottom:12px;font-size:13px">
        <div style="display:flex;justify-content:space-between"><span style="color:var(--text2)">Liquid SOL</span><span><b>${liquidBal}</b></span></div>
        <div id="stk-jup-info" style="margin-top:6px;color:var(--text2)">Loading JupSOL position…</div>
      </div>
      <div class="form-group">
        <label>Action</label>
        ${segmentedControl('stk-jup-action', [
          { value: 'stake',   label: 'Stake → JupSOL' },
          { value: 'unstake', label: 'Unstake → SOL' },
        ], 'stake')}
      </div>
      <div class="form-group">
        <label id="stk-jup-amount-label">Amount (SOL)</label>
        <input id="stk-jup-amount" type="number" step="any" min="0" placeholder="0.0">
      </div>
      <div id="stk-jup-err" style="color:var(--red);font-size:13px;min-height:18px;margin-bottom:8px"></div>
      <div class="modal-actions">
        <button class="btn btn-outline" id="stk-jup-back">Back</button>
        <button class="btn btn-primary" id="stk-jup-do">Confirm</button>
      </div>
    `);
    root.querySelector('#stk-jup-back').onclick = () => { close(); openSolModal(); };

    const infoDiv = root.querySelector('#stk-jup-info');
    Promise.all([SolanaWallet.getJupSolBalance(addr), SolanaWallet.getJupSolRate()])
      .then(([bal, rate]) => {
        const balNum = Number(bal);
        const sol = rate ? (balNum * rate).toFixed(6) : null;
        infoDiv.innerHTML = `
          <div>JupSOL balance: <b>${bal}</b>${sol ? ` (≈ ${sol} SOL)` : ''}</div>
          ${rate ? `<div>Rate: 1 JupSOL ≈ ${rate.toFixed(6)} SOL</div>` : ''}
        `;
      });

    const amountLabel = root.querySelector('#stk-jup-amount-label');
    const actionSeg = wireSeg(root, 'stk-jup-action', v => {
      amountLabel.textContent = v === 'stake' ? 'Amount (SOL)' : 'Amount (JupSOL)';
    });

    const errDiv = root.querySelector('#stk-jup-err');
    root.querySelector('#stk-jup-do').onclick = async () => {
      errDiv.textContent = '';
      const action = actionSeg.getValue();
      const amt = root.querySelector('#stk-jup-amount').value.trim();
      if (!amt || parseFloat(amt) <= 0) { errDiv.textContent = 'Enter a valid amount'; return; }
      const verb = action === 'stake' ? 'stake' : 'unstake';
      if (!confirm(`Confirm ${verb} ${amt} ${action === 'stake' ? 'SOL' : 'JupSOL'}?`)) return;
      if (typeof verifyAuth === 'function') {
        try { await verifyAuth(`Confirm ${verb}`); } catch { toast('Cancelled'); return; }
      }
      const btn = root.querySelector('#stk-jup-do');
      btn.disabled = true; btn.textContent = `${verb === 'stake' ? 'Staking' : 'Unstaking'}…`;
      try {
        const sig = action === 'stake'
          ? await SolanaWallet.liquidStakeJupSol(state.mnemonic, amt)
          : await SolanaWallet.liquidUnstakeJupSol(state.mnemonic, amt);
        toast(`Done! TX: ${String(sig).slice(0, 20)}…`);
        if (typeof Inbox !== 'undefined') Inbox.add({
          type: 'stake',
          title: action === 'stake' ? 'JupSOL liquid stake complete' : 'JupSOL unstaked',
          subtitle: action === 'stake'
            ? `${amt} SOL → JupSOL · earning ~7% APY`
            : `${amt} JupSOL → SOL · returned to liquid balance`,
        });
        close();
        // Solana confirms quickly but Jupiter swap balances take 10-20s
        // to settle. Two refreshes catches both fast and slow cases.
        setTimeout(refreshBalances, 6000);
        setTimeout(refreshBalances, 20000);
      } catch (e) { errDiv.textContent = e.message || 'Transaction failed'; btn.disabled = false; btn.textContent = 'Confirm'; }
    };
  }

  async function openSolNativeModal() {
    const addr = state.addresses['SOL'];
    if (!addr) { toast('SOL wallet not loaded'); return; }
    const liquidBal = state.balances['SOL'] ?? '…';

    const { root, close } = showModal(`
      <h2>Stake SOL</h2>
      <p>Delegate to a Solana validator to earn ~6–7% APY. Unbonding takes ~2 epochs (~3 days).</p>
      <div style="background:var(--surface2);border-radius:10px;padding:10px 12px;margin-bottom:12px;font-size:13px">
        <div style="display:flex;justify-content:space-between"><span style="color:var(--text2)">Liquid balance</span><span><b>${liquidBal} SOL</b></span></div>
      </div>
      <div id="stake-list" style="font-size:13px;color:var(--text2);margin-bottom:12px">Loading stake accounts…</div>
      <div class="form-group">
        <label>Validator vote address</label>
        <input id="stk-validator" placeholder="Vote pubkey (e.g. He1iusunGwq…)" autocomplete="off" spellcheck="false">
        <div style="font-size:11px;color:var(--text3);margin-top:4px">
          Find one at <a href="https://stakewiz.com/" target="_blank" style="color:var(--accent)">stakewiz.com</a> or
          <a href="https://solanabeach.io/validators" target="_blank" style="color:var(--accent)">solanabeach.io</a>.
        </div>
      </div>
      <div class="form-group">
        <label>Amount (SOL)</label>
        <input id="stk-amount" type="number" step="any" min="0" placeholder="0.0">
      </div>
      <div id="stk-err" style="color:var(--red);font-size:13px;min-height:18px;margin-bottom:8px"></div>
      <div class="modal-actions">
        <button class="btn btn-outline" id="stk-close">Back</button>
        <button class="btn btn-primary" id="stk-do">Stake</button>
      </div>
    `);
    root.querySelector('#stk-close').onclick = () => { close(); openSolModal(); };

    const listDiv = root.querySelector('#stake-list');
    SolanaWallet.getStakeAccounts(addr).then(accs => {
      if (!accs.length) { listDiv.textContent = 'No stake accounts yet.'; return; }
      listDiv.innerHTML = '<div style="margin-bottom:6px;color:var(--text);font-weight:600">Your stake accounts</div>' +
        accs.map(a => {
          const stateColor = a.state === 'active' ? 'var(--green)'
                          : a.state === 'inactive' ? 'var(--text3)'
                          : 'var(--accent2)';
          return `
            <div style="background:var(--surface2);border-radius:10px;padding:10px 12px;margin-bottom:6px">
              <div style="display:flex;justify-content:space-between;align-items:center;font-size:12px">
                <code style="color:var(--text2);word-break:break-all">${a.pubkey.slice(0,10)}…${a.pubkey.slice(-6)}</code>
                <span style="color:${stateColor};font-weight:600;text-transform:uppercase;font-size:10px">${a.state}</span>
              </div>
              <div style="display:flex;justify-content:space-between;margin-top:4px;font-size:13px">
                <span>${a.sol} SOL</span>
                <span>
                  ${a.state === 'active' || a.state === 'activating'
                    ? `<button class="btn btn-outline btn-sm" data-act="deactivate" data-acc="${a.pubkey}">Unstake</button>`
                    : a.state === 'inactive'
                    ? `<button class="btn btn-outline btn-sm" data-act="withdraw" data-acc="${a.pubkey}">Withdraw</button>`
                    : ''}
                </span>
              </div>
            </div>`;
        }).join('');
      listDiv.querySelectorAll('button[data-act]').forEach(btn => {
        btn.onclick = async () => {
          const action = btn.dataset.act, accPub = btn.dataset.acc;
          const verb = action === 'deactivate' ? 'unstake' : 'withdraw';
          if (!confirm(`Confirm ${verb}?`)) return;
          if (typeof verifyAuth === 'function') {
            try { await verifyAuth(`Confirm ${verb}`); } catch { toast('Cancelled'); return; }
          }
          btn.disabled = true; btn.textContent = '…';
          try {
            if (action === 'deactivate') await SolanaWallet.deactivateStake(state.mnemonic, accPub);
            else                         await SolanaWallet.withdrawStake(state.mnemonic, accPub);
            toast(action === 'deactivate' ? 'Unstake submitted — funds available after cooldown' : 'Withdrawn');
            close();
            setTimeout(refreshBalances, 4000);
          } catch (e) { toast(`Error: ${e.message || 'Transaction failed'}`); btn.disabled = false; btn.textContent = verb; }
        };
      });
    });

    const errDiv = root.querySelector('#stk-err');
    root.querySelector('#stk-do').onclick = async () => {
      errDiv.textContent = '';
      const validator = root.querySelector('#stk-validator').value.trim();
      const amt = root.querySelector('#stk-amount').value.trim();
      if (!validator) { errDiv.textContent = 'Enter a validator vote address'; return; }
      if (!amt || parseFloat(amt) <= 0) { errDiv.textContent = 'Enter a valid amount'; return; }
      try { new solanaWeb3.PublicKey(validator); } catch { errDiv.textContent = 'Invalid validator address'; return; }
      if (!confirm(`Stake ${amt} SOL to ${validator.slice(0,10)}…?`)) return;
      if (typeof verifyAuth === 'function') {
        try { await verifyAuth(`Stake ${amt} SOL`); } catch { toast('Cancelled'); return; }
      }
      const btn = root.querySelector('#stk-do');
      btn.disabled = true; btn.textContent = 'Staking…';
      try {
        const sig = await SolanaWallet.stakeSOL(state.mnemonic, validator, amt);
        toast(`Staked! TX: ${sig.slice(0, 20)}…`);
        if (typeof Inbox !== 'undefined') Inbox.add({
          type: 'stake',
          title: 'SOL stake delegated',
          subtitle: `${amt} SOL delegated · ~3 day activation period`,
        });
        close();
        setTimeout(refreshBalances, 4000);
      } catch (e) { errDiv.textContent = e.message || 'Stake failed'; btn.disabled = false; btn.textContent = 'Stake'; }
    };
  }

  // ── Tron flow ────────────────────────────────────────────────────────
  async function openTrxModal() {
    const addr = state.addresses['TRX'];
    if (!addr) { toast('TRX wallet not loaded'); return; }
    const liquidBal = state.balances['TRX'] ?? '…';

    const { root, close } = showModal(`
      <h2>Stake TRX</h2>
      <p>Freeze TRX to gain ENERGY (free USDT transfers) or BANDWIDTH, then vote for a Super Representative to earn rewards (~3–5% APY). Unbonding takes 14 days.</p>
      <div style="background:var(--surface2);border-radius:10px;padding:10px 12px;margin-bottom:12px;font-size:13px">
        <div style="display:flex;justify-content:space-between"><span style="color:var(--text2)">Liquid balance</span><span><b>${liquidBal} TRX</b></span></div>
        <div id="stk-info" style="margin-top:6px;color:var(--text2)">Loading…</div>
      </div>
      <div class="form-group">
        <label>Action</label>
        ${segmentedControl('stk-action', [
          { value: 'freeze',   label: 'Stake' },
          { value: 'unfreeze', label: 'Unstake' },
          { value: 'withdraw', label: 'Withdraw' },
          { value: 'vote',     label: 'Vote' },
          { value: 'claim',    label: 'Rewards' },
        ], 'freeze')}
      </div>
      <div class="form-group" id="stk-resource-group">
        <label>Resource</label>
        ${segmentedControl('stk-resource', [
          { value: 'ENERGY',    label: 'ENERGY (recommended)' },
          { value: 'BANDWIDTH', label: 'BANDWIDTH' },
        ], 'ENERGY')}
      </div>
      <div class="form-group" id="stk-amount-group">
        <label>Amount (TRX)</label>
        <input id="stk-amount" type="number" step="any" min="0" placeholder="0.0">
      </div>
      <div class="form-group" id="stk-vote-group" style="display:none">
        <label>Super Representative address</label>
        <input id="stk-sr-address" placeholder="T... vote address" autocomplete="off" spellcheck="false">
        <div style="font-size:11px;color:var(--text3);margin-top:4px">
          Browse SRs at <a href="https://tronscan.org/#/sr/representatives" target="_blank" style="color:var(--accent)">tronscan.org</a>.
        </div>
      </div>
      <div class="form-group" id="stk-tp-group" style="display:none">
        <label>TRON Power to vote</label>
        <input id="stk-tp-count" type="number" step="1" min="1" placeholder="0">
      </div>
      <div id="stk-claim-info" style="display:none;background:var(--surface2);border-radius:10px;padding:10px 12px;margin-bottom:12px;font-size:13px"></div>
      <div id="stk-err" style="color:var(--red);font-size:13px;min-height:18px;margin-bottom:8px"></div>
      <div class="modal-actions">
        <button class="btn btn-outline" id="stk-close">Close</button>
        <button class="btn btn-primary" id="stk-do">Confirm</button>
      </div>
    `);
    root.querySelector('#stk-close').onclick = close;

    const infoDiv = root.querySelector('#stk-info');
    const claimInfo = root.querySelector('#stk-claim-info');
    let voting = { tronPower: 0, tronPowerAvailable: 0, currentVotes: [], claimableRewards: 0 };

    Promise.all([
      TronWallet.getStakeInfo(addr),
      TronWallet.getVotingInfo(addr),
    ]).then(([stake, vote]) => {
      voting = vote;
      const now = Date.now();
      const claimable = stake.pending.filter(p => p.expireMs <= now).reduce((s, p) => s + p.amount, 0);
      const waiting   = stake.pending.filter(p => p.expireMs >  now);
      const votesHtml = vote.currentVotes.length
        ? `<div style="margin-top:4px">Voting: ${vote.currentVotes.map(v => `${v.voteCount} → ${v.srAddress.slice(0,6)}…${v.srAddress.slice(-4)}`).join(', ')}</div>`
        : '';
      infoDiv.innerHTML = `
        <div>Frozen for ENERGY: <b>${stake.energy.toFixed(2)} TRX</b></div>
        <div>Frozen for BANDWIDTH: <b>${stake.bandwidth.toFixed(2)} TRX</b></div>
        <div>TRON Power: <b>${vote.tronPower.toFixed(2)}</b> · used <b>${vote.tronPowerUsed.toFixed(0)}</b> · free <b>${vote.tronPowerAvailable.toFixed(0)}</b></div>
        ${vote.claimableRewards > 0 ? `<div style="color:var(--green)">Claimable rewards: <b>${vote.claimableRewards.toFixed(6)} TRX</b></div>` : ''}
        ${claimable > 0 ? `<div style="color:var(--green)">Unfrozen ready to withdraw: <b>${claimable.toFixed(2)} TRX</b></div>` : ''}
        ${waiting.length ? `<div>Unfreeze pending: ${waiting.map(p => `${p.amount.toFixed(2)} TRX in ${Math.ceil((p.expireMs - now) / 86400000)}d`).join(', ')}</div>` : ''}
        ${votesHtml}
      `;
      // Now that we know rewards, refresh the claim panel if currently shown
      if (actionSeg && actionSeg.getValue() === 'claim') updateActionView('claim');
    });

    const amountGroup   = root.querySelector('#stk-amount-group');
    const resourceGroup = root.querySelector('#stk-resource-group');
    const voteGroup     = root.querySelector('#stk-vote-group');
    const tpGroup       = root.querySelector('#stk-tp-group');

    function updateActionView(v) {
      amountGroup.style.display   = (v === 'freeze' || v === 'unfreeze') ? '' : 'none';
      resourceGroup.style.display = (v === 'freeze' || v === 'unfreeze') ? '' : 'none';
      voteGroup.style.display     = v === 'vote' ? '' : 'none';
      tpGroup.style.display       = v === 'vote' ? '' : 'none';
      if (v === 'claim') {
        claimInfo.style.display = '';
        claimInfo.innerHTML = voting.claimableRewards > 0
          ? `Claim <b>${voting.claimableRewards.toFixed(6)} TRX</b> in voting rewards. Note: TRON enforces a 24-hour cooldown between claims.`
          : 'No rewards to claim yet. Vote for a Super Representative and check back in ~24h.';
      } else {
        claimInfo.style.display = 'none';
      }
    }
    const actionSeg = wireSeg(root, 'stk-action', updateActionView);
    const resourceSeg = wireSeg(root, 'stk-resource');
    updateActionView(actionSeg.getValue());

    const errDiv = root.querySelector('#stk-err');
    root.querySelector('#stk-do').onclick = async () => {
      errDiv.textContent = '';
      const action = actionSeg.getValue();
      const btn = root.querySelector('#stk-do');

      if (action === 'freeze' || action === 'unfreeze') {
        const resource = resourceSeg.getValue();
        const amt = root.querySelector('#stk-amount').value.trim();
        if (!amt || parseFloat(amt) <= 0) { errDiv.textContent = 'Enter a valid amount'; return; }
        const verb = action === 'freeze' ? 'stake' : 'unstake';
        if (!confirm(`Confirm ${verb} ${amt} TRX?`)) return;
        if (typeof verifyAuth === 'function') {
          try { await verifyAuth(`Confirm ${verb}`); } catch { toast('Cancelled'); return; }
        }
        btn.disabled = true; btn.textContent = 'Submitting…';
        try {
          const txid = action === 'freeze'
            ? await TronWallet.freezeTRX(state.mnemonic, amt, resource)
            : await TronWallet.unfreezeTRX(state.mnemonic, amt, resource);
          toast(`Done! TX: ${String(txid).slice(0, 20)}…`);
          close(); setTimeout(refreshBalances, 4000);
        } catch (e) { errDiv.textContent = e.message || 'Transaction failed'; btn.disabled = false; btn.textContent = 'Confirm'; }
        return;
      }

      if (action === 'withdraw') {
        if (!confirm('Withdraw expired unfrozen TRX?')) return;
        if (typeof verifyAuth === 'function') {
          try { await verifyAuth('Withdraw expired'); } catch { toast('Cancelled'); return; }
        }
        btn.disabled = true; btn.textContent = 'Submitting…';
        try {
          const txid = await TronWallet.withdrawUnfrozenTRX(state.mnemonic);
          toast(`Done! TX: ${String(txid).slice(0, 20)}…`);
          close(); setTimeout(refreshBalances, 4000);
        } catch (e) { errDiv.textContent = e.message || 'Transaction failed'; btn.disabled = false; btn.textContent = 'Confirm'; }
        return;
      }

      if (action === 'vote') {
        const srAddr = root.querySelector('#stk-sr-address').value.trim();
        const count  = parseInt(root.querySelector('#stk-tp-count').value, 10);
        if (!srAddr || !srAddr.startsWith('T') || srAddr.length !== 34) { errDiv.textContent = 'Invalid SR address'; return; }
        if (!Number.isFinite(count) || count <= 0) { errDiv.textContent = 'Enter a valid TP count'; return; }
        if (count > voting.tronPowerAvailable) {
          errDiv.textContent = `Only ${voting.tronPowerAvailable.toFixed(0)} TP available. Freeze more TRX to gain TP.`; return;
        }
        if (!confirm(`Vote ${count} TP for ${srAddr.slice(0,6)}…${srAddr.slice(-4)}?\n\nThis adds to your existing votes.`)) return;
        if (typeof verifyAuth === 'function') {
          try { await verifyAuth('Confirm vote'); } catch { toast('Cancelled'); return; }
        }
        btn.disabled = true; btn.textContent = 'Voting…';
        try {
          const txid = await TronWallet.voteForSR(state.mnemonic, srAddr, count);
          toast(`Voted! TX: ${String(txid).slice(0, 20)}…`);
          close(); setTimeout(refreshBalances, 4000);
        } catch (e) { errDiv.textContent = e.message || 'Vote failed'; btn.disabled = false; btn.textContent = 'Confirm'; }
        return;
      }

      if (action === 'claim') {
        if (voting.claimableRewards <= 0) { errDiv.textContent = 'Nothing to claim'; return; }
        if (!confirm(`Claim ${voting.claimableRewards.toFixed(6)} TRX in rewards?`)) return;
        if (typeof verifyAuth === 'function') {
          try { await verifyAuth('Claim rewards'); } catch { toast('Cancelled'); return; }
        }
        btn.disabled = true; btn.textContent = 'Claiming…';
        try {
          const txid = await TronWallet.claimRewards(state.mnemonic);
          toast(`Claimed! TX: ${String(txid).slice(0, 20)}…`);
          close(); setTimeout(refreshBalances, 4000);
        } catch (e) { errDiv.textContent = e.message || 'Claim failed'; btn.disabled = false; btn.textContent = 'Confirm'; }
        return;
      }
    };
  }

  function open(coinId) {
    if (!state || !state.mnemonic) { toast('Unlock the wallet first'); return; }
    if (coinId === 'SOL') return openSolModal();
    if (coinId === 'TRX') return openTrxModal();
    toast(`Staking not supported for ${coinId}`);
  }

  return { open };
})();

window.openStakeModal = Staking.open;
