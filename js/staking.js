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
        <div style="display:flex;gap:8px">
          <input id="stk-jup-amount" type="number" step="any" min="0" placeholder="0.0" style="flex:1">
          <button type="button" class="btn btn-outline" id="stk-jup-max" style="padding:0 16px;flex-shrink:0">Max</button>
        </div>
      </div>
      <div id="stk-jup-err" style="color:var(--red);font-size:13px;min-height:18px;margin-bottom:8px"></div>
      <div class="modal-actions">
        <button class="btn btn-outline" id="stk-jup-back">Back</button>
        <button class="btn btn-primary" id="stk-jup-do">Confirm</button>
      </div>
    `);
    root.querySelector('#stk-jup-back').onclick = () => { close(); openSolModal(); };

    const infoDiv = root.querySelector('#stk-jup-info');
    // Track JupSOL balance so the Max button can fill it in when unstaking.
    let jupSolBal = 0;
    Promise.all([SolanaWallet.getJupSolBalance(addr), SolanaWallet.getJupSolRate()])
      .then(([bal, rate]) => {
        jupSolBal = Number(bal) || 0;
        const sol = rate ? (jupSolBal * rate).toFixed(6) : null;
        infoDiv.innerHTML = `
          <div>JupSOL balance: <b>${bal}</b>${sol ? ` (≈ ${sol} SOL)` : ''}</div>
          ${rate ? `<div>Rate: 1 JupSOL ≈ ${rate.toFixed(6)} SOL</div>` : ''}
        `;
      });

    const amountLabel = root.querySelector('#stk-jup-amount-label');
    const actionSeg = wireSeg(root, 'stk-jup-action', v => {
      amountLabel.textContent = v === 'stake' ? 'Amount (SOL)' : 'Amount (JupSOL)';
    });

    // Max fills in liquid SOL (minus tx-fee buffer) when staking, or the
    // full JupSOL balance when unstaking — picked by the current toggle.
    // JupSOL is a swap (not a stake account), so the buffer only needs to
    // cover Jupiter's swap fee (~0.000005 SOL). 0.001 SOL is generous and
    // doesn't strand small balances the way 0.01 did.
    root.querySelector('#stk-jup-max').onclick = () => {
      const action = actionSeg.getValue();
      if (action === 'stake') {
        const bal = parseFloat(state.balances['SOL']);
        if (!Number.isFinite(bal) || bal <= 0) { toast('No liquid SOL'); return; }
        // Buffer covers (worst case, first-time swap):
        //   ~0.00204 SOL — rent reserve for the JupSOL token account
        //   ~0.00001 SOL — base tx fees + signatures
        //   ~0.00295 SOL — slippage + Jupiter compute units + safety margin
        // Total ≈ 0.005 SOL. Smaller buffers triggered SPL Token "0x1
        // InsufficientFunds" on-chain because the leftover wasn't enough
        // to pay rent for the new JupSOL token account.
        const max = bal - 0.005;
        if (max <= 0) {
          toast('Need ~0.005 SOL extra to cover fees + JupSOL account rent');
          return;
        }
        root.querySelector('#stk-jup-amount').value = max.toFixed(6);
      } else {
        if (jupSolBal <= 0) { toast('No JupSOL to unstake'); return; }
        root.querySelector('#stk-jup-amount').value = jupSolBal.toFixed(6);
      }
    };

    const errDiv = root.querySelector('#stk-jup-err');
    root.querySelector('#stk-jup-do').onclick = async () => {
      errDiv.textContent = '';
      const action = actionSeg.getValue();
      const amt = root.querySelector('#stk-jup-amount').value.trim();
      if (!amt || parseFloat(amt) <= 0) { errDiv.textContent = 'Enter a valid amount'; return; }
      const verb = action === 'stake' ? 'stake' : 'unstake';
      const symLine = action === 'stake' ? 'SOL' : 'JupSOL';
      const okConfirm = await confirmModal({
        title: action === 'stake' ? 'Liquid Stake (JupSOL)' : 'Unstake JupSOL',
        lines: [['Amount', `${amt} ${symLine}`], ['Action', verb]],
        confirmLabel: action === 'stake' ? 'Stake' : 'Unstake',
      });
      if (!okConfirm) return;
      if (typeof verifyAuth === 'function') {
        try { await verifyAuth(`Confirm ${verb}`); } catch { toast('Cancelled'); return; }
      }
      const btn = root.querySelector('#stk-jup-do');
      btn.disabled = true; btn.textContent = `${verb === 'stake' ? 'Staking' : 'Unstaking'}…`;
      try {
        const sig = action === 'stake'
          ? await SolanaWallet.liquidStakeJupSol(state.mnemonic, amt)
          : await SolanaWallet.liquidUnstakeJupSol(state.mnemonic, amt);
        toast(action === 'stake' ? 'Liquid stake submitted' : 'Unstake submitted', {
          href: `https://solscan.io/tx/${sig}`,
        });
        if (typeof Inbox !== 'undefined') Inbox.add({
          type: 'stake',
          title: action === 'stake' ? 'JupSOL liquid stake complete' : 'JupSOL unstaked',
          network: 'Solana',
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
        <div style="display:flex;gap:8px">
          <input id="stk-amount" type="number" step="any" min="0" placeholder="0.0" style="flex:1">
          <button type="button" class="btn btn-outline" id="stk-max" style="padding:0 16px;flex-shrink:0">Max</button>
        </div>
      </div>
      <div id="stk-err" style="color:var(--red);font-size:13px;min-height:18px;margin-bottom:8px"></div>
      <div class="modal-actions">
        <button class="btn btn-outline" id="stk-close">Back</button>
        <button class="btn btn-primary" id="stk-do">Stake</button>
      </div>
    `);
    root.querySelector('#stk-close').onclick = () => { close(); openSolModal(); };

    // Max button — fill in the liquid balance minus a small buffer for the
    // stake-account rent reserve (~0.00228 SOL) plus tx fees. Without this
    // buffer "Max" reliably fails with "insufficient funds for rent".
    root.querySelector('#stk-max').onclick = () => {
      const bal = parseFloat(state.balances['SOL']);
      if (!Number.isFinite(bal) || bal <= 0) { toast('No liquid SOL'); return; }
      const max = bal - 0.01;
      if (max <= 0) {
        toast('Need ~0.01 SOL extra to cover rent reserve + tx fee');
        return;
      }
      root.querySelector('#stk-amount').value = max.toFixed(6);
    };

    const listDiv = root.querySelector('#stake-list');

    // Manual recovery flow — for stake accounts that exist on-chain but
    // didn't get cached locally (created before v93, or while
    // getProgramAccounts was failing). User pastes the pubkey, we
    // validate as a Solana key, save to cache, then reload.
    function addManualStakeAccount() {
      const promptModal = showModal(`
        <h2>Add Stake Account</h2>
        <p>If your stake account isn't showing up here, paste its pubkey to add it manually. Find it on
          <a href="https://solscan.io/account/${escapeHtml(addr)}#stakeAccounts" target="_blank" style="color:var(--accent)">solscan.io</a>.</p>
        <div class="form-group">
          <label>Stake account pubkey</label>
          <input id="recover-pk" placeholder="B49Xj1AaLS…PhJg4x" autocomplete="off" spellcheck="false" autocapitalize="off">
        </div>
        <div id="recover-err" style="color:var(--red);font-size:13px;min-height:18px;margin-bottom:8px"></div>
        <div class="modal-actions">
          <button class="btn btn-outline" id="recover-cancel">Cancel</button>
          <button class="btn btn-primary" id="recover-ok">Add</button>
        </div>
      `);
      const errDiv = promptModal.root.querySelector('#recover-err');
      const input  = promptModal.root.querySelector('#recover-pk');
      promptModal.root.querySelector('#recover-cancel').onclick = promptModal.close;
      promptModal.root.querySelector('#recover-ok').onclick = () => {
        const trimmed = (input.value || '').trim();
        if (!trimmed) { errDiv.textContent = 'Enter a stake account pubkey'; return; }
        try { new solanaWeb3.PublicKey(trimmed); }
        catch { errDiv.textContent = 'Not a valid Solana pubkey'; return; }
        SolanaWallet.rememberStakeAccount(addr, trimmed);
        promptModal.close();
        toast('Added — refreshing list…');
        close();
        openSolNativeModal();
      };
      setTimeout(() => input.focus(), 50);
    }

    const recoverBtnHtml = `
      <div style="text-align:center;margin-top:8px">
        <button type="button" class="link-btn" id="stk-recover"
                style="font-size:12px;color:var(--accent);background:transparent;border:none;padding:6px 8px;cursor:pointer">
          + Add existing stake account
        </button>
      </div>`;
    function wireRecover() {
      const btn = listDiv.querySelector('#stk-recover');
      if (btn) btn.onclick = addManualStakeAccount;
    }

    SolanaWallet.getStakeAccounts(addr).then(async accs => {
      if (!accs.length) {
        listDiv.innerHTML = `
          <div>No stake accounts yet.</div>
          ${recoverBtnHtml}`;
        wireRecover();
        return;
      }
      // Fetch in parallel: previous-epoch reward (one batched call) and the
      // validator metadata for each delegation (Stakewiz, cached 24h).
      const [rewardLamports, validatorInfos] = await Promise.all([
        SolanaWallet.getLastEpochRewards(accs.map(a => a.pubkey)),
        Promise.all(accs.map(a => SolanaWallet.getValidatorInfo(a.validator))),
      ]);
      const APR = 0.065;       // ballpark Solana staking APR — used for projections
      const LAMPORTS = 1e9;
      const EPOCH_DAYS = 2.5;  // ~2-3 days per epoch on mainnet
      listDiv.innerHTML = '<div style="margin-bottom:6px;color:var(--text);font-weight:600">Your stake accounts</div>' +
        accs.map((a, i) => {
          const stateColor = a.state === 'active' ? 'var(--green)'
                          : a.state === 'inactive' ? 'var(--text3)'
                          : 'var(--accent2)';
          // Projected earnings — pure math from APR, no RPC needed.
          const solAmount  = parseFloat(a.sol);
          const dailyProj  = Number.isFinite(solAmount) ? (solAmount * APR / 365) : 0;
          const yearlyProj = Number.isFinite(solAmount) ? (solAmount * APR) : 0;
          // Real last-epoch reward (if RPC returned one). Convert to per-day rate.
          const lastReward = rewardLamports[i] || 0;
          const lastRewardSol = lastReward / LAMPORTS;
          const lastDaily     = lastRewardSol / EPOCH_DAYS;
          // Only show real rewards if the account is active and has a non-zero entry.
          const rewardsHtml = (a.state === 'active' && lastReward > 0)
            ? `<div style="margin-top:4px;font-size:12px;color:var(--green)">
                 +${lastRewardSol.toFixed(6)} SOL last epoch (~${lastDaily.toFixed(6)}/day)
               </div>`
            : '';
          const projHtml = (a.state === 'active' || a.state === 'activating')
            ? `<div style="margin-top:2px;font-size:11px;color:var(--text3)">
                 Projected: ~${dailyProj.toFixed(6)} SOL/day · ~${yearlyProj.toFixed(4)}/year at ${(APR*100).toFixed(1)}% APR
               </div>`
            : '';
          // Validator header: logo + name when available, else just the vote
          // address tail so the user can still identify the project.
          const v = validatorInfos[i];
          const voteTail = a.validator ? `${a.validator.slice(0,6)}…${a.validator.slice(-4)}` : '';
          const validatorHtml = v && (v.name || v.image)
            ? `<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
                 ${v.image ? `<img src="${escapeHtml(v.image)}" alt="" style="width:22px;height:22px;border-radius:50%;background:var(--surface);object-fit:cover" onerror="this.style.display='none'">` : ''}
                 <div style="font-weight:600;font-size:13px;color:var(--text)">${escapeHtml(v.name || voteTail)}</div>
               </div>`
            : (a.validator
                ? `<div style="font-size:11px;color:var(--text3);margin-bottom:4px">Validator: ${voteTail}</div>`
                : '');
          return `
            <div style="background:var(--surface2);border-radius:10px;padding:10px 12px;margin-bottom:6px">
              ${validatorHtml}
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
              ${rewardsHtml}
              ${projHtml}
            </div>`;
        }).join('') + recoverBtnHtml;
      wireRecover();
      listDiv.querySelectorAll('button[data-act]').forEach(btn => {
        btn.onclick = async () => {
          const action = btn.dataset.act, accPub = btn.dataset.acc;
          const verb = action === 'deactivate' ? 'unstake' : 'withdraw';
          const okStakeAcc = await confirmModal({
            title: action === 'deactivate' ? 'Unstake' : 'Withdraw',
            lines: [['Stake account', accPub, { code: true }], ['Action', verb]],
            confirmLabel: action === 'deactivate' ? 'Unstake' : 'Withdraw',
          });
          if (!okStakeAcc) return;
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
      const okStake = await confirmModal({
        title: 'Confirm Stake',
        lines: [['Amount', `${amt} SOL`], ['Validator', validator, { code: true }], ['Unbonding', '~3 days after unstake']],
        confirmLabel: 'Stake',
      });
      if (!okStake) return;
      if (typeof verifyAuth === 'function') {
        try { await verifyAuth(`Stake ${amt} SOL`); } catch { toast('Cancelled'); return; }
      }
      const btn = root.querySelector('#stk-do');
      btn.disabled = true; btn.textContent = 'Staking…';
      try {
        const sig = await SolanaWallet.stakeSOL(state.mnemonic, validator, amt);
        toast('SOL stake submitted', { href: `https://solscan.io/tx/${sig}` });
        if (typeof Inbox !== 'undefined') Inbox.add({
          type: 'stake',
          title: 'SOL stake delegated',
          network: 'Solana',
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
        <div style="display:flex;gap:8px">
          <input id="stk-amount" type="number" step="any" min="0" placeholder="0.0" style="flex:1">
          <button type="button" class="btn btn-outline" id="stk-trx-max" style="padding:0 16px;flex-shrink:0">Max</button>
        </div>
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
    // Track frozen amounts per resource so the Max button can fill in the
    // right cap when the action is "unfreeze".
    let frozen = { ENERGY: 0, BANDWIDTH: 0 };

    Promise.all([
      TronWallet.getStakeInfo(addr),
      TronWallet.getVotingInfo(addr),
    ]).then(([stake, vote]) => {
      voting = vote;
      frozen = { ENERGY: stake.energy, BANDWIDTH: stake.bandwidth };
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

    // Max button — caps depend on action:
    //  - freeze  → liquid TRX minus a 1 TRX buffer for the freeze tx fee
    //  - unfreeze → currently frozen for the selected resource
    root.querySelector('#stk-trx-max').onclick = () => {
      const action = actionSeg.getValue();
      const input = root.querySelector('#stk-amount');
      if (action === 'freeze') {
        const bal = parseFloat(state.balances['TRX']);
        if (!Number.isFinite(bal) || bal <= 0) return;
        input.value = Math.max(0, bal - 1).toFixed(6);
      } else if (action === 'unfreeze') {
        const cap = frozen[resourceSeg.getValue()] || 0;
        if (cap <= 0) return;
        input.value = cap.toFixed(6);
      }
    };

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
        const okFreeze = await confirmModal({
          title: action === 'freeze' ? 'Stake TRX' : 'Unstake TRX',
          lines: [['Amount', `${amt} TRX`], ['Resource', resource], ...(action === 'unfreeze' ? [['Unbonding', '14 days']] : [])],
          confirmLabel: action === 'freeze' ? 'Stake' : 'Unstake',
        });
        if (!okFreeze) return;
        if (typeof verifyAuth === 'function') {
          try { await verifyAuth(`Confirm ${verb}`); } catch { toast('Cancelled'); return; }
        }
        btn.disabled = true; btn.textContent = 'Submitting…';
        try {
          const txid = action === 'freeze'
            ? await TronWallet.freezeTRX(state.mnemonic, amt, resource)
            : await TronWallet.unfreezeTRX(state.mnemonic, amt, resource);
          toast(action === 'freeze' ? 'TRX stake submitted' : 'Unstake submitted', {
            href: `https://tronscan.org/#/transaction/${txid}`,
          });
          if (typeof Inbox !== 'undefined') Inbox.add({
            type: 'stake',
            title: action === 'freeze' ? 'TRX staked (frozen)' : 'TRX unstaked',
            network: 'Tron',
            subtitle: action === 'freeze'
              ? `${amt} TRX frozen for ${resource} · TRON Power gained`
              : `${amt} TRX unfreezing · 14 day cooldown`,
          });
          close(); setTimeout(refreshBalances, 4000);
        } catch (e) { errDiv.textContent = e.message || 'Transaction failed'; btn.disabled = false; btn.textContent = 'Confirm'; }
        return;
      }

      if (action === 'withdraw') {
        const okWithdraw = await confirmModal({
          title: 'Withdraw Expired TRX',
          lines: [['Action', 'Sweep all expired unfrozen TRX back to your liquid balance']],
          confirmLabel: 'Withdraw',
        });
        if (!okWithdraw) return;
        if (typeof verifyAuth === 'function') {
          try { await verifyAuth('Withdraw expired'); } catch { toast('Cancelled'); return; }
        }
        btn.disabled = true; btn.textContent = 'Submitting…';
        try {
          const txid = await TronWallet.withdrawUnfrozenTRX(state.mnemonic);
          toast('Withdraw submitted', { href: `https://tronscan.org/#/transaction/${txid}` });
          if (typeof Inbox !== 'undefined') Inbox.add({
            type: 'stake',
            title: 'TRX withdrawn from stake',
            network: 'Tron',
            subtitle: 'Expired unfrozen TRX returned to liquid balance',
          });
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
        const okVote = await confirmModal({
          title: 'Vote for SR',
          lines: [['SR address', srAddr, { code: true }], ['TRON Power', `${count} TP`], ['Note', 'Adds to existing votes (does not replace)']],
          confirmLabel: 'Vote',
        });
        if (!okVote) return;
        if (typeof verifyAuth === 'function') {
          try { await verifyAuth('Confirm vote'); } catch { toast('Cancelled'); return; }
        }
        btn.disabled = true; btn.textContent = 'Voting…';
        try {
          const txid = await TronWallet.voteForSR(state.mnemonic, srAddr, count);
          toast('Vote submitted', { href: `https://tronscan.org/#/transaction/${txid}` });
          if (typeof Inbox !== 'undefined') Inbox.add({
            type: 'stake',
            title: 'TRX vote cast',
            network: 'Tron',
            subtitle: `${count} TP → ${srAddr.slice(0,6)}…${srAddr.slice(-4)}`,
          });
          close(); setTimeout(refreshBalances, 4000);
        } catch (e) { errDiv.textContent = e.message || 'Vote failed'; btn.disabled = false; btn.textContent = 'Confirm'; }
        return;
      }

      if (action === 'claim') {
        if (voting.claimableRewards <= 0) { errDiv.textContent = 'Nothing to claim'; return; }
        const okClaim = await confirmModal({
          title: 'Claim Rewards',
          lines: [['Amount', `${voting.claimableRewards.toFixed(6)} TRX`], ['Cooldown', '24h between claims']],
          confirmLabel: 'Claim',
        });
        if (!okClaim) return;
        if (typeof verifyAuth === 'function') {
          try { await verifyAuth('Claim rewards'); } catch { toast('Cancelled'); return; }
        }
        btn.disabled = true; btn.textContent = 'Claiming…';
        try {
          const txid = await TronWallet.claimRewards(state.mnemonic);
          toast('Rewards claimed', { href: `https://tronscan.org/#/transaction/${txid}` });
          if (typeof Inbox !== 'undefined') Inbox.add({
            type: 'stake',
            title: 'TRX rewards claimed',
            network: 'Tron',
            subtitle: `${voting.claimableRewards.toFixed(6)} TRX returned to liquid balance`,
          });
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
