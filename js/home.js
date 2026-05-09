// Home view: total balance + asset list. Bottom nav routing.
// Monkey-patches the existing app.js functions instead of editing them so
// the redesign stays separable.
(() => {
  const $ = id => document.getElementById(id);

  // Render progress pills (incoming/outgoing confirmation status) for a coin.
  // Returns '' when no active txs are tracked.
  function renderProgressPills(coinId) {
    if (typeof TxProgress === 'undefined') return '';
    const items = TxProgress.getForCoin(coinId);
    if (!items.length) return '';
    return `<div class="tx-progress-row">` + items.map(it => {
      const pct = Math.min(100, Math.round((it.confs / it.required) * 100));
      const arrow = it.dir === 'send' ? '↑' : '↓';
      const cls   = it.dir === 'send' ? 'tx-prog-out' : 'tx-prog-in';
      const label = it.confs === 0 ? 'Pending' : `Confirming ${it.confs}/${it.required}`;
      return `
        <div class="tx-progress ${cls}" title="${it.hash}">
          <span class="tx-prog-label">${arrow} ${label}</span>
          <div class="tx-prog-bar"><div class="tx-prog-fill" style="width:${pct}%"></div></div>
        </div>`;
    }).join('') + `</div>`;
  }

  // ── Custom category order (saved per-user) ────────────────
  const ORDER_KEY = 'category_order_v1';
  function loadCatOrder() {
    try { return JSON.parse(localStorage.getItem(ORDER_KEY) || '[]'); } catch { return []; }
  }
  function saveCatOrder(order) { localStorage.setItem(ORDER_KEY, JSON.stringify(order)); }

  // Reorder coins so categories appear in saved order; coins within a category keep registry order
  function applyOrder(coins) {
    const cats = [...new Set(coins.map(c => c.category))];
    const saved = loadCatOrder();
    const ordered = [...saved.filter(c => cats.includes(c)), ...cats.filter(c => !saved.includes(c))];
    return [...coins].sort((a, b) => ordered.indexOf(a.category) - ordered.indexOf(b.category));
  }

  // Move a whole category up/down in the global order
  function moveCategory(cat, direction) {
    const active = (typeof getActiveCoins === 'function') ? getActiveCoins() : [];
    const sorted = applyOrder(active);
    const cats = [...new Set(sorted.map(c => c.category))];
    const idx = cats.indexOf(cat);
    if (idx < 0) return;
    const swap = direction === 'up' ? idx - 1 : idx + 1;
    if (swap < 0 || swap >= cats.length) return;
    [cats[idx], cats[swap]] = [cats[swap], cats[idx]];
    saveCatOrder(cats);
    updateHome();
  }
  window.moveCategory = moveCategory;

  // Bring a category to the top — used by wallet picker tap
  function bringCategoryToTop(cat) {
    const active = (typeof getActiveCoins === 'function') ? getActiveCoins() : [];
    const sorted = applyOrder(active);
    const cats = [...new Set(sorted.map(c => c.category))];
    const idx = cats.indexOf(cat);
    if (idx < 1) return;  // already at top or not found
    cats.splice(idx, 1);
    cats.unshift(cat);
    saveCatOrder(cats);
    updateHome();
  }

  // ── View routing ──────────────────────────────────────────
  function showView(name) {
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    if (name === 'home')     $('home-view').classList.add('active');
    if (name === 'wallet')   $('wallet-view').classList.add('active');
    if (name === 'coin')     $('main').classList.add('active');
    if (name === 'settings') $('settings-view').classList.add('active');
    // Map view → bottom nav highlight
    const navMap = { home: 'home', wallet: 'wallet', coin: 'wallet', settings: 'settings' };
    document.querySelectorAll('.nav-item').forEach(n => {
      n.classList.toggle('active', n.dataset.nav === navMap[name]);
    });
  }
  window.showView = showView;

  // Reorder mode state — toggled by Edit button in home view
  let editMode = false;
  function toggleEditMode() {
    editMode = !editMode;
    const btn = $('home-edit-btn');
    if (btn) btn.textContent = editMode ? 'Done' : 'Edit';
    renderAssetList();
  }
  window.toggleEditMode = toggleEditMode;

  // ── Home asset list (categories reorderable in Edit mode) ─
  function renderAssetList() {
    const list = $('asset-list');
    if (!list) return;
    const activeRaw = (typeof getActiveCoins === 'function') ? getActiveCoins() : [];
    if (!activeRaw.length) {
      list.innerHTML = `<p style="text-align:center;color:var(--text2);padding:24px">No assets enabled. Tap Manage to add some.</p>`;
      return;
    }
    const active = applyOrder(activeRaw);
    const cats = [...new Set(active.map(c => c.category))];
    let html = '';
    cats.forEach((cat, catIdx) => {
      const group = active.filter(c => c.category === cat);
      const isFirstCat = catIdx === 0, isLastCat = catIdx === cats.length - 1;
      html += `<div class="network-group">`;
      html += `<div class="network-header">
        <span>${cat}</span>
        ${editMode ? `
          <div class="reorder-controls">
            <button class="reorder-btn" data-move="up"   data-cat="${cat}" ${isFirstCat ? 'disabled' : ''}>▲</button>
            <button class="reorder-btn" data-move="down" data-cat="${cat}" ${isLastCat ? 'disabled' : ''}>▼</button>
          </div>` : ''}
      </div>`;
      html += `<div class="network-card">`;
      html += group.map(coin => {
        const bal = state.balances[coin.id] ?? '…';
        const usd = formatUSD(bal, state.prices[coin.id]) || '';
        const badge = coin.networkLabel
          ? `<span class="network-badge ${coin.networkClass}">${coin.networkLabel}</span>` : '';
        const progress = renderProgressPills(coin.id);
        return `
          <div class="asset-item" data-coin="${coin.id}">
            <div class="asset-icon">
              <img src="${coin.icon}" alt="" onerror="this.style.display='none'">
            </div>
            <div class="asset-meta">
              <div class="asset-name">${coin.name} ${badge}</div>
              <div class="asset-symbol">${coin.symbol}</div>
              ${progress}
            </div>
            <div class="asset-right">
              <div class="asset-bal">${bal}</div>
              <div class="asset-usd">${usd}</div>
            </div>
          </div>`;
      }).join('');
      html += `</div></div>`;
    });
    list.innerHTML = html;

    list.querySelectorAll('.reorder-btn[data-cat]').forEach(btn => {
      btn.onclick = e => {
        e.stopPropagation();
        if (btn.disabled) return;
        moveCategory(btn.dataset.cat, btn.dataset.move);
      };
    });
    // Home asset list is display-only — no navigation on tap.
    // To send/receive, the user goes to the Wallets tab.
  }

  function updateTotalBalance() {
    const total = $('total-balance');
    if (!total) return;
    const active = (typeof getActiveCoins === 'function') ? getActiveCoins() : [];
    let sum = 0;
    let anyKnown = false;
    for (const coin of active) {
      const bal = parseFloat(state.balances[coin.id]);
      const px = state.prices[coin.id];
      if (!isNaN(bal) && px) {
        sum += bal * px;
        anyKnown = true;
      }
    }
    total.textContent = anyKnown
      ? '$' + sum.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      : '$—';
  }

  // Wallet view: which coin is currently displayed at top
  let walletDisplayCoin = null;

  function renderWalletDisplay(coinId) {
    const active = (typeof getActiveCoins === 'function') ? getActiveCoins() : [];
    if (!active.length) return;
    walletDisplayCoin = coinId || walletDisplayCoin || active[0].id;
    const coin = active.find(c => c.id === walletDisplayCoin);
    if (!coin) { walletDisplayCoin = active[0].id; return renderWalletDisplay(walletDisplayCoin); }

    const bal  = state.balances[coin.id] ?? '…';
    const usd  = formatUSD(bal, state.prices[coin.id]) || '';
    const addr = state.addresses[coin.id] || '—';

    $('wd-icon').innerHTML = `<img src="${coin.icon}" alt="" style="width:18px;height:18px;border-radius:50%" onerror="this.style.display='none'">`;
    $('wd-symbol').textContent = coin.symbol;
    const badge = $('wd-badge');
    if (coin.networkLabel) {
      badge.textContent = coin.networkLabel;
      badge.className = 'network-badge ' + coin.networkClass;
      badge.style.display = '';
    } else { badge.style.display = 'none'; }
    $('wd-amount').textContent = `${bal} ${coin.symbol}`;
    $('wd-usd').textContent = usd;
    $('wd-address').textContent = addr;

    // Render QR
    const qrSlot = $('wd-qr');
    qrSlot.innerHTML = '';
    if (typeof QRCode !== 'undefined' && addr && addr !== '—') {
      new QRCode(qrSlot, {
        text: addr, width: 320, height: 320,
        colorDark: '#000000', colorLight: '#ffffff',
        correctLevel: QRCode.CorrectLevel.H,
      });
    }

    // Wire actions
    $('wd-copy').onclick = () => navigator.clipboard.writeText(addr).then(() => toast('Address copied'));

    // Show / hide Stake button for stakable coins (SOL, TRX)
    const stakeBtn = $('wd-stake-toggle');
    const earnBtn  = $('wd-earn-toggle');
    const actionsRow = $('wd-balance-actions');
    if (coin.canStake && typeof openStakeModal === 'function') {
      stakeBtn.style.display = '';
      actionsRow?.classList.add('has-stake');
      stakeBtn.onclick = () => openStakeModal(coin.id);
    } else {
      stakeBtn.style.display = 'none';
      actionsRow?.classList.remove('has-stake');
    }
    // Show / hide Earn button for Aave-supported stablecoins
    if (coin.canEarn && typeof openEarnModal === 'function') {
      earnBtn.style.display = '';
      actionsRow?.classList.add('has-earn');
      earnBtn.onclick = () => openEarnModal(coin.id);
    } else {
      earnBtn.style.display = 'none';
      actionsRow?.classList.remove('has-earn');
    }

    // Send toggle — shows the inline send form right in the wallet view
    $('wd-send-toggle').onclick = () => {
      const form = $('wd-send-form');
      const visible = form.style.display !== 'none';
      if (visible) {
        form.style.display = 'none';
        clearFeeTimer();
        return;
      }
      // Close history if open
      $('wd-history-list').style.display = 'none';
      form.style.display = 'block';
      // Sync state: select this coin so app.js helpers (validateAddress, send, fee) work
      selectCoin(coin.id);
      $('wd-send-symbol').textContent = coin.symbol;
      $('wd-send-to').value = '';
      $('wd-send-amount').value = '';

      const isEvm = !!EVM_GAS[coin.id];
      const feeRow = $('wd-send-fee-row');
      const feeDisplay = $('wd-send-fee-display');
      if (isEvm) {
        feeRow.style.display = 'block';
        feeDisplay.textContent = 'Estimating…';
        delete feeRow.dataset.fee;
        const coinId = coin.id;
        estimateEvmFee(coinId).then(info => {
          feeDisplay.textContent = `~${info.fee} ${info.symbol} · ${info.gwei} gwei`;
          feeRow.dataset.fee = info.fee;
          feeRow.dataset.feeId = info.feeId;
          feeRow.dataset.rollup = info.isRollup ? '1' : '0';
          // Auto-fill max for native EVM coins
          const bal = parseFloat(state.balances[coinId] || '0');
          if (bal > 0 && !EVM_GAS[coinId].token) {
            const buffer = info.isRollup ? 1.5 : 1.2;
            const max = Math.max(0, bal - parseFloat(info.fee) * buffer);
            if (max > 0) $('wd-send-amount').value = max.toFixed(6);
          }
        }).catch(() => { feeDisplay.textContent = 'Unable to estimate'; });
      } else {
        feeRow.style.display = 'none';
      }

      // Scroll the form into view
      requestAnimationFrame(() => $('wd-send-form').scrollIntoView({ behavior: 'smooth', block: 'nearest' }));
    };

    // Max button
    $('wd-send-max').onclick = () => {
      const bal = parseFloat(state.balances[coin.id] || '0');
      if (bal <= 0) return;
      const feeRow = $('wd-send-fee-row');
      const isEvm = !!EVM_GAS[coin.id];
      if (isEvm && !EVM_GAS[coin.id].token && feeRow.dataset.fee) {
        const isRollup = feeRow.dataset.rollup === '1';
        const buffer = isRollup ? 1.5 : 1.2;
        const fee = parseFloat(feeRow.dataset.fee) * buffer;
        $('wd-send-amount').value = Math.max(0, bal - fee).toFixed(6);
      } else {
        $('wd-send-amount').value = bal.toString();
      }
    };

    // Inline send — reuses the same coin.send + verifyAuth path as the coin detail
    $('wd-do-send').onclick = async () => {
      const to = $('wd-send-to').value.trim();
      const amt = $('wd-send-amount').value.trim();
      if (!to || !amt || parseFloat(amt) <= 0) { toast('Enter a valid address and amount.'); return; }
      const addrErr = validateAddress(to, coin.id);
      if (addrErr) { toast(addrErr); return; }
      if (!confirm(`Send ${amt} ${coin.symbol}?\n\nTo:\n${to}`)) return;
      if (typeof verifyAuth === 'function') {
        try { await verifyAuth(`Confirm sending ${amt} ${coin.symbol}`); }
        catch { toast('Send cancelled'); return; }
      }
      const btn = $('wd-do-send');
      btn.disabled = true; btn.textContent = 'Sending…';
      try {
        const txid = await coin.send(state.mnemonic, to, amt);
        toast(`Sent! TX: ${String(txid).slice(0, 20)}…`);
        if (typeof TxProgress !== 'undefined') TxProgress.track(coin.id, txid, 'send', amt);
        $('wd-send-to').value = '';
        $('wd-send-amount').value = '';
        $('wd-send-form').style.display = 'none';
        setTimeout(refreshBalances, 4000);
      } catch (e) {
        toast(`Error: ${e.message || 'Transaction failed.'}`);
      } finally {
        btn.disabled = false; btn.textContent = 'Send';
      }
    };

    // History toggle — renders inline list right in the wallet view
    $('wd-history-toggle').onclick = async () => {
      const histDiv = $('wd-history-list');
      const visible = histDiv.style.display !== 'none';
      if (visible) { histDiv.style.display = 'none'; return; }
      // Close send form if open
      $('wd-send-form').style.display = 'none';

      histDiv.style.display = 'block';
      histDiv.innerHTML = `<p style="color:var(--text2);font-size:13px;padding:8px 0">Loading…</p>`;
      // Sync state so updateHistoryTab uses the right coin, then render into our div
      selectCoin(coin.id);
      try {
        if (!coin.history) {
          const url = coin.explorerAddr ? coin.explorerAddr(state.addresses[coin.id]) : '';
          histDiv.innerHTML = `<p style="color:var(--text2);font-size:13px;padding:8px 0">History not available for ${coin.name}.</p>
            ${url ? `<button class="btn btn-outline btn-sm wd-explorer-btn" data-url="${url}" style="margin-top:6px">View address on explorer ↗</button>` : ''}`;
        } else {
          const txs = await coin.history(state.addresses[coin.id]);
          if (!txs || txs.length === 0) {
            const url = coin.explorerAddr ? coin.explorerAddr(state.addresses[coin.id]) : '';
            histDiv.innerHTML = `<p style="color:var(--text2);font-size:13px;padding:8px 0">No transactions yet.</p>
              ${url ? `<button class="btn btn-outline btn-sm wd-explorer-btn" data-url="${url}" style="margin-top:6px">View on explorer ↗</button>` : ''}`;
          } else {
            histDiv.innerHTML = txs.map(tx => {
              const send = tx.type === 'send';
              const time = tx.time ? timeAgo(tx.time) : 'Pending';
              const url  = tx.explorerUrl || '';
              const st   = tx.status || (tx.confirmed ? 'ok' : 'pending');
              const stColor = st === 'error' ? '#ef4444' : st === 'pending' ? '#eab308' : '#22c55e';
              const stLabel = st === 'error' ? 'Failed' : st === 'pending' ? 'Pending' : 'OK';
              return `<div style="display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid var(--border)">
                <div style="width:28px;height:28px;border-radius:50%;flex-shrink:0;display:flex;align-items:center;
                  justify-content:center;font-size:14px;
                  background:${send ? 'rgba(239,68,68,0.15)' : 'rgba(34,197,94,0.15)'};
                  color:${send ? '#ef4444' : '#22c55e'}">${send ? '↑' : '↓'}</div>
                <div style="flex:1;min-width:0">
                  <div style="font-size:13px;font-weight:600">${send ? 'Sent' : 'Received'} ${tx.amount} ${coin.symbol}</div>
                  <div style="font-size:11px;color:var(--text2);margin-top:2px">
                    <span>${time}</span>
                    <span style="color:${stColor};margin-left:6px">• ${stLabel}</span>
                  </div>
                </div>
                ${url ? `<button class="btn btn-outline btn-sm wd-explorer-btn" data-url="${url}"
                  style="padding:5px 9px;font-size:11px;flex-shrink:0">↗</button>` : ''}
              </div>`;
            }).join('');
          }
        }
      } catch (e) {
        histDiv.innerHTML = `<p style="color:var(--red);font-size:13px;padding:8px 0">Failed: ${e.message}</p>`;
      }
      histDiv.querySelectorAll('.wd-explorer-btn').forEach(btn => {
        btn.onclick = () => openExternal(btn.dataset.url);
      });
      requestAnimationFrame(() => histDiv.scrollIntoView({ behavior: 'smooth', block: 'nearest' }));
    };

    // Hide forms when switching coins
    $('wd-send-form').style.display = 'none';
    $('wd-history-list').style.display = 'none';

    // Highlight selected coin in the picker list
    document.querySelectorAll('#wallet-asset-list .asset-item').forEach(el => {
      el.classList.toggle('selected', el.dataset.coin === coin.id);
    });
  }

  // Bottom picker list (grouped by network, follows custom order)
  function renderWalletList() {
    const list = $('wallet-asset-list');
    if (!list) return;
    const activeRaw = (typeof getActiveCoins === 'function') ? getActiveCoins() : [];
    if (!activeRaw.length) {
      list.innerHTML = `<p style="text-align:center;color:var(--text2);padding:24px">No wallets enabled. Tap Settings → Manage Assets.</p>`;
      return;
    }
    const active = applyOrder(activeRaw);
    const cats = [...new Set(active.map(c => c.category))];
    let html = '';
    for (const cat of cats) {
      const group = active.filter(c => c.category === cat);
      html += `<div class="network-group">`;
      html += `<div class="network-header">${cat}</div>`;
      html += `<div class="network-card">`;
      html += group.map(coin => {
        const bal = state.balances[coin.id] ?? '…';
        const usd = formatUSD(bal, state.prices[coin.id]) || '';
        const badge = coin.networkLabel
          ? `<span class="network-badge ${coin.networkClass}">${coin.networkLabel}</span>` : '';
        const progress = renderProgressPills(coin.id);
        return `
          <div class="asset-item" data-coin="${coin.id}">
            <div class="asset-icon">
              <img src="${coin.icon}" alt="" onerror="this.style.display='none'">
            </div>
            <div class="asset-meta">
              <div class="asset-name">${coin.name} ${badge}</div>
              <div class="asset-symbol">${coin.symbol}</div>
              ${progress}
            </div>
            <div class="asset-right">
              <div class="asset-bal">${bal}</div>
              <div class="asset-usd">${usd}</div>
            </div>
          </div>`;
      }).join('');
      html += `</div></div>`;
    }
    list.innerHTML = html;

    // Tapping a coin updates the QR display at top
    list.querySelectorAll('.asset-item').forEach(el => {
      el.onclick = () => {
        renderWalletDisplay(el.dataset.coin);
        // Scroll the QR back into view so it's immediately visible
        const target = $('wallet-display');
        if (target?.scrollIntoView) {
          requestAnimationFrame(() => target.scrollIntoView({ behavior: 'smooth', block: 'start' }));
        }
        try { window.scrollTo({ top: 0, behavior: 'smooth' }); } catch { window.scrollTo(0, 0); }
      };
    });

    // Initialise top display
    renderWalletDisplay(walletDisplayCoin);
  }

  function updateHome() {
    renderAssetList();
    renderWalletList();
    updateTotalBalance();
  }
  window.updateHome = updateHome;

  // Re-render lists when tx confirmation state changes so progress pills update.
  if (typeof TxProgress !== 'undefined') TxProgress.subscribe(updateHome);

  // ── Patch app.js functions ────────────────────────────────
  function patchApp() {
    // After balances refresh, update home
    if (typeof refreshBalances === 'function') {
      const orig = refreshBalances;
      window.refreshBalances = async function() {
        await orig.apply(this, arguments);
        updateHome();
      };
    }

    // After prices fetch, update home
    if (typeof fetchPrices === 'function') {
      const orig = fetchPrices;
      window.fetchPrices = async function() {
        await orig.apply(this, arguments);
        updateHome();
      };
    }

    // After loadWallet, show app shell + home view
    if (typeof loadWallet === 'function') {
      const orig = loadWallet;
      window.loadWallet = async function() {
        await orig.apply(this, arguments);
        $('app').style.display = 'flex';
        // Reset every view — was leaving stale .active from previous session
        document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
        $('home-view').classList.add('active');
        // Reset bottom nav highlight to Home
        document.querySelectorAll('.nav-item').forEach(n => {
          n.classList.toggle('active', n.dataset.nav === 'home');
        });
        updateHome();
      };
    }

    // renderCoinList is called by app.js whenever enabled coins change
    // (Manage Assets toggle). Re-render the new home + wallet views too.
    if (typeof renderCoinList === 'function') {
      const orig = renderCoinList;
      window.renderCoinList = function() {
        orig.apply(this, arguments);
        updateHome();
      };
    }

    // updateSidebarBal is called whenever a single coin's balance changes.
    // Update home/wallet views so the new tile appears even before next full refresh.
    if (typeof updateSidebarBal === 'function') {
      const orig = updateSidebarBal;
      window.updateSidebarBal = function() {
        orig.apply(this, arguments);
        updateHome();
      };
    }
  }

  // ── Wire UI events ────────────────────────────────────────
  function wireEvents() {
    // Bottom nav (Home / Wallets / Settings)
    document.querySelectorAll('.nav-item').forEach(btn => {
      btn.onclick = () => {
        const target = btn.dataset.nav;
        if (target === 'home')     showView('home');
        else if (target === 'wallet')   showView('wallet');
        else if (target === 'settings') {
          showView('settings');
          window.renderSettingsTab?.();
        }
      };
    });

    // Wallet view refresh button
    $('wallet-refresh')?.addEventListener('click', () => $('refresh-btn')?.click());

    // Home view: Edit/Done toggle (reorder mode)
    $('home-edit-btn')?.addEventListener('click', () => toggleEditMode());

    // Back button on coin view
    $('back-btn').onclick = () => showView('home');

    // Refresh button on coin view (mirrors home refresh)
    $('refresh-btn-coin').onclick = () => $('refresh-btn').click();

    // Quick actions
    $('qa-send').onclick = () => {
      const first = (typeof getActiveCoins === 'function') ? getActiveCoins()[0] : null;
      if (!state.active && first) selectCoin(first.id);
      showView('coin');
      document.querySelector('.tab[data-tab="send"]')?.click();
    };
    $('qa-receive').onclick = () => {
      const first = (typeof getActiveCoins === 'function') ? getActiveCoins()[0] : null;
      if (!state.active && first) selectCoin(first.id);
      showView('coin');
      document.querySelector('.tab[data-tab="receive"]')?.click();
    };
    $('qa-manage').onclick = () => $('settings-btn')?.click();

    // The action card (Send / History) is hidden by default so the receive view
    // (balance + QR + address) fits in one screen. Tapping Send or History opens it.
    function openAction(tab) {
      const card = $('action-card');
      if (card) card.style.display = 'block';
      // Activate target tab
      document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
      ['send', 'history'].forEach(name => {
        const el = $('tab-' + name);
        if (el) el.classList.toggle('active', name === tab);
      });
      // Scroll the card into view
      setTimeout(() => card?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
    }
    function closeAction() {
      const card = $('action-card');
      if (card) card.style.display = 'none';
    }
    window.openAction = openAction;
    window.closeAction = closeAction;

    // Override receive-tab-btn (now labeled "History") and send-tab-btn
    setTimeout(() => {
      const histBtn = $('receive-tab-btn');
      if (histBtn) histBtn.onclick = () => openAction('history');
      const sendBtn = $('send-tab-btn');
      if (sendBtn) sendBtn.onclick = () => openAction('send');
    }, 0);

    // Tab clicks (Send / History switch; ✕ closes the card)
    document.querySelectorAll('.tab').forEach(tab => {
      tab.addEventListener('click', () => {
        const target = tab.dataset.tab;
        if (target === 'close') { closeAction(); return; }
        openAction(target);
      });
    });

    // Lock from settings sheet
    $('lock-action-btn')?.addEventListener('click', () => {
      $('settings-close-btn')?.click();
      $('lock-btn')?.click();
    });

    // Settings overlay show/hide via classList (CSS uses .show)
    const overlay = $('settings-overlay');
    if (overlay) {
      const observer = new MutationObserver(() => {
        // app.js sets style.display='flex'; convert to .show class
        if (overlay.style.display === 'flex') {
          overlay.classList.add('show');
          overlay.style.display = '';
        }
      });
      observer.observe(overlay, { attributes: true, attributeFilter: ['style'] });

      $('settings-close-btn')?.addEventListener('click', () => {
        overlay.classList.remove('show');
      });
    }
  }

  // ── Boot ──────────────────────────────────────────────────
  // app.js may not have defined functions yet (loaded just before us); use a microtask.
  Promise.resolve().then(() => {
    patchApp();
    wireEvents();
  });
})();
