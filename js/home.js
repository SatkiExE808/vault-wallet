// Home view: total balance + asset list. Bottom nav routing.
// Monkey-patches the existing app.js functions instead of editing them so
// the redesign stays separable.
(() => {
  const $ = id => document.getElementById(id);

  // Small green pill showing live Aave supply APY for stablecoins.
  // Returns '' when no APY is known for the coin yet.
  function renderApyBadge(coinId) {
    const raw = state.aaveApy?.[coinId];
    const num = parseFloat(raw);
    // Defense against any stale-cached or mis-decoded rate slipping
    // through with Infinity / NaN / bogus huge values.
    if (!raw || !Number.isFinite(num) || num <= 0 || num > 200) return '';
    return `<span class="apy-badge" title="Aave supply APY">${num.toFixed(2)}%</span>`;
  }

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
    if (name === 'inbox')    $('inbox-view').classList.add('active');
    // Map view → bottom nav highlight (inbox keeps the home tab lit)
    const navMap = { home: 'home', wallet: 'wallet', coin: 'wallet', settings: 'settings', inbox: 'home' };
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
              <img src="${coin.icon}" alt="">
            </div>
            <div class="asset-meta">
              <div class="asset-name">${coin.name} ${badge} ${renderApyBadge(coin.id)}</div>
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
    if (!anyKnown) { total.textContent = '—'; return; }
    const ccy = (typeof getDisplayCurrency === 'function' ? getDisplayCurrency() : 'usd').toUpperCase();
    const noDecimals = new Set(['JPY','KRW','IDR','VND']);
    const digits = noDecimals.has(ccy) ? 0 : 2;
    total.textContent = new Intl.NumberFormat(undefined, {
      style: 'currency', currency: ccy,
      minimumFractionDigits: digits, maximumFractionDigits: digits,
    }).format(sum);
  }

  // Wallet view: which coin is currently displayed at top
  let walletDisplayCoin = null;
  // Tracks whether the last renderWalletDisplay call switched coins so the
  // function can know to reset open send/history forms only on a real
  // change of context — not on every balance refresh re-render. Without
  // this, the inline send form silently snaps shut every ~30 s while the
  // user is mid-edit.
  let _lastRenderedCoin = null;
  // Explicit "this panel was opened by the user" flags. Set to true when
  // the user taps Send / History; reset to false on real coin-switch,
  // explicit toggle-close, or successful send. At the END of
  // renderWalletDisplay we use these to FORCE the matching panel back
  // into view if it was open — that way, even if some other code path
  // sneaks a `style.display = 'none'` in mid-render, the panel is
  // re-shown before the render completes. Belt-and-suspenders.
  let _sendFormOpen = false;
  let _histListOpen = false;

  // Opens an info modal that walks the user through verifying the displayed
  // multi-address in a third-party BIP84/BIP44 wallet. Critical safety
  // check anyone should do before sending large funds to a freshly derived
  // address — the same standards-based derivation should produce the
  // exact same address in Sparrow, Electrum, BlueWallet, etc.
  function openVerifyHelp(coin, idx, addr, derivPath) {
    if (typeof infoModal !== 'function') return;
    // Coin-specific wallet recommendations. BTC/LTC use BIP84 → bech32
    // SegWit; DOGE uses BIP44 legacy P2PKH (no SegWit on Doge yet).
    const recos = {
      BTC: [
        { name: 'Sparrow Wallet', url: 'https://sparrowwallet.com/' },
        { name: 'Electrum',       url: 'https://electrum.org/' },
        { name: 'BlueWallet',     url: 'https://bluewallet.io/' },
      ],
      LTC: [
        { name: 'Electrum-LTC',   url: 'https://electrum-ltc.org/' },
        { name: 'Trust Wallet',   url: 'https://trustwallet.com/' },
      ],
      DOGE: [
        { name: 'Trust Wallet',   url: 'https://trustwallet.com/' },
        { name: 'MyDogeWallet',   url: 'https://mydoge.com/' },
      ],
    };
    const list = (recos[coin.id] || [])
      .map(r => `<li><a href="${r.url}" data-external style="color:var(--accent)">${r.name}</a></li>`)
      .join('');
    const safe = (s) => String(s).replace(/[&<>"]/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[m]));
    // Self-test only meaningful for BIP84 coins (BTC, LTC). For DOGE
    // (legacy BIP44 P2PKH) the test vectors live in a different spec
    // we don't bundle, so we hide the button there.
    const showSelfTest = coin.id !== 'DOGE';

    const body = `
      <p style="font-size:13px;color:var(--text2);margin-bottom:10px">
        Every BIP84/BIP44 wallet that supports the same derivation standards will
        regenerate <b>exactly the same address</b> from your 12-word seed. There
        are two ways to confirm this is correct:
      </p>
      ${showSelfTest ? `
      <!-- Option 1: in-app cryptographic self-test against BIP-0084 vectors -->
      <div style="background:var(--surface2);border-radius:8px;padding:12px;margin-bottom:14px">
        <div style="font-size:12px;font-weight:600;color:var(--text);margin-bottom:6px">Option 1 — Run cryptographic self-test</div>
        <p style="font-size:11px;color:var(--text2);margin-bottom:8px">
          Reproduces the addresses documented in <b>BIP-0084</b> from the canonical test
          seed. If the actual outputs match the spec, the algorithm is provably correct
          and so are your generated addresses.
        </p>
        <button class="btn btn-primary btn-sm" id="run-self-test" style="width:100%;font-size:12px">Run BIP-0084 self-test</button>
        <div id="self-test-results" style="margin-top:10px"></div>
      </div>` : ''}
      <!-- Option 2: cross-wallet verification -->
      <div style="background:var(--surface2);border-radius:8px;padding:12px;margin-bottom:12px">
        <div style="font-size:12px;font-weight:600;color:var(--text);margin-bottom:6px">Option ${showSelfTest ? '2' : '1'} — Cross-check in another wallet</div>
        <div style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;word-break:break-all;background:var(--surface);padding:8px;border-radius:6px;margin-bottom:8px">
          <div style="color:var(--text2);font-size:10px;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:3px">Derivation path</div>
          <div style="color:var(--text)">${safe(derivPath)}</div>
          <div style="color:var(--text2);font-size:10px;text-transform:uppercase;letter-spacing:0.5px;margin:8px 0 3px">Address shown</div>
          <div style="color:var(--text)">${safe(addr)}</div>
        </div>
        <ol style="font-size:11px;color:var(--text2);padding-left:18px;line-height:1.6;margin-bottom:0">
          <li>Install one of these on a separate device (or watch-only mode):
            <ul style="padding-left:16px;margin:2px 0">${list}</ul>
          </li>
          <li><b>Restore from seed phrase</b> and paste your 12 words.
            ${coin.id !== 'DOGE' ? 'Pick <b>Native SegWit (BIP84)</b>.' : 'Pick <b>Legacy (BIP44)</b>.'}</li>
          <li>If you use a BIP39 passphrase here, enable it there too.</li>
          <li>Receive → address index ${idx} should match character-for-character.</li>
        </ol>
      </div>
      <p style="font-size:11px;color:var(--text3);padding:8px 10px;background:rgba(249,115,22,0.08);border-radius:6px">
        💡 For very large amounts, also do a round-trip test: send a small amount
        first, wait for it to appear in Vault, then send it back out. If both work,
        the address is fully functional.
      </p>
    `;

    infoModal({
      title: `Verify ${coin.symbol} address`,
      body,
      closeLabel: 'Got it',
      onMount(root) {
        if (!showSelfTest) return;
        const btn = root.querySelector('#run-self-test');
        const resDiv = root.querySelector('#self-test-results');
        if (!btn || !resDiv) return;
        btn.onclick = async () => {
          btn.disabled = true;
          btn.textContent = 'Running…';
          let outcome;
          try { outcome = await UTXOCrypto.selfTest(); }
          catch(e) { outcome = { passed: false, results: [], error: e.message }; }
          btn.style.display = 'none';
          const rowsHtml = (outcome.results || []).map(r => `
            <div style="background:var(--surface);padding:8px;border-radius:6px;margin-top:6px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10px;word-break:break-all">
              <div style="color:var(--text2)">${safe(r.path)}</div>
              <div style="color:${r.match ? 'var(--green)' : 'var(--red)'}">expected: ${safe(r.expected)}</div>
              <div style="color:${r.match ? 'var(--green)' : 'var(--red)'}">actual:&nbsp;&nbsp; ${safe(r.actual || r.error || '(failed)')}</div>
            </div>
          `).join('');
          resDiv.innerHTML = `
            <div style="font-size:13px;font-weight:700;color:${outcome.passed ? 'var(--green)' : 'var(--red)'};margin-bottom:4px">
              ${outcome.passed ? '✓ All test vectors pass' : '✗ Derivation does NOT match the BIP-0084 spec'}
            </div>
            ${rowsHtml}
            <p style="font-size:11px;color:var(--text3);margin-top:8px">
              ${outcome.passed
                ? 'The BIP-0084 algorithm in Vault matches the official Bitcoin specification. Addresses derived from your own seed are also correct.'
                : '⚠ Do not send funds to addresses generated by this wallet. Report this immediately.'}
            </p>
          `;
        };
      },
    });
  }

  function renderWalletDisplay(coinId) {
    const active = (typeof getActiveCoins === 'function') ? getActiveCoins() : [];
    if (!active.length) return;
    walletDisplayCoin = coinId || walletDisplayCoin || active[0].id;
    const coin = active.find(c => c.id === walletDisplayCoin);
    if (!coin) { walletDisplayCoin = active[0].id; return renderWalletDisplay(walletDisplayCoin); }

    const bal  = state.balances[coin.id] ?? '…';
    const usd  = formatUSD(bal, state.prices[coin.id]) || '';
    const addr = state.addresses[coin.id] || '—';

    $('wd-icon').innerHTML = `<img src="${coin.icon}" alt="" style="width:18px;height:18px;border-radius:50%">`;
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

    // "+ Generate new address" — only show for multi-address UTXO coins (BTC/LTC/DOGE).
    // Index 0 was the original single-address default; clicking + bumps to index 1, 2, …
    const newAddrBtn = $('wd-new-addr');
    if (newAddrBtn) {
      if (coin.multiAddr) {
        newAddrBtn.style.display = '';
        newAddrBtn.disabled = false;
        newAddrBtn.onclick = async () => {
          newAddrBtn.disabled = true;
          await window.generateNewAddress?.(coin.id);
          newAddrBtn.disabled = false;
        };
      } else {
        newAddrBtn.style.display = 'none';
      }
    }

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

    // Helper: keep one of the four action buttons (Send / History /
    // Stake / Earn) highlighted in the accent gradient while its content
    // is showing. Inline content swaps Send <-> History; modal-based
    // actions (Stake / Earn) revert to "Send active" once the modal
    // closes since they don't have inline content here.
    function setActiveAction(activeId) {
      // Default to highlighting Send when nothing else is open — that
      // matches the original "Send is the primary CTA" look.
      const target = activeId || 'wd-send-toggle';
      ['wd-send-toggle', 'wd-history-toggle'].forEach(id => {
        const btn = $(id);
        if (!btn) return;
        const on = id === target;
        btn.classList.toggle('btn-primary', on);
        btn.classList.toggle('btn-outline', !on);
      });
    }
    // Switching coins should close any open inline panel and reset the
    // highlighted button — otherwise a History list from the previous
    // coin sticks around with stale data. But this must NOT trigger on
    // plain balance-refresh re-renders (every 60 s), otherwise an open
    // send form gets yanked out from under the user while they're typing.
    if (_lastRenderedCoin !== coin.id) {
      $('wd-send-form').style.display = 'none';
      $('wd-history-list').style.display = 'none';
      _sendFormOpen = false;
      _histListOpen = false;
      setActiveAction(null);
    }

    // Send toggle — shows the inline send form right in the wallet view
    $('wd-send-toggle').onclick = () => {
      const form = $('wd-send-form');
      const visible = form.style.display !== 'none';
      if (visible) {
        form.style.display = 'none';
        _sendFormOpen = false;
        clearFeeTimer();
        setActiveAction(null);
        return;
      }
      // Close history if open
      $('wd-history-list').style.display = 'none';
      _histListOpen = false;
      form.style.display = 'block';
      _sendFormOpen = true;
      setActiveAction('wd-send-toggle');
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
          feeDisplay.textContent = `~${info.fee} ${info.symbol}`;
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

    // Paste / Scan — share the implementation with the coin-detail send
    // path (see app.js) so error handling stays consistent.
    $('wd-paste-addr').onclick = () => window.pasteAddress?.($('wd-send-to'));
    $('wd-scan-addr').onclick  = () => window.scanAddress?.($('wd-send-to'));

    // Max button — fill in the largest amount that still leaves room for
    // the network fee. The fee model varies by coin:
    //   EVM native: use the live fee row × buffer (rollup-aware)
    //   SOL: reserve ~0.001 SOL for the tx fee (real fee is ~5,000 lamports
    //        but a fatter buffer prevents "insufficient funds for fee"
    //        when the rate shifts mid-tx)
    //   TRX: reserve 1 TRX for activation fees / energy edge cases
    //   Others (UTXO, tokens): fee is paid out of the same balance and
    //     handled by the send logic, so Max can use the full balance.
    $('wd-send-max').onclick = () => {
      const bal = parseFloat(state.balances[coin.id] || '0');
      if (bal <= 0) { toast(`No liquid ${coin.symbol}`); return; }
      const feeRow = $('wd-send-fee-row');
      const isEvm = !!EVM_GAS[coin.id];
      let max;
      if (isEvm && !EVM_GAS[coin.id].token && feeRow.dataset.fee) {
        const isRollup = feeRow.dataset.rollup === '1';
        const buffer = isRollup ? 1.5 : 1.2;
        const fee = parseFloat(feeRow.dataset.fee) * buffer;
        max = bal - fee;
      } else if (coin.id === 'SOL') {
        max = bal - 0.001;
        if (max <= 0) { toast('Need ~0.001 SOL extra to cover the network fee'); return; }
      } else if (coin.id === 'TRX') {
        max = bal - 1;
        if (max <= 0) { toast('Need ~1 TRX extra to cover the network fee'); return; }
      } else {
        max = bal;
      }
      $('wd-send-amount').value = Math.max(0, max).toFixed(6);
    };

    // Inline send — reuses the same coin.send + verifyAuth path as the coin detail
    $('wd-do-send').onclick = async () => {
      const to = $('wd-send-to').value.trim();
      const amt = $('wd-send-amount').value.trim();
      if (!to || !amt || parseFloat(amt) <= 0) { toast('Enter a valid address and amount.'); return; }
      const addrErr = validateAddress(to, coin.id);
      if (addrErr) { toast(addrErr); return; }
      const feeText = $('wd-send-fee-display')?.textContent || '';
      const showFee = feeText && feeText !== '—' && feeText !== 'Estimating…';
      const ok = await confirmModal({
        title: 'Confirm Send',
        lines: [
          ['Amount', `${amt} ${coin.symbol}`],
          ['To', to, { code: true }],
          ...(showFee ? [['Network fee', feeText]] : []),
        ],
        confirmLabel: 'Send',
      });
      if (!ok) return;
      if (typeof verifyAuth === 'function') {
        try { await verifyAuth(`Confirm sending ${amt} ${coin.symbol}`); }
        catch { toast('Send cancelled'); return; }
      }
      const btn = $('wd-do-send');
      btn.disabled = true; btn.textContent = 'Sending…';
      try {
        if (typeof validateEvmGas === 'function') await validateEvmGas(coin.id, amt);
        const txid = await coin.send(state.mnemonic, to, amt);
        toast(`Sent! TX: ${String(txid).slice(0, 20)}…`);
        if (typeof TxProgress !== 'undefined') TxProgress.track(coin.id, txid, 'send', amt);
        Inbox?.add({
          type: 'send',
          title: `${coin.symbol} withdrawal complete`,
          network: coin.category,
          subtitle: `Sent ${amt} ${coin.symbol} to ${to.slice(0, 8)}…${to.slice(-6)}`,
        });
        $('wd-send-to').value = '';
        $('wd-send-amount').value = '';
        $('wd-send-form').style.display = 'none';
        _sendFormOpen = false;
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
      if (visible) { histDiv.style.display = 'none'; _histListOpen = false; setActiveAction(null); return; }
      // Close send form if open
      $('wd-send-form').style.display = 'none';
      _sendFormOpen = false;

      histDiv.style.display = 'block';
      _histListOpen = true;
      setActiveAction('wd-history-toggle');
      histDiv.innerHTML = `<p style="color:var(--text2);font-size:13px;padding:8px 0">Loading…</p>`;
      // Sync state so updateHistoryTab uses the right coin, then render into our div
      selectCoin(coin.id);
      try {
        if (!coin.history) {
          const url = safeUrl(coin.explorerAddr ? coin.explorerAddr(state.addresses[coin.id]) : '');
          histDiv.innerHTML = `<p style="color:var(--text2);font-size:13px;padding:8px 0">History not available for ${escapeHtml(coin.name)}.</p>
            ${url ? `<button class="btn btn-outline btn-sm wd-explorer-btn" data-url="${escapeHtml(url)}" style="margin-top:6px">View address on explorer ↗</button>` : ''}`;
        } else {
          // Multi-address coins: pass full address list so history shows
          // txs from every derived index (BTC / LTC / DOGE).
          const histTarget = state.addressLists[coin.id]?.length
            ? state.addressLists[coin.id]
            : state.addresses[coin.id];
          const txs = await coin.history(histTarget);
          if (!txs || txs.length === 0) {
            const url = safeUrl(coin.explorerAddr ? coin.explorerAddr(state.addresses[coin.id]) : '');
            histDiv.innerHTML = `<p style="color:var(--text2);font-size:13px;padding:8px 0">No transactions yet.</p>
              ${url ? `<button class="btn btn-outline btn-sm wd-explorer-btn" data-url="${escapeHtml(url)}" style="margin-top:6px">View on explorer ↗</button>` : ''}`;
          } else {
            // Tinted icon + verb based on tx.kind (set by coin modules
            // that classify their history). Falls back to plain
            // Sent/Received when the coin doesn't tag rows.
            // Lucide-style SVGs; currentColor inherits the per-tint fg.
            const _I = (path, sw = 2.2) =>
              `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;
            const TX_LABELS = {
              'send':           { verb: 'Sent',            tint: 'red',    icon: _I('<path d="M7 17 L17 7"/><polyline points="8 7 17 7 17 16"/>', 2.4) },
              'receive':        { verb: 'Received',        tint: 'green',  icon: _I('<path d="M17 7 L7 17"/><polyline points="16 17 7 17 7 8"/>', 2.4) },
              'stake':          { verb: 'Staked',          tint: 'orange', icon: _I('<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V7.5a4 4 0 0 1 8 0V11"/>') },
              'stake-withdraw': { verb: 'Withdrew stake',  tint: 'green',  icon: _I('<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V7.5a4 4 0 0 1 7-2.6"/>') },
              'stake-manage':   { verb: 'Stake action',    tint: 'orange', icon: _I('<path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><polyline points="3 22 3 16 9 16"/><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><polyline points="21 2 21 8 15 8"/>') },
              'liquid-stake':   { verb: 'Liquid staked',   tint: 'cyan',   icon: _I('<path d="M12 2.5C9 6 5.5 10 5.5 14a6.5 6.5 0 0 0 13 0c0-4-3.5-8-6.5-11.5z"/><polyline points="9 12 12 15 15 12"/>') },
              'liquid-unstake': { verb: 'Liquid unstaked', tint: 'cyan',   icon: _I('<path d="M12 2.5C9 6 5.5 10 5.5 14a6.5 6.5 0 0 0 13 0c0-4-3.5-8-6.5-11.5z"/><polyline points="9 13 12 10 15 13"/>') },
            };
            const TX_TINTS = {
              red:    { bg: 'rgba(239,68,68,0.15)',  fg: '#ef4444' },
              green:  { bg: 'rgba(34,197,94,0.15)',  fg: '#22c55e' },
              orange: { bg: 'rgba(249,115,22,0.15)', fg: '#f97316' },
              cyan:   { bg: 'rgba(34,211,238,0.15)', fg: '#22d3ee' },
            };
            histDiv.innerHTML = txs.map(tx => {
              const send = tx.type === 'send';
              const time = tx.time ? timeAgo(tx.time) : 'Pending';
              const url  = safeUrl(tx.explorerUrl);
              const st   = tx.status || (tx.confirmed ? 'ok' : 'pending');
              const kind = tx.kind || (send ? 'send' : 'receive');
              const lbl  = TX_LABELS[kind] || TX_LABELS[send ? 'send' : 'receive'];
              const tint = TX_TINTS[lbl.tint] || TX_TINTS.red;
              const stColor = st === 'error' ? '#ef4444' : st === 'pending' ? '#eab308' : '#22c55e';
              const stLabel = st === 'error' ? 'Failed' : st === 'pending' ? 'Pending' : 'Completed';
              return `<div style="display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid var(--border)">
                <div style="width:28px;height:28px;border-radius:50%;flex-shrink:0;display:flex;align-items:center;
                  justify-content:center;font-size:14px;
                  background:${tint.bg};color:${tint.fg}">${lbl.icon}</div>
                <div style="flex:1;min-width:0">
                  <div style="font-size:13px;font-weight:600">${lbl.verb} ${escapeHtml(tx.amount)} ${escapeHtml(coin.symbol)}</div>
                  <div style="font-size:11px;color:var(--text2);margin-top:2px">
                    <span>${time}</span>
                    <span style="color:${stColor};margin-left:6px">• ${stLabel}</span>
                  </div>
                </div>
                ${url ? `<button class="btn btn-outline btn-sm wd-explorer-btn" data-url="${escapeHtml(url)}"
                  style="padding:5px 9px;font-size:11px;flex-shrink:0">↗</button>` : ''}
              </div>`;
            }).join('');
          }
        }
      } catch (e) {
        histDiv.innerHTML = `<p style="color:var(--red);font-size:13px;padding:8px 0">Failed: ${escapeHtml(e.message)}</p>`;
      }
      histDiv.querySelectorAll('.wd-explorer-btn').forEach(btn => {
        btn.onclick = () => openExternal(btn.dataset.url);
      });
      requestAnimationFrame(() => histDiv.scrollIntoView({ behavior: 'smooth', block: 'nearest' }));
    };

    // (Form reset already handled earlier in this function — at the top
    // of the button-wiring block, gated on coin-change.)
    // ── Belt-and-suspenders: force-restore the open panel ──
    // If the user opened Send or History, make absolutely sure it's
    // visible at the end of this render. Any rogue code path that did
    // `style.display = 'none'` while we were rendering is overridden.
    if (_sendFormOpen) {
      $('wd-send-form').style.display = 'block';
      setActiveAction('wd-send-toggle');
    } else if (_histListOpen) {
      $('wd-history-list').style.display = 'block';
      setActiveAction('wd-history-toggle');
    }
    _lastRenderedCoin = coin.id;

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
              <img src="${coin.icon}" alt="">
            </div>
            <div class="asset-meta">
              <div class="asset-name">${coin.name} ${badge} ${renderApyBadge(coin.id)}</div>
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

    // Quick actions — IDs left over from the old design that no longer exist
    // in index.html. Guard with optional chaining so the rest of wireEvents()
    // doesn't throw if any of them are missing.
    $('qa-send')?.addEventListener('click', () => {
      const first = (typeof getActiveCoins === 'function') ? getActiveCoins()[0] : null;
      if (!state.active && first) selectCoin(first.id);
      showView('coin');
      document.querySelector('.tab[data-tab="send"]')?.click();
    });
    $('qa-receive')?.addEventListener('click', () => {
      const first = (typeof getActiveCoins === 'function') ? getActiveCoins()[0] : null;
      if (!state.active && first) selectCoin(first.id);
      showView('coin');
      document.querySelector('.tab[data-tab="receive"]')?.click();
    });
    $('qa-manage')?.addEventListener('click', () => $('settings-btn')?.click());

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
