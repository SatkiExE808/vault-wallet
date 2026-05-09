// Staking UI — modal flow for SOL (validator delegation) and TRX (resource freezing).
// Exposes window.openStakeModal(coinId).
const Staking = (() => {
  function el(html) {
    const t = document.createElement('template');
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
  }

  function showModal(html) {
    const root = document.createElement('div');
    root.className = 'modal-backdrop';
    root.innerHTML = `<div class="modal">${html}</div>`;
    document.body.appendChild(root);
    const close = () => root.remove();
    root.addEventListener('click', e => { if (e.target === root) close(); });
    return { root, close };
  }

  // ── Solana flow ──────────────────────────────────────────────────────
  async function openSolModal() {
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
        <button class="btn btn-outline" id="stk-close">Close</button>
        <button class="btn btn-primary" id="stk-do">Stake</button>
      </div>
    `);
    root.querySelector('#stk-close').onclick = close;

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
      <p>Freeze TRX to gain ENERGY (free USDT transfers) or BANDWIDTH. Unbonding takes 14 days.</p>
      <div style="background:var(--surface2);border-radius:10px;padding:10px 12px;margin-bottom:12px;font-size:13px">
        <div style="display:flex;justify-content:space-between"><span style="color:var(--text2)">Liquid balance</span><span><b>${liquidBal} TRX</b></span></div>
        <div id="stk-info" style="margin-top:6px;color:var(--text2)">Loading…</div>
      </div>
      <div class="form-group">
        <label>Action</label>
        <select id="stk-action">
          <option value="freeze">Stake (freeze)</option>
          <option value="unfreeze">Unstake (unfreeze)</option>
          <option value="withdraw">Withdraw expired</option>
        </select>
      </div>
      <div class="form-group" id="stk-resource-group">
        <label>Resource</label>
        <select id="stk-resource">
          <option value="ENERGY">ENERGY (recommended)</option>
          <option value="BANDWIDTH">BANDWIDTH</option>
        </select>
      </div>
      <div class="form-group" id="stk-amount-group">
        <label>Amount (TRX)</label>
        <input id="stk-amount" type="number" step="any" min="0" placeholder="0.0">
      </div>
      <div id="stk-err" style="color:var(--red);font-size:13px;min-height:18px;margin-bottom:8px"></div>
      <div class="modal-actions">
        <button class="btn btn-outline" id="stk-close">Close</button>
        <button class="btn btn-primary" id="stk-do">Confirm</button>
      </div>
    `);
    root.querySelector('#stk-close').onclick = close;

    const infoDiv = root.querySelector('#stk-info');
    TronWallet.getStakeInfo(addr).then(info => {
      const now = Date.now();
      const claimable = info.pending.filter(p => p.expireMs <= now).reduce((s, p) => s + p.amount, 0);
      const waiting   = info.pending.filter(p => p.expireMs >  now);
      infoDiv.innerHTML = `
        <div>Frozen for ENERGY: <b>${info.energy.toFixed(2)} TRX</b></div>
        <div>Frozen for BANDWIDTH: <b>${info.bandwidth.toFixed(2)} TRX</b></div>
        ${claimable > 0 ? `<div style="color:var(--green)">Claimable now: <b>${claimable.toFixed(2)} TRX</b></div>` : ''}
        ${waiting.length ? `<div>Pending: ${waiting.map(p => `${p.amount.toFixed(2)} TRX in ${Math.ceil((p.expireMs - now) / 86400000)}d`).join(', ')}</div>` : ''}
      `;
    });

    const actionSel = root.querySelector('#stk-action');
    const amountGroup = root.querySelector('#stk-amount-group');
    const resourceGroup = root.querySelector('#stk-resource-group');
    actionSel.onchange = () => {
      const v = actionSel.value;
      amountGroup.style.display   = v === 'withdraw' ? 'none' : '';
      resourceGroup.style.display = v === 'withdraw' ? 'none' : '';
    };

    const errDiv = root.querySelector('#stk-err');
    root.querySelector('#stk-do').onclick = async () => {
      errDiv.textContent = '';
      const action = actionSel.value;
      const resource = root.querySelector('#stk-resource').value;
      const amt = root.querySelector('#stk-amount').value.trim();
      if (action !== 'withdraw' && (!amt || parseFloat(amt) <= 0)) {
        errDiv.textContent = 'Enter a valid amount'; return;
      }
      const verb = action === 'freeze' ? 'stake' : action === 'unfreeze' ? 'unstake' : 'withdraw expired';
      if (!confirm(`Confirm ${verb}${action === 'withdraw' ? '' : ` ${amt} TRX`}?`)) return;
      if (typeof verifyAuth === 'function') {
        try { await verifyAuth(`Confirm ${verb}`); } catch { toast('Cancelled'); return; }
      }
      const btn = root.querySelector('#stk-do');
      btn.disabled = true; btn.textContent = 'Submitting…';
      try {
        let txid;
        if (action === 'freeze')        txid = await TronWallet.freezeTRX(state.mnemonic, amt, resource);
        else if (action === 'unfreeze') txid = await TronWallet.unfreezeTRX(state.mnemonic, amt, resource);
        else                            txid = await TronWallet.withdrawUnfrozenTRX(state.mnemonic);
        toast(`Done! TX: ${String(txid).slice(0, 20)}…`);
        close();
        setTimeout(refreshBalances, 4000);
      } catch (e) { errDiv.textContent = e.message || 'Transaction failed'; btn.disabled = false; btn.textContent = 'Confirm'; }
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
