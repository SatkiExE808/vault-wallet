// Aave Earn modal — deposit / withdraw stablecoins to/from Aave v3.
// Mirrors the staking modal pattern. Exposes window.openEarnModal(coinId).
const Earn = (() => {
  function showModal(html) {
    const root = document.createElement('div');
    root.className = 'modal-backdrop';
    root.innerHTML = `<div class="modal">${html}</div>`;
    document.body.appendChild(root);
    const close = () => root.remove();
    root.addEventListener('click', e => { if (e.target === root) close(); });
    return { root, close };
  }

  function segmentedControl(id, options, defaultValue) {
    return `<div class="seg-control" id="${id}">${
      options.map(o => `<button type="button" class="seg-btn${o.value === defaultValue ? ' active' : ''}" data-val="${o.value}">${o.label}</button>`).join('')
    }</div>`;
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
    return { getValue: () => el.querySelector('.seg-btn.active')?.dataset.val };
  }

  async function open(coinId) {
    if (!state || !state.mnemonic) { toast('Unlock the wallet first'); return; }
    if (!AaveEarn.isSupported(coinId)) { toast(`Earn not supported for ${coinId}`); return; }

    const coin = COINS.find(c => c.id === coinId);
    const addr = state.addresses[coinId];
    const symbol = coin?.symbol || coinId;
    const liquidBal = state.balances[coinId] ?? '…';

    const { root, close } = showModal(`
      <h2>Earn ${symbol} on Aave</h2>
      <p>Deposit ${symbol} into Aave v3 to earn variable APY paid by borrowers. Withdraw any time — no lockup. The deposit is held by Aave's audited smart contract; you remain the only one who can withdraw.</p>
      <div style="background:var(--surface2);border-radius:10px;padding:10px 12px;margin-bottom:12px;font-size:13px">
        <div style="display:flex;justify-content:space-between"><span style="color:var(--text2)">Liquid balance</span><span><b>${liquidBal} ${symbol}</b></span></div>
        <div id="ern-info" style="margin-top:6px;color:var(--text2)">Loading position…</div>
      </div>
      <div class="form-group">
        <label>Action</label>
        ${segmentedControl('ern-action', [
          { value: 'deposit',  label: `Deposit ${symbol}` },
          { value: 'withdraw', label: 'Withdraw' },
        ], 'deposit')}
      </div>
      <div class="form-group">
        <label id="ern-amount-label">Amount (${symbol})</label>
        <input id="ern-amount" type="number" step="any" min="0" placeholder="0.0">
        <button type="button" class="btn btn-outline btn-sm" id="ern-max" style="margin-top:6px">Max</button>
      </div>
      <div id="ern-err" style="color:var(--red);font-size:13px;min-height:18px;margin-bottom:8px"></div>
      <div class="modal-actions">
        <button class="btn btn-outline" id="ern-close">Close</button>
        <button class="btn btn-primary" id="ern-do">Confirm</button>
      </div>
    `);
    root.querySelector('#ern-close').onclick = close;

    const infoDiv = root.querySelector('#ern-info');
    let info = null;
    AaveEarn.getInfo(coinId, addr).then(res => {
      info = res;
      if (!res) { infoDiv.innerHTML = '<span style="color:var(--red)">Failed to load Aave data</span>'; return; }
      infoDiv.innerHTML = `
        <div>Currently deposited: <b>${res.depositedFormatted} ${symbol}</b></div>
        <div>Current APY: <b style="color:var(--green)">${res.apy}%</b></div>
      `;
    });

    const actionSeg = wireSeg(root, 'ern-action', v => {
      const lbl = root.querySelector('#ern-amount-label');
      lbl.textContent = v === 'deposit' ? `Amount (${symbol})` : `Withdraw (${symbol})`;
    });

    root.querySelector('#ern-max').onclick = () => {
      const action = actionSeg.getValue();
      const input = root.querySelector('#ern-amount');
      if (action === 'deposit') input.value = state.balances[coinId] || '0';
      else                      input.value = info?.depositedFormatted || '0';
    };

    const errDiv = root.querySelector('#ern-err');
    root.querySelector('#ern-do').onclick = async () => {
      errDiv.textContent = '';
      const action = actionSeg.getValue();
      const amt = root.querySelector('#ern-amount').value.trim();
      if (!amt || parseFloat(amt) <= 0) { errDiv.textContent = 'Enter a valid amount'; return; }
      const verb = action === 'deposit' ? 'deposit' : 'withdraw';
      if (!confirm(`Confirm ${verb} ${amt} ${symbol}?${action === 'deposit' ? '\n\nFirst-time deposits include a one-time approval transaction.' : ''}`)) return;
      if (typeof verifyAuth === 'function') {
        try { await verifyAuth(`Confirm ${verb}`); } catch { toast('Cancelled'); return; }
      }
      const btn = root.querySelector('#ern-do');
      btn.disabled = true; btn.textContent = `${verb === 'deposit' ? 'Depositing' : 'Withdrawing'}…`;
      try {
        const isMax = info && action === 'withdraw' && parseFloat(amt) >= parseFloat(info.depositedFormatted) - 0.0001;
        const txHash = action === 'deposit'
          ? await AaveEarn.supply(state.mnemonic, coinId, amt)
          : await AaveEarn.withdraw(state.mnemonic, coinId, isMax ? 'max' : amt);
        toast(`Done! TX: ${String(txHash).slice(0, 20)}…`);
        close();
        setTimeout(refreshBalances, 5000);
      } catch (e) {
        const msg = e.shortMessage || e.reason || e.message || 'Transaction failed';
        errDiv.textContent = msg;
        btn.disabled = false; btn.textContent = 'Confirm';
      }
    };
  }

  return { open };
})();

window.openEarnModal = Earn.open;
