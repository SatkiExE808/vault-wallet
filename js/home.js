// Home view: total balance + asset list. Bottom nav routing.
// Monkey-patches the existing app.js functions instead of editing them so
// the redesign stays separable.
(() => {
  const $ = id => document.getElementById(id);

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

  // ── Home asset list (grouped by network) ──────────────────
  function renderAssetList() {
    const list = $('asset-list');
    if (!list) return;
    const active = (typeof getActiveCoins === 'function') ? getActiveCoins() : [];
    if (!active.length) {
      list.innerHTML = `<p style="text-align:center;color:var(--text2);padding:24px">No assets enabled. Tap Manage to add some.</p>`;
      return;
    }
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
        return `
          <div class="asset-item" data-coin="${coin.id}">
            <div class="asset-icon">
              <img src="${coin.icon}" alt="" onerror="this.style.display='none'">
            </div>
            <div class="asset-meta">
              <div class="asset-name">${coin.name} ${badge}</div>
              <div class="asset-symbol">${coin.symbol}</div>
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
    list.querySelectorAll('.asset-item').forEach(el => {
      el.onclick = () => {
        selectCoin(el.dataset.coin);
        showView('coin');
      };
    });
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
        text: addr, width: 140, height: 140,
        colorDark: '#000', colorLight: '#fff',
        correctLevel: QRCode.CorrectLevel.M,
      });
    }

    // Wire actions
    $('wd-copy').onclick = () => navigator.clipboard.writeText(addr).then(() => toast('Address copied'));
    $('wd-send').onclick = () => {
      selectCoin(coin.id);
      showView('coin');
      document.querySelector('.tab[data-tab="send"]')?.click();
    };
    $('wd-history').onclick = () => {
      selectCoin(coin.id);
      showView('coin');
      document.querySelector('.tab[data-tab="history"]')?.click();
    };

    // Highlight selected coin in the picker list
    document.querySelectorAll('#wallet-asset-list .asset-item').forEach(el => {
      el.classList.toggle('selected', el.dataset.coin === coin.id);
    });
  }

  // Bottom picker list (grouped by network)
  function renderWalletList() {
    const list = $('wallet-asset-list');
    if (!list) return;
    const active = (typeof getActiveCoins === 'function') ? getActiveCoins() : [];
    if (!active.length) {
      list.innerHTML = `<p style="text-align:center;color:var(--text2);padding:24px">No wallets enabled. Tap Settings → Manage Assets.</p>`;
      return;
    }
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
        return `
          <div class="asset-item" data-coin="${coin.id}">
            <div class="asset-icon">
              <img src="${coin.icon}" alt="" onerror="this.style.display='none'">
            </div>
            <div class="asset-meta">
              <div class="asset-name">${coin.name} ${badge}</div>
              <div class="asset-symbol">${coin.symbol}</div>
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

    // Tapping a coin updates the QR display at the top (no navigation)
    list.querySelectorAll('.asset-item').forEach(el => {
      el.onclick = () => renderWalletDisplay(el.dataset.coin);
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
        $('main').classList.remove('active');     // start on home
        $('home-view').classList.add('active');
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
